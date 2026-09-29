import { describe, expect, it, afterEach } from "bun:test";
import { getDefaultSessionStorage, setDefaultSessionStorage, FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { initSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-init";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

describe("session-storage default and init", () => {
	const origEnvStorage = process.env.OMP_SESSION_STORAGE;
	const origEnvPg = process.env.OMP_PG_SESSIONS;
	const origDbUrl = process.env.DATABASE_URL;

	afterEach(() => {
		if (origEnvStorage !== undefined) process.env.OMP_SESSION_STORAGE = origEnvStorage;
		else delete process.env.OMP_SESSION_STORAGE;

		if (origEnvPg !== undefined) process.env.OMP_PG_SESSIONS = origEnvPg;
		else delete process.env.OMP_PG_SESSIONS;

		if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
		else delete process.env.DATABASE_URL;

		setDefaultSessionStorage(new FileSessionStorage());
	});

	it("defaults transparently to FileSessionStorage when unset", () => {
		delete process.env.OMP_SESSION_STORAGE;
		delete process.env.OMP_PG_SESSIONS;
		const storage = getDefaultSessionStorage();
		expect(storage).toBeInstanceOf(FileSessionStorage);
	});

	it("allows overriding default session storage via setDefaultSessionStorage", () => {
		const mem = new MemorySessionStorage();
		setDefaultSessionStorage(mem);
		expect(getDefaultSessionStorage()).toBe(mem);
		expect(SessionManager.createEmptySessionFile).toBeDefined();
	});

	it("initSessionStorage returns undefined and keeps FileSessionStorage when unset", async () => {
		delete process.env.OMP_SESSION_STORAGE;
		delete process.env.OMP_PG_SESSIONS;
		const res = await initSessionStorage();
		expect(res).toBeUndefined();
		expect(getDefaultSessionStorage()).toBeInstanceOf(FileSessionStorage);
	});

	it("initializes SqlSessionStorage when OMP_PG_SESSIONS=true or OMP_SESSION_STORAGE=postgres", async () => {
		process.env.OMP_PG_SESSIONS = "true";
		// Uses DATABASE_URL from ~/.config/pg-memory/env if available
		const storage = await initSessionStorage();
		if (storage) {
			expect(storage).toBeInstanceOf(SqlSessionStorage);
			expect(getDefaultSessionStorage()).toBe(storage);
		}
	});
});
