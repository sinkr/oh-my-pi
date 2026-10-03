import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileLock, tryAcquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { isAssistantMessageLine } from "./session-entries";
import type {
	SessionStorage,
	SessionStorageStat,
	SessionStorageWriteOptions,
	SessionStorageWriter,
	WriteTextAtomicOptions,
} from "./session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { enoent } from "./session-storage-errors";
import {
	overlayTitleSlotContent,
	parseTitleSlotFromContent,
	serializeTitleSlot,
	titleUpdateFromSlot,
} from "./session-title-slot";
import type { SessionTitleUpdate } from "./session-title-slot";
import { SqlSessionStorage } from "./sql-session-storage";
import type { SqlSessionStorageClient, SqlSessionStorageTransaction } from "./sql-session-storage";

export interface BufferedSqlSessionStorageOptions {
	cachePath: string;
	createClient: () => SqlSessionStorageClient | Promise<SqlSessionStorageClient>;
	table?: string;
	syncIntervalMs?: number;
	onSyncError?: (error: Error) => void;
}

interface Token {
	size: number;
	mtime: number;
}
interface CacheFile {
	path: string;
	present: number;
	hydrated: number;
	base_size: number;
	size: number;
	mtime: number;
	revision: number;
	title: string | null;
	title_source: string | null;
	title_updated_at: string | null;
}
interface RemoteFile {
	path: string;
	byte_len: number | bigint | string;
	mtime_ms: number | bigint | string;
	content?: string;
	title: string | null;
	title_source: string | null;
	title_updated_at: string | null;
}
interface ExpectedFile {
	path: string;
	token: Token | null;
}
interface Operation {
	kind: "write" | "append" | "title" | "rename" | "delete";
	expected: ExpectedFile[];
	mtime: number;
	content?: string;
	title?: SessionTitleUpdate | null;
	destination?: string;
	prefix?: string;
}
interface OutboxRow {
	seq: number;
	id: string;
	payload: string;
}
interface Scope {
	paths: string[];
	prefix?: string;
}

class LocalCacheError extends Error {
	constructor(error: unknown) {
		super(`Session SQLite cache failure: ${toError(error).message}`, { cause: error });
		this.name = "LocalCacheError";
	}
}
class RemoteConflictError extends Error {
	constructor(file: string) {
		super(
			`Buffered session sync conflict at ${file}: remote size or modification time changed. Local work remains buffered.`,
		);
		this.name = "RemoteConflictError";
	}
}

const decoder = new TextDecoder("utf-8");
const ownership = new Map<string, { lock: FileLockHandle; holders: number }>();

function token(file: Pick<CacheFile, "present" | "size" | "mtime"> | undefined): Token | null {
	return file?.present ? { size: file.size, mtime: file.mtime } : null;
}
function sameToken(a: Token | null, b: Token | null): boolean {
	return a === null ? b === null : b !== null && a.size === b.size && a.mtime === b.mtime;
}
function remoteToken(file: RemoteFile | undefined): Token | null {
	return file ? { size: Number(file.byte_len), mtime: Number(file.mtime_ms) } : null;
}
function titleFor(file: CacheFile | RemoteFile): SessionTitleUpdate | undefined {
	if (!file.title_updated_at) return undefined;
	return {
		title: file.title ?? undefined,
		source: file.title_source === "auto" || file.title_source === "user" ? file.title_source : undefined,
		updatedAt: file.title_updated_at,
	};
}
function scopeFor(operation: Operation): Scope {
	return { paths: operation.expected.map(file => file.path), prefix: operation.prefix };
}
function contains(scope: Scope, file: string): boolean {
	return scope.paths.includes(file) || (scope.prefix !== undefined && file.startsWith(scope.prefix));
}
function overlaps(a: Scope, b: Scope): boolean {
	return (
		a.paths.some(file => contains(b, file)) ||
		b.paths.some(file => contains(a, file)) ||
		(a.prefix !== undefined &&
			b.prefix !== undefined &&
			(a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)))
	);
}
function byteLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function connectionFailure(error: Error): boolean {
	if (error instanceof AggregateError && error.errors.some(cause => connectionFailure(toError(cause)))) return true;
	return /connection.*(?:closed|terminated|lost|reset|refused)|closed.*connection|timeout|timed out|ECONN|EPIPE|ENET|EHOST|ENOTFOUND|EAI_AGAIN/i.test(
		error.message,
	);
}

/**
 * PostgreSQL is the shared catalog; SQLite is the synchronous durability boundary.
 * Each local change commits its cache mutation and ordered outbox delta together.
 * Replay holds a process-owned OS lock and commits a UUID receipt with the remote
 * mutation, so a lost COMMIT acknowledgement cannot publish an append twice.
 */
export class BufferedSqlSessionStorage implements SessionStorage {
	readonly defersSyncPublish = false;
	readonly #db: Database;
	readonly #cachePath: string;
	readonly #table: string;
	readonly #receipts: string;
	readonly #options: BufferedSqlSessionStorageOptions;
	readonly #writers = new Set<BufferedWriter>();
	readonly #claims = new Set<() => void>();
	readonly #reads = new Set<Promise<unknown>>();
	#client: SqlSessionStorageClient | undefined;
	#clientOpening: Promise<SqlSessionStorageClient> | undefined;
	#adapter: "postgres" | "sqlite" = "postgres";
	#timer: NodeJS.Timeout | undefined;
	#syncing: Promise<void> | undefined;
	#closing: Promise<void> | undefined;
	#closingRequested = false;
	#closed = false;
	#transactionDepth = 0;
	#firstWriteError: Error | undefined;
	#localSyncError: Error | undefined;

	private constructor(options: BufferedSqlSessionStorageOptions) {
		this.#options = options;
		this.#table = options.table ?? "omp_session_files";
		this.#receipts = `${this.#table}_buffer_receipts`;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.#table) || this.#receipts.length > 63) {
			throw new Error(
				"Buffered SQL session table must be an identifier whose receipt table name fits 63 characters",
			);
		}
		this.#cachePath = path.resolve(options.cachePath);
		fs.mkdirSync(path.dirname(this.#cachePath), { recursive: true, mode: 0o700 });
		// Set the database's mode before SQLite can create private WAL/SHM pages.
		const descriptor = fs.openSync(this.#cachePath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
		try {
			fs.fchmodSync(descriptor, 0o600);
		} finally {
			fs.closeSync(descriptor);
		}
		for (const sidecar of [`${this.#cachePath}-wal`, `${this.#cachePath}-shm`]) {
			try {
				fs.chmodSync(sidecar, 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		this.#db = new Database(this.#cachePath, { create: true, strict: true });
		try {
			this.#db.exec(`
				PRAGMA busy_timeout = 5000;
				PRAGMA journal_mode = WAL;
				PRAGMA synchronous = FULL;
				CREATE TABLE IF NOT EXISTS buffer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS buffer_files (
					path TEXT PRIMARY KEY, present INTEGER NOT NULL, body TEXT, base_size INTEGER NOT NULL,
					size INTEGER NOT NULL, mtime INTEGER NOT NULL, revision INTEGER NOT NULL,
					title TEXT, title_source TEXT, title_updated_at TEXT
				);
				CREATE TABLE IF NOT EXISTS buffer_segments (
					seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, offset INTEGER NOT NULL, content TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS buffer_segments_path ON buffer_segments(path, seq);
				CREATE TABLE IF NOT EXISTS buffer_outbox (
					seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
					conflict INTEGER NOT NULL DEFAULT 0, error TEXT
				);
				CREATE TABLE IF NOT EXISTS buffer_paths (
					operation_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(operation_id, path)
				);
				CREATE TABLE IF NOT EXISTS buffer_prefixes (
					operation_id TEXT PRIMARY KEY, prefix TEXT NOT NULL
				);
			`);
			this.#atomic(() => {
				const table = this.#meta("table");
				if (table !== null && table !== this.#table)
					throw new Error("Session SQLite cache belongs to another SQL table");
				this.#setMeta("table", this.#table);
			});
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	static async create(options: BufferedSqlSessionStorageOptions): Promise<BufferedSqlSessionStorage> {
		const interval = options.syncIntervalMs ?? 30_000;
		if (!Number.isFinite(interval) || interval < 0) throw new Error("syncIntervalMs must be nonnegative and finite");
		const storage = new BufferedSqlSessionStorage(options);
		try {
			await storage.sync();
		} catch (error) {
			if (error instanceof LocalCacheError) {
				await storage.close();
				throw error;
			}
			// sync records and reports remote failures; the durable cache remains usable.
		}
		if (interval > 0) {
			// sync() reports both local and remote failures; consume its already-reported rejection.
			storage.#timer = setInterval(() => {
				void storage.sync().catch(() => {});
			}, interval);
			storage.#timer.unref();
		}
		return storage;
	}

	#assertOpen(): void {
		if (this.#closed || this.#closingRequested) throw new Error("Buffered SQL session storage closed");
	}
	#all<T>(sql: string, ...values: SQLQueryBindings[]): T[] {
		try {
			return this.#db.query<T, SQLQueryBindings[]>(sql).all(...values);
		} catch (error) {
			throw new LocalCacheError(error);
		}
	}
	#run(sql: string, ...values: SQLQueryBindings[]): void {
		try {
			this.#db.query(sql).run(...values);
		} catch (error) {
			throw new LocalCacheError(error);
		}
	}
	#atomic<T>(operation: () => T): T {
		if (this.#transactionDepth > 0) return operation();
		try {
			this.#db.exec("BEGIN IMMEDIATE");
		} catch (error) {
			throw new LocalCacheError(error);
		}
		this.#transactionDepth++;
		try {
			const result = operation();
			try {
				this.#db.exec("COMMIT");
			} catch (error) {
				throw new LocalCacheError(error);
			}
			return result;
		} catch (error) {
			try {
				this.#db.exec("ROLLBACK");
			} catch (rollbackError) {
				throw new LocalCacheError(new AggregateError([error, rollbackError], "Cache transaction rollback failed"));
			}
			throw error;
		} finally {
			this.#transactionDepth--;
		}
	}
	#meta(key: string): string | null {
		return this.#all<{ value: string }>("SELECT value FROM buffer_meta WHERE key = ?", key)[0]?.value ?? null;
	}
	#setMeta(key: string, value: string): void {
		this.#run(
			"INSERT INTO buffer_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}
	#generation(): number {
		return Number(this.#meta("generation") ?? 0);
	}
	#bump(): number {
		const generation = this.#generation() + 1;
		this.#setMeta("generation", String(generation));
		return generation;
	}
	#mtime(): number {
		const next = Math.max(Date.now(), Number(this.#meta("mtime") ?? 0) + 1);
		this.#setMeta("mtime", String(next));
		return next;
	}
	#file(file: string): CacheFile | undefined {
		return this.#all<CacheFile>(
			`SELECT path, present, body IS NOT NULL AS hydrated, base_size, size,
			mtime, revision, title, title_source, title_updated_at FROM buffer_files WHERE path = ?`,
			file,
		)[0];
	}
	#require(file: string): CacheFile {
		const current = this.#file(file);
		if (!current?.present) throw enoent(file);
		return current;
	}
	#expected(file: string): ExpectedFile {
		return { path: file, token: token(this.#file(file)) };
	}
	#enqueue(operation: Operation): void {
		const id = randomUUID();
		this.#run("INSERT INTO buffer_outbox(id, payload) VALUES (?, ?)", id, JSON.stringify(operation));
		for (const file of operation.expected) {
			this.#run("INSERT INTO buffer_paths(operation_id, path) VALUES (?, ?)", id, file.path);
		}
		if (operation.prefix !== undefined) {
			this.#run("INSERT INTO buffer_prefixes(operation_id, prefix) VALUES (?, ?)", id, operation.prefix);
		}
	}
	#put(file: string, content: string, mtime: number, revision: number, title: SessionTitleUpdate | null): void {
		const size = Buffer.byteLength(content, "utf8");
		this.#run(
			`INSERT INTO buffer_files(path, present, body, base_size, size, mtime, revision, title, title_source, title_updated_at)
			VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET
			present=1, body=excluded.body, base_size=excluded.base_size, size=excluded.size, mtime=excluded.mtime,
			revision=excluded.revision, title=excluded.title, title_source=excluded.title_source, title_updated_at=excluded.title_updated_at`,
			file,
			content,
			size,
			size,
			mtime,
			revision,
			title?.title ?? null,
			title?.source ?? null,
			title?.updatedAt ?? null,
		);
		this.#run("DELETE FROM buffer_segments WHERE path = ?", file);
	}

	ensureDirSync(_dir: string): void {
		this.#assertOpen();
	}
	existsSync(file: string): boolean {
		this.#assertOpen();
		return this.#file(file)?.present === 1;
	}
	async exists(file: string): Promise<boolean> {
		return this.existsSync(file);
	}
	statSync(file: string): SessionStorageStat {
		this.#assertOpen();
		const current = this.#require(file);
		return { size: current.size, mtimeMs: current.mtime, mtime: new Date(current.mtime) };
	}
	listFilesSync(dir: string, pattern: string): string[] {
		this.#assertOpen();
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const glob = new Bun.Glob(pattern);
		return this.#all<{ path: string }>(
			"SELECT path FROM buffer_files WHERE present = 1 AND substr(path, 1, ?) = ?",
			prefix.length,
			prefix,
		)
			.map(file => file.path)
			.filter(file => glob.match(file.slice(prefix.length)));
	}
	writeTextSync(file: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#replace(file, content, options);
	}
	#replace(file: string, content: string, options?: WriteTextAtomicOptions): void {
		this.#assertOpen();
		if (options?.commitGuard && !options.commitGuard()) return;
		this.#atomic(() => {
			const expected = this.#expected(file);
			if (options?.expectedSize !== undefined && options.expectedSize !== (expected.token?.size ?? null)) {
				throw new SessionWriteConflictError(file, options.expectedSize, expected.token?.size ?? null);
			}
			if (options?.commitGuard && !options.commitGuard()) return;
			const mtime = this.#mtime();
			const title = titleUpdateFromSlot(parseTitleSlotFromContent(content)) ?? null;
			this.#put(file, content, mtime, this.#bump(), title);
			this.#enqueue({ kind: "write", expected: [expected], mtime, content, title });
		});
	}
	async writeText(file: string, content: string): Promise<void> {
		this.writeTextSync(file, content);
	}
	async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.#replace(file, content, options);
	}

	#unhydrated(file: string): Error {
		return new Error(
			`Session body not cached for ${file}; await readText() before a synchronous read or append. Remote content was not replaced.`,
		);
	}
	readTextSync(file: string): string {
		this.#assertOpen();
		return this.#atomic(() => {
			const current = this.#require(file);
			if (!current.hydrated) throw this.#unhydrated(file);
			const body = this.#all<{ body: string }>("SELECT body FROM buffer_files WHERE path = ?", file)[0].body;
			const segments = this.#all<{ content: string }>(
				"SELECT content FROM buffer_segments WHERE path = ? ORDER BY seq",
				file,
			);
			const content = segments.length ? [body, ...segments.map(segment => segment.content)].join("") : body;
			const title = titleFor(current);
			return title ? overlayTitleSlotContent(content, title) : content;
		});
	}
	async readText(file: string): Promise<string> {
		this.#assertOpen();
		while (!this.#require(file).hydrated) {
			const pending = this.#hydrate(file);
			this.#reads.add(pending);
			try {
				await pending;
			} finally {
				this.#reads.delete(pending);
			}
		}
		return this.readTextSync(file);
	}
	#acceptRemoteRead<T>(operation: () => T): T {
		try {
			return this.#atomic(operation);
		} catch (error) {
			if (error instanceof RemoteConflictError) this.#report(error);
			throw error;
		}
	}
	async #hydrate(file: string): Promise<void> {
		const before = this.#require(file);
		if (before.hydrated) return;
		let rows: RemoteFile[];
		try {
			const client = await this.#remote();
			rows = (await client.unsafe(
				`SELECT path, content, mtime_ms, ${this.#byteLength()} AS byte_len, title, title_source, title_updated_at
				FROM ${this.#table} WHERE path = ${this.#p(1)}`,
				[file],
			)) as RemoteFile[];
		} catch (error) {
			await this.#remoteError(error);
			throw error;
		}
		this.#assertOpen();
		this.#acceptRemoteRead(() => {
			const current = this.#require(file);
			if (current.hydrated || (current.revision !== before.revision && !sameToken(token(current), token(before))))
				return;
			const remote = rows[0];
			if (!remote) throw enoent(file);
			if (!sameToken(token(current), remoteToken(remote)) && this.#active(file)) {
				throw new RemoteConflictError(file);
			}
			const scopes = this.#pendingScopes();
			if (scopes.some(scope => contains(scope, file))) throw this.#unhydrated(file);
			const revision = this.#bump();
			this.#put(file, remote.content!, Number(remote.mtime_ms), revision, titleFor(remote) ?? null);
			this.#setMeta("mtime", String(Math.max(Number(this.#meta("mtime") ?? 0), Number(remote.mtime_ms))));
		});
	}

	#window(file: CacheFile, start: number, length: number): Uint8Array {
		if (length === 0) return new Uint8Array(0);
		const chunks: Uint8Array[] = [];
		const baseLength = Math.max(0, Math.min(length, file.base_size - start));
		if (baseLength > 0) {
			const row = this.#all<{ chunk: Uint8Array }>(
				"SELECT substr(cast(body AS blob), ?, ?) AS chunk FROM buffer_files WHERE path = ?",
				start + 1,
				baseLength,
				file.path,
			)[0];
			chunks.push(row.chunk);
		}
		const end = start + length;
		const segments = this.#all<{ chunk: Uint8Array }>(
			`SELECT substr(cast(content AS blob), max(1, ? - offset + 1),
			min(length(cast(content AS blob)), ? - offset) - max(0, ? - offset)) AS chunk
			FROM buffer_segments WHERE path = ? AND offset < ? AND offset + length(cast(content AS blob)) > ? ORDER BY seq`,
			start,
			end,
			start,
			file.path,
			end,
			start,
		);
		for (const segment of segments) chunks.push(segment.chunk);
		const bytes = Buffer.concat(chunks);
		const title = titleFor(file);
		if (title && start < 256) {
			const slot = Buffer.from(serializeTitleSlot(title));
			bytes.set(slot.subarray(start, Math.min(slot.length, end)), 0);
		}
		return bytes;
	}
	async readTextSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		this.#assertOpen();
		const current = this.#require(file);
		const prefix = byteLimit(prefixBytes);
		const suffix = byteLimit(suffixBytes);
		if (prefix === 0 && suffix === 0) return ["", ""];
		if (!current.hydrated) {
			const pending = this.#remoteSlices(current, prefix, suffix);
			this.#reads.add(pending);
			try {
				return await pending;
			} finally {
				this.#reads.delete(pending);
			}
		}
		return this.#atomic(() => {
			const latest = this.#require(file);
			return [
				decoder.decode(this.#window(latest, 0, Math.min(prefix, latest.size))),
				decoder.decode(this.#window(latest, Math.max(0, latest.size - suffix), Math.min(suffix, latest.size))),
			];
		});
	}
	async #remoteSlices(before: CacheFile, prefix: number, suffix: number): Promise<[string, string]> {
		let rows: Array<RemoteFile & { head: Uint8Array; tail: Uint8Array }>;
		try {
			const client = await this.#remote();
			const windows =
				this.#adapter === "postgres"
					? `substring(convert_to(content, 'UTF8') from 1 for ${this.#p(1)}) AS head,
					CASE WHEN ${this.#p(2)} <= 0 THEN ''::bytea ELSE substring(convert_to(content, 'UTF8')
					from greatest(1, octet_length(content) - ${this.#p(2)} + 1)) END AS tail`
					: "substr(cast(content AS blob), 1, ?) AS head, CASE WHEN ? <= 0 THEN x'' ELSE substr(cast(content AS blob), -?) END AS tail";
			const values =
				this.#adapter === "postgres" ? [prefix, suffix, before.path] : [prefix, suffix, suffix, before.path];
			rows = (await client.unsafe(
				`SELECT path, mtime_ms, ${this.#byteLength()} AS byte_len, title, title_source,
				title_updated_at, ${windows} FROM ${this.#table} WHERE path = ${this.#p(this.#adapter === "postgres" ? 3 : 4)}`,
				values,
			)) as Array<RemoteFile & { head: Uint8Array; tail: Uint8Array }>;
		} catch (error) {
			await this.#remoteError(error);
			throw error;
		}
		this.#assertOpen();
		const remote = rows[0];
		if (!remote) throw enoent(before.path);
		const accepted = this.#acceptRemoteRead(() => {
			const current = this.#require(before.path);
			if (current.hydrated || (current.revision !== before.revision && !sameToken(token(current), token(before))))
				return false;
			if (!sameToken(token(current), remoteToken(remote)) && this.#active(before.path)) {
				throw new RemoteConflictError(before.path);
			}
			if (this.#pendingScopes().some(scope => contains(scope, before.path))) throw this.#unhydrated(before.path);
			this.#run(
				`UPDATE buffer_files SET size=?, mtime=?, revision=?, title=?, title_source=?, title_updated_at=? WHERE path=?`,
				Number(remote.byte_len),
				Number(remote.mtime_ms),
				this.#bump(),
				remote.title,
				remote.title_source,
				remote.title_updated_at,
				before.path,
			);
			this.#setMeta("mtime", String(Math.max(Number(this.#meta("mtime") ?? 0), Number(remote.mtime_ms))));
			return true;
		});
		if (!accepted) return this.readTextSlices(before.path, prefix, suffix);
		const title = titleFor(remote);
		const slot = title ? Buffer.from(serializeTitleSlot(title)) : undefined;
		const head = Buffer.from(remote.head);
		const tail = Buffer.from(remote.tail);
		if (slot) {
			head.set(slot.subarray(0, Math.min(slot.length, head.length)));
			const start = Math.max(0, Number(remote.byte_len) - suffix);
			if (start < slot.length) tail.set(slot.subarray(start, Math.min(slot.length, start + tail.length)));
		}
		return [decoder.decode(head), decoder.decode(tail)];
	}
	async hasAssistantTurn(file: string): Promise<boolean> {
		return (await this.readText(file)).split("\n").some(isAssistantMessageLine);
	}
	async updateSessionTitle(file: string, update: SessionTitleUpdate): Promise<void> {
		this.#assertOpen();
		if (!this.#require(file).hydrated) await this.readText(file);
		serializeTitleSlot(update);
		this.#atomic(() => {
			this.#require(file);
			const expected = this.#expected(file);
			const mtime = this.#mtime();
			this.#run(
				"UPDATE buffer_files SET title = ?, title_source = ?, title_updated_at = ?, mtime = ?, revision = ? WHERE path = ?",
				update.title ?? null,
				update.source ?? null,
				update.updatedAt,
				mtime,
				this.#bump(),
				file,
			);
			this.#enqueue({ kind: "title", expected: [expected], mtime, title: update });
		});
	}

	appendSync(file: string, line: string): void {
		this.#assertOpen();
		this.#atomic(() => {
			const current = this.#file(file);
			if (current?.present && !current.hydrated) throw this.#unhydrated(file);
			const expected = this.#expected(file);
			const mtime = this.#mtime();
			const revision = this.#bump();
			if (!current?.present) this.#put(file, "", mtime, revision, null);
			const offset = current?.present ? current.size : 0;
			this.#run("INSERT INTO buffer_segments(path, offset, content) VALUES (?, ?, ?)", file, offset, line);
			this.#run(
				"UPDATE buffer_files SET size = ?, mtime = ?, revision = ? WHERE path = ?",
				offset + Buffer.byteLength(line, "utf8"),
				mtime,
				revision,
				file,
			);
			this.#enqueue({ kind: "append", expected: [expected], mtime, content: line });
		});
	}
	_appendForWriter(file: string, line: string): Promise<void> | undefined {
		this.#assertOpen();
		const current = this.#file(file);
		if (current?.present && !current.hydrated) {
			return this.readText(file).then(() => this.appendSync(file, line));
		}
		this.appendSync(file, line);
		return undefined;
	}
	async rename(source: string, destination: string): Promise<void> {
		this.#assertOpen();
		if (!this.#require(source).hydrated) await this.readText(source);
		if (source === destination) return;
		this.#atomic(() => {
			this.#require(source);
			const expected = [this.#expected(source), this.#expected(destination)];
			const mtime = this.#mtime();
			const revision = this.#bump();
			this.#run("DELETE FROM buffer_files WHERE path = ?", destination);
			this.#run("DELETE FROM buffer_segments WHERE path = ?", destination);
			this.#run(
				"UPDATE buffer_files SET path = ?, mtime = ?, revision = ? WHERE path = ?",
				destination,
				mtime,
				revision,
				source,
			);
			this.#run("UPDATE buffer_segments SET path = ? WHERE path = ?", destination, source);
			this.#enqueue({ kind: "rename", expected, mtime, destination });
		});
	}
	#delete(file: string, artifacts: boolean): void {
		this.#assertOpen();
		this.#atomic(() => {
			this.#require(file);
			const prefix = artifacts ? `${file.slice(0, -6).replace(/\/$/, "")}/` : undefined;
			const files = prefix
				? this.#all<Pick<CacheFile, "path" | "present" | "size" | "mtime">>(
						"SELECT path, present, size, mtime FROM buffer_files WHERE present = 1 AND substr(path, 1, ?) = ?",
						prefix.length,
						prefix,
					)
				: [];
			const expected = [
				this.#expected(file),
				...files.filter(entry => entry.path !== file).map(entry => ({ path: entry.path, token: token(entry) })),
			];
			const mtime = this.#mtime();
			const revision = this.#bump();
			for (const entry of expected) {
				this.#run(
					"UPDATE buffer_files SET present = 0, body = NULL, base_size = 0, size = 0, mtime = ?, revision = ? WHERE path = ?",
					mtime,
					revision,
					entry.path,
				);
				this.#run("DELETE FROM buffer_segments WHERE path = ?", entry.path);
			}
			this.#enqueue({ kind: "delete", expected, mtime, prefix });
		});
	}
	async unlink(file: string): Promise<void> {
		this.#delete(file, false);
	}
	async deleteSessionWithArtifacts(file: string): Promise<void> {
		this.#delete(file, true);
	}
	async deleteSessionWithArtifactsIf(file: string, shouldDelete: (content: string) => boolean): Promise<boolean> {
		await this.readText(file);
		return this.withSessionFileLockSync(file, () => {
			if (!shouldDelete(this.readTextSync(file))) return false;
			this.#delete(file, true);
			return true;
		});
	}
	withSessionFileLockSync<T>(_file: string, operation: () => T): T {
		this.#assertOpen();
		// BEGIN IMMEDIATE is the cross-process mutation lock, including nested writes.
		return this.#atomic(operation);
	}
	#ownerKey(file: string): string {
		return `${this.#cachePath}.owner-${createHash("sha256").update(file).digest("hex")}`;
	}
	#active(file: string): boolean {
		const key = this.#ownerKey(file);
		if (ownership.has(key)) return true;
		const probe = tryAcquireFileLock(key);
		if (!probe) return true;
		probe.release();
		return false;
	}
	claimSessionFile(file: string): (() => void) | null {
		this.#assertOpen();
		const key = this.#ownerKey(file);
		let held = ownership.get(key);
		if (!held) {
			const lock = tryAcquireFileLock(key);
			if (!lock) return null;
			held = { lock, holders: 0 };
			ownership.set(key, held);
		}
		const claim = held;
		claim.holders++;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.#claims.delete(release);
			if (--claim.holders === 0) {
				ownership.delete(key);
				claim.lock.release();
			}
		};
		this.#claims.add(release);
		return release;
	}
	openWriter(file: string, options?: { flags?: "a" | "w"; onError?: (error: Error) => void }): SessionStorageWriter {
		this.#assertOpen();
		const release = this.claimSessionFile(file);
		if (!release) throw new Error(`Session file is owned by another process: ${file}`);
		try {
			const writer = new BufferedWriter(this, file, release, options);
			this.#writers.add(writer);
			return writer;
		} catch (error) {
			release();
			throw error;
		}
	}
	_writerClosed(writer: BufferedWriter): void {
		this.#writers.delete(writer);
	}
	_writerError(error: Error): void {
		this.#firstWriteError ??= error;
	}
	async confirmWrites(_file: string): Promise<void> {
		await this.drain();
	}
	async drain(): Promise<void> {
		this.#assertOpen();
		const results = await Promise.allSettled([...this.#writers].map(writer => writer.flush()));
		const errors = results.filter(result => result.status === "rejected").map(result => toError(result.reason));
		if (this.#firstWriteError && !errors.includes(this.#firstWriteError)) errors.unshift(this.#firstWriteError);
		this.#firstWriteError = undefined;
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Session writers failed while draining");
	}

	getSyncStatus(): {
		pendingOperations: number;
		conflictCount: number;
		lastSyncAt: number | null;
		lastError: string | null;
	} {
		this.#assertOpen();
		const counts = this.#all<{ pending: number; conflicts: number }>(
			"SELECT count(*) AS pending, coalesce(sum(conflict), 0) AS conflicts FROM buffer_outbox",
		)[0];
		const lastSync = this.#meta("last_sync");
		return {
			pendingOperations: counts.pending,
			conflictCount: counts.conflicts,
			lastSyncAt: lastSync === null ? null : Number(lastSync),
			lastError: this.#localSyncError?.message ?? (this.#meta("last_error") || null),
		};
	}
	#p(index: number): string {
		return this.#adapter === "postgres" ? `$${index}` : "?";
	}
	#byteLength(): string {
		return this.#adapter === "postgres" ? "octet_length(content)" : "length(cast(content AS blob))";
	}
	async #remote(): Promise<SqlSessionStorageClient> {
		this.#assertOpen();
		if (this.#clientOpening) return this.#clientOpening;
		if (this.#client) return this.#client;
		const opening = (async () => {
			const client = await this.#options.createClient();
			try {
				this.#assertOpen();
				const adapter = String(client.options.adapter ?? "").toLowerCase();
				if (adapter === "postgres" || adapter === "postgresql" || adapter === "pg") this.#adapter = "postgres";
				else if (adapter === "sqlite" || adapter === "sqlite3") this.#adapter = "sqlite";
				else throw new Error(`Buffered SQL sessions require postgres or sqlite, got ${adapter}`);
				// Register immediately so close can interrupt schema/catalog queries.
				this.#client = client;
				await SqlSessionStorage.initializeSchema({ client, table: this.#table, adapter: this.#adapter });
				await client.unsafe(
					`CREATE TABLE IF NOT EXISTS ${this.#receipts} (id TEXT PRIMARY KEY, applied_at ${this.#adapter === "postgres" ? "BIGINT" : "INTEGER"} NOT NULL)`,
				);
				this.#assertOpen();
				return client;
			} catch (error) {
				if (this.#client === client) this.#client = undefined;
				try {
					await client.end?.();
				} catch (closeError) {
					throw new AggregateError([error, closeError], "Remote session initialization and client close failed");
				}
				throw error;
			}
		})();
		this.#clientOpening = opening;
		try {
			return await opening;
		} finally {
			if (this.#clientOpening === opening) this.#clientOpening = undefined;
		}
	}
	async #resetRemote(): Promise<void> {
		const client = this.#client;
		this.#client = undefined;
		await client?.end?.();
	}
	#notifySyncError(error: Error): void {
		this.#localSyncError = error instanceof LocalCacheError ? error : undefined;
		try {
			this.#options.onSyncError?.(error);
		} catch (observerError) {
			logger.error("Session sync error observer failed", { error: toError(observerError).message });
		}
	}
	#report(error: Error): void {
		try {
			this.#setMeta("last_error", error.message);
		} catch (cacheError) {
			const failure = new LocalCacheError(new AggregateError([error, cacheError], toError(cacheError).message));
			this.#notifySyncError(failure);
			throw failure;
		}
		this.#notifySyncError(error);
	}
	async #remoteError(error: unknown): Promise<void> {
		let failure = toError(error);
		try {
			await this.#resetRemote();
		} catch (closeError) {
			failure = new AggregateError([failure, closeError], "Remote session operation and client close failed");
		}
		this.#report(failure);
	}
	#pendingScopes(): Scope[] {
		const paths = this.#all<{ path: string }>(
			"SELECT DISTINCT path FROM buffer_paths JOIN buffer_outbox ON operation_id = id",
		);
		const prefixes = this.#all<{ prefix: string }>(
			"SELECT DISTINCT prefix FROM buffer_prefixes JOIN buffer_outbox ON operation_id = id",
		);
		return [{ paths: paths.map(row => row.path) }, ...prefixes.map(row => ({ paths: [], prefix: row.prefix }))];
	}

	async #publish(row: OutboxRow, operation: Operation): Promise<void> {
		const client = await this.#remote();
		await client.transaction(async transaction => {
			// Prefix deletes need predicate exclusion, and a rename may target an
			// absent row that cannot be row-locked. Routine appends lock only their
			// session row; conditional INSERT handles absent-row creation races.
			const tableLock = operation.kind === "rename" || operation.prefix !== undefined;
			if (this.#adapter === "postgres" && tableLock) {
				await transaction.unsafe(`LOCK TABLE ${this.#table} IN SHARE ROW EXCLUSIVE MODE`);
			}
			// On SQLite this INSERT also obtains the transaction's write lock.
			const inserted = await transaction.unsafe(
				`INSERT INTO ${this.#receipts}(id, applied_at) VALUES (${this.#p(1)}, ${this.#p(2)}) ON CONFLICT(id) DO NOTHING RETURNING id`,
				[row.id, Date.now()],
			);
			if (inserted.length === 0) return;
			for (const expected of [...operation.expected].sort((a, b) => a.path.localeCompare(b.path))) {
				const lockRow = this.#adapter === "postgres" && !tableLock ? " FOR UPDATE" : "";
				const rows = (await transaction.unsafe(
					`SELECT path, mtime_ms, ${this.#byteLength()} AS byte_len FROM ${this.#table} WHERE path = ${this.#p(1)}${lockRow}`,
					[expected.path],
				)) as RemoteFile[];
				if (!sameToken(expected.token, remoteToken(rows[0]))) throw new RemoteConflictError(expected.path);
			}
			if (operation.prefix !== undefined) {
				const rows = (await transaction.unsafe(
					`SELECT path FROM ${this.#table} WHERE substr(path, 1, ${this.#p(1)}) = ${this.#p(2)}`,
					[operation.prefix.length, operation.prefix],
				)) as Array<{ path: string }>;
				const expected = new Set(operation.expected.filter(file => file.token !== null).map(file => file.path));
				for (const remote of rows) if (!expected.has(remote.path)) throw new RemoteConflictError(remote.path);
			}
			await this.#apply(transaction, operation);
		});
	}
	async #apply(transaction: SqlSessionStorageTransaction, operation: Operation): Promise<void> {
		const file = operation.expected[0].path;
		const exists = operation.expected[0].token !== null;
		switch (operation.kind) {
			case "write": {
				const values = [
					operation.content!,
					operation.mtime,
					operation.title?.title ?? null,
					operation.title?.source ?? null,
					operation.title?.updatedAt ?? null,
					file,
				];
				if (exists) {
					await transaction.unsafe(
						`UPDATE ${this.#table} SET content=${this.#p(1)}, mtime_ms=${this.#p(2)},
						title=${this.#p(3)}, title_source=${this.#p(4)}, title_updated_at=${this.#p(5)} WHERE path=${this.#p(6)}`,
						values,
					);
				} else {
					const inserted = await transaction.unsafe(
						`INSERT INTO ${this.#table}(content, mtime_ms, title, title_source, title_updated_at, path)
						VALUES (${this.#p(1)}, ${this.#p(2)}, ${this.#p(3)}, ${this.#p(4)}, ${this.#p(5)}, ${this.#p(6)})
						ON CONFLICT(path) DO NOTHING RETURNING path`,
						values,
					);
					if (inserted.length === 0) throw new RemoteConflictError(file);
				}
				return;
			}
			case "append":
				if (exists) {
					await transaction.unsafe(
						`UPDATE ${this.#table} SET content = content || ${this.#p(1)}, mtime_ms = ${this.#p(2)} WHERE path = ${this.#p(3)}`,
						[operation.content!, operation.mtime, file],
					);
				} else {
					const inserted = await transaction.unsafe(
						`INSERT INTO ${this.#table}(path, content, mtime_ms)
						VALUES (${this.#p(1)}, ${this.#p(2)}, ${this.#p(3)}) ON CONFLICT(path) DO NOTHING RETURNING path`,
						[file, operation.content!, operation.mtime],
					);
					if (inserted.length === 0) throw new RemoteConflictError(file);
				}
				return;
			case "title":
				await transaction.unsafe(
					`UPDATE ${this.#table} SET title=${this.#p(1)}, title_source=${this.#p(2)}, title_updated_at=${this.#p(3)}, mtime_ms=${this.#p(4)} WHERE path=${this.#p(5)}`,
					[
						operation.title?.title ?? null,
						operation.title?.source ?? null,
						operation.title?.updatedAt ?? null,
						operation.mtime,
						file,
					],
				);
				return;
			case "rename":
				await transaction.unsafe(`DELETE FROM ${this.#table} WHERE path = ${this.#p(1)}`, [operation.destination!]);
				await transaction.unsafe(
					`UPDATE ${this.#table} SET path = ${this.#p(1)}, mtime_ms = ${this.#p(2)} WHERE path = ${this.#p(3)}`,
					[operation.destination!, operation.mtime, file],
				);
				return;
			case "delete":
				for (const expected of operation.expected)
					await transaction.unsafe(`DELETE FROM ${this.#table} WHERE path = ${this.#p(1)}`, [expected.path]);
		}
	}

	async #refresh(): Promise<void> {
		const generation = this.#generation();
		const client = await this.#remote();
		const rows = (await client.unsafe(
			`SELECT path, mtime_ms, ${this.#byteLength()} AS byte_len, title, title_source, title_updated_at FROM ${this.#table}`,
		)) as RemoteFile[];
		this.#atomic(() => {
			// A local write during the network fetch invalidates its entire snapshot.
			if (this.#generation() !== generation) return;
			const dirty = this.#pendingScopes();
			const remote = new Set(rows.map(row => row.path));
			for (const current of this.#all<{ path: string }>("SELECT path FROM buffer_files")) {
				if (
					!remote.has(current.path) &&
					!dirty.some(scope => contains(scope, current.path)) &&
					!this.#active(current.path)
				) {
					this.#run("DELETE FROM buffer_files WHERE path = ?", current.path);
					this.#run("DELETE FROM buffer_segments WHERE path = ?", current.path);
				}
			}
			const revision = this.#bump();
			let maxMtime = Number(this.#meta("mtime") ?? 0);
			for (const row of rows) {
				if (dirty.some(scope => contains(scope, row.path))) continue;
				const current = this.#file(row.path);
				const unchanged = sameToken(token(current), remoteToken(row));
				if (!unchanged && this.#active(row.path)) continue;
				if (!unchanged) this.#run("DELETE FROM buffer_segments WHERE path = ?", row.path);
				this.#run(
					`INSERT INTO buffer_files(path, present, body, base_size, size, mtime, revision, title, title_source, title_updated_at)
					VALUES (?, 1, NULL, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET
					present=1, body=CASE WHEN ? THEN body ELSE NULL END, base_size=CASE WHEN ? THEN base_size ELSE 0 END,
					size=excluded.size, mtime=excluded.mtime, revision=excluded.revision,
					title=excluded.title, title_source=excluded.title_source, title_updated_at=excluded.title_updated_at`,
					row.path,
					Number(row.byte_len),
					Number(row.mtime_ms),
					revision,
					row.title,
					row.title_source,
					row.title_updated_at,
					unchanged ? 1 : 0,
					unchanged ? 1 : 0,
				);
				maxMtime = Math.max(maxMtime, Number(row.mtime_ms));
			}
			this.#setMeta("mtime", String(maxMtime));
		});
	}

	sync(): Promise<void> {
		this.#assertOpen();
		if (this.#syncing) return this.#syncing;
		const pending = this.#sync();
		this.#syncing = pending;
		void pending
			.finally(() => {
				if (this.#syncing === pending) this.#syncing = undefined;
			})
			.catch(() => {});
		return pending;
	}
	async #sync(): Promise<void> {
		let lock: FileLockHandle | undefined;
		try {
			// The kernel, not a timeout, determines when a dead replay owner is gone.
			lock = await acquireFileLock(`${this.#cachePath}.replay`);
			const blocked: Scope[] = [];
			const errors: Error[] = [];
			const highWater = this.#all<{ seq: number }>("SELECT coalesce(max(seq), 0) AS seq FROM buffer_outbox")[0].seq;
			let cursor = 0;
			let stop = false;
			while (!stop && !this.#closingRequested) {
				const page = this.#all<OutboxRow>(
					"SELECT seq, id, payload FROM buffer_outbox WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 32",
					cursor,
					highWater,
				);
				if (page.length === 0) break;
				for (const row of page) {
					cursor = row.seq;
					if (this.#closingRequested) {
						stop = true;
						break;
					}
					const operation = JSON.parse(row.payload) as Operation;
					const scope = scopeFor(operation);
					if (blocked.some(previous => overlaps(previous, scope))) {
						// Remember newly coupled paths, not a duplicate scope per
						// blocked append during a long outage.
						const addsPath = scope.paths.some(file => !blocked.some(previous => contains(previous, file)));
						const prefix = scope.prefix;
						const addsPrefix =
							prefix !== undefined &&
							!blocked.some(previous => previous.prefix !== undefined && prefix.startsWith(previous.prefix));
						if (addsPath || addsPrefix) blocked.push(scope);
						continue;
					}
					try {
						await this.#publish(row, operation);
						this.#atomic(() => {
							this.#run("DELETE FROM buffer_outbox WHERE id = ?", row.id);
							this.#run("DELETE FROM buffer_paths WHERE operation_id = ?", row.id);
							this.#run("DELETE FROM buffer_prefixes WHERE operation_id = ?", row.id);
						});
					} catch (error) {
						if (error instanceof LocalCacheError) throw error;
						const failure = toError(error);
						this.#run(
							"UPDATE buffer_outbox SET conflict = ?, error = ? WHERE id = ?",
							error instanceof RemoteConflictError ? 1 : 0,
							failure.message,
							row.id,
						);
						blocked.push(scope);
						errors.push(failure);
						if (!(error instanceof RemoteConflictError)) {
							try {
								await this.#resetRemote();
							} catch (closeError) {
								errors.push(toError(closeError));
							}
							if (connectionFailure(failure)) {
								stop = true;
								break;
							}
						}
					}
				}
			}
			try {
				if (!this.#closingRequested) await this.#refresh();
			} catch (error) {
				if (error instanceof LocalCacheError) throw error;
				errors.push(toError(error));
				try {
					await this.#resetRemote();
				} catch (closeError) {
					errors.push(toError(closeError));
				}
			}
			if (errors.length > 0)
				throw errors.length === 1
					? errors[0]
					: new AggregateError(errors, errors.map(error => error.message).join("; "));
			this.#atomic(() => {
				this.#setMeta("last_sync", String(Date.now()));
				this.#setMeta("last_error", "");
			});
			this.#localSyncError = undefined;
		} catch (error) {
			const failure = toError(error);
			if (failure instanceof LocalCacheError) this.#notifySyncError(failure);
			else this.#report(failure);
			throw error;
		} finally {
			lock?.release();
		}
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		if (this.#closed) return Promise.resolve();
		this.#closingRequested = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		const closing = this.#close();
		this.#closing = closing;
		return closing;
	}
	async #close(): Promise<void> {
		const errors: unknown[] = [];
		// Parent clients force-close native Bun.SQL instead of waiting for stalled
		// queries. Keep the leader lock until that cancellation has settled.
		try {
			await this.#resetRemote();
		} catch (error) {
			errors.push(error);
		}
		// Pending remote work remains in the outbox; close never demands connectivity.
		if (this.#syncing) await this.#syncing.catch(() => {});
		await Promise.allSettled(this.#reads);
		for (const writer of this.#writers) {
			try {
				await writer.close();
			} catch (error) {
				errors.push(error);
			}
		}
		for (const release of this.#claims) release();
		try {
			await this.#resetRemote();
		} catch (error) {
			errors.push(error);
		}
		try {
			this.#db.close();
		} catch (error) {
			errors.push(error);
		}
		this.#closed = true;
		if (errors.length) throw new AggregateError(errors, "Buffered SQL session close failed");
	}
}

class BufferedWriter implements SessionStorageWriter {
	readonly #storage: BufferedSqlSessionStorage;
	readonly #path: string;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #release: () => void;
	#closed = false;
	#error: Error | undefined;
	#pending: Promise<void> | undefined;

	constructor(
		storage: BufferedSqlSessionStorage,
		file: string,
		release: () => void,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	) {
		this.#storage = storage;
		this.#path = file;
		this.#onError = options?.onError;
		this.#release = release;
		if (options?.flags === "w") storage.writeTextSync(file, "");
	}
	#check(): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
	}
	#fail(error: unknown): Error {
		const failure = toError(error);
		if (!this.#error) {
			this.#error = failure;
			this.#storage._writerError(failure);
			this.#onError?.(failure);
		}
		return failure;
	}
	appendSync(line: string): void {
		this.#check();
		try {
			if (this.#pending)
				throw new Error("Session writer has asynchronous work in progress; await flush() before appendSync()");
			this.#storage.appendSync(this.#path, line);
		} catch (error) {
			throw this.#fail(error);
		}
	}
	append(line: string): Promise<void> {
		try {
			this.#check();
			const operation = this.#pending
				? this.#pending.then(() => {
						if (this.#error) throw this.#error;
						return this.#storage._appendForWriter(this.#path, line);
					})
				: this.#storage._appendForWriter(this.#path, line);
			if (!operation) return Promise.resolve();
			const pending = operation.catch(error => {
				throw this.#fail(error);
			});
			this.#pending = pending;
			void pending
				.finally(() => {
					if (this.#pending === pending) this.#pending = undefined;
				})
				.catch(() => {});
			return pending;
		} catch (error) {
			return Promise.reject(this.#fail(error));
		}
	}
	flushSync(): void {
		if (this.#error) throw this.#error;
		if (this.#pending) throw new Error("Session writer has asynchronous work in progress; await flush()");
	}
	async flush(): Promise<void> {
		if (this.#pending) await this.#pending.catch(() => {});
		if (this.#error) throw this.#error;
	}
	isOpen(): boolean {
		return !this.#closed;
	}
	async close(): Promise<void> {
		if (this.#closed) {
			if (this.#error) throw this.#error;
			return;
		}
		this.#closed = true;
		try {
			await this.flush();
		} finally {
			this.#storage._writerClosed(this);
			this.#release();
		}
	}
	getError(): Error | undefined {
		return this.#error;
	}
}
