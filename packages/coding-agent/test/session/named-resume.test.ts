import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import {
	FileSessionStorage,
	getDefaultSessionStorage,
	setDefaultSessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { __resetDirsFromEnvForTests, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const PROFILE_ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_PROFILE", "OMP_PROFILE"] as const;
const stubSettings = { get: () => undefined } as unknown as Settings;

for (const backend of ["file", "sql"] as const) {
	describe(`named resume (${backend})`, () => {
		let root: string;
		let sessionsRoot: string;
		let cwd: string;
		let client: SQL | undefined;
		let originalStorage: SessionStorage;
		let originalEnv: Array<string | undefined>;

		beforeEach(async () => {
			originalEnv = PROFILE_ENV_KEYS.map(key => process.env[key]);
			originalStorage = getDefaultSessionStorage();
			root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-named-resume-"));
			setAgentDir(path.join(root, "active-profile", "agent"));
			sessionsRoot = getSessionsDir();
			cwd = path.join(root, "current-project");
			await fs.mkdir(cwd, { recursive: true });
			if (backend === "sql") {
				client = new SQL("sqlite::memory:");
				await SqlSessionStorage.create({ client });
			}
		});

		afterEach(async () => {
			setDefaultSessionStorage(originalStorage);
			for (const [index, key] of PROFILE_ENV_KEYS.entries()) {
				const value = originalEnv[index];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			await client?.end();
			client = undefined;
			await fs.rm(root, { recursive: true, force: true });
		});

		async function writeSession(
			id: string,
			title: string | undefined,
			modified: number,
			dir = path.join(sessionsRoot, "other-project"),
		): Promise<string> {
			const sessionPath = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			const titleSlot =
				backend === "sql"
					? serializeTitleSlot({
							title: "stale header title",
							source: "user",
							updatedAt: "2026-01-01T00:00:00.000Z",
						})
					: "";
			const content = `${titleSlot}${JSON.stringify({
				type: "session",
				id,
				title: backend === "sql" ? "stale header title" : title,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			})}\n`;
			if (client) {
				await client.unsafe(
					"INSERT INTO omp_session_files (path, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?)",
					[sessionPath, content, modified, title ?? null, "user", "2026-01-01T00:00:00.000Z"],
				);
			} else {
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(sessionPath, content);
				await fs.utimes(sessionPath, new Date(modified), new Date(modified));
			}
			return sessionPath;
		}

		async function storage(): Promise<SessionStorage> {
			return client ? await SqlSessionStorage.create({ client }) : new FileSessionStorage();
		}

		async function resolve(arg: string, sessionDir?: string, allowGlobalFallback = false) {
			return resolveResumableSession(arg, cwd, sessionDir, await storage(), { allowGlobalFallback });
		}

		it("resolves SQL semantic titles and file titles across cwd buckets, case-insensitively", async () => {
			const sessionPath = await writeSession("aws-session", "AWS", 1000);
			const match = await resolve("aWs");
			expect(match?.session.path).toBe(sessionPath);
			expect(match?.session.title).toBe("AWS");
			expect(match?.scope).toBe("global");
			if (client) expect(await Bun.file(sessionPath).exists()).toBe(false);
		});

		it("reports local scope for a title in the default cwd bucket", async () => {
			const localDir = computeDefaultSessionDir(cwd, await storage());
			const sessionPath = await writeSession("local-session", "Local AWS", 1000, localDir);
			const match = await resolve("local aws");
			expect(match?.scope).toBe("local");
			expect(match?.session.path).toBe(sessionPath);
		});

		it("preserves full IDs, ID prefixes and legacy filename selectors", async () => {
			const id = "019ed676-02fb-7000-8dac-396e2f84d484";
			const sessionPath = await writeSession(id, "AWS", 1000);
			for (const arg of [id, "019ED676", "2026-01-01T00-00"]) {
				expect((await resolve(arg))?.session.path).toBe(sessionPath);
			}
		});

		it("prioritizes global ID matches over a newer local exact title", async () => {
			const localDir = path.join(root, "custom");
			await writeSession("local", "aws", 9000, localDir);
			const sessionPath = await writeSession("aws-id", "Unrelated", 1000);
			expect((await resolve("aws", localDir, true))?.session.path).toBe(sessionPath);
		});

		it("retains local-first ID prefix semantics", async () => {
			const localDir = path.join(root, "custom");
			const localPath = await writeSession("aws-local", "Older", 1000, localDir);
			await writeSession("aws-global", "Newer", 9000);
			expect((await resolve("aws", localDir, true))?.session.path).toBe(localPath);
		});

		it("chooses the latest exact title across buckets before any substring", async () => {
			const localDir = path.join(root, "custom");
			await writeSession("local-exact", "AWS", 1000, localDir);
			await writeSession("partial", "AWS deployment", 9000);
			const latestExact = await writeSession("global-exact", "aws", 3000);
			expect((await resolve("AWS", localDir, true))?.session.path).toBe(latestExact);
		});

		it("chooses the latest substring title and deterministically breaks timestamp ties", async () => {
			const localDir = path.join(root, "custom");
			await writeSession("local", "Old AWS work", 1000, localDir);
			await writeSession("a", "AWS deployment", 3000);
			const latest = await writeSession("z", "New AWS work", 3000);
			expect((await resolve("aws", localDir, true))?.session.path).toBe(latest);
		});

		it("keeps an explicit session directory scoped for title and ID lookup", async () => {
			const localDir = path.join(root, "custom");
			const globalPath = await writeSession("global-id", "AWS", 9000);
			expect(await resolve("AWS", localDir)).toBeUndefined();
			expect(await resolve("global-id", localDir)).toBeUndefined();
			const localPath = await writeSession("local-id", "AWS", 1000, localDir);
			expect((await resolve("aws", localDir))?.session.path).toBe(localPath);
			expect((await resolve("aws", localDir, true))?.session.path).toBe(globalPath);
		});

		it("does not leak another profile's buckets even when sharing a SQL table", async () => {
			setAgentDir(path.join(root, "other-profile", "agent"));
			await writeSession("foreign-id", "Foreign title", 9000, path.join(getSessionsDir(), "project"));
			await writeSession("foreign-aws", "AWS", 9000, path.join(getSessionsDir(), "project"));
			setAgentDir(path.join(root, "active-profile", "agent"));
			const activePath = await writeSession("active-id", "AWS", 1000);
			expect((await resolve("aws"))?.session.path).toBe(activePath);
			expect(await resolve("foreign-id")).toBeUndefined();
			expect(await resolve("Foreign title")).toBeUndefined();
			expect(await resolve("unknown")).toBeUndefined();
		});

		it("opens a title-selected session through the CLI consumer without changing stored content", async () => {
			const sessionPath = await writeSession("cli-session", "AWS", 1000);
			const backing = await storage();
			setDefaultSessionStorage(backing);
			const before = await backing.readText(sessionPath);
			const args = parseArgs(["-r", "aWs"]);
			const manager = await createSessionManager(args, cwd, stubSettings);
			expect(manager?.getSessionId()).toBe("cli-session");
			expect(manager?.getSessionFile()).toBe(sessionPath);
			expect(manager?.getSessionName()).toBe("AWS");
			expect(await backing.readText(sessionPath)).toBe(before);
			await manager?.close();
			await expect(createSessionManager({ ...args, resume: "unknown" }, cwd, stubSettings)).rejects.toBeInstanceOf(
				SessionResolutionError,
			);
		});
	});
}
