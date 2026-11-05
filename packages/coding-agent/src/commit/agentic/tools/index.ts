import type { CommitAgentState } from "../../../commit/agentic/state";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { createGitFileDiffTool } from "./git-file-diff";
import { createGitHunkTool } from "./git-hunk";
import { createGitOverviewTool } from "./git-overview";
import { createProposeChangelogTool } from "./propose-changelog";
import { createProposeCommitTool } from "./propose-commit";
import { createRecentCommitsTool } from "./recent-commits";
import { createSplitCommitTool } from "./split-commit";

export interface CommitToolOptions {
	cwd: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	spawns?: string;
	state: CommitAgentState;
	changelogTargets: string[];
}

export function createCommitTools(options: CommitToolOptions): Array<CustomTool<any, any>> {
	return [
		createGitOverviewTool(options.cwd, options.state),
		createGitFileDiffTool(options.cwd, options.state),
		createGitHunkTool(options.cwd),
		createRecentCommitsTool(options.cwd),
		createProposeChangelogTool(options.state, options.changelogTargets),
		createProposeCommitTool(options.cwd, options.state),
		createSplitCommitTool(options.cwd, options.state, options.changelogTargets),
	];
}
