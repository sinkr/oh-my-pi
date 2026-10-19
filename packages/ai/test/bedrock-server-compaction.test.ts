import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { completeSimple } from "@oh-my-pi/pi-ai/stream";

import { Effort } from "@oh-my-pi/pi-catalog/effort";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	bedrockHappyPathFrames,
	bedrockTestModel,
	BEDROCK_TEST_CONTEXT,
	withSkippedBedrockAuth,
} from "./helpers/bedrock-stream";

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function captureFetch(response: () => Response): { fetch: FetchImpl; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const rawBody = init?.body;
			const bodyText = rawBody instanceof Uint8Array ? new TextDecoder().decode(rawBody) : String(rawBody ?? "");
			const parsed: unknown = JSON.parse(bodyText);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Expected a JSON object request body");
			}
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: parsed as Record<string, unknown>,
			});
			return response();
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as FetchImpl;
	return { fetch, requests };
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (typeof block !== "object" || block === null || !("text" in block)) return "";
			const text = block.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function eventStreamResponse(): Response {
	const frames = bedrockHappyPathFrames();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) controller.enqueue(frame);
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
	);
}

function compactionModel(remoteCompaction?: { enabled?: boolean }) {
	return bedrockTestModel({
		compat: { supportsServerCompaction: true },
		...(remoteCompaction === undefined ? {} : { remoteCompaction }),
	});
}
const SIGNED_TOOL_CHANGES: Record<string, unknown>[] = [
	{
		type: "tool_addition",
		tool: { type: "tool_reference", name: "search" },
		opaque: { key: "bedrock-signed-add", details: ["opaque", { revision: 4 }] },
	},
	{
		type: "tool_removal",
		tool: { type: "tool_reference", name: "legacy_search" },
		opaque: { key: "bedrock-signed-remove", details: ["opaque", { revision: 9 }] },
	},
];

const compactionResponse = {
	id: "msg_compaction",
	model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
	content: [
		{
			type: "compaction",
			content: "Signed compacted context",
			signature: "opaque-bedrock-signature",
			tool_changes: SIGNED_TOOL_CHANGES,
		},
	],
	stop_reason: "compaction",
	usage: {
		input_tokens: 1,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		iterations: [
			{ type: "message", input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 2 },
			{
				type: "compaction",
				input_tokens: 20,
				output_tokens: 3,
				cache_read_input_tokens: 4,
				cache_creation_input_tokens: 1,
			},
		],
	},
};

describe("Bedrock native compaction transport", () => {
	it("uses authenticated InvokeModel with Anthropic compaction body and returns signed summary usage", async () => {
		const { fetch, requests } = captureFetch(() => Response.json(compactionResponse));
		const model = compactionModel();
		const result = await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			anthropicCompaction: { instructions: "Keep only verified findings." },
			requestMetadata: { run: "compaction" },

			fetch,
		});
		expect(requests[0]?.url).toBe(
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
		);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer bedrock-test-token");
		expect(requests[0]?.headers.get("x-amzn-bedrock-request-metadata")).toBe('{"run":"compaction"}');
		expect(requests[0]?.headers.get("accept")).toBe("application/json");
		expect(requests[0]?.headers.get("content-type")).toBe("application/json");
		const body = requests[0]?.body;
		expect(body).toMatchObject({
			anthropic_version: "bedrock-2023-05-31",
			anthropic_beta: ["compact-2026-09-04"],
			compaction: { type: "summarize", instructions: "Keep only verified findings." },
		});
		const requestMessages = body?.messages;
		expect(Array.isArray(requestMessages)).toBe(true);
		if (!Array.isArray(requestMessages)) throw new Error("Expected Anthropic request messages");
		expect(requestMessages).toHaveLength(1);
		expect(requestMessages[0]).toMatchObject({ role: "user" });
		expect(messageText(requestMessages[0])).toBe("hi");
		expect(body?.model).toBeUndefined();
		expect(body?.stream).toBeUndefined();
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.providerPayload).toMatchObject({
			type: "anthropicCompaction",
			provider: "amazon-bedrock",
			model: model.id,
			api: "bedrock-converse-stream",
			content: "Signed compacted context",
			signature: "opaque-bedrock-signature",
			toolChanges: SIGNED_TOOL_CHANGES,
		});
		if (result.providerPayload?.type !== "anthropicCompaction") {
			throw new Error("expected signed compaction payload");
		}
		expect(result.providerPayload.toolChanges).toEqual(SIGNED_TOOL_CHANGES);
		expect(result.usage).toMatchObject({ input: 32, output: 4, cacheRead: 6, cacheWrite: 1, totalTokens: 43 });
	});
	it("uses KDL-resolved Opus 5.5 effort and all Anthropic wire-control betas", async () => {
		const model = bedrockTestModel({
			id: "global.anthropic.claude-opus-5-5",
			name: "Claude Opus 5.5",
			reasoning: true,
			compat: { supportsServerCompaction: true },
		});
		const { fetch, requests } = captureFetch(() => Response.json(compactionResponse));
		await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			reasoning: Effort.Low,
			anthropicCompaction: {},
			taskBudget: { type: "tokens", total: 1024, remaining: 512 },
			fetch,
		});

		const body = requests[0]?.body;
		expect(body?.thinking).toMatchObject({
			type: "adaptive",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(body?.output_config).toMatchObject({ effort: "low", task_budget: { type: "tokens", total: 1024 } });
		expect(JSON.stringify(body?.output_config)).not.toContain("remaining");

		const betas = body?.anthropic_beta as string[];
		expect(betas).toContain("compact-2026-09-04");
		expect(betas).toContain("thinking-binding-controls-2026-08-01");
		expect(betas).toContain("effort-2025-11-24");
		expect(betas).toContain("task-budgets-2026-03-13");
	});

	it("keeps ordinary and unsupported/disabled requests on Converse without compaction beta", async () => {
		const cases = [
			{ model: compactionModel(), options: {} },
			{
				model: bedrockTestModel({ compat: { supportsServerCompaction: false } }),
				options: { anthropicCompaction: {} },
			},
			{ model: compactionModel({ enabled: false }), options: { anthropicCompaction: {} } },
		];

		for (const entry of cases) {
			const { fetch, requests } = captureFetch(eventStreamResponse);
			await streamBedrock(entry.model, BEDROCK_TEST_CONTEXT, {
				bearerToken: "bedrock-test-token",
				...entry.options,
				fetch,
			}).result();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toEndWith("/converse-stream");
			expect(requests[0]?.headers.get("accept")).toBe("application/vnd.amazon.eventstream");
			expect(requests[0]?.body.compaction).toBeUndefined();
			expect(requests[0]?.body.anthropic_beta).toBeUndefined();
		}
	});

	it("replays signed state only on its Bedrock model/API and keeps ordinary Converse summaries textual", async () => {
		const producer = compactionModel();
		const produced = await streamBedrock(producer, BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: captureFetch(() => Response.json(compactionResponse)).fetch,
		}).result();
		const payload = produced.providerPayload;
		if (payload?.type !== "anthropicCompaction") throw new Error("expected a signed compaction payload");
		const context = {
			messages: [
				{
					role: "user" as const,
					content: "<summary>Signed compacted context</summary>",
					providerPayload: payload,
					timestamp: 1,
				},
				{ role: "user" as const, content: "Continue", timestamp: 2 },
			],
		};

		const sameModel = captureFetch(() => Response.json(compactionResponse));
		await streamBedrock(producer, context, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: sameModel.fetch,
		}).result();
		const replayMessages = sameModel.requests[0]?.body.messages;
		expect(Array.isArray(replayMessages)).toBe(true);
		if (!Array.isArray(replayMessages)) throw new Error("Expected Anthropic replay messages");
		expect(replayMessages).toHaveLength(2);
		expect(replayMessages[0]).toMatchObject({ role: "assistant" });
		const firstMessage = replayMessages[0];
		const firstContent =
			typeof firstMessage === "object" && firstMessage !== null && "content" in firstMessage
				? firstMessage.content
				: undefined;
		const firstBlock = Array.isArray(firstContent) ? firstContent[0] : undefined;
		expect(firstBlock).toMatchObject({
			type: "compaction",
			content: "Signed compacted context",
			signature: "opaque-bedrock-signature",
		});
		expect(
			typeof firstBlock === "object" && firstBlock !== null && "tool_changes" in firstBlock
				? firstBlock.tool_changes
				: undefined,
		).toEqual(SIGNED_TOOL_CHANGES);
		expect(replayMessages[1]).toMatchObject({ role: "user" });
		expect(messageText(replayMessages[1])).toBe("Continue");

		const otherModel = bedrockTestModel({
			id: "anthropic.other-bedrock-model",
			compat: { supportsServerCompaction: true },
		});
		const crossModel = captureFetch(() => Response.json(compactionResponse));
		await streamBedrock(otherModel, context, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: crossModel.fetch,
		}).result();
		const crossModelMessages = JSON.stringify(crossModel.requests[0]?.body.messages);
		expect(crossModelMessages).toContain("Signed compacted context");
		expect(crossModelMessages).not.toContain("opaque-bedrock-signature");
		expect(crossModelMessages).not.toContain('"type":"compaction"');
		expect(crossModelMessages).not.toContain("bedrock-signed-add");
		expect(crossModelMessages).not.toContain("bedrock-signed-remove");

		const portable = captureFetch(eventStreamResponse);
		await streamBedrock(producer, context, {
			bearerToken: "bedrock-test-token",
			fetch: portable.fetch,
		}).result();
		expect(portable.requests[0]?.url).toEndWith("/converse-stream");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).toContain("Signed compacted context");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("opaque-bedrock-signature");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("tool_changes");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("bedrock-signed-add");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("bedrock-signed-remove");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain('"type":"compaction"');
	});

	it("preserves InvokeModel HTTP failure status and caller cancellation", async () => {
		const failed = captureFetch(() => new Response("Access denied", { status: 403 }));
		const failure = await streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: failed.fetch,
		}).result();
		expect(failure.stopReason).toBe("error");
		expect(failure.errorStatus).toBe(403);
		expect(failed.requests[0]?.url).toEndWith("/invoke");
		const signed = captureFetch(() => Response.json(compactionResponse));
		await withSkippedBedrockAuth(async () => {
			await streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
				anthropicCompaction: {},
				fetch: signed.fetch,
			}).result();
		});
		expect(signed.requests[0]?.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
		expect(signed.requests[0]?.headers.get("x-amz-date")).toBeTruthy();

		const controller = new AbortController();
		const requestStarted = Promise.withResolvers<void>();
		const waitingFetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				requestStarted.resolve();
				return await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal?.aborted) {
						reject(new DOMException("The operation was aborted", "AbortError"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => reject(new DOMException("The operation was aborted", "AbortError")),
						{ once: true },
					);
				});
			},
			{ preconnect: fetch.preconnect },
		) as FetchImpl;
		const pending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: waitingFetch,
			signal: controller.signal,
		});
		await requestStarted.promise;
		controller.abort();
		expect((await pending.result()).stopReason).toBe("aborted");
	});
});
