/**
 * Opt-in background session compression (`gc.autoCompress`).
 *
 * An interactive launch calls {@link scheduleGcAutoCompress}, which starts a
 * detached, low-priority `omp gc --compress --apply` at most once per
 * {@link GC_AUTO_COMPRESS_INTERVAL_MS}. The child's output log doubles as the
 * last-run stamp: spawning truncates it and the run writes its summary there,
 * so its mtime is when the latest run started or finished. `gc.lock`
 * serializes the child with any other gc run; one that finds the lock held
 * exits with an error in the log and is retried after the next interval.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { spawnDetached } from "../subprocess/shared-worker";
import { resolveCliEntryCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { compressMethod } from "./gc-compress";

/** Minimum time between background runs. Sessions qualify only after days idle, so daily is enough. */
export const GC_AUTO_COMPRESS_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Output of the latest background run, under the agent dir. */
export const GC_AUTO_COMPRESS_LOG = "gc-auto-compress.log";

/**
 * Start a detached `omp gc --compress --apply` for `agentDir` when the last
 * background run is at least a day old and the sessions directory sits on a
 * filesystem with transparent compression (APFS, NTFS). Returns the child, or
 * undefined when no run was due or possible. The child outlives this process.
 */
export async function scheduleGcAutoCompress(agentDir: string): Promise<Subprocess | undefined> {
	const logPath = path.join(agentDir, GC_AUTO_COMPRESS_LOG);
	try {
		if (Date.now() - (await fs.stat(logPath)).mtimeMs < GC_AUTO_COMPRESS_INTERVAL_MS) return undefined;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if ((await compressMethod(getSessionsDir(agentDir))) === undefined) return undefined;

	const cmd = [...resolveCliEntryCmd(), "gc", "--compress", "--apply", "--agent-dir", agentDir];
	const { proc } = spawnDetached(cmd, undefined, workerEnvFromParent(), logPath);
	try {
		// Inherited by `ditto`/`compact`, so the copy-and-verify work yields to the foreground.
		os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW);
	} catch {
		// Already exited, or the platform refused; the run proceeds at normal priority.
	}
	return proc;
}
