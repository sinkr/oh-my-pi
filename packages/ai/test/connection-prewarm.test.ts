import { afterEach, describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { prewarmModelConnection, resetConnectionPrewarmForTesting } from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api } from "@oh-my-pi/pi-catalog/types";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

function model<TApi extends Api>(provider: string, api: TApi, baseUrl: string): Model<TApi> {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const ANTHROPIC = model("anthropic", "anthropic-messages", "https://api.anthropic.com");
const COPILOT = model("github-copilot", "openai-completions", "https://api.business.githubcopilot.com");

function captureFetch(): { calls: Array<{ url: string; init: RequestInit & { tls?: unknown } }>; fetch: FetchImpl } {
	const calls: Array<{ url: string; init: RequestInit & { tls?: unknown } }> = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(null, { status: 404 });
	};
	return { calls, fetch };
}

withOfficialAnthropicEndpoint();
afterEach(() => resetConnectionPrewarmForTesting());

describe("prewarmModelConnection", () => {
	it("warms official Anthropic with the real request's TLS options and no credentials", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmModelConnection(ANTHROPIC, { fetch });

		const real = buildAnthropicClientOptions({
			model: ANTHROPIC,
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

	it("warms a catalog provider's own host at its origin", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmModelConnection(COPILOT, { fetch });

		expect(calls.map(call => [call.url, call.init.method])).toEqual([
			["https://api.business.githubcopilot.com", "HEAD"],
		]);
	});

	it("throttles repeat warm-ups per origin, not globally", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmModelConnection(ANTHROPIC, { fetch });
		await prewarmModelConnection(ANTHROPIC, { fetch });
		await prewarmModelConnection(COPILOT, { fetch });
		await prewarmModelConnection(COPILOT, { fetch });

		expect(calls.map(call => call.url)).toEqual([
			"https://api.anthropic.com",
			"https://api.business.githubcopilot.com",
		]);
	});

	it("never probes custom providers, built-in ids pointed at a gateway, local hosts, or Anthropic gateways", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmModelConnection(model("corp-gateway", "openai-completions", "https://llm.corp.example/v1"), {
			fetch,
		});
		await prewarmModelConnection(model("openai", "openai-responses", "https://gateway.internal.example/v1"), {
			fetch,
		});
		await prewarmModelConnection(model("ollama", "openai-completions", "http://127.0.0.1:11434/v1"), { fetch });
		await prewarmModelConnection(model("anthropic", "anthropic-messages", "https://opencode.ai/zen"), { fetch });
		await withEnv({ ANTHROPIC_BASE_URL: "https://llm-gateway.corp.example" }, () =>
			prewarmModelConnection(ANTHROPIC, { fetch }),
		);

		expect(calls).toHaveLength(0);
	});
});
