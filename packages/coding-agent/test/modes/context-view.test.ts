import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { buildSessionContextView } from "../../src/session/context-view";
import { buildSystemPrompt } from "../../src/system-prompt";
import type { Skill } from "../../src/extensibility/skills";
import { computeSessionContextBreakdown } from "../../src/session/context-usage-runtime";
import { convertToLlm, INTERRUPTED_THINKING_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../src/session/messages";
import type { ContextViewData } from "@oh-my-pi/pi-tui/overlays/context-viewer";

const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: type({ value: "string" }),
		async execute() {
			return { content: [{ type: "text", text: "result" }] };
		},
	};
}

function sessionWith(
	options: {
		prompt?: string[];
		skills?: Skill[];
		messages?: AgentMessage[];
		tools?: AgentTool[];
		settings?: Settings;
		model?: Model;
	} = {},
): AgentSession {
	const tools = options.tools ?? [];
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: options.model ?? model,
				systemPrompt: options.prompt ?? ["opaque system"],
				tools,
				messages: options.messages ?? [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: options.settings ?? Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		builtInToolNames: ["read"],
		skills: options.skills,
	});
	sessions.push(session);
	return session;
}

function category(data: ContextViewData, id: string) {
	return data.categories.find(category => category.id === id)!;
}

function totalTokens(data: ContextViewData): number {
	return data.categories.reduce((sum, category) => sum + category.tokens, 0);
}

const reply = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 24,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 24,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 10,
});

function payloadReply(reader: Model, explicitThinking = false): AssistantMessage {
	const reasoning = { type: "reasoning", id: "rs_private", summary: [], encrypted_content: "private-ciphertext" };
	const text = { type: "text", text: "visible answer" } as const;
	return {
		...reply(
			explicitThinking
				? [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) }, text]
				: [text],
		),
		api: reader.api,
		provider: reader.provider,
		model: reader.id,
		stopReason: "stop",
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: reader.provider,
			dt: true,
			items: [
				reasoning,
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: text.text }] },
			],
		},
		usage: { ...reply([]).usage, output: 6_000, totalTokens: 6_000, reasoningTokens: 1_000 },
	};
}

describe("context snapshot capacity and savings", () => {
	it("retains compaction thresholds and computes optional wire savings without changing content capacity", () => {
		const prompt = ["Repeated context policy for the next model request.\n".repeat(1000)];
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"todo.enabled": false,
			"snapcompact.systemPrompt": "all",
		});
		const session = sessionWith({ prompt, settings });
		const data = buildSessionContextView(session);
		expect(data.breakdown.thresholdTokens).toBeGreaterThan(0);
		expect(data.breakdown.snapcompact?.systemPrompt).toMatchObject({ applied: true, scope: "all" });
		expect(data.breakdown.snapcompact?.savedTokens).toBeGreaterThan(0);
		const plain = buildSessionContextView(sessionWith({ prompt }));
		expect(plain.breakdown.snapcompact).toBeUndefined();
		expect(totalTokens(data)).toBe(totalTokens(plain));
		expect(data.free + data.buffer + data.usage).toBe(data.window);
	});

	it("keeps provider-anchored capacity when raw prompt estimates exceed the window", () => {
		const message = reply([{ type: "text", text: "saved answer" }]);
		message.usage.input = 100;
		message.usage.totalTokens = 124;
		const session = sessionWith({
			prompt: ["large prompt ".repeat(120000)],
			messages: [message],
			settings: Settings.isolated({ "compaction.enabled": true, "todo.enabled": false }),
		});
		const data = buildSessionContextView(session);
		expect(totalTokens(data)).toBeGreaterThan(data.window);
		expect(data.usage).toBe(100);
		expect(data.buffer).toBeGreaterThan(0);
		expect(data.free + data.buffer).toBe(data.window - 100);
	});
});

describe("context snapshot system prompt and skills", () => {
	it.each([
		{ name: "default prompt", customPrompt: undefined },
		{ name: "custom prompt", customPrompt: "Literal custom prompt." },
	])("retains effective system blocks and skill content without file I/O: $name", async ({ customPrompt }) => {
		const skills: Skill[] = [
			{
				name: "fixture",
				description: "Use <T> & {{literal}} without expansion",
				filePath: "/nonexistent/SKILL.md",
				baseDir: "/nonexistent",
				source: "user",
			},
		];
		const built = await buildSystemPrompt({
			cwd: import.meta.dir,
			customPrompt,
			personality: "none",
			activeRepoContext: null,
			contextFiles: [{ path: "/nonexistent/instructions.md", content: "Unique instruction body" }],
			skills,
		});
		const prompt = [...built.systemPrompt, "Additional effective policy"];
		const session = sessionWith({ prompt, skills, tools: [tool("read")] });
		const file = vi.spyOn(Bun, "file");
		const data = buildSessionContextView(session);
		const system = category(data, "system-prompt");
		expect(system.entries.map(entry => entry.text)).toEqual(prompt);
		expect(system.entries.map(entry => entry.tokens)).toEqual(
			prompt.map(block => session.agent.tokenizer.countTokens(block)),
		);
		const text = system.entries.map(entry => entry.text).join("\n");
		expect(text).toContain("Unique instruction body");
		expect(text).toContain("Use <T> & {{literal}} without expansion");
		if (customPrompt) expect(text).toContain(customPrompt);
		const shared = computeSessionContextBreakdown(session).categories.find(category => category.id === "skills")!;
		expect(shared.tokens).toBeGreaterThan(0);
		expect(category(data, "skills")).toMatchObject({ entries: [], tokens: shared.tokens });
		const fullPromptTokens = system.entries.reduce((sum, entry) => sum + entry.tokens, 0);
		expect(system.tokens).toBe(fullPromptTokens - shared.tokens);
		expect(system.tokens + category(data, "skills").tokens).toBe(fullPromptTokens);
		expect(totalTokens(data)).toBe(fullPromptTokens + category(data, "built-in-tools").tokens);
		expect(file).not.toHaveBeenCalled();
		file.mockRestore();
	});

	it.each([
		{ name: "visible skills with read", hasRead: true, onlyHidden: false, skillful: true, attributed: true },
		{ name: "without read", hasRead: false, onlyHidden: false, skillful: true, attributed: false },
		{ name: "only hidden skills", hasRead: true, onlyHidden: true, skillful: true, attributed: false },
		{ name: "skillful disabled", hasRead: true, onlyHidden: false, skillful: false, attributed: false },
	])("attributes skill tokens under shared gating: $name", ({ hasRead, onlyHidden, skillful, attributed }) => {
		const visible: Skill = {
			name: "visible",
			description: "Visible skill description",
			filePath: "/nonexistent/visible/SKILL.md",
			baseDir: "/nonexistent/visible",
			source: "user",
		};
		const hidden: Skill = {
			...visible,
			name: "hidden",
			description: "Hidden skill description",
			hide: true,
		};
		const session = sessionWith({
			prompt: ["Effective policy including visible and hidden skill descriptions.\n".repeat(20)],
			skills: onlyHidden ? [hidden] : [visible, hidden],
			tools: hasRead ? [tool("read")] : [],
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				skillful,
			}),
		});
		const data = buildSessionContextView(session);
		const shared = computeSessionContextBreakdown(session).categories.find(category => category.id === "skills")!;
		const expected = attributed ? session.agent.tokenizer.countTokens([visible.name, visible.description]) : 0;
		expect(shared.tokens).toBe(expected);
		expect(category(data, "skills")).toMatchObject({ tokens: expected, entries: [] });
		const system = category(data, "system-prompt");
		const promptTokens = session.agent.tokenizer.countTokens(session.systemPrompt[0]!);
		expect(system.entries[0]!.text).toBe(session.systemPrompt[0]!);
		expect(system.entries[0]!.tokens).toBe(promptTokens);
		expect(system.tokens + expected).toBe(promptTokens);
	});

	it("clamps the System Prompt total when the shared Skills estimate exceeds the effective blocks", () => {
		const session = sessionWith({
			prompt: [""],
			tools: [tool("read")],
			skills: [
				{
					name: "fixture",
					description: "A nonempty skill description",
					filePath: "/nonexistent/SKILL.md",
					baseDir: "/nonexistent",
					source: "user",
				},
			],
		});
		const data = buildSessionContextView(session);
		expect(category(data, "skills").tokens).toBeGreaterThan(0);
		expect(category(data, "skills").entries).toEqual([]);
		expect(category(data, "system-prompt")).toMatchObject({
			tokens: 0,
			entries: [{ id: "system-prompt/0", text: "", tokens: 0 }],
		});
	});
});

describe("context snapshot tool schemas", () => {
	it("keeps a tool inspectable when its schema is cyclic", () => {
		const broken = tool("cyclic");
		const schema: Record<string, unknown> = {};
		schema.self = schema;
		broken.parameters = schema as never;
		const session = sessionWith({ tools: [broken] });
		const data = buildSessionContextView(session);
		expect(category(data, "custom-tools").entries[0]?.text).toContain("Schema unavailable");
	});
});

describe("context snapshot assistant reasoning", () => {
	it("separates assistant blocks without charging reasoning usage repeatedly and shows only signature sizes", () => {
		const message = reply([
			{ type: "text", text: "visible answer" },
			{ type: "thinking", thinking: "readable thought", thinkingSignature: "private-signature" },
			{ type: "thinking", thinking: "", thinkingSignature: "private-encoded-thinking" },
			{ type: "redactedThinking", data: "private-ciphertext" },
			{ type: "toolCall", name: "read", id: "duplicate", arguments: { path: "notes.txt" } },
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const data = buildSessionContextView(session);
		expect(category(data, "assistant-messages").entries.map(entry => entry.text)).toEqual(["visible answer"]);
		const thinking = category(data, "assistant-thinking").entries;
		expect(thinking.map(entry => entry.text)).toEqual([
			"readable thought",
			"[Encrypted thinking]",
			"[Encrypted thinking]",
		]);
		expect(thinking.map(entry => entry.info)).toEqual([
			"signature · 17 chars",
			"signature · 24 chars",
			"data · 18 chars",
		]);
		expect(category(data, "tool-calls").entries[0]?.text).toContain('"path": "notes.txt"');
		expect(totalTokens(data)).toBe(session.agent.tokenizer.countMessages([message]));
		expect(JSON.stringify(data)).not.toMatch(/private-signature|private-encoded-thinking|private-ciphertext/);
	});

	it("prices the latest surviving signed turn until a newer assistant response survives replay", () => {
		const message: AssistantMessage = {
			...reply([
				{ type: "thinking", thinking: "retained excerpt", thinkingSignature: "private-signature" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "notes.md" } },
			]),
			stopReason: "length",
			usage: { ...reply([]).usage, output: 1000 },
		};
		const session = sessionWith({ prompt: [], messages: [message] });
		const initial = buildSessionContextView(session);
		expect(totalTokens(initial)).toBe(1000);
		expect(category(initial, "assistant-thinking").tokens).toBe(1000 - category(initial, "tool-calls").tokens);

		session.agent.appendMessage({ ...reply([]), stopReason: "length" });
		expect(totalTokens(buildSessionContextView(session))).toBe(1000);

		const next = reply([{ type: "text", text: "new response" }]);
		session.agent.appendMessage(next);
		const updated = buildSessionContextView(session);
		expect(totalTokens(updated)).toBe(
			session.agent.tokenizer.countMessage(message) + session.agent.tokenizer.countMessage(next),
		);
		expect(category(updated, "assistant-thinking").tokens).toBe(
			session.agent.tokenizer.countTokens("retained excerpt"),
		);
		expect(totalTokens(initial)).toBe(1000);
		expect(JSON.stringify(updated)).not.toContain("private-signature");
	});

	it.each([
		{ name: "payload-only reasoning", explicitThinking: false },
		{ name: "payload with an explicit thinking block", explicitThinking: true },
	])("counts one reasoning budget without exposing its payload: $name", ({ explicitThinking }) => {
		const reader = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol")!;
		const message = payloadReply(reader, explicitThinking);
		const session = sessionWith({ model: reader, prompt: [], messages: [message] });
		const before = structuredClone(session.messages);
		const data = buildSessionContextView(session);
		const visibleTokens = session.agent.tokenizer.countTokens("visible answer");
		const thinking = category(data, "assistant-thinking");
		expect(thinking.entries).toEqual([expect.objectContaining({ tokens: 1_000, timestamp: message.timestamp })]);
		expect(thinking.tokens).toBe(1_000);
		expect(category(data, "assistant-messages").tokens).toBe(visibleTokens);
		expect(totalTokens(data)).toBe(visibleTokens + 1_000);
		expect(JSON.stringify(data)).not.toMatch(/private-ciphertext|rs_private|encrypted_content/);
		expect(session.messages).toEqual(before);
	});

	it("drops payload reasoning after switching to an incompatible or filtering reader", () => {
		const reader = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol")!;
		const session = sessionWith({ model: reader, prompt: [], messages: [payloadReply(reader)] });
		const initial = buildSessionContextView(session);
		expect(category(initial, "assistant-thinking").tokens).toBe(1_000);

		session.agent.setModel(getBundledModel("openai-codex", "gpt-6-sol")!);
		const changedReader = buildSessionContextView(session);
		expect(category(changedReader, "assistant-thinking").entries).toEqual([]);
		expect(totalTokens(changedReader)).toBe(session.agent.tokenizer.countTokens("visible answer"));

		session.agent.setModel({ ...reader, compat: { ...reader.compat, filterReasoningHistory: true } });
		const filtered = buildSessionContextView(session);
		expect(category(filtered, "assistant-thinking").entries).toEqual([]);
		expect(totalTokens(filtered)).toBe(session.agent.tokenizer.countTokens("visible answer"));
		expect(category(initial, "assistant-thinking").tokens).toBe(1_000);
	});

	it("keeps the tokenizer's thinking budget at message scope without assigning it to individual blocks", () => {
		const reader = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol")!;
		const summary = "A visible summary of the second reasoning item.";
		const message: AssistantMessage = {
			...reply([
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: summary },
				{ type: "text", text: "Answer" },
			]),
			api: reader.api,
			provider: reader.provider,
			model: reader.id,
			stopReason: "stop",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: reader.provider,
				dt: true,
				items: [
					{ type: "reasoning", id: "rs_first", summary: [], encrypted_content: "private-first" },
					{
						type: "reasoning",
						id: "rs_second",
						summary: [{ type: "summary_text", text: summary }],
						encrypted_content: "private-second",
					},
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
				],
			},
			usage: { ...reply([]).usage, output: 1033, reasoningTokens: 846 },
		};
		const session = sessionWith({ model: reader, prompt: [], messages: [message] });
		const data = buildSessionContextView(session);
		const thinking = category(data, "assistant-thinking");
		const messageTokens = session.agent.tokenizer.countMessage(message);
		const reasoningBudget = messageTokens - session.agent.tokenizer.countTokens("Answer");
		expect(thinking.tokens).toBe(reasoningBudget);
		expect(thinking.entries.map(entry => entry.thinkingGroup?.tokens)).toEqual([reasoningBudget, reasoningBudget]);
		expect(thinking.entries.map(entry => entry.tokens)).toEqual([0, 0]);
		expect(totalTokens(data)).toBe(messageTokens);
		expect(JSON.stringify(data)).not.toMatch(/private-first|private-second|rs_first|rs_second/);

		session.agent.setModel(getBundledModel("openai-codex", "gpt-6-sol")!);
		const demoted = buildSessionContextView(session);
		expect(category(demoted, "assistant-thinking").tokens).toBe(session.agent.tokenizer.countTokens(summary));
	});

	it.each([
		{ name: "unmeasured interruption", reasoningTokens: undefined, interrupted: true },
		{ name: "measured zero", reasoningTokens: 0, interrupted: false },
	])("distinguishes empty thinking with zero usage: $name", ({ reasoningTokens, interrupted }) => {
		const message: AssistantMessage = {
			...reply([{ type: "thinking", thinking: "" }]),
			stopReason: "aborted",
			usage: { ...reply([]).usage, output: 0, totalTokens: 0, reasoningTokens },
		};
		const data = buildSessionContextView(sessionWith({ prompt: [], messages: [message] }));
		const thinking = category(data, "assistant-thinking");
		expect(thinking.tokens).toBe(0);
		expect(thinking.entries[0]?.interrupted).toBe(interrupted);
	});
});

describe("context snapshot message projection and snapshots", () => {
	it("keeps old tool and prompt snapshots detached while new snapshots use the active state", () => {
		const session = sessionWith({
			prompt: ["original system"],
			tools: [tool("read"), tool("extension")],
		});
		const initial = buildSessionContextView(session);
		session.agent.setTools([tool("replacement")]);
		session.agent.setSystemPrompt(["different system"]);
		const updated = buildSessionContextView(session);
		expect(category(updated, "built-in-tools").entries).toEqual([]);
		expect(category(updated, "custom-tools").entries.map(entry => entry.label)).toEqual(["replacement"]);
		expect(category(updated, "system-prompt").entries.map(entry => entry.text)).toEqual(["different system"]);
		expect(category(initial, "built-in-tools").entries.map(entry => entry.label)).toEqual(["read"]);
		expect(category(initial, "custom-tools").entries.map(entry => entry.label)).toEqual(["extension"]);
		expect(category(initial, "system-prompt").entries.map(entry => entry.text)).toEqual(["original system"]);
	});

	it("projects canonical tool names and metadata without rewriting saved content", () => {
		const assistant = reply([
			{ type: "toolCall", name: "xd://recall", id: "call", arguments: { query: "history" } },
			{ type: "text", text: "assistant answer" },
		]);
		const messages: AgentMessage[] = [
			assistant,
			{
				role: "toolResult",
				toolName: "xd://recall",
				toolCallId: "call",
				content: [{ type: "text", text: "remembered result" }],
				isError: false,
				timestamp: 12,
			},
		];
		const session = sessionWith({ messages });
		const before = structuredClone(session.messages);
		const data = buildSessionContextView(session);
		expect(category(data, "assistant-messages").entries.map(entry => entry.timestamp)).toEqual([10]);
		const call = category(data, "tool-calls").entries[0]!;
		expect(call).toMatchObject({ label: "recall", timestamp: 10, callId: "call" });
		expect(JSON.parse(call.text)).toEqual({ query: "history" });
		expect(category(data, "tool-output").entries[0]).toMatchObject({
			label: "recall",
			timestamp: 12,
			callId: "call",
		});
		expect(category(data, "tool-output").children?.map(group => group.label)).toEqual(["recall"]);
		expect(session.messages).toEqual(before);
	});

	it("keeps a tool call without arguments inspectable and charges no phantom thinking", () => {
		const call = { type: "toolCall", name: "read", id: "call", arguments: undefined };
		const assistant = reply([call as unknown as AssistantMessage["content"][number]]);
		const data = buildSessionContextView(sessionWith({ messages: [assistant] }));
		expect(category(data, "tool-calls").entries[0]).toMatchObject({ label: "read", text: "null" });
		expect(category(data, "assistant-thinking").entries).toEqual([]);
	});

	it("rebuilds thinking after continuity changes without mutating earlier snapshots or production caches", () => {
		const assistant = {
			...reply([
				{ type: "thinking", thinking: "complete reasoning", thinkingSignature: "signed" },
				{ type: "thinking", thinking: "unfinished reasoning" },
			]),
			stopReason: "aborted",
		} satisfies AssistantMessage;
		const session = sessionWith({ messages: [assistant] });
		const before = structuredClone(assistant);
		const initial = buildSessionContextView(session);
		expect(category(initial, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"complete reasoning",
			"unfinished reasoning",
		]);
		session.agent.appendMessage({
			role: "custom",
			customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
			content: "continuity",
			display: false,
			attribution: "agent",
			timestamp: 11,
		});
		const productionHistory = [...session.messages];
		const projected = convertToLlm(productionHistory);
		expect(projected[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "thinking", thinking: "complete reasoning" }],
		});
		const updated = buildSessionContextView(session);
		expect(category(updated, "assistant-thinking").entries.map(entry => entry.text)).toEqual(["complete reasoning"]);
		expect(category(updated, "user-messages").entries).toEqual([
			expect.objectContaining({
				info: "custom · interrupted-thinking → developer",
				text: "continuity",
				timestamp: 11,
			}),
		]);
		session.agent.state.messages.pop();
		expect(buildSessionContextView(session)).toEqual(initial);
		expect(category(initial, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"complete reasoning",
			"unfinished reasoning",
		]);
		expect(assistant).toEqual(before);
		expect(convertToLlm(productionHistory)).toBe(projected);
		expect(convertToLlm([...productionHistory])[0]).toBe(projected[0]);
	});

	it("retains source and output positions across omitted executions, empty interruptions and image splits", () => {
		const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" } as const;
		const session = sessionWith({
			messages: [
				{
					role: "bashExecution",
					command: "excluded",
					output: "hidden",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: 1,
				},
				{
					role: "custom",
					customType: "image-note",
					content: [{ type: "text", text: "same body" }, image],
					display: false,
					timestamp: 2,
				},
				{
					role: "fileMention",
					files: [
						{ path: "notes.md", content: "same body" },
						{ path: "picture.png", content: "", image },
					],
					timestamp: 3,
				},
				{
					role: "pythonExecution",
					code: "print('kept')",
					output: "kept output",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 4,
				},
				{ ...reply([]), stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL },
				{ role: "user", content: "same body", timestamp: 6 },
			],
		});
		const before = structuredClone(session.messages);
		const data = buildSessionContextView(session);
		const users = category(data, "user-messages").entries;
		expect(users.map(entry => entry.id)).toEqual([
			"user-messages/1/0",
			"user-messages/1/1",
			"user-messages/2/2",
			"user-messages/2/3",
			"user-messages/5/5",
		]);
		expect(users.slice(0, 2).every(entry => entry.info?.includes("image-note"))).toBe(true);
		expect(users.slice(2, 4).every(entry => entry.info?.includes("fileMention"))).toBe(true);
		expect(users[2]?.text).toContain('<file path="notes.md">');
		expect(users[3]?.text).toContain('<file path="picture.png">');
		expect(users[4]?.info).toBeUndefined();
		const output = category(data, "tool-output");
		expect(output.children?.map(group => group.label)).toEqual(["python"]);
		expect(output.entries[0]?.id).toBe("tool-output/3/4");
		expect(output.entries[0]?.info).toContain("pythonExecution");
		expect(output.entries[0]?.text).toContain("kept output");
		expect(session.messages).toEqual(before);
	});

	it("keeps included bash execution output while excluding python executions", () => {
		const messages: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "echo kept",
				output: "saved stdout",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{
				role: "pythonExecution",
				code: "print('excluded')",
				output: "hidden",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			},
		];
		const session = sessionWith({ messages });
		const data = buildSessionContextView(session);
		expect(category(data, "tool-output").children?.map(group => group.label)).toEqual(["bash"]);
		expect(category(data, "tool-output").entries[0]?.text).toContain("saved stdout");
		expect(JSON.stringify(data)).not.toContain("excluded");
	});

	it("counts original image content rather than its display summary without exposing binary data", () => {
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
			timestamp: 5,
		};
		const session = sessionWith({ messages: [message] });
		const data = buildSessionContextView(session);
		const users = category(data, "user-messages").entries;
		expect(users).toEqual([
			expect.objectContaining({
				text: expect.stringContaining("image/png"),
				tokens: session.agent.tokenizer.countMessages([message]),
			}),
		]);
		expect(JSON.stringify(data)).not.toContain("aGVsbG8=");
	});
});

describe("context snapshot tool calls and output", () => {
	it("groups retained server-tool calls and results while replacing provider ciphertext with its size", () => {
		const message = reply([
			{
				type: "anthropicServerTool",
				block: { type: "server_tool_use", id: "search", name: "web_search", input: { query: "release notes" } },
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "tools",
					name: "tool_search_tool_regex",
					input: { pattern: "read.*" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "tool_search_tool_result",
					tool_use_id: "tools",
					content: [{ type: "tool_reference", tool_name: "read_file" }],
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "search",
					content: [
						{
							type: "web_search_result",
							title: "Release notes",
							url: "https://example.org/releases",
							encrypted_content: "private-ciphertext",
							signature: "private-signature",
						},
					],
				},
			},
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const before = structuredClone(message);
		const data = buildSessionContextView(session);
		const calls = category(data, "tool-calls").entries;
		expect(calls.map(entry => [entry.label, entry.callId])).toEqual([
			["web_search", "search"],
			["tool_search_tool_regex", "tools"],
		]);
		expect(JSON.parse(calls[0]!.text).input).toEqual({ query: "release notes" });
		const results = category(data, "tool-output");
		expect(results.entries.map(entry => [entry.label, entry.callId, entry.timestamp])).toEqual([
			["tool_search_tool_regex", "tools", message.timestamp],
			["web_search", "search", message.timestamp],
		]);
		expect(JSON.parse(results.entries[0]!.text).content).toEqual([
			{ type: "tool_reference", tool_name: "read_file" },
		]);
		expect(JSON.parse(results.entries[1]!.text).content).toEqual([
			{
				type: "web_search_result",
				title: "Release notes",
				url: "https://example.org/releases",
				encrypted_content: "[encrypted_content · 18 chars]",
				signature: "[signature · 17 chars]",
			},
		]);
		expect(category(data, "assistant-messages").entries).toEqual([]);
		expect(totalTokens(data)).toBe(session.agent.tokenizer.countMessages([message]));
		expect(message).toEqual(before);
	});

	it("sorts tool groups by token totals and saved results by timestamp then conversation order", () => {
		const result = (name: string, text: string, timestamp: number): AgentMessage => ({
			role: "toolResult",
			toolName: name,
			toolCallId: "duplicate",
			content: [{ type: "text", text }],
			isError: false,
			timestamp,
		});
		const session = sessionWith({
			messages: [
				result("small", "b", 20),
				result("large", "large ".repeat(100), 30),
				result("small", "a", 10),
				result("small", "c", 20),
			],
		});
		const output = category(buildSessionContextView(session), "tool-output");
		expect(output.children?.map(group => group.label)).toEqual(["large", "small"]);
		expect(output.children?.[1]?.entries.map(entry => entry.text)).toEqual(["a", "b", "c"]);
		expect(output.entries.map(entry => entry.text)).toEqual(["a", "b", "c", "large ".repeat(100)]);
		expect(new Set(output.entries.map(entry => entry.id)).size).toBe(4);
		expect(output.tokens).toBe(output.children!.reduce((sum, group) => sum + group.tokens, 0));
	});

	it("keeps first-appearance group order when token totals tie, regardless of result timestamps", () => {
		const messages: AgentMessage[] = ["zulu", "alfa"].map((toolName, index) => ({
			role: "toolResult",
			toolName,
			toolCallId: "duplicate",
			content: [{ type: "text", text: "same output" }],
			isError: false,
			timestamp: index === 0 ? 30 : 10,
		}));
		const output = category(buildSessionContextView(sessionWith({ messages })), "tool-output");
		expect(output.children?.map(group => group.tokens)).toEqual([output.tokens / 2, output.tokens / 2]);
		expect(output.children?.map(group => group.label)).toEqual(["zulu", "alfa"]);
		expect(output.entries.map(entry => entry.label)).toEqual(["alfa", "zulu"]);
	});
});
