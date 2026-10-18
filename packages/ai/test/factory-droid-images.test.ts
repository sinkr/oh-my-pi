import { describe, expect, it } from "bun:test";
import * as AIError from "../src/error";
import { generateImage, type ImageInput } from "../src/images";
import type { FetchImpl } from "../src/types";
import { type CapturedRequest, captureFetch, factoryModel, WORKOS_TOKEN } from "./helpers/factory-droid";

const IMAGE = Buffer.from("png bytes").toString("base64");

/** Fake Factory endpoint answering every request with one JSON body and status. */
function jsonFetch(captured: CapturedRequest[], body: unknown, status = 200): FetchImpl {
	return async (url, init) => {
		captured.push({
			url: String(url),
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
					key.toLowerCase(),
					value,
				]),
			),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		return Response.json(body, { status });
	};
}

const imagesResponse = { data: [{ b64_json: IMAGE }], usage: { input_tokens: 18, output_tokens: 229 } };

describe("Factory Droid image generation", () => {
	it("generates GPT images through the proxy's Images route with chat's identity", async () => {
		const captured: CapturedRequest[] = [];
		const result = await generateImage(
			factoryModel("gpt-image-2.5-flare"),
			{ prompt: "a red circle", count: 1 },
			{ apiKey: WORKOS_TOKEN, fetch: jsonFetch(captured, imagesResponse), sessionId: "session-1" },
		);

		expect(captured).toHaveLength(1);
		const [request] = captured;
		expect(request.url).toBe("https://api.factory.ai/api/llm/o/v1/images/generations");
		expect(Object.keys(request.body).sort()).toEqual(["instructions", "model", "n", "prompt"]);
		expect(request.body).toMatchObject({ model: "gpt-image-2.5-flare", prompt: "a red circle", n: 1 });
		expect(String(request.body.instructions)).toContain("Droid");
		expect(request.headers).toMatchObject({
			authorization: `Bearer ${WORKOS_TOKEN}`,
			"x-api-provider": "openai",
			"x-factory-client": "cli",
			"x-factory-org-id": "org-1",
		});
		expect(request.headers["user-agent"]).toStartWith("factory-cli/");
		expect(result.images).toEqual([{ data: IMAGE, mimeType: "image/png" }]);
		expect(result.usage).toMatchObject({ input: 18, output: 229 });
	});

	it("edits with inline reference images on the JSON edits route", async () => {
		const captured: CapturedRequest[] = [];
		await generateImage(
			factoryModel("gpt-image-2.5-sunburst"),
			{
				prompt: "make it blue",
				inputImages: [
					{ data: IMAGE, mimeType: "image/png" },
					{ data: IMAGE, mimeType: "image/jpeg" },
				],
			},
			{ apiKey: WORKOS_TOKEN, fetch: jsonFetch(captured, imagesResponse) },
		);

		expect(captured[0].url).toBe("https://api.factory.ai/api/llm/o/v1/images/edits");
		expect(captured[0].body.input_images).toEqual([
			{ media_type: "image/png", data: IMAGE },
			{ media_type: "image/jpeg", data: IMAGE },
		]);
	});

	const rejected: Array<{ label: string; inputImages: ImageInput[] }> = [
		{
			label: "more than 16 references",
			inputImages: Array.from({ length: 17 }, () => ({ data: IMAGE, mimeType: "image/png" })),
		},
		{ label: "a reference type the edits contract rejects", inputImages: [{ data: IMAGE, mimeType: "image/gif" }] },
	];
	it.each(rejected)("rejects $label before sending", async ({ inputImages }) => {
		const captured: CapturedRequest[] = [];
		await expect(
			generateImage(
				factoryModel("gpt-image-2.5-flare"),
				{ prompt: "edit", inputImages },
				{ apiKey: WORKOS_TOKEN, fetch: jsonFetch(captured, imagesResponse) },
			),
		).rejects.toBeInstanceOf(AIError.ValidationError);
		expect(captured).toHaveLength(0);
	});

	it("generates Gemini images on the native route with TEXT and IMAGE output", async () => {
		const captured: CapturedRequest[] = [];
		const chunk = {
			candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: IMAGE } }] } }],
			usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 1120 },
		};
		const result = await generateImage(
			factoryModel("gemini-3-pro-image-preview"),
			{ prompt: "a lighthouse", inputImages: [{ data: IMAGE, mimeType: "image/png" }] },
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(captured, [JSON.stringify(chunk)]) },
		);

		const [request] = captured;
		expect(request.url).toBe("https://api.factory.ai/api/llm/g/v1/generate");
		expect(request.headers["x-api-provider"]).toBe("google");
		const config = request.body.generationConfig as Record<string, unknown>;
		expect(config.responseModalities).toEqual(["TEXT", "IMAGE"]);
		// Gemini image models reject thinking configuration.
		expect(config).not.toHaveProperty("thinkingConfig");
		expect(JSON.stringify(request.body.systemInstruction)).toContain("Droid");
		expect(request.body.contents).toEqual([
			{ role: "user", parts: [{ inlineData: { data: IMAGE, mimeType: "image/png" } }, { text: "a lighthouse" }] },
		]);
		expect(result.images).toEqual([{ data: IMAGE, mimeType: "image/png" }]);
		expect(result.usage).toMatchObject({ input: 23, output: 1120 });
	});

	it("says why when Gemini blocks the prompt instead of returning nothing", async () => {
		const result = await generateImage(
			factoryModel("gemini-3-pro-image-preview"),
			{ prompt: "a circle" },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch([], [JSON.stringify({ promptFeedback: { blockReason: "OTHER" } })]),
			},
		);
		expect(result.images).toEqual([]);
		expect(result.text).toContain("OTHER");
	});

	it("maps a proxy rejection to a provider HTTP error carrying Factory's reason", async () => {
		const error = await generateImage(
			factoryModel("gpt-image-2.5-flare"),
			{ prompt: "a cat" },
			{ apiKey: WORKOS_TOKEN, fetch: jsonFetch([], { detail: "Image generation is disabled" }, 403) },
		).catch((caught: unknown) => caught);
		// The tool's fallback chain moves to the next image model on provider HTTP errors.
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		expect((error as AIError.ProviderHttpError).status).toBe(403);
		expect((error as Error).message).toContain("Image generation is disabled");
	});

	it("refuses Factory chat models", async () => {
		await expect(
			generateImage(
				factoryModel("kimi-k3"),
				{ prompt: "a cat" },
				{ apiKey: WORKOS_TOKEN, fetch: jsonFetch([], {}) },
			),
		).rejects.toBeInstanceOf(AIError.ValidationError);
	});
});
