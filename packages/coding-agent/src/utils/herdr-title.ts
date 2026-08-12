export type HerdrTitleSyncResult = "skipped" | "renamed" | "failed";

type Environment = Readonly<Record<string, string | undefined>>;
type CommandRunner = (command: readonly string[]) => Promise<number>;

async function run(command: readonly string[]): Promise<number> {
	const child = Bun.spawn([...command], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	return child.exited;
}

/**
 * Mirror an explicit OMP session rename onto the enclosing HerdR surfaces.
 *
 * Renames both the tab (tab bar) and the workspace (sidebar) so the session
 * name is visible regardless of which chrome the current layout shows.
 * Requires the HerdR pane environment (`HERDR_ENV=1` plus at least one target
 * id); anywhere else the sync is skipped. The `herdr` CLI exits non-zero with
 * `protocol_mismatch` when the session server predates the installed binary —
 * surfaced as "failed" so callers can tell the user to restart HerdR.
 */
export async function syncHerdrTitles(
	title: string,
	environment: Environment = process.env,
	runner: CommandRunner = run,
): Promise<HerdrTitleSyncResult> {
	if (environment.HERDR_ENV !== "1") return "skipped";
	const targets: string[][] = [];
	if (environment.HERDR_TAB_ID) {
		targets.push(["herdr", "tab", "rename", environment.HERDR_TAB_ID, title]);
	}
	if (environment.HERDR_WORKSPACE_ID) {
		targets.push(["herdr", "workspace", "rename", environment.HERDR_WORKSPACE_ID, title]);
	}
	if (targets.length === 0) return "skipped";

	try {
		const codes = await Promise.all(targets.map(command => runner(command)));
		return codes.every(code => code === 0) ? "renamed" : "failed";
	} catch {
		return "failed";
	}
}
