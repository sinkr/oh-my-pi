import type { AgentHubRegistry, AgentRecordLike } from "./agent-hub-types";

export interface RunningSubagentRegistrySource<T extends AgentHubRegistry = AgentHubRegistry> {
	agentRegistry: T;
}

export function getRunningSubagentBadgeRegistry<T extends AgentHubRegistry>(
	collabGuest: RunningSubagentRegistrySource<T> | undefined,
	localRegistry: T,
): T {
	return collabGuest?.agentRegistry ?? localRegistry;
}

export function getRunningSubagentBadgeAgentRefs(registry: AgentHubRegistry): AgentRecordLike[] {
	return registry.list().filter(ref => ref.kind === "sub" && ref.status === "running");
}

export function getRunningSubagentBadgeAgentIds(registry: AgentHubRegistry): string[] {
	return getRunningSubagentBadgeAgentRefs(registry).map(ref => ref.id);
}
