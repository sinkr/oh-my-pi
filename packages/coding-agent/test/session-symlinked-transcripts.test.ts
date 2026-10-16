/**
 * Regression for #15878: a transcript placed in a session directory as a
 * symlink — a launcher's, a supervisor's clean-up tool's — is a transcript
 * like any other. `Bun.Glob` walks no symlink unless it is asked to, so
 * `omp --session-dir <dir> --resume <id>` found nothing where a hardlink, or
 * a copy, resumed the very same bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	findSessionFiles,
	listAllSessions,
	listRecentSessions,
	listSessions,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_ID = "0198aaaa-0000-7000-8000-000000000001";
const SESSION_NAME = `2026-10-15T00-00-00-000Z_${SESSION_ID}.jsonl`;

// This account's filesystem may not be able to make a symlink at all: Windows
// needs SeCreateSymbolicLink, which an unprivileged account doesn't have.
const symlinksAvailable = ((): boolean => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-symlink-probe-"));
	try {
		fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
})();

describe("a transcript that is a symlink", () => {
	let sessionsDir = "";
	let real = "";

	beforeEach(async () => {
		sessionsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-symlink-"));
		real = path.join(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-symlink-src-")),
			"transcript.jsonl",
		);
		// a session file as the CLI writes one: its header, then a turn
		await fs.promises.writeFile(
			real,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: SESSION_ID,
					timestamp: "2026-10-15T00:00:00.000Z",
					cwd: "/tmp",
				}),
				JSON.stringify({
					type: "message",
					id: "u0",
					parentId: null,
					timestamp: "2026-10-15T00:00:00.000Z",
					message: { role: "user", content: "ping", timestamp: 0 },
				}),
			].join("\n") + "\n",
		);
	});

	afterEach(async () => {
		// `real` is empty when `beforeEach` threw before assigning it; removing
		// `path.dirname("")` (`.`) recursively would sweep the test runner's cwd.
		if (sessionsDir) await fs.promises.rm(sessionsDir, { recursive: true, force: true });
		if (real) await fs.promises.rm(path.dirname(real), { recursive: true, force: true });
	});

	it.skipIf(!symlinksAvailable)("is listed, and resumed from --session-dir", async () => {
		await fs.promises.symlink(real, path.join(sessionsDir, SESSION_NAME));

		const storage = new FileSessionStorage();
		expect((await listSessions(sessionsDir, storage)).map(session => session.id)).toEqual([SESSION_ID]);
		expect((await resolveResumableSession(SESSION_ID, "/tmp", sessionsDir))?.session.id).toBe(SESSION_ID);
	});

	it.skipIf(!symlinksAvailable)("is found under a project bucket, by id prefix", async () => {
		const bucket = path.join(sessionsDir, "-Users-me-proj");
		await fs.promises.mkdir(bucket, { recursive: true });
		await fs.promises.symlink(real, path.join(bucket, SESSION_NAME));

		expect(await findSessionFiles(SESSION_ID.slice(0, 8), sessionsDir)).toEqual([path.join(bucket, SESSION_NAME)]);
	});

	it.skipIf(!symlinksAvailable)("is listed once when a project bucket is a symlink to another", async () => {
		// The layout people build after renaming a project (#5385): one bucket
		// points at the other, so following symlinks reaches the transcript by
		// both names. It is one session, not two, and not an ambiguous match.
		const realBucket = path.join(sessionsDir, "-Users-me-real-proj");
		const aliasBucket = path.join(sessionsDir, "-Users-me-alias-proj");
		await fs.promises.mkdir(realBucket, { recursive: true });
		await fs.promises.symlink(real, path.join(realBucket, SESSION_NAME));
		await fs.promises.symlink(path.basename(realBucket), aliasBucket);

		const storage = new FileSessionStorage();
		expect((await listAllSessions(storage, sessionsDir)).map(session => session.id)).toEqual([SESSION_ID]);
		expect(await findSessionFiles(SESSION_ID.slice(0, 8), sessionsDir)).toEqual([
			path.join(realBucket, SESSION_NAME),
		]);
		expect((await listRecentSessions({ limit: 10, sessionsRoot: sessionsDir })).map(s => s.id)).toEqual([SESSION_ID]);
	});
});
