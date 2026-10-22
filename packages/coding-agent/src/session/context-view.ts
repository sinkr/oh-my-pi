import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AnthropicServerToolContent, AssistantMessage } from "@oh-my-pi/pi-ai";
import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { ContextCategoryId } from "@oh-my-pi/pi-tui/chrome/context-presentation";
import type {
	ContextThinkingGroup,
	ContextViewCategory,
	ContextViewData,
	ContextViewEntry,
} from "@oh-my-pi/pi-tui/overlays/context-viewer";
import { type ContextBreakdown, estimateContextToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "./agent-session";
import { computeSessionContextBreakdown } from "./context-usage-runtime";
import { type ContextViewMessage, convertMessagesForContextView } from "./messages";

const CATEGORIES: readonly [ContextCategoryId, string][] = [
	["system-prompt", "System Prompt"],
	["skills", "Skills"],
	["built-in-tools", "Built-in Tools"],
	["custom-tools", "Custom Tools"],
	["user-messages", "User / Developer Messages"],
	["assistant-messages", "Assistant Messages"],
	["assistant-thinking", "Assistant Thinking"],
	["tool-calls", "Tool Calls"],
	["tool-output", "Tool Output"],
];

const ENCRYPTED_THINKING = "[Encrypted thinking]";

/** Provider ciphertext is shown as its size, never its bytes. */
function opaqueSize(name: string, value: string): string {
	return `${name} · ${value.length.toLocaleString("en-US")} chars`;
}

/** Summarize message content without retaining binary data or message objects. */
function summarizeContentForView(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => {
			if (block === null || typeof block !== "object") return "[Unknown content]";
			const item = block as Record<string, unknown>;
			if (item.type === "text") return typeof item.text === "string" ? item.text : "";
			const facts = [String(item.type ?? "media")];
			if (typeof item.mimeType === "string") facts.push(item.mimeType);
			if (typeof item.width === "number" && typeof item.height === "number")
				facts.push(`${item.width}×${item.height}`);
			if (typeof item.data === "string") facts.push(`~${Math.floor((item.data.length * 3) / 4)} bytes`);
			return `[${facts.join(" · ")}]`;
		})
		.join("\n");
}

interface AssistantBlockEstimate {
	blockTokenEstimates: number[];
	thinkingBlockCount: number;
	reasoningReplayTokens: number;
	isInterruptedThinkingPlaceholder: boolean;
}

function estimateAssistantBlocks(
	message: AssistantMessage,
	tokenizer: Tokenizer,
	isLatestSurviving: boolean,
): AssistantBlockEstimate {
	// Count reasoning replay once; text and calls do not inherit the provider's whole-turn usage.
	let thinkingBlockCount = 0;
	const blockTokenEstimates = message.content.map(block => {
		if (block.type === "text") return tokenizer.countTokens(block.text);
		if (block.type === "toolCall") {
			try {
				// Same serializer as Tokenizer.countMessage, so the reasoning residual stays exact.
				return tokenizer.countTokens([block.name, stringifyJson(block.arguments) ?? "null"]);
			} catch {
				return tokenizer.countTokens(block.name);
			}
		}
		if (block.type === "thinking" || block.type === "redactedThinking") {
			thinkingBlockCount++;
			return 0;
		}
		const isolated: AgentMessage = { ...message, providerPayload: undefined, content: [block] };
		return tokenizer.countMessages([isolated]);
	});
	const messageTokens = isLatestSurviving ? tokenizer.countLatestTurn(message) : tokenizer.countMessage(message);
	const reasoningReplayTokens = Math.max(
		0,
		messageTokens - blockTokenEstimates.reduce((sum, tokens) => sum + tokens, 0),
	);
	const isInterruptedThinkingPlaceholder =
		message.stopReason === "aborted" &&
		reasoningReplayTokens === 0 &&
		message.usage.output === 0 &&
		message.usage.reasoningTokens === undefined &&
		!message.providerPayload &&
		message.content.every(block => block.type === "thinking" && !block.thinking.trim());
	return { blockTokenEstimates, thinkingBlockCount, reasoningReplayTokens, isInterruptedThinkingPlaceholder };
}

interface ContextViewState {
	categoriesById: Map<ContextCategoryId, ContextViewCategory>;
	toolOutputGroupsByName: Map<string, ContextViewCategory>;
	serverToolNamesByCallId: Map<string, string>;
}

function appendEntry(state: ContextViewState, categoryId: ContextCategoryId, entry: ContextViewEntry): void {
	const category = state.categoriesById.get(categoryId)!;
	category.entries.push(entry);
	category.tokens += entry.tokens;
}

function appendToolOutput(state: ContextViewState, toolName: string, entry: ContextViewEntry): void {
	let group = state.toolOutputGroupsByName.get(toolName);
	if (!group) {
		group = {
			id: "tool-output",
			key: `tool-output/tool-${state.toolOutputGroupsByName.size}`,
			label: toolName,
			tokens: 0,
			entries: [],
		};
		state.toolOutputGroupsByName.set(toolName, group);
	}
	group.entries.push(entry);
	group.tokens += entry.tokens;
	appendEntry(state, "tool-output", entry);
}

function appendSystemPromptEntries(session: AgentSession, state: ContextViewState, skillListingTokens: number): void {
	for (const [index, block] of session.systemPrompt.entries()) {
		appendEntry(state, "system-prompt", {
			id: `system-prompt/${index}`,
			label: `System Block ${index + 1}`,
			text: block,
			tokens: session.agent.tokenizer.countTokens(block),
		});
	}
	const skillsCategory = state.categoriesById.get("skills")!;
	skillsCategory.tokens = skillListingTokens;
	const systemPromptCategory = state.categoriesById.get("system-prompt")!;
	// Skills estimates the prompt's skill listing, not full skill files or additional context.
	// Subtract it only from the category weight; entries retain complete blocks and unscaled estimates.
	systemPromptCategory.tokens = Math.max(0, systemPromptCategory.tokens - skillListingTokens);
}

function appendToolDefinitionEntries(session: AgentSession, state: ContextViewState): void {
	const toolSourcesByName = new Map(session.getAllToolInfos().map(info => [info.name, info.sourceInfo]));
	for (const [index, tool] of session.agent.state.tools.entries()) {
		const categoryId = session.hasBuiltInTool(tool.name) ? "built-in-tools" : "custom-tools";
		const parts = [tool.name, tool.description];
		try {
			parts.push(JSON.stringify(toolWireSchema(tool), null, 2) ?? "[Schema unavailable]");
			const examples = renderToolExamples(tool);
			if (examples) parts.push(examples);
		} catch (error) {
			parts.push(`Schema unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		const source = toolSourcesByName.get(tool.name);
		appendEntry(state, categoryId, {
			id: `${categoryId}/${index}`,
			label: tool.name,
			text: parts.join("\n\n"),
			info: source?.source ?? "unknown",
			path: source?.path,
			tokens: estimateContextToolSchemaTokens([tool], session.agent.tokenizer, session.model),
		});
	}
}

function messageOriginInfo(
	sourceMessage: AgentMessage,
	convertedRole: ContextViewMessage["message"]["role"],
): string | undefined {
	if (sourceMessage.role === convertedRole && !("customType" in sourceMessage)) return undefined;
	const customType = "customType" in sourceMessage ? ` · ${sourceMessage.customType}` : "";
	const roleConversion = sourceMessage.role !== convertedRole ? ` → ${convertedRole}` : "";
	return `${sourceMessage.role}${customType}${roleConversion}`;
}

/** Provider-signed or encrypted server-tool fields, replayed verbatim but never readable. */
const OPAQUE_SERVER_TOOL_FIELDS: Record<string, true> = {
	signature: true,
	encrypted_content: true,
	encrypted_index: true,
};

function appendServerToolEntry(
	state: ContextViewState,
	block: AnthropicServerToolContent["block"],
	entryIdSuffix: string,
	sourceMessage: AgentMessage,
	info: string | undefined,
	tokens: number,
): void {
	const isCall = block.type === "server_tool_use";
	const callId = isCall ? block.id : block.tool_use_id;
	const toolName = isCall
		? block.name
		: (state.serverToolNamesByCallId.get(callId) ??
			(block.type === "web_search_tool_result" ? "web_search" : "tool_search"));
	if (isCall) state.serverToolNamesByCallId.set(callId, toolName);
	const categoryId = isCall ? "tool-calls" : "tool-output";
	let text: string;
	try {
		// Ciphertext is unreadable; show its size while the entry estimate still counts it.
		text =
			JSON.stringify(
				block,
				(key, value) =>
					typeof value === "string" && Object.hasOwn(OPAQUE_SERVER_TOOL_FIELDS, key)
						? `[${opaqueSize(key, value)}]`
						: value,
				2,
			) ?? "";
	} catch {
		text = "[Content unavailable]";
	}
	const entry: ContextViewEntry = {
		id: `${categoryId}/${entryIdSuffix}`,
		label: toolName,
		info,
		text,
		timestamp: sourceMessage.timestamp,
		callId,
		tokens,
	};
	if (isCall) appendEntry(state, categoryId, entry);
	else appendToolOutput(state, toolName, entry);
}

function appendAssistantMessageEntries(
	session: AgentSession,
	state: ContextViewState,
	message: AssistantMessage,
	{ sourceIndex, convertedIndex }: ContextViewMessage,
	isLatestSurviving: boolean,
): void {
	const sourceMessage = session.agent.state.messages[sourceIndex]!;
	const entryIdPrefix = `${sourceIndex}/${convertedIndex}`;
	const info = messageOriginInfo(sourceMessage, message.role);
	const { blockTokenEstimates, thinkingBlockCount, reasoningReplayTokens, isInterruptedThinkingPlaceholder } =
		estimateAssistantBlocks(message, session.agent.tokenizer, isLatestSurviving);
	const thinkingGroup: ContextThinkingGroup | undefined =
		thinkingBlockCount > 1
			? {
					id: `assistant-thinking/${entryIdPrefix}`,
					label: `Message ${sourceIndex + 1}`,
					tokens: reasoningReplayTokens,
					interrupted: isInterruptedThinkingPlaceholder,
				}
			: undefined;
	// Multiple thinking blocks share one message-level weight; their entries contribute zero.
	if (thinkingGroup) state.categoriesById.get("assistant-thinking")!.tokens += reasoningReplayTokens;
	// Payload-only reasoning still carries a message-level estimate, without exposing its bytes.
	if (reasoningReplayTokens > 0 && thinkingBlockCount === 0) {
		appendEntry(state, "assistant-thinking", {
			id: `assistant-thinking/${entryIdPrefix}/payload`,
			label: `Thinking 1/1 · message ${sourceIndex + 1}`,
			info,
			text: ENCRYPTED_THINKING,
			timestamp: sourceMessage.timestamp,
			tokens: reasoningReplayTokens,
		});
	}
	let thinkingIndex = 0;
	for (const [blockIndex, block] of message.content.entries()) {
		if (block.type === "anthropicServerTool") {
			appendServerToolEntry(
				state,
				block.block,
				`${entryIdPrefix}/${blockIndex}`,
				sourceMessage,
				info,
				blockTokenEstimates[blockIndex]!,
			);
			continue;
		}
		const categoryId =
			block.type === "toolCall"
				? "tool-calls"
				: block.type === "thinking" || block.type === "redactedThinking"
					? "assistant-thinking"
					: "assistant-messages";
		let text: string;
		let opaque: string | undefined;
		if (block.type === "toolCall") {
			try {
				text = stringifyJson(block.arguments, 2) ?? "null";
			} catch {
				text = "[Arguments unavailable]";
			}
		} else if (block.type === "fallback") {
			text = `[provider fallback: ${block.from.model} to ${block.to.model}]`;
		} else if (block.type === "thinking") {
			text = block.thinking || ENCRYPTED_THINKING;
			if (block.thinkingSignature) opaque = opaqueSize("signature", block.thinkingSignature);
		} else if (block.type === "redactedThinking") {
			text = ENCRYPTED_THINKING;
			opaque = opaqueSize("data", block.data);
		} else text = summarizeContentForView([block]);
		appendEntry(state, categoryId, {
			id: `${categoryId}/${entryIdPrefix}/${blockIndex}`,
			label:
				block.type === "toolCall"
					? block.name
					: categoryId === "assistant-thinking"
						? `Thinking ${++thinkingIndex}/${thinkingBlockCount} · message ${sourceIndex + 1}`
						: `${block.type} · message ${sourceIndex + 1}`,
			info: [info, opaque].filter(Boolean).join(" · ") || undefined,
			text,
			timestamp: sourceMessage.timestamp,
			callId: block.type === "toolCall" ? block.id : undefined,
			tokens:
				categoryId === "assistant-thinking" && !thinkingGroup
					? reasoningReplayTokens
					: blockTokenEstimates[blockIndex]!,
			...(categoryId === "assistant-thinking"
				? {
						thinkingGroup,
						interrupted: isInterruptedThinkingPlaceholder,
					}
				: {}),
		});
	}
}

function appendMessageEntries(session: AgentSession, state: ContextViewState): void {
	const tokenizer = session.agent.tokenizer;
	const sourceMessages = session.agent.state.messages;
	const convertedMessages = convertMessagesForContextView(sourceMessages);
	const latestSurvivingAssistantIndex = convertedMessages.findLastIndex(
		({ message }) => message.role === "assistant" && isSurvivingAssistant(message, session.model ?? undefined),
	);
	for (const convertedMessage of convertedMessages) {
		const { message, sourceIndex, convertedIndex } = convertedMessage;
		if (message.role === "assistant") {
			appendAssistantMessageEntries(
				session,
				state,
				message,
				convertedMessage,
				convertedIndex === latestSurvivingAssistantIndex,
			);
			continue;
		}
		const sourceMessage = sourceMessages[sourceIndex]!;
		const executionToolName =
			sourceMessage.role === "bashExecution"
				? "bash"
				: sourceMessage.role === "pythonExecution"
					? "python"
					: undefined;
		const entryIdPrefix = `${sourceIndex}/${convertedIndex}`;
		const info = messageOriginInfo(sourceMessage, message.role);
		if (message.role === "toolResult" || executionToolName) {
			const toolName = message.role === "toolResult" ? message.toolName : executionToolName!;
			const callId = message.role === "toolResult" ? message.toolCallId : undefined;
			appendToolOutput(state, toolName, {
				id: `tool-output/${entryIdPrefix}`,
				label: toolName,
				info,
				text: summarizeContentForView(message.content),
				timestamp: sourceMessage.timestamp,
				callId,
				tokens: tokenizer.countMessages([message]),
			});
		} else {
			appendEntry(state, "user-messages", {
				id: `user-messages/${entryIdPrefix}`,
				label: `${message.role} · message ${sourceIndex + 1}`,
				info,
				text: summarizeContentForView(message.content),
				timestamp: sourceMessage.timestamp,
				tokens: tokenizer.countMessages([message]),
			});
		}
	}
}

function finalizeToolOutputGroups(state: ContextViewState): void {
	const toolOutputCategory = state.categoriesById.get("tool-output")!;
	const chronological = (a: ContextViewEntry, b: ContextViewEntry): number => (a.timestamp ?? 0) - (b.timestamp ?? 0);
	toolOutputCategory.entries.sort(chronological);
	toolOutputCategory.children = [...state.toolOutputGroupsByName.values()].sort((a, b) => b.tokens - a.tokens);
	for (const group of toolOutputCategory.children) group.entries.sort(chronological);
}

/** Sample once on open without session hooks, provider transforms, or file I/O. */
export function buildSessionContextView(
	session: AgentSession,
	breakdown: ContextBreakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true }),
): ContextViewData {
	const categories: ContextViewCategory[] = CATEGORIES.map(([id, label]) => ({ id, label, tokens: 0, entries: [] }));
	const state: ContextViewState = {
		categoriesById: new Map(categories.map(category => [category.id, category])),
		toolOutputGroupsByName: new Map(),
		serverToolNamesByCallId: new Map(),
	};

	appendSystemPromptEntries(session, state, breakdown.categories.find(category => category.id === "skills")!.tokens);
	appendToolDefinitionEntries(session, state);
	appendMessageEntries(session, state);
	finalizeToolOutputGroups(state);

	return {
		modelLabel: session.model?.name ?? session.model?.id ?? "no model",
		window: breakdown.contextWindow,
		usage: breakdown.usedTokens,
		buffer: breakdown.autoCompactBufferTokens,
		free: breakdown.freeTokens,
		breakdown,
		categories,
	};
}
