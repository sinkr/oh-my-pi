/**
 * Opt-in background session compression (`gc.autoCompress`).
 *
 * An interactive launch calls {@link scheduleGcAutoCompress}, which starts a
 * detached, low-priority `omp gc --compress --apply` at most once per
 * {@link GC_AUTO_COMPRESS_INTERVAL_MS}. The child's output log doubles as the
 * last-run stamp: spawning truncates it and the run writes its summary there,
 * so its mtime is when the latest run started or finished. A launch that finds
 * compression unavailable writes the reason there instead, so the check also
 * runs once per interval. Launches claim the run under an OS lock keyed on the
 * log, so concurrent launches start one child per interval. `gc.lock`
 * serializes that child with any other gc run; one that finds the lock held
 * exits with an error in the log and is retried after the next interval.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { getSessionsDir, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { errorMessage } from "../slash-commands/helpers/parse";
import { spawnDetached } from "../subprocess/shared-worker";
import { resolveCliEntryCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { compressionWorks, compressMethod } from "./gc-compress";

/** Minimum time between background runs. Sessions qualify only after days idle, so daily is enough. */
export const GC_AUTO_COMPRESS_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Output of the latest background run, under the agent dir. */
export const GC_AUTO_COMPRESS_LOG = "gc-auto-compress.log";

/**
 * Start a detached `omp gc --compress --apply` for `agentDir` when the last
 * background run is at least a day old and the sessions directory sits on a
 * filesystem whose transparent compression (APFS, NTFS) shrinks a probe file.
 * Returns the child, or undefined when no run was due or possible, or another
 * launch is claiming it. The child outlives this process.
 */
export async function scheduleGcAutoCompress(agentDir: string): Promise<Subprocess | undefined> {
	const logPath = path.join(agentDir, GC_AUTO_COMPRESS_LOG);
	if (!(await runIsDue(logPath))) return undefined;
	const claim = tryAcquireFileLock(logPath);
	if (claim === null) return undefined;
	try {
		// A launch that held the claim before this one may have just started the run.
		if (!(await runIsDue(logPath))) return undefined;
		const skipped = await unavailableReason(getSessionsDir(agentDir));
		if (skipped !== undefined) {
			// Stamps the interval: without it every launch would repeat the probe's copy.
			await Bun.write(logPath, `compress skipped: ${skipped}\n`);
			return undefined;
		}

		const cmd = [...resolveCliEntryCmd(), "gc", "--compress", "--apply", "--agent-dir", agentDir];
		let proc: Subprocess;
		try {
			({ proc } = spawnDetached(cmd, undefined, workerEnvFromParent(), logPath));
		} catch (error) {
			// The log is truncated before the spawn; left behind, it would stamp a run that never started.
			await fs.rm(logPath, { force: true });
			throw error;
		}
		try {
			// Inherited by `ditto`/`compact`, so the copy-and-verify work yields to the foreground.
			os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW);
		} catch {
			// Already exited, or the platform refused; the run proceeds at normal priority.
		}
		return proc;
	} finally {
		claim.release();
	}
}

/** Why the sessions directory cannot be compressed, or undefined when a probe file compresses there. */
async function unavailableReason(sessionsDir: string): Promise<string | undefined> {
	const method = await compressMethod(sessionsDir);
	if (method === undefined) return "unsupported on this filesystem (APFS or NTFS only)";
	try {
		if (await compressionWorks(sessionsDir, method)) return undefined;
		return `${method} compression stored a compressible probe file uncompressed`;
	} catch (error) {
		return `compression probe failed: ${errorMessage(error)}`;
	}
}

/** Whether the last background run, stamped by the log's mtime, is at least an interval old. */
async function runIsDue(logPath: string): Promise<boolean> {
	try {
		return Date.now() - (await fs.stat(logPath)).mtimeMs >= GC_AUTO_COMPRESS_INTERVAL_MS;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return true;
	}
}
