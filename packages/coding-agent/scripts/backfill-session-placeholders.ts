#!/usr/bin/env bun
/**
 * Create local placeholders for main sessions already stored in SQL session
 * storage (see `src/session/session-placeholder.ts`). New sessions get theirs
 * on first persistence; this covers sessions persisted before that existed.
 *
 * Usage (from the repo root):
 *   OMP_PG_SESSIONS=true bun packages/coding-agent/scripts/backfill-session-placeholders.ts [--dry-run] [sessionsRoot...]
 *
 * Without roots it covers the base agent sessions directory plus every
 * profile's (`<config root>/profiles/<name>/agent/sessions`). Session rows are
 * keyed by unresolved absolute paths, so roots are used verbatim.
 */
import * as path from "node:path";
import { BufferedSqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/buffered-sql-session-storage";
import { backfillSessionPlaceholders } from "@oh-my-pi/pi-coding-agent/session/session-placeholder";
import { initSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-init";
import { getBaseConfigRoot, getSessionsDir } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
let roots = args.filter(arg => arg !== "--dry-run").map(root => path.resolve(root));
if (roots.length === 0) {
	const configRoot = getBaseConfigRoot();
	const profileRoots = new Glob("profiles/*/agent/sessions").scanSync({ cwd: configRoot, onlyFiles: false });
	roots = [getSessionsDir(), ...Array.from(profileRoots, root => path.join(configRoot, root))];
}

const storage = await initSessionStorage();
if (!(storage instanceof BufferedSqlSessionStorage)) {
	console.error("SQL session storage is not enabled (set OMP_PG_SESSIONS=true); nothing to backfill.");
	process.exit(1);
}
try {
	const result = backfillSessionPlaceholders(storage, roots, { dryRun });
	for (const file of result.created) console.log(file);
	console.error(
		`${dryRun ? "Would create" : "Created"} ${result.created.length} placeholder(s) for ${result.sessions} session(s) under:\n  ${roots.join("\n  ")}`,
	);
} finally {
	await storage.close();
}
