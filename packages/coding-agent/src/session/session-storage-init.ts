import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBaseConfigRoot } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SQL } from "bun";
import { BufferedSqlSessionStorage } from "./buffered-sql-session-storage";
import type { SessionStorage } from "./session-storage";
import { setDefaultSessionStorage } from "./session-storage";
import type { SqlSessionStorageClient } from "./sql-session-storage";

function resolvePostgresUrl(): string | undefined {
	if (process.env.DATABASE_URL) {
		return process.env.DATABASE_URL;
	}

	const configPath = path.join(os.homedir(), ".config", "pg-memory", "env");
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eqIdx = trimmed.indexOf("=");
				if (eqIdx !== -1) {
					const key = trimmed.slice(0, eqIdx).trim();
					const val = trimmed.slice(eqIdx + 1).trim();
					if (key === "DATABASE_URL") {
						return val;
					}
				}
			}
		}
	} catch (err) {
		logger.debug("Failed reading pg-memory env file", { error: err });
	}

	return undefined;
}

function sessionCachePath(dbUrl: string): string {
	const url = new URL(dbUrl);
	// Credentials rotate independently of the shared database's identity.
	// Profiles using the same remote must share local locks and an outbox.
	const identity = JSON.stringify([
		url.protocol,
		url.hostname.toLowerCase(),
		url.port || "5432",
		url.pathname,
		url.username,
		url.searchParams.get("options"),
		url.searchParams.get("search_path"),
		"omp_session_files",
	]);
	const key = createHash("sha256").update(identity).digest("hex");
	return path.join(getBaseConfigRoot(), "session-cache", `${key}.sqlite`);
}

export async function initSessionStorage(): Promise<SessionStorage | undefined> {
	const storageType = process.env.OMP_SESSION_STORAGE?.toLowerCase();
	const pgSessionsEnabled = process.env.OMP_PG_SESSIONS === "true" || process.env.OMP_PG_SESSIONS === "1";

	const wantsPostgres =
		pgSessionsEnabled || storageType === "postgres" || storageType === "postgresql" || storageType === "sql";

	if (!wantsPostgres) {
		return undefined;
	}

	const dbUrl = resolvePostgresUrl();
	if (!dbUrl) {
		throw new Error("PostgreSQL session storage requested, but DATABASE_URL could not be resolved.");
	}

	// The local WAL is the durability boundary. A remote outage must not switch
	// to unrelated filesystem journals or leave new entries only in memory.
	const cachePath = sessionCachePath(dbUrl);
	const storage = await BufferedSqlSessionStorage.create({
		cachePath,
		createClient: (): SqlSessionStorageClient => {
			const client = new SQL(dbUrl, {
				max: 2,
				connectionTimeout: 5,
				idleTimeout: 20,
				maxLifetime: 600,
			});
			return {
				options: client.options,
				unsafe: (query, values) => client.unsafe(query, values),
				transaction: operation => client.transaction(operation),
				// Receipts make an interrupted/ambiguously committed replay safe.
				end: () => client.end({ timeout: 0 }),
			};
		},
		onSyncError: error => {
			logger.warn("Session storage synchronization paused.", {
				cachePath,
				error: error.message,
			});
		},
	});
	setDefaultSessionStorage(storage);
	return storage;
}
