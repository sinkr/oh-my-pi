import { afterEach, describe, expect, it } from "bun:test";
import {
	buildAnthropicClientOptions,
	prewarmAnthropicConnection,
	resetAnthropicPrewarmForTesting,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function captureFetch(): { calls: Array<{ url: string; init: RequestInit & { tls?: unknown } }>; fetch: FetchImpl } {
	const calls: Array<{ url: string; init: RequestInit & { tls?: unknown } }> = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(null, { status: 404 });
	};
	return { calls, fetch };
}

afterEach(() => resetAnthropicPrewarmForTesting());

describe("prewarmAnthropicConnection", () => {
	it("warms with the real request's TLS options and no credentials, so the socket is reused", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmAnthropicConnection(MODEL, { fetch });

		const real = buildAnthropicClientOptions({
			model: MODEL,
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			extraBetas: [],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.anthropic.com");
		expect(calls[0].init.method).toBe("HEAD");
		expect(calls[0].init.tls).toEqual(real.fetchOptions?.tls);
		const headers = new Headers(calls[0].init.headers);
		expect([headers.get("authorization"), headers.get("x-api-key")]).toEqual([null, null]);
	});

	it("throttles repeat warm-ups of the same host", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmAnthropicConnection(MODEL, { fetch });
		await prewarmAnthropicConnection(MODEL, { fetch });

		expect(calls).toHaveLength(1);
	});

	it("ignores models on other APIs", async () => {
		const { calls, fetch } = captureFetch();
		const openai = getBundledModel("openai", "gpt-4o");
		if (!openai) throw new Error("Expected bundled gpt-4o");
		await prewarmAnthropicConnection(openai, { fetch });

		expect(calls).toHaveLength(0);
	});
});
