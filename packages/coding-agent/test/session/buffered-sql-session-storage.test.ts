import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { BufferedSqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/buffered-sql-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const TABLE = "omp_session_files";
const SESSION = "/sessions/project/main.jsonl";
const BUFFER_MODULE = path.join(import.meta.dir, "../../src/session/buffered-sql-session-storage.ts");

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

function appendSync(writer: SessionStorageWriter, line: string): void {
	if (!writer.appendSync) throw new Error("Buffered storage must support synchronous durable appends");
	writer.appendSync(line);
}

/** Fault injection wraps real file-backed Bun.SQL; SQL and transaction outcomes are never mocked. */
class Remote {
	readonly temp = TempDir.createSync("@omp-buffered-sql-");
	readonly remotePath = this.temp.join("remote.sqlite");
	readonly cachePath = this.temp.join("cache.sqlite");
	readonly admin = new SQL(`sqlite://${this.remotePath}`);
	readonly storages: BufferedSqlSessionStorage[] = [];
	readonly clients: InstanceType<typeof SQL>[] = [];
	readonly errors: Error[] = [];
	online = true;
	clientsCreated = 0;
	loseNextCommitAck = false;
	beforeTransaction: (() => Promise<void>) | undefined;
	afterRead: ((query: string, values?: unknown[]) => Promise<void>) | undefined;

	async initialize(): Promise<void> {
		await SqlSessionStorage.create({ client: this.admin });
	}

	createClient = (): SqlSessionStorageClient => {
		this.clientsCreated++;
		const client = new SQL(`sqlite://${this.remotePath}`);
		this.clients.push(client);
		let stale = false;
		const checkConnection = () => {
			if (!this.online) stale = true;
			if (stale) throw new Error("Connection closed");
		};
		return {
			options: { adapter: "sqlite" },
			unsafe: async (query, values) => {
				checkConnection();
				const rows = await client.unsafe(query, values);
				if (/^\s*SELECT\b/i.test(query)) await this.afterRead?.(query, values);
				return rows;
			},
			transaction: async callback => {
				checkConnection();
				await this.beforeTransaction?.();
				await client.transaction(async transaction => {
					await callback({
						unsafe: async (query, values) => {
							checkConnection();
							return transaction.unsafe(query, values);
						},
					});
				});
				// The real SQL transaction has committed before this transport failure.
				if (this.loseNextCommitAck) {
					this.loseNextCommitAck = false;
					stale = true;
					throw new Error("Connection closed after COMMIT");
				}
			},
			end: () => client.end(),
		};
	};

	async open(cachePath = this.cachePath): Promise<BufferedSqlSessionStorage> {
		const storage = await BufferedSqlSessionStorage.create({
			cachePath,
			createClient: this.createClient,
			syncIntervalMs: 0,
			onSyncError: error => this.errors.push(error),
		});
		this.storages.push(storage);
		return storage;
	}

	async seed(sessionPath: string, content: string, mtime = 100): Promise<void> {
		await this.admin.unsafe(`INSERT INTO ${TABLE} (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			sessionPath,
			content,
			mtime,
		]);
	}

	async rows(): Promise<Array<{ path: string; content: string; mtime_ms: number }>> {
		return this.admin.unsafe(`SELECT path, content, mtime_ms FROM ${TABLE} ORDER BY path`);
	}

	async content(sessionPath = SESSION): Promise<string | null> {
		const rows = await this.admin.unsafe(`SELECT content FROM ${TABLE} WHERE path = ?`, [sessionPath]);
		return rows[0]?.content ?? null;
	}

	async dispose(): Promise<void> {
		for (const storage of this.storages) await storage.close();
		for (const client of this.clients) await client.end();
		await this.admin.end();
		await this.temp.remove();
	}
}

const remotes: Remote[] = [];
let previousAgentDir: string | undefined;
async function fixture(): Promise<Remote> {
	const remote = new Remote();
	remotes.push(remote);
	await remote.initialize();
	return remote;
}

afterEach(async () => {
	if (previousAgentDir !== undefined) {
		setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
	}
	for (const remote of remotes.splice(0)) await remote.dispose();
});

describe("BufferedSqlSessionStorage durable SQLite cache/outbox", () => {
	it("drains an independent pending writer before reporting another writer's failed hydration", async () => {
		const remote = await fixture();
		const failedPath = "/sessions/project/failed.jsonl";
		const pendingPath = "/sessions/project/pending.jsonl";
		await remote.seed(failedPath, "failed header\n");
		await remote.seed(pendingPath, "pending header\n");
		const storage = await remote.open();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		remote.afterRead = async (_query, values) => {
			if (values?.includes(failedPath)) {
				await entered.promise;
				throw new Error("Transcript hydration unavailable");
			}
			if (values?.includes(pendingPath)) {
				entered.resolve();
				await release.promise;
			}
		};
		const failedWriter = storage.openWriter(failedPath);
		const pendingWriter = storage.openWriter(pendingPath);
		const failedAppend = failedWriter.append("failed turn\n");
		const pendingAppend = pendingWriter.append("pending turn\n");
		await expect(failedAppend).rejects.toThrow("Transcript hydration unavailable");
		let settled = false;
		const draining = storage.drain().catch(error => {
			settled = true;
			return error;
		});
		await scheduler.yield();
		expect(settled).toBe(false);
		release.resolve();
		await pendingAppend;
		expect(await draining).toBeInstanceOf(Error);
		expect(storage.readTextSync(pendingPath)).toBe("pending header\npending turn\n");
		await expect(failedWriter.close()).rejects.toThrow("Transcript hydration unavailable");
		await pendingWriter.close();
		await storage.sync();
		expect(await remote.content(pendingPath)).toBe("pending header\npending turn\n");
	});

	it("reports SQLite sync failures, rejects non-durable writes, and recovers after repair", async () => {
		const remote = await fixture();
		const recoveredPath = "/sessions/project/recovered.jsonl";
		const source = `
			import { Database } from "bun:sqlite";
			import { SQL } from "bun";
			import { BufferedSqlSessionStorage } from ${JSON.stringify(BUFFER_MODULE)};
			const cachePath = ${JSON.stringify(remote.cachePath)};
			const originalExec = Database.prototype.exec;
			let cache;
			Database.prototype.exec = function(...args) {
				if (this.filename === cachePath) cache = this;
				return originalExec.apply(this, args);
			};
			let reportedError;
			let storage;
			try {
				storage = await BufferedSqlSessionStorage.create({
					cachePath, syncIntervalMs: 0,
					createClient: () => new SQL(${JSON.stringify(`sqlite://${remote.remotePath}`)}),
					onSyncError: error => { reportedError = error; }
				});
			} finally {
				Database.prototype.exec = originalExec;
			}
			if (!cache) throw new Error("Native cache database was not captured");
			cache.exec("PRAGMA query_only=ON");
			let error;
			try { await storage.sync(); } catch (failure) { error = failure; }
			if (!error) throw new Error("Read-only SQLite unexpectedly accepted synchronization");
			const failedStatus = storage.getSyncStatus();
			let rejected = false;
			try { storage.writeTextSync(${JSON.stringify(recoveredPath)}, "not durable\\n"); }
			catch { rejected = true; }
			const presentAfterFailure = storage.existsSync(${JSON.stringify(recoveredPath)});
			cache.exec("PRAGMA query_only=OFF");
			await storage.sync();
			storage.writeTextSync(${JSON.stringify(recoveredPath)}, "resumed\\n");
			await storage.sync();
			const recoveredStatus = storage.getSyncStatus();
			await storage.close();
			console.log(JSON.stringify({
				error: error.message, reported: reportedError?.message ?? null,
				failedStatus, rejected, presentAfterFailure, recoveredStatus
			}));
		`;
		const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const result = JSON.parse(stdout);
		expect(result.reported).toBe(result.error);
		expect(result.failedStatus.lastError).toBe(result.error);
		expect(result.rejected).toBe(true);
		expect(result.presentAfterFailure).toBe(false);
		expect(result.recoveredStatus.lastError).toBeNull();
		expect(result.recoveredStatus.pendingOperations).toBe(0);
		expect(await remote.content(recoveredPath)).toBe("resumed\n");
	}, 15_000);

	it("continues cached writes and resume while disconnected, without requiring remote durability in drain", async () => {
		const remote = await fixture();
		await remote.seed(SESSION, "header\n");
		const storage = await remote.open();
		expect(await storage.readText(SESSION)).toBe("header\n");
		remote.online = false;
		const writer = storage.openWriter(SESSION);
		appendSync(writer, "first\n");
		await writer.append("second\n");
		await writer.flush();
		await storage.drain();
		expect(await storage.readText(SESSION)).toBe("header\nfirst\nsecond\n");
		expect(await remote.content()).toBe("header\n");
		await expect(storage.sync()).rejects.toThrow("Connection closed");
		const pending = storage.getSyncStatus().pendingOperations;
		expect(pending).toBeGreaterThan(0);
		expect(storage.getSyncStatus().lastError).toContain("Connection closed");
		expect(remote.errors.some(error => error.message.includes("Connection closed"))).toBe(true);
		await writer.close();
		await storage.close();

		const resumed = await remote.open();
		expect(await resumed.readText(SESSION)).toBe("header\nfirst\nsecond\n");
		expect(resumed.getSyncStatus().pendingOperations).toBe(pending);
		await resumed.drain();
		expect(await remote.content()).toBe("header\n");
	});

	it("restarts with queued append order intact and recreates stale clients to replay into SQL", async () => {
		const remote = await fixture();
		const storage = await remote.open();
		remote.online = false;
		storage.writeTextSync(SESSION, "base\n", { expectedSize: null });
		const writer = storage.openWriter(SESSION);
		appendSync(writer, "one\n");
		appendSync(writer, "two\n");
		appendSync(writer, "three\n");
		await expect(storage.sync()).rejects.toThrow("Connection closed");
		await writer.close();
		await storage.close();

		const restarted = await remote.open();
		expect(await restarted.readText(SESSION)).toBe("base\none\ntwo\nthree\n");
		const generationsBeforeReconnect = remote.clientsCreated;
		remote.online = true;
		await restarted.sync();
		expect(remote.clientsCreated).toBeGreaterThan(generationsBeforeReconnect);
		expect(await remote.content()).toBe("base\none\ntwo\nthree\n");
		expect(restarted.getSyncStatus()).toMatchObject({ pendingOperations: 0, conflictCount: 0, lastError: null });
		expect(restarted.getSyncStatus().lastSyncAt).not.toBeNull();
		await restarted.sync();
		expect(await remote.content()).toBe("base\none\ntwo\nthree\n");
	});

	it("replays an append committed before its acknowledgement was lost exactly once, even after restart", async () => {
		const remote = await fixture();
		await remote.seed(SESSION, "base\n");
		const storage = await remote.open();
		await storage.readText(SESSION);
		const writer = storage.openWriter(SESSION);
		appendSync(writer, "once\n");
		remote.loseNextCommitAck = true;
		await expect(storage.sync()).rejects.toThrow("after COMMIT");
		expect(await remote.content()).toBe("base\nonce\n");
		expect(storage.getSyncStatus().pendingOperations).toBeGreaterThan(0);
		appendSync(writer, "next\n");
		await writer.close();
		await storage.close();

		const restarted = await remote.open();
		expect(await restarted.readText(SESSION)).toBe("base\nonce\nnext\n");
		await restarted.sync();
		await restarted.sync();
		expect(await remote.content()).toBe("base\nonce\nnext\n");
		expect(restarted.getSyncStatus().pendingOperations).toBe(0);
	});

	for (const operation of ["rename", "unlink"] as const) {
		it(`does not repeat an acknowledged-lost ${operation} against a newly recreated source`, async () => {
			const remote = await fixture();
			await remote.seed(SESSION, "original\n");
			const storage = await remote.open();
			await storage.readText(SESSION);
			const destination = "/sessions/project/moved.jsonl";
			if (operation === "rename") await storage.rename(SESSION, destination);
			else await storage.unlink(SESSION);
			remote.loseNextCommitAck = true;
			await expect(storage.sync()).rejects.toThrow("after COMMIT");
			expect(await remote.content()).toBeNull();
			if (operation === "rename") expect(await remote.content(destination)).toBe("original\n");
			expect(storage.getSyncStatus().pendingOperations).toBeGreaterThan(0);
			await storage.close();

			// Another machine reuses the source path after the first operation really committed.
			await remote.seed(SESSION, "new peer session\n", 200);
			const restarted = await remote.open();
			await restarted.sync();
			expect(await remote.content()).toBe("new peer session\n");
			if (operation === "rename") expect(await remote.content(destination)).toBe("original\n");
			expect(restarted.getSyncStatus()).toMatchObject({ pendingOperations: 0, conflictCount: 0 });
		});
	}

	for (const externalContent of ["peer changed length\n", "peer\n"]) {
		it(`preserves remote CAS conflicts (${externalContent === "peer\n" ? "same byte size, newer mtime" : "changed size"}) and still syncs unrelated paths`, async () => {
			const remote = await fixture();
			await remote.seed(SESSION, "base\n", 100);
			const storage = await remote.open();
			await storage.readText(SESSION);
			const writer = storage.openWriter(SESSION);
			appendSync(writer, "local\n");
			await remote.admin.unsafe(`UPDATE ${TABLE} SET content = ?, mtime_ms = ? WHERE path = ?`, [
				externalContent,
				101,
				SESSION,
			]);
			storage.writeTextSync("/sessions/project/unrelated.jsonl", "unrelated\n");

			await expect(storage.sync()).rejects.toThrow();
			expect(await remote.content()).toBe(externalContent);
			expect(await remote.content("/sessions/project/unrelated.jsonl")).toBe("unrelated\n");
			expect(await storage.readText(SESSION)).toBe("base\nlocal\n");
			expect(storage.getSyncStatus().conflictCount).toBeGreaterThan(0);
			const pending = storage.getSyncStatus().pendingOperations;
			expect(pending).toBeGreaterThan(0);
			await expect(storage.sync()).rejects.toThrow();
			expect(storage.getSyncStatus().pendingOperations).toBe(pending);
			await writer.close();
			await storage.close();

			const restarted = await remote.open();
			expect(await restarted.readText(SESSION)).toBe("base\nlocal\n");
			expect(restarted.getSyncStatus().conflictCount).toBeGreaterThan(0);
			await expect(restarted.sync()).rejects.toThrow();
			expect(await remote.content()).toBe(externalContent);
		});
	}

	for (const peerEdit of ["rewrite", "delete"] as const) {
		it(`retains an active clean writer's baseline across a peer ${peerEdit} and catalog refresh`, async () => {
			const remote = await fixture();
			await remote.seed(SESSION, "base\n", 100);
			const storage = await remote.open();
			await storage.readText(SESSION);
			const writer = storage.openWriter(SESSION);
			const baseline = storage.statSync(SESSION);
			if (peerEdit === "rewrite") {
				await remote.admin.unsafe(`UPDATE ${TABLE} SET content = ?, mtime_ms = ? WHERE path = ?`, [
					"peer\n",
					101,
					SESSION,
				]);
			} else {
				await remote.admin.unsafe(`DELETE FROM ${TABLE} WHERE path = ?`, [SESSION]);
			}

			await storage.sync();
			expect(storage.getSyncStatus().pendingOperations).toBe(0);
			expect(storage.existsSync(SESSION)).toBe(true);
			expect(storage.statSync(SESSION)).toEqual(baseline);
			expect(await storage.readText(SESSION)).toBe("base\n");
			appendSync(writer, "local after refresh\n");
			await expect(storage.sync()).rejects.toThrow();
			expect(await remote.content()).toBe(peerEdit === "rewrite" ? "peer\n" : null);
			expect(await storage.readText(SESSION)).toBe("base\nlocal after refresh\n");
			expect(storage.getSyncStatus().conflictCount).toBeGreaterThan(0);
			await writer.close();
		});
	}

	it("loads a cold remote catalog, hydrates bodies durably, and rejects offline misses rather than inventing empty files", async () => {
		const remote = await fixture();
		await remote.seed(SESSION, "remote transcript\n");
		const unhydrated = "/sessions/project/unhydrated.jsonl";
		await remote.seed(unhydrated, "not loaded\n");
		const storage = await remote.open();
		expect(storage.listFilesSync("/sessions/project", "*.jsonl").sort()).toEqual([SESSION, unhydrated]);
		expect(storage.statSync(SESSION).size).toBe(Buffer.byteLength("remote transcript\n"));
		expect(await storage.readText(SESSION)).toBe("remote transcript\n");
		remote.online = false;
		await expect(storage.readText(unhydrated)).rejects.toThrow("Connection closed");
		await expect(storage.readText("/sessions/project/missing.jsonl")).rejects.toThrow();
		await storage.close();

		const restarted = await remote.open();
		expect(restarted.existsSync(SESSION)).toBe(true);
		expect(await restarted.readText(SESSION)).toBe("remote transcript\n");
		await expect(restarted.readText(unhydrated)).rejects.toThrow();
		expect(restarted.getSyncStatus().pendingOperations).toBe(0);
	});

	it("starts with a usable durable cache when the initial remote factory fails", async () => {
		const remote = await fixture();
		const errors: Error[] = [];
		const storage = await BufferedSqlSessionStorage.create({
			cachePath: remote.cachePath,
			createClient: () => {
				throw new Error("Remote unavailable at startup");
			},
			syncIntervalMs: 0,
			onSyncError: error => errors.push(error),
		});
		remote.storages.push(storage);
		storage.writeTextSync(SESSION, "offline first session\n");
		await storage.drain();
		expect(await storage.readText(SESSION)).toBe("offline first session\n");
		expect(storage.getSyncStatus().lastError).toContain("Remote unavailable");
		expect(errors).toHaveLength(1);
		await storage.close();
		const restarted = await remote.open();
		expect(await restarted.readText(SESSION)).toBe("offline first session\n");
		await restarted.sync();
		expect(await remote.content()).toBe("offline first session\n");
	});

	it("fails closed when SQLite cannot open, rather than accepting writes into another storage backend", async () => {
		const remote = await fixture();
		await expect(remote.open(remote.temp.path())).rejects.toThrow();
		expect(await remote.rows()).toEqual([]);
	});

	it("rejects local expectedSize and abandons a failed commitGuard without changing cache or outbox", async () => {
		const remote = await fixture();
		const storage = await remote.open();
		storage.writeTextSync(SESSION, "keep\n");
		await storage.sync();
		const stat = storage.statSync(SESSION);
		const pending = storage.getSyncStatus().pendingOperations;
		remote.online = false;
		let checks = 0;
		await storage.writeTextAtomic(SESSION, "discard\n", {
			expectedSize: stat.size,
			commitGuard: () => {
				checks++;
				return false;
			},
		});
		expect(checks).toBeGreaterThan(0);
		expect(() => storage.writeTextSync(SESSION, "wrong size\n", { expectedSize: stat.size + 1 })).toThrow(
			SessionWriteConflictError,
		);
		await expect(storage.writeTextAtomic(SESSION, "also wrong\n", { expectedSize: null })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		expect(await storage.readText(SESSION)).toBe("keep\n");
		expect(storage.statSync(SESSION)).toEqual(stat);
		expect(storage.getSyncStatus().pendingOperations).toBe(pending);
		await storage.close();
		const restarted = await remote.open();
		expect(await restarted.readText(SESSION)).toBe("keep\n");
		expect(restarted.getSyncStatus().pendingOperations).toBe(pending);
	});

	it("preserves a local append made while an older remote catalog fetch is in flight", async () => {
		const remote = await fixture();
		await remote.seed(SESSION, "base\n");
		const storage = await remote.open();
		await storage.readText(SESSION);
		const fetched = deferred();
		const release = deferred();
		remote.afterRead = async query => {
			if (!query.includes(TABLE)) return;
			remote.afterRead = undefined;
			fetched.resolve();
			await release.promise;
		};
		const syncing = storage.sync();
		try {
			await fetched.promise;
			const writer = storage.openWriter(SESSION);
			appendSync(writer, "during refresh\n");
			await writer.close();
		} finally {
			release.resolve();
		}
		await syncing;
		expect(await storage.readText(SESSION)).toBe("base\nduring refresh\n");
		await storage.sync();
		expect(await remote.content()).toBe("base\nduring refresh\n");
	});

	it("shares cache state across instances and refuses a stale local rewrite", async () => {
		const remote = await fixture();
		const first = await remote.open();
		const second = await remote.open();
		first.writeTextSync(SESSION, "base\n");
		expect(await second.readText(SESSION)).toBe("base\n");
		const before = second.statSync(SESSION).size;
		const writer = first.openWriter(SESSION);
		appendSync(writer, "first instance\n");
		await expect(second.writeTextAtomic(SESSION, "stale\n", { expectedSize: before })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		expect(await second.readText(SESSION)).toBe("base\nfirst instance\n");
		const otherWriter = second.openWriter(SESSION);
		appendSync(otherWriter, "second instance\n");
		await writer.close();
		await otherWriter.close();
		await second.sync();
		expect(await remote.content()).toBe("base\nfirst instance\nsecond instance\n");
		expect(first.getSyncStatus().pendingOperations).toBe(0);
	});

	it("serializes replay leaders across competing cache instances without duplicating appends", async () => {
		const remote = await fixture();
		const first = await remote.open();
		const second = await remote.open();
		first.writeTextSync(SESSION, "base\n");
		const writer = first.openWriter(SESSION);
		appendSync(writer, "once\n");
		await writer.close();
		const entered = deferred();
		const release = deferred();
		let active = 0;
		let maximumActive = 0;
		remote.beforeTransaction = async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			entered.resolve();
			await release.promise;
			active--;
		};
		const firstSync = first.sync();
		let secondSync: Promise<void> | undefined;
		try {
			await entered.promise;
			secondSync = second.sync();
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			release.resolve();
		}
		await Promise.allSettled([firstSync, secondSync]);
		remote.beforeTransaction = undefined;
		await second.sync();
		expect(maximumActive).toBe(1);
		expect(await remote.content()).toBe("base\nonce\n");
		expect(second.getSyncStatus().pendingOperations).toBe(0);
	});

	it("does not grant another process the active local session claim, and releases ownership for its next writer", async () => {
		const remote = await fixture();
		const storage = await remote.open();
		storage.writeTextSync(SESSION, "owner\n");
		const release = storage.claimSessionFile?.(SESSION);
		if (!release) throw new Error("Expected an ownership claim");
		const script = remote.temp.join("claim-peer.ts");
		await Bun.write(
			script,
			[
				`import { BufferedSqlSessionStorage } from ${JSON.stringify(BUFFER_MODULE)};`,
				"const storage = await BufferedSqlSessionStorage.create({ cachePath: process.argv[2], syncIntervalMs: 0, createClient: () => { throw new Error('offline'); } });",
				"const release = storage.claimSessionFile(process.argv[3]);",
				"if (release) { const writer = storage.openWriter(process.argv[3]); writer.appendSync('peer\\n'); await writer.close(); release(); }",
				"console.log(JSON.stringify({ acquired: release !== null, content: await storage.readText(process.argv[3]) }));",
				"await storage.close();",
			].join("\n"),
		);
		const runPeer = async () => {
			const child = Bun.spawn([process.execPath, script, remote.cachePath, SESSION], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [output, error, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (exitCode !== 0) throw new Error(`Claim peer failed (${exitCode}): ${error}`);
			return JSON.parse(output) as { acquired: boolean; content: string };
		};
		try {
			expect(await runPeer()).toEqual({ acquired: false, content: "owner\n" });
		} finally {
			release();
		}
		expect(await runPeer()).toEqual({ acquired: true, content: "owner\npeer\n" });
		expect(await storage.readText(SESSION)).toBe("owner\npeer\n");
		await storage.sync();
		expect(await remote.content()).toBe("owner\npeer\n");
	});

	it("retains UTF-8 byte slices and title changes across offline restart and rename replay", async () => {
		const remote = await fixture();
		const storage = await remote.open();
		const title = { title: "Old", source: "auto" as const, updatedAt: "t1" };
		const content = `${serializeTitleSlot(title)}αβ🙂tail\n`;
		storage.writeTextSync(SESSION, content);
		await storage.sync();
		remote.online = false;
		await storage.updateSessionTitle(SESSION, { title: "Offline title", source: "user", updatedAt: "t2" });
		const renamed = "/sessions/project/renamed.jsonl";
		await storage.rename(SESSION, renamed);
		expect(storage.existsSync(SESSION)).toBe(false);
		expect((await storage.readTextSlices(renamed, 0, 5))[1]).toBe("tail\n");
		expect(JSON.parse((await storage.readTextSlices(renamed, 256, 0))[0].split("\n")[0])).toMatchObject({
			title: "Offline title",
			source: "user",
		});
		const preserved = await storage.readText(renamed);
		expect(storage.statSync(renamed).size).toBe(Buffer.byteLength(preserved));
		await storage.close();
		const restarted = await remote.open();
		expect(restarted.existsSync(SESSION)).toBe(false);
		expect(await restarted.readText(renamed)).toBe(preserved);
		remote.online = true;
		await restarted.sync();
		expect(await remote.content(SESSION)).toBeNull();
		const cold = await remote.open(remote.temp.join("cold.sqlite"));
		expect(await cold.readText(renamed)).toBe(preserved);
	});

	it("keeps offline delete tombstones across catalog refresh and removes artifacts without touching siblings", async () => {
		const remote = await fixture();
		const artifact = "/sessions/project/main/nested/draft.txt";
		const sibling = "/sessions/project/main-other.jsonl";
		await remote.seed(SESSION, "delete me\n");
		await remote.seed(artifact, "draft");
		await remote.seed(sibling, "keep\n");
		const storage = await remote.open();
		remote.online = false;
		await storage.deleteSessionWithArtifacts(SESSION);
		expect(storage.existsSync(SESSION)).toBe(false);
		expect(storage.existsSync(artifact)).toBe(false);
		await expect(storage.sync()).rejects.toThrow("Connection closed");
		await storage.close();
		const restarted = await remote.open();
		expect(restarted.existsSync(SESSION)).toBe(false);
		expect(restarted.existsSync(artifact)).toBe(false);
		remote.online = true;
		await restarted.sync();
		expect((await remote.rows()).map(row => row.path)).toEqual([sibling]);
		expect(await restarted.readText(sibling)).toBe("keep\n");
		await restarted.unlink(sibling);
		await restarted.sync();
		expect(await remote.rows()).toEqual([]);
	});

	it("SessionManager resumes locally durable assistant history and appends during a remote outage", async () => {
		const remote = await fixture();
		remote.online = false;
		const storage = await remote.open();
		previousAgentDir = getAgentDir();
		setAgentDir(remote.temp.join("agent"));
		const sessionDir = remote.temp.join("sessions");
		const manager = await SessionManager.open(remote.temp.join("sessions", "lifecycle.jsonl"), sessionDir, storage, {
			initialCwd: remote.temp.path(),
			suppressBreadcrumb: true,
		});
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		await manager.ensureOnDisk();
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "durable answer" }],
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
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await manager.close();
		await storage.close();
		const restarted = await remote.open();
		const resumed = await SessionManager.open(sessionFile, sessionDir, restarted, { suppressBreadcrumb: true });
		expect(
			resumed
				.getEntries()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message),
		).toMatchObject([
			{ role: "user", content: "before" },
			{ role: "assistant", content: [{ type: "text", text: "durable answer" }] },
		]);
		resumed.appendMessage({ role: "user", content: "after restart", timestamp: 3 });
		await resumed.close();
		remote.online = true;
		await restarted.sync();
		const durable = await remote.content(sessionFile);
		expect(durable).toContain("durable answer");
		expect(durable).toContain("after restart");
		expect(restarted.getSyncStatus().pendingOperations).toBe(0);
	});
});
