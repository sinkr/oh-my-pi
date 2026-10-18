/**
 * Local placeholders for sessions whose transcript lives in SQL storage.
 *
 * Terminal session restore (Tern) relaunches `omp --restore <file>` for a pane
 * only while the reported session path exists on the local filesystem. SQL
 * storage never writes the `.jsonl` locally, so a restored pane would fall back
 * to a plain shell. An empty regular file at the exact session path keeps that
 * check satisfied; its content is never read because SQL storage resolves the
 * path through its own catalog.
 *
 * Every operation is best-effort: a placeholder failure logs a warning and
 * never fails the session operation that triggered it. Only empty regular
 * files are ever removed, so a real transcript is never touched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isFsError } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { SessionStorage } from "./session-storage";

/** True when `file` is an empty regular file (not a symlink, not a transcript). */
export function isSessionPlaceholder(file: string): boolean {
	try {
		const stat = fs.lstatSync(file);
		return stat.isFile() && stat.size === 0;
	} catch {
		return false;
	}
}

/** Create the placeholder at `file` unless something already exists there. */
export function ensureSessionPlaceholder(file: string): boolean {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL));
		return true;
	} catch (err) {
		if (isFsError(err) && err.code === "EEXIST") return false;
		logger.warn("Session placeholder could not be created", { file, err });
		return false;
	}
}

/** Remove the placeholder at `file`; anything other than an empty regular file stays. */
export function removeSessionPlaceholder(file: string): void {
	if (!isSessionPlaceholder(file)) return;
	try {
		fs.unlinkSync(file);
	} catch (err) {
		if (!isEnoent(err)) logger.warn("Session placeholder could not be removed", { file, err });
	}
}

/** Follow a session rename: the placeholder moves only when `source` had one. */
export function moveSessionPlaceholder(source: string, destination: string): void {
	if (source === destination || !isSessionPlaceholder(source)) return;
	ensureSessionPlaceholder(destination);
	removeSessionPlaceholder(source);
}

export interface SessionPlaceholderBackfill {
	/** Main session paths found in storage under the requested roots. */
	sessions: number;
	/** Placeholders newly created (or that would be, with `dryRun`). */
	created: string[];
}

/**
 * Create placeholders for every main session (`<root>/<bucket>/<file>.jsonl`)
 * the storage holds under `roots`. Subagent transcripts nest one level deeper,
 * inside the session's artifacts directory, so the pattern excludes them.
 */
export function backfillSessionPlaceholders(
	storage: SessionStorage,
	roots: readonly string[],
	options: { dryRun?: boolean } = {},
): SessionPlaceholderBackfill {
	const result: SessionPlaceholderBackfill = { sessions: 0, created: [] };
	for (const root of new Set(roots)) {
		for (const file of storage.listFilesSync(root, "*/*.jsonl")) {
			result.sessions++;
			if (fs.existsSync(file)) continue;
			if (options.dryRun || ensureSessionPlaceholder(file)) result.created.push(file);
		}
	}
	return result;
}
