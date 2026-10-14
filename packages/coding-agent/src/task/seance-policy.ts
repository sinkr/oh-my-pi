import type { WorkspaceTree } from "../workspace-tree";

export const SEANCE_AGENT_NAME = "seance";

/** Options cleared on both fresh seance creation and cold revival. */
export interface SeanceIsolationOptions {
	disableExtensionDiscovery: true;
	additionalDirectories: never[];
	inheritedSessionAgents: undefined;
	contextFiles: never[];
	autoloadSkills: never[];
	skills: never[];
	workspaceTree: WorkspaceTree;
	promptTemplates: never[];
	rules: never[];
	extensionRoots: undefined;
	preloadedExtensionPaths: never[];
	preloadedPreparedExtensions: never[];
	preloadedCustomToolPaths: never[];
	customTools: undefined;
	localProtocolOptions: undefined;
	parentArtifactManager: undefined;
	parentHindsightSessionState: undefined;
	parentMnemopiSessionState: undefined;
}

export function seanceIsolationOptions(cwd: string): SeanceIsolationOptions {
	return {
		disableExtensionDiscovery: true,
		additionalDirectories: [],
		inheritedSessionAgents: undefined,
		autoloadSkills: [],
		contextFiles: [],
		skills: [],
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		promptTemplates: [],
		rules: [],
		extensionRoots: undefined,
		preloadedExtensionPaths: [],
		preloadedPreparedExtensions: [],
		preloadedCustomToolPaths: [],
		customTools: undefined,
		localProtocolOptions: undefined,
		parentArtifactManager: undefined,
		parentHindsightSessionState: undefined,
		parentMnemopiSessionState: undefined,
	};
}
