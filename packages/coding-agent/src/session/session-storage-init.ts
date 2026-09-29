import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { type SessionStorage, setDefaultSessionStorage } from "./session-storage";

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

export async function initSessionStorage(): Promise<SessionStorage | undefined> {
	const storageType = process.env.OMP_SESSION_STORAGE?.toLowerCase();
	const pgSessionsEnabled = process.env.OMP_PG_SESSIONS === "true" || process.env.OMP_PG_SESSIONS === "1";

	const wantsPostgres =
		pgSessionsEnabled ||
		storageType === "postgres" ||
		storageType === "postgresql" ||
		storageType === "sql";

	if (!wantsPostgres) {
		return undefined;
	}

	const dbUrl = resolvePostgresUrl();
	if (!dbUrl) {
		logger.warn("PostgreSQL session storage requested, but DATABASE_URL could not be resolved. Falling back to FileSessionStorage.");
		return undefined;
	}

	try {
		// Deferred dynamic import: avoid loading bun SQL client and SqlSessionStorage unless SQL storage is activated
		const { SQL } = await import("bun");
		const { SqlSessionStorage } = await import("./sql-session-storage");
		const client = new SQL(dbUrl);
		const sqlStorage = await SqlSessionStorage.create({ client, table: "omp_session_files" });
		setDefaultSessionStorage(sqlStorage);
		return sqlStorage;
	} catch (error) {
		logger.warn("Failed to initialize PostgreSQL session storage. Falling back to FileSessionStorage.", { error });
		return undefined;
	}
}
