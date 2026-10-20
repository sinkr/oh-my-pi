import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const mercury3 = buildModel(seedModels<"openai-completions">("inception").find(model => model.id === "mercury-3")!);
const context: Context = {
	systemPrompt: ["You are a coding assistant."],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("Inception chat requests", () => {
	test.each([
		{ options: { reasoning: Effort.Minimal }, wireEffort: "instant" },
		{ options: { reasoning: Effort.High }, wireEffort: "high" },
		{ options: { disableReasoning: true }, wireEffort: "instant" },
	])("serializes $options without unsupported OpenAI fields", async ({ options, wireEffort }) => {
		let payload: Record<string, unknown> | undefined;
		const controller = new AbortController();
		controller.abort();
		const stream = streamOpenAICompletions(mercury3, context, {
			...options,
			apiKey: "inception-test-key",
			maxTokens: 131_072,
			signal: controller.signal,
			onPayload: body => {
				payload = body as Record<string, unknown>;
			},
		});
		await stream.result();
		expect(payload?.reasoning_effort).toBe(wireEffort);
		expect(payload?.max_completion_tokens).toBe(131_072);
		expect(payload).not.toHaveProperty("max_tokens");
		expect(payload).not.toHaveProperty("store");
		expect(payload?.messages).toEqual([
			expect.objectContaining({ role: "system" }),
			expect.objectContaining({ role: "user" }),
		]);
	});
});

describe("Inception API-key login", () => {
	test("rejects invalid credentials using a models probe without generating tokens", async () => {
		const login = getProviderDefinition("inception")!.login!;
		let endpoint = "";
		await expect(
			login({
				onAuth: () => {},
				onPrompt: async () => "invalid-test-key",
				fetch: async input => {
					endpoint = String(input);
					return Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 });
				},
			}),
		).rejects.toThrow();
		expect(endpoint).toBe("https://api.inceptionlabs.ai/v1/models");
	});
});
