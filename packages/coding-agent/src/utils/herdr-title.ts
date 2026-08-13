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
 * Mirror an explicit OMP session rename onto the enclosing HerdR tab.
 *
 * Renames only the tab (tab bar); the workspace (sidebar) label is left
 * alone — workspaces group multiple tabs, so a per-session rename clobbering
 * the workspace name was wrong whenever more than one agent shared it.
 * Requires the HerdR pane environment (`HERDR_ENV=1` plus a tab id);
 * anywhere else the sync is skipped. The `herdr` CLI exits non-zero with
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
	if (targets.length === 0) return "skipped";

	try {
		const codes = await Promise.all(targets.map(command => runner(command)));
		return codes.every(code => code === 0) ? "renamed" : "failed";
	} catch {
		return "failed";
	}
}
