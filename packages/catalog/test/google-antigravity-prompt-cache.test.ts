import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { getBundledModel } from "../src/models";

describe("google-antigravity promptCache catalog metadata", () => {
	test("bundled models inherit promptCache with a 300-second short TTL", () => {
		for (const id of ["gemini-4-argon", "claude-opus-5-5"]) {
			const model = getBundledModel("google-antigravity", id);
			expect(model).toBeDefined();
			expect(model.promptCache).toEqual({ short: 300 });
		}
	});

	test("buildModel resolves promptCache for google-antigravity models", () => {
		const dynamicModel = buildModel({
			id: "gemini-4-custom",
			name: "Gemini 4 Custom",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});

		expect(dynamicModel.promptCache).toEqual({ short: 300 });
	});
});
