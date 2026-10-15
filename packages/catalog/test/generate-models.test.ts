import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import type { Api, Model, ModelSpec } from "../src/types";
import { selectGeneratedModels } from "../scripts/generate-models";

function modelSpec(provider: string, id: string, name: string): ModelSpec<Api> {
	const isOpenRouter = provider === "openrouter";
	return {
		id,
		name,
		api: isOpenRouter ? "openrouter-decisions" : "typesafe",
		provider,
		baseUrl: isOpenRouter ? "https://openrouter.ai/api/alpha" : "https://api.typesafe.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: isOpenRouter ? 0.042 : 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 28_800,
	};
}

function previousModel(provider: string, id: string, name: string): Model<Api> {
	return buildModel(modelSpec(provider, id, name));
}

describe("selectGeneratedModels", () => {
	test("updates the selected Jev row through its input-modality policy and preserves other snapshot rows", () => {
		const previousSelected = previousModel("openrouter", "typesafe/jev-1.14", "old selected row");
		previousSelected.input = ["text"];
		const previousSameProvider = previousModel("openrouter", "typesafe/jev-1.13", "old same-provider row");
		const previousOtherProvider = previousModel("typesafe", "jev-latest", "old other-provider row");
		const output = selectGeneratedModels(
			{
				openrouter: {
					"typesafe/jev-1.14": modelSpec("openrouter", "typesafe/jev-1.14", "updated selected row"),
					"typesafe/jev-1.13": modelSpec("openrouter", "typesafe/jev-1.13", "unselected replacement"),
				},
				typesafe: { "jev-latest": modelSpec("typesafe", "jev-latest", "unselected provider replacement") },
			},
			{
				openrouter: {
					"typesafe/jev-1.14": previousSelected,
					"typesafe/jev-1.13": previousSameProvider,
				},
				typesafe: { "jev-latest": previousOtherProvider },
			},
			"openrouter",
			["typesafe/jev-1.14"],
		);

		expect(output.openrouter?.["typesafe/jev-1.14"]?.input).toEqual(["text", "image"]);
		expect(output.openrouter?.["typesafe/jev-1.13"]).toEqual(previousSameProvider);
		expect(output.typesafe?.["jev-latest"]).toEqual(previousOtherProvider);
	});

	test("rejects any requested model missing from generated provider rows", () => {
		expect(() =>
			selectGeneratedModels(
				{ openrouter: { available: modelSpec("openrouter", "available", "available") } },
				{},
				"openrouter",
				["missing"],
			),
		).toThrow("missing");
	});

	test("keeps provider-only replacement and full generation behavior", () => {
		const retainedOtherProviderRow = previousModel("typesafe", "retained", "retained row");
		const providerOnly = selectGeneratedModels(
			{
				openrouter: {
					z: modelSpec("openrouter", "z", "z"),
					a: modelSpec("openrouter", "a", "a"),
				},
				typesafe: { refreshed: modelSpec("typesafe", "refreshed", "refreshed") },
			},
			{
				openrouter: { retired: previousModel("openrouter", "retired", "retired row") },
				typesafe: { retained: retainedOtherProviderRow },
			},
			"openrouter",
		);
		expect(Object.keys(providerOnly.openrouter ?? {})).toEqual(["a", "z"]);
		expect(providerOnly.openrouter?.retired).toBeUndefined();
		expect(providerOnly.typesafe?.retained).toEqual(retainedOtherProviderRow);

		const full = selectGeneratedModels(
			{ openrouter: { current: modelSpec("openrouter", "current", "current") } },
			{ typesafe: { row: previousModel("typesafe", "row", "stale row") } },
		);
		expect(Object.keys(full)).toEqual(["openrouter"]);
		expect(Object.keys(full.openrouter ?? {})).toEqual(["current"]);
	});

	test("requires a provider when model ids are selected", () => {
		expect(() => selectGeneratedModels({}, {}, undefined, ["jev"])).toThrow("--model requires --provider");
	});
});
