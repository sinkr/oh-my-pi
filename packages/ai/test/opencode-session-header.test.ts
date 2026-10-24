import { describe, expect, it } from "bun:test";
import { completeSimple, stream } from "@oh-my-pi/pi-ai";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { normalizeOpenAIPromptCacheKey, resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { USER_AGENT } from "@oh-my-pi/pi-utils";

import { withEnv } from "./helpers";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

const OPENCODE_GO_COMPLETIONS_MODEL = {
	provider: "opencode-go",
	id: "kimi-k2.7-code",
	baseUrl: "https://opencode.ai/zen/go/v1",
};

function chatSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function anthropicSse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const payload = `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeOpenCodeGoCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		...OPENCODE_GO_COMPLETIONS_MODEL,
		name: "Kimi K2.7 Code",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
	});
}

function makeOpenCodeGoCompletionsLaneModel(id: string, name: string): Model<"openai-completions"> {
	return buildModel({
		provider: "opencode-go",
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function makeOpenCodeGoLunaModel(): Model<"openai-responses"> {
	return buildModel({
		provider: "opencode-go",
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "openai-responses",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
}

function makeOpenCodeGoMuseModel(id = "muse-spark-1.3"): Model<"openai-responses"> {
	return buildModel({
		provider: "opencode-go",
		id,
		name: id === "muse-spark-1.3" ? "Muse Spark 1.3" : "Muse Spark 1.2",
		api: "openai-responses",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function makeOpenCodeZenMuseModel(): Model<"openai-responses"> {
	return buildModel({
		provider: "opencode-zen",
		id: "muse-spark-1.3",
		name: "Muse Spark 1.3",
		api: "openai-responses",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function makeOpenAICompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
	});
}

function makeLiteLLMCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "proxy-model",
		name: "Proxy Model",
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "https://litellm.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

function makeOpenCodeGoGoogleModel(): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

function makeAnthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

function makeOpenCodeGoAnthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "qwen3.7-max",
		name: "Qwen3.7 Max",
		api: "anthropic-messages",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function makeOpenCodeGoHaikuModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		api: "anthropic-messages",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

describe("opencode and gpt session header on OpenAI transports", () => {
	it("sends the conversation session id to OpenCode", () => {
		const setup = resolveOpenAIRequestSetup(OPENCODE_GO_COMPLETIONS_MODEL, {
			apiKey: "key",
			messages: [],
			sessionId: "session-1",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("session-1");
		expect(setup.headers["User-Agent"]).toBe(USER_AGENT);
		expect(setup.headers.session_id).toBeUndefined();
	});

	it("falls back to the prompt-cache session id", () => {
		const setup = resolveOpenAIRequestSetup(OPENCODE_GO_COMPLETIONS_MODEL, {
			apiKey: "key",
			messages: [],
			promptCacheSessionId: "cache-1",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("cache-1");
	});

	it("generates one session id at the inference boundary when the caller omitted it", async () => {
		let sessionId: string | null = null;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			sessionId = new Headers(init?.headers).get(OPENCODE_SESSION_HEADER);
			return chatSse();
		};

		const response = await completeSimple(
			makeOpenCodeGoCompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", fetch: fetchMock as typeof fetch },
		);

		expect(response.stopReason).toBe("stop");
		expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("replaces conflicting caller values with the authoritative session id", () => {
		const setup = resolveOpenAIRequestSetup(OPENCODE_GO_COMPLETIONS_MODEL, {
			apiKey: "key",
			messages: [],
			extraHeaders: { "X-OpenCode-Session": "caller" },
			sessionId: "session-1",
		});
		expect(setup.headers["X-OpenCode-Session"]).toBeUndefined();
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("session-1");
	});

	it("sends session_id and x-client-request-id on OpenAI requests", () => {
		const setup = resolveOpenAIRequestSetup(
			{ provider: "openai", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" },
			{ apiKey: "key", messages: [], sessionId: "session-1" },
		);
		expect(setup.headers.session_id).toBe("session-1");
		expect(setup.headers["x-client-request-id"]).toBe("session-1");
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
		expect(setup.headers["x-litellm-session-id"]).toBeUndefined();
	});

	it("sends x-litellm-session-id on LiteLLM requests even with prompt caching disabled", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return chatSse();
		};

		const response = await completeSimple(
			makeLiteLLMCompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", sessionId: "session-1", cacheRetention: "none", fetch: fetchMock as typeof fetch },
		);

		expect(response.stopReason).toBe("stop");
		expect(headersSeen[0]?.get("x-litellm-session-id")).toBe("session-1");
		expect(headersSeen[0]?.get("session_id")).toBeNull();
	});

	it("keeps a configured x-litellm-session-id over the conversation session id", () => {
		const setup = resolveOpenAIRequestSetup(makeLiteLLMCompletionsModel(), {
			apiKey: "key",
			messages: [],
			extraHeaders: { "X-LiteLLM-Session-Id": "run-42" },
			sessionId: "session-1",
		});
		expect(setup.headers["X-LiteLLM-Session-Id"]).toBe("run-42");
		expect(setup.headers["x-litellm-session-id"]).toBeUndefined();
	});

	it("does not turn a shared prompt-cache key into a LiteLLM conversation", () => {
		const model = makeLiteLLMCompletionsModel();
		const cacheOnly = resolveOpenAIRequestSetup(model, {
			apiKey: "key",
			messages: [],
			promptCacheSessionId: "shared-cache",
		});
		expect(cacheOnly.headers["x-litellm-session-id"]).toBeUndefined();
		const conversation = resolveOpenAIRequestSetup(model, {
			apiKey: "key",
			messages: [],
			promptCacheSessionId: "shared-cache",
			sessionId: "conversation",
		});
		expect(conversation.headers["x-litellm-session-id"]).toBe("conversation");
	});

	it("applies omp's common User-Agent as the global inference default", async () => {
		const userAgents: Array<string | null> = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			userAgents.push(new Headers(init?.headers).get("User-Agent"));
			return chatSse();
		};

		const response = await completeSimple(
			makeOpenAICompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", sessionId: "session-1", fetch: fetchMock as typeof fetch },
		);

		expect(response.stopReason).toBe("stop");
		expect(userAgents).toEqual([USER_AGENT]);
	});

	it("applies the same default through the typed stream entrypoint", async () => {
		const userAgents: Array<string | null> = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			userAgents.push(new Headers(init?.headers).get("User-Agent"));
			return chatSse();
		};

		const response = await stream(
			makeOpenAICompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", sessionId: "session-1", fetch: fetchMock as typeof fetch },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(userAgents).toEqual([USER_AGENT]);
	});

	it("preserves an explicit User-Agent", async () => {
		const userAgents: Array<string | null> = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			userAgents.push(new Headers(init?.headers).get("User-Agent"));
			return chatSse();
		};

		const response = await completeSimple(
			makeOpenAICompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "key",
				sessionId: "session-1",
				headers: { "User-Agent": "other-client/1.0" },
				fetch: fetchMock as typeof fetch,
			},
		);

		expect(response.stopReason).toBe("stop");
		expect(userAgents).toEqual(["other-client/1.0"]);
	});
});

describe("Go sibling prompt-cache wire affinity", () => {
	it.each(["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2-contributor"])(
		"sends the shared task cache key as the OpenCode session header for %s",
		id => {
			const setup = resolveOpenAIRequestSetup(makeOpenCodeGoMuseModel(id), {
				apiKey: "key",
				messages: [],
				sessionId: "child-1",
				promptCacheAffinityKey: "parent:task",
			});
			expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("parent:task");
		},
	);

	it("keeps the child conversation id when the shared cache key is absent", () => {
		const setup = resolveOpenAIRequestSetup(makeOpenCodeGoMuseModel(), {
			apiKey: "key",
			messages: [],
			sessionId: "child-1",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("child-1");
	});

	it("keeps the child conversation id for an empty shared cache key", () => {
		const setup = resolveOpenAIRequestSetup(makeOpenCodeGoMuseModel(), {
			apiKey: "key",
			messages: [],
			sessionId: "child-1",
			promptCacheAffinityKey: "",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("child-1");
	});

	it("never lets a sessionId-derived cache id flip the header on an opted-in lane", () => {
		// Real callers resolve the shared cache id through getOpenAIPromptCacheKey,
		// which falls back to the sessionId normalized to the 64-char wire limit;
		// that derived value must never feed the family affinity.
		const sessionId = `child-${"0123456789".repeat(10)}`;
		const derivedCacheId = normalizeOpenAIPromptCacheKey(sessionId);
		expect(derivedCacheId?.startsWith("pc_")).toBe(true);
		const setup = resolveOpenAIRequestSetup(
			makeOpenCodeGoCompletionsLaneModel("mimo-v2.6-flash", "MiMo V2.6 Flash"),
			{
				apiKey: "key",
				messages: [],
				sessionId,
				promptCacheSessionId: derivedCacheId,
			},
		);
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe(sessionId);
	});

	it("keeps a long conversation id intact on the wire without an explicit cache key", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return chatSse();
		};
		const sessionId = `child-${"0123456789".repeat(10)}`;

		const response = await completeSimple(
			makeOpenCodeGoCompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", sessionId, fetch: fetchMock as typeof fetch },
		);

		expect(response.stopReason).toBe("stop");
		expect(headersSeen).toHaveLength(1);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe(sessionId);
	});

	it.each([
		["mimo-v2.6-flash", "MiMo V2.6 Flash"],
		["kimi-k2.7-code", "Kimi K2.7 Code"],
		["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
	])("sends the explicit shared cache key on the opted-in Go Completions lane %s", (id, name) => {
		const model = makeOpenCodeGoCompletionsLaneModel(id, name);
		const first = resolveOpenAIRequestSetup(model, {
			apiKey: "key",
			messages: [],
			sessionId: "child-1",
			promptCacheAffinityKey: "parent:task",
		});
		const second = resolveOpenAIRequestSetup(model, {
			apiKey: "key",
			messages: [],
			sessionId: "child-2",
			promptCacheAffinityKey: "parent:task",
		});
		expect(first.headers[OPENCODE_SESSION_HEADER]).toBe("parent:task");
		expect(second.headers[OPENCODE_SESSION_HEADER]).toBe("parent:task");
	});

	it("shares the family key across distinct child ids on the wire", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return chatSse();
		};

		for (const sessionId of ["child-1", "child-2"]) {
			const response = await completeSimple(
				makeOpenCodeGoCompletionsModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "key", sessionId, promptCacheKey: "parent:task", fetch: fetchMock as typeof fetch },
			);
			expect(response.stopReason).toBe("stop");
		}

		expect(headersSeen).toHaveLength(2);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe("parent:task");
		expect(headersSeen[1]?.get(OPENCODE_SESSION_HEADER)).toBe("parent:task");
	});

	it("keeps the conversation id on the wire when cache retention is disabled", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return chatSse();
		};

		const response = await completeSimple(
			makeOpenCodeGoCompletionsModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "key",
				sessionId: "child-1",
				promptCacheKey: "parent:task",
				cacheRetention: "none",
				fetch: fetchMock as typeof fetch,
			},
		);

		expect(response.stopReason).toBe("stop");
		expect(headersSeen).toHaveLength(1);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe("child-1");
	});

	it("keeps the family key on the wire when an explicit retention overrides PI_CACHE_RETENTION=none", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return chatSse();
		};

		for (const cacheRetention of ["short", "long"] as const) {
			await withEnv({ PI_CACHE_RETENTION: "none" }, async () => {
				const response = await completeSimple(
					makeOpenCodeGoCompletionsModel(),
					{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
					{
						apiKey: "key",
						sessionId: "child-1",
						promptCacheKey: "parent:task",
						cacheRetention,
						fetch: fetchMock as typeof fetch,
					},
				);
				expect(response.stopReason).toBe("stop");
			});
		}

		expect(headersSeen).toHaveLength(2);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe("parent:task");
		expect(headersSeen[1]?.get(OPENCODE_SESSION_HEADER)).toBe("parent:task");
	});

	it("keeps the child conversation id on the wire when PI_CACHE_RETENTION=none without an explicit retention", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return chatSse();
		};

		await withEnv({ PI_CACHE_RETENTION: "none" }, async () => {
			const response = await completeSimple(
				makeOpenCodeGoCompletionsModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "key", sessionId: "child-1", promptCacheKey: "parent:task", fetch: fetchMock as typeof fetch },
			);
			expect(response.stopReason).toBe("stop");
		});

		expect(headersSeen).toHaveLength(1);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe("child-1");
	});

	it("keeps unsupported Go lanes on the conversation session id", () => {
		const setup = resolveOpenAIRequestSetup(makeOpenCodeGoLunaModel(), {
			apiKey: "key",
			messages: [],
			sessionId: "child-1",
			promptCacheAffinityKey: "parent:task",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("child-1");
	});

	it("keeps non-opted Go Muse lanes on the conversation session id", () => {
		const setup = resolveOpenAIRequestSetup(makeOpenCodeGoMuseModel("muse-spark-1.2"), {
			apiKey: "key",
			messages: [],
			sessionId: "child-1",
			promptCacheAffinityKey: "parent:task",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("child-1");
	});

	it("does not extend the affinity to Zen", () => {
		const setup = resolveOpenAIRequestSetup(makeOpenCodeZenMuseModel(), {
			apiKey: "key",
			messages: [],
			sessionId: "child-1",
			promptCacheAffinityKey: "parent:task",
		});
		expect(setup.headers[OPENCODE_SESSION_HEADER]).toBe("child-1");
	});

	it("leaves non-Go providers on the conversation session id", () => {
		const setup = resolveOpenAIRequestSetup(
			{ provider: "openai", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" },
			{ apiKey: "key", messages: [], sessionId: "conversation", promptCacheSessionId: "shared-cache" },
		);
		expect(setup.headers.session_id).toBe("conversation");
		expect(setup.headers["x-opencode-session"]).toBeUndefined();
	});
});

describe("opencode session header on the Google transport", () => {
	it("maps the shared inference identity onto OpenCode headers", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers));
			return new Response(
				`data: ${JSON.stringify({
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};

		const response = await completeSimple(
			makeOpenCodeGoGoogleModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "key", sessionId: "session-1", fetch: fetchMock as typeof fetch },
		);

		expect(response.stopReason).toBe("stop");
		expect(headersSeen).toHaveLength(1);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe("session-1");
		expect(headersSeen[0]?.get("User-Agent")).toBe(USER_AGENT);
	});
});

describe("session header on the Anthropic transport", () => {
	it("sends both x-opencode-session and X-Claude-Code-Session-Id on OpenCode Anthropic", () => {
		const options = buildAnthropicClientOptions({
			model: makeOpenCodeGoAnthropicModel(),
			apiKey: "opencode_test_key",
			sessionId: "session-1",
		});
		expect(options.defaultHeaders[OPENCODE_SESSION_HEADER]).toBe("session-1");
		expect(options.defaultHeaders["X-Claude-Code-Session-Id"]).toBe("session-1");
		expect(options.defaultHeaders["User-Agent"]).toBe(USER_AGENT);
	});

	it("sends the shared cache key as x-opencode-session while the Claude session header stays the child id", () => {
		const options = buildAnthropicClientOptions({
			model: makeOpenCodeGoHaikuModel(),
			apiKey: "opencode_test_key",
			sessionId: "child-1",
			promptCacheKey: "parent:task",
		});
		expect(options.defaultHeaders[OPENCODE_SESSION_HEADER]).toBe("parent:task");
		expect(options.defaultHeaders["X-Claude-Code-Session-Id"]).toBe("child-1");
	});

	it("keeps the child session headers when cache retention is disabled", () => {
		const options = buildAnthropicClientOptions({
			model: makeOpenCodeGoHaikuModel(),
			apiKey: "opencode_test_key",
			sessionId: "child-1",
			promptCacheKey: "parent:task",
			cacheRetention: "none",
		});
		expect(options.defaultHeaders[OPENCODE_SESSION_HEADER]).toBe("child-1");
		expect(options.defaultHeaders["X-Claude-Code-Session-Id"]).toBe("child-1");
	});

	it("keeps the native Anthropic session header child-scoped on the wire", async () => {
		const headersSeen: Headers[] = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
			headersSeen.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
			return anthropicSse();
		};

		const response = await completeSimple(
			makeOpenCodeGoHaikuModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "opencode_test_key",
				sessionId: "child-1",
				promptCacheKey: "parent:task",
				fetch: fetchMock as typeof fetch,
			},
		);

		expect(response.stopReason).toBe("stop");
		expect(headersSeen).toHaveLength(1);
		expect(headersSeen[0]?.get(OPENCODE_SESSION_HEADER)).toBe("parent:task");
		expect(headersSeen[0]?.get("X-Claude-Code-Session-Id")).toBe("child-1");
	});

	it("preserves the Claude fingerprint for OpenCode OAuth requests", () => {
		const options = buildAnthropicClientOptions({
			model: makeOpenCodeGoAnthropicModel(),
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			sessionId: "session-1",
		});
		expect(options.defaultHeaders["User-Agent"]).toMatch(/^claude-cli\//);
		expect(options.defaultHeaders["User-Agent"]).not.toBe(USER_AGENT);
	});

	it("preserves the Claude OAuth User-Agent on the wire", async () => {
		const userAgents: Array<string | null> = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			userAgents.push(headers.get("User-Agent"));
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await completeSimple(
			makeAnthropicModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "sk-ant-oat-test",
				sessionId: "session-1",
				fetch: fetchMock as typeof fetch,
			},
		);

		expect(response.stopReason).toBe("error");
		expect(userAgents).toHaveLength(1);
		expect(userAgents[0]).toMatch(/^claude-cli\//);
	});

	it("always sends X-Claude-Code-Session-Id on standard Anthropic, but not x-opencode-session", () => {
		const options = buildAnthropicClientOptions({
			model: makeAnthropicModel(),
			apiKey: "sk-ant-test",
			sessionId: "session-1",
		});
		expect(options.defaultHeaders[OPENCODE_SESSION_HEADER]).toBeUndefined();
		expect(options.defaultHeaders["X-Claude-Code-Session-Id"]).toBe("session-1");
	});

	it("enforces one session id over conflicting caller headers", () => {
		const options = buildAnthropicClientOptions({
			model: makeOpenCodeGoAnthropicModel(),
			apiKey: "opencode_test_key",
			headers: { [OPENCODE_SESSION_HEADER]: "caller", "X-Claude-Code-Session-Id": "caller-claude" },
			sessionId: "session-1",
		});
		expect(options.defaultHeaders[OPENCODE_SESSION_HEADER]).toBe("session-1");
		expect(options.defaultHeaders["X-Claude-Code-Session-Id"]).toBe("session-1");
	});
});
