import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { BufferedSqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/buffered-sql-session-storage";
import {
	findMostRecentSession,
	listAllSessions,
	listSessions,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { backfillSessionPlaceholders } from "@oh-my-pi/pi-coding-agent/session/session-placeholder";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const assistant: AssistantMessage = {
	role: "assistant",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	api: "anthropic-messages",
	content: [{ type: "text", text: "hi" }],
	stopReason: "stop",
	timestamp: 2,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

/** Real Bun.SQL SQLite stands in for the shared PostgreSQL catalog. */
class Fixture {
	readonly temp = TempDir.createSync("@omp-session-placeholder-");
	readonly admin = new SQL(`sqlite://${this.temp.join("remote.sqlite")}`);
	readonly storages: BufferedSqlSessionStorage[] = [];
	readonly sessionsRoot = this.temp.join("agent", "sessions");
	readonly cwd = this.temp.join("project");

	async open(): Promise<BufferedSqlSessionStorage> {
		await SqlSessionStorage.create({ client: this.admin });
		const storage = await BufferedSqlSessionStorage.create({
			cachePath: this.temp.join("cache.sqlite"),
			createClient: () => new SQL(`sqlite://${this.temp.join("remote.sqlite")}`),
			syncIntervalMs: 0,
		});
		this.storages.push(storage);
		return storage;
	}

	async dispose(): Promise<void> {
		for (const storage of this.storages) await storage.close();
		await this.admin.end();
		await this.temp.remove();
	}
}

const fixtures: Fixture[] = [];
let previousAgentDir: string | undefined;

async function fixture(): Promise<Fixture> {
	const created = new Fixture();
	fixtures.push(created);
	fs.mkdirSync(created.cwd, { recursive: true });
	previousAgentDir ??= getAgentDir();
	setAgentDir(created.temp.join("agent"));
	return created;
}

afterEach(async () => {
	if (previousAgentDir !== undefined) {
		setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
	}
	for (const created of fixtures.splice(0)) await created.dispose();
});

async function persistedSession(manager: SessionManager): Promise<string> {
	manager.appendMessage({ role: "user", content: "say hi", timestamp: 1 });
	manager.appendMessage(assistant);
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session");
	return sessionFile;
}

function placeholderSize(file: string): number | undefined {
	try {
		return fs.lstatSync(file).size;
	} catch {
		return undefined;
	}
}

describe("local placeholders for SQL-backed sessions", () => {
	it("creates an empty placeholder once the session row exists, and only then", async () => {
		const env = await fixture();
		const storage = await env.open();
		const manager = SessionManager.create(env.cwd, path.join(env.sessionsRoot, "-project-"), storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session path");

		manager.appendMessage({ role: "user", content: "say hi", timestamp: 1 });
		await manager.flush();
		expect(storage.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(sessionFile)).toBe(false);

		expect(await persistedSession(manager)).toBe(sessionFile);
		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(placeholderSize(sessionFile)).toBe(0);
		await manager.close();
		expect(placeholderSize(sessionFile)).toBe(0);
	});

	it("recreates the placeholder when an existing session is resumed", async () => {
		const env = await fixture();
		const storage = await env.open();
		const sessionDir = path.join(env.sessionsRoot, "-project-");
		const manager = SessionManager.create(env.cwd, sessionDir, storage);
		const sessionFile = await persistedSession(manager);
		await manager.close();
		fs.rmSync(sessionFile);

		const resumed = await SessionManager.open(sessionFile, sessionDir, storage, { throwIfMissing: true });
		expect(resumed.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);
		expect(placeholderSize(sessionFile)).toBe(0);
		await resumed.close();
	});

	it("removes the placeholder with the session and moves it with the session", async () => {
		const env = await fixture();
		const storage = await env.open();
		const manager = SessionManager.create(env.cwd, path.join(env.sessionsRoot, "-project-"), storage);
		const sessionFile = await persistedSession(manager);

		const nextCwd = env.temp.join("moved");
		fs.mkdirSync(nextCwd);
		const nextDir = path.join(env.sessionsRoot, "-moved-");
		await manager.moveTo(nextCwd, nextDir);
		await manager.flush();
		const movedFile = manager.getSessionFile();
		expect(movedFile).toBe(path.join(nextDir, path.basename(sessionFile)));
		expect(storage.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(storage.existsSync(movedFile!)).toBe(true);
		expect(placeholderSize(movedFile!)).toBe(0);
		await manager.close();

		await storage.deleteSessionWithArtifacts(movedFile!);
		expect(storage.existsSync(movedFile!)).toBe(false);
		expect(fs.existsSync(movedFile!)).toBe(false);
	});

	it("never removes a non-empty local file at a deleted session path", async () => {
		const env = await fixture();
		const storage = await env.open();
		const file = path.join(env.sessionsRoot, "-project-", "legacy.jsonl");
		storage.writeTextSync(file, '{"type":"session"}\n');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "transcript\n");
		await storage.unlink(file);
		expect(fs.readFileSync(file, "utf8")).toBe("transcript\n");
	});

	it("creates no placeholder for sessions that suppress the terminal breadcrumb", async () => {
		const env = await fixture();
		const storage = await env.open();
		const sessionDir = path.join(env.sessionsRoot, "-project-");
		const manager = await SessionManager.open(path.join(sessionDir, "subagent.jsonl"), sessionDir, storage, {
			initialCwd: env.cwd,
			suppressBreadcrumb: true,
		});
		const sessionFile = await persistedSession(manager);
		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(fs.existsSync(sessionFile)).toBe(false);
		await manager.close();
	});

	it("creates no placeholder outside SQL storage", async () => {
		const env = await fixture();
		const memory = SessionManager.create(
			env.cwd,
			path.join(env.sessionsRoot, "-memory-"),
			new MemorySessionStorage(),
		);
		const memoryFile = await persistedSession(memory);
		expect(fs.existsSync(memoryFile)).toBe(false);
		await memory.close();

		const file = SessionManager.create(env.cwd, path.join(env.sessionsRoot, "-file-"), new FileSessionStorage());
		const fileSession = await persistedSession(file);
		expect(fs.readFileSync(fileSession, "utf8")).toContain('"say hi"');
		await file.close();
	});

	it("backfills placeholders for main sessions only", async () => {
		const env = await fixture();
		const storage = await env.open();
		const otherRoot = env.temp.join("profiles", "work", "agent", "sessions");
		const main = path.join(env.sessionsRoot, "-project-", "2026_a.jsonl");
		const subagent = path.join(env.sessionsRoot, "-project-", "2026_a", "Task.jsonl");
		const other = path.join(otherRoot, "-other-", "2026_b.jsonl");
		const existing = path.join(env.sessionsRoot, "-project-", "2026_c.jsonl");
		for (const file of [main, subagent, other, existing]) storage.writeTextSync(file, '{"type":"session"}\n');
		fs.mkdirSync(path.dirname(existing), { recursive: true });
		fs.writeFileSync(existing, "");

		const dryRun = backfillSessionPlaceholders(storage, [env.sessionsRoot, otherRoot], { dryRun: true });
		expect(dryRun.sessions).toBe(3);
		expect(dryRun.created.sort()).toEqual([main, other].sort());
		expect(fs.existsSync(main)).toBe(false);

		const result = backfillSessionPlaceholders(storage, [env.sessionsRoot, otherRoot]);
		expect(result.created.sort()).toEqual([main, other].sort());
		expect(placeholderSize(main)).toBe(0);
		expect(placeholderSize(other)).toBe(0);
		expect(fs.existsSync(subagent)).toBe(false);
	});

	it("file-mode listing skips placeholders pulled from another machine", async () => {
		const env = await fixture();
		const storage = new FileSessionStorage();
		const sessionDir = path.join(env.sessionsRoot, "-project-");
		const manager = SessionManager.create(env.cwd, sessionDir, storage);
		const real = await persistedSession(manager);
		await manager.close();
		const placeholder = path.join(sessionDir, "2099-01-01T00-00-00-000Z_placeholder.jsonl");
		fs.writeFileSync(placeholder, "");

		expect((await listSessions(sessionDir, storage)).map(session => session.path)).toEqual([real]);
		expect((await listAllSessions(storage, env.sessionsRoot)).map(session => session.path)).toEqual([real]);
		expect(await findMostRecentSession(sessionDir, storage)).toBe(real);
		expect(fs.existsSync(placeholder)).toBe(true);
	});
});
