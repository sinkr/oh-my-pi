import { describe, expect, test } from "bun:test";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { buildModel } from "../src/build";
import { resolveCatalogPolicy } from "../src/compat/catalog-policy";
import { resolveCascadeRules } from "../src/compat/cascade";
import { getBundledModel, getBundledModels } from "../src/models";
import { museCodeModelManagerOptions } from "../src/provider-models/openai-compat";
import type { Model } from "../src/types";

describe("task sibling prompt-cache opt-in", () => {
	const muse = getBundledModel("muse-code", "muse-spark-1.3-contributor");

	test("enables the six exact Spark and Wonder models only on the Muse Code Responses route", async () => {
		const ids = [
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
			"muse-wonder-1.0",
			"muse-wonder-1.0-contributor",
			"muse-wonder-full-1.0",
			"muse-wonder-full-1.0-contributor",
		];
		const options = museCodeModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				Response.json({ data: ids.map(id => ({ id, object: "model", created: 0, owned_by: "meta" })) }),
		});
		const models = (await options.fetchDynamicModels?.())?.map(buildModel);
		expect(models?.map(model => model.id).sort()).toEqual([...ids].sort());
		for (const model of models ?? []) {
			expect(resolveCatalogPolicy(model).taskSiblingPromptCache, model.id).toBe(true);
		}
		const unsupported: Model[] = [
			{ ...muse, id: "muse-spark-1.2-contributor" },
			{ ...muse, id: "muse-spark-1.4-contributor" },
			{ ...muse, id: "muse-wonder-1.1" },
			{ ...muse, id: "muse-wonder-full-1.1-contributor" },
			{ ...muse, id: "muse-wonder-1.0", provider: "meta", providerType: undefined },
			{ ...muse, id: "muse-wonder-full-1.0-contributor", api: "openai-completions" },
			{ ...muse, provider: "meta", providerType: undefined },
			{ ...muse, provider: "custom-host", providerType: undefined },
			{ ...muse, api: "openai-completions" },
			getBundledModel("openai-codex", "gpt-6-luna"),
			getBundledModel("google-antigravity", "gemini-3.8-flash"),
		];
		for (const model of unsupported) {
			expect(
				resolveCatalogPolicy(model).taskSiblingPromptCache,
				`${model.provider}/${model.id}/${model.api}`,
			).not.toBe(true);
		}
	});

	test("enables the verified Go Responses, Completions, and Anthropic lanes and no other Go or Zen route", () => {
		const go = (id: string) => getBundledModel("opencode-go", id);
		const responses = [
			"gpt-5.6-luna",
			"gpt-6-luna",
			"grok-4.6",
			"grok-4.7",
			"muse-spark-1.3-contributor",
			"muse-spark-1.2-contributor",
		];
		const completions = [
			"mimo-v2.6-flash",
			"kimi-k2.7-code",
			"deepseek-v4.1-flash",
			"deepseek-v4-pro",
			"glm-5.1",
			"glm-5.3-flash",
			"omen-alpha",
		];
		const anthropic = ["claude-haiku-5-5"];
		// Live Go discovery serves `omen-alpha` but the bundle ships no row;
		// the verified sibling on the same Completions lane supplies the wire
		// facts, like the gateway-only standard Muse ids below.
		const laneModel = (id: string): Model => (id === "omen-alpha" ? { ...go("deepseek-v4-pro"), id } : go(id));
		const optedIn = [...responses, ...completions, ...anthropic].map(laneModel);
		for (const model of optedIn) {
			expect(resolveCatalogPolicy(model).taskSiblingPromptCache, `${model.provider}/${model.id}/${model.api}`).toBe(
				true,
			);
		}
		// The opt-in matches the lane each id was measured on, so the same id
		// declared on any other wire never inherits the family key.
		const wrongApi: Model[] = [
			...responses.map(id => ({ ...laneModel(id), api: "openai-completions" })),
			...completions.map(id => ({ ...laneModel(id), api: "openai-responses" })),
			...anthropic.map(id => ({ ...laneModel(id), api: "openai-responses" })),
		];
		for (const model of wrongApi) {
			expect(
				resolveCatalogPolicy(model).taskSiblingPromptCache,
				`${model.provider}/${model.id}/${model.api}`,
			).not.toBe(true);
		}
		const unsupported: Model[] = [
			// Argon showed no material warm hit (unproven) and DeepSeek V4
			// Flash was not measured; Minimax and Beam warmed under any key,
			// so a shared family key buys nothing there.
			go("gemini-4-argon-contributor"),
			go("deepseek-v4-flash"),
			go("minimax-m2.7"),
			go("beam-free"),
			// Qwen 3.6 Plus likewise showed no material warm hit (unproven,
			// not shown broken), and the upstream rejects the MiMo 2.5 Pro
			// lane outright (HTTP 400 "Unsupported model").
			go("qwen3.6-plus"),
			go("mimo-v2.5-pro"),
			// Gateway-only standard ids ship no bundled row; the verified
			// Contributor sibling supplies the wire facts. Only Contributor
			// 1.3 and 1.2 were exactly lane-verified, so the standard ids
			// stay off.
			{ ...go("muse-spark-1.3-contributor"), id: "muse-spark-1.3" },
			{ ...go("muse-spark-1.2-contributor"), id: "muse-spark-1.2" },
			// Zen shares the gateway family but is not opted in.
			getBundledModel("opencode-zen", "claude-haiku-5-5"),
			getBundledModel("opencode-zen", "kimi-k2.7-code"),
			getBundledModel("opencode-zen", "muse-spark-1.3-contributor-free"),
			// Native Muse keeps only its six opted-in Spark and Wonder lanes.
			{ ...muse, id: "muse-spark-1.2-contributor" },
		];
		for (const model of unsupported) {
			expect(
				resolveCatalogPolicy(model).taskSiblingPromptCache,
				`${model.provider}/${model.id}/${model.api}`,
			).not.toBe(true);
		}
		// Complement sweep: the cache-compatible-but-non-isolating lanes, the
		// unproven routes and every other bundled Go route keep per-child
		// routing — nothing outside the opted-in set may resolve the flag.
		const optedIds = new Set(optedIn.map(model => model.id));
		for (const model of getBundledModels("opencode-go")) {
			expect(
				resolveCatalogPolicy(model).taskSiblingPromptCache === true,
				`${model.provider}/${model.id}/${model.api}`,
			).toBe(optedIds.has(model.id));
		}
	});

	test("honors an explicitly declared backend for custom provider names", () => {
		expect(
			resolveCatalogPolicy({ ...muse, provider: "custom-muse", providerType: "muse-code" }).taskSiblingPromptCache,
		).toBe(true);
		expect(resolveCatalogPolicy({ ...muse, providerType: "meta" }).taskSiblingPromptCache).not.toBe(true);
	});

	test("allows a narrower false rule to disable sharing and rejects string booleans", () => {
		const cascade = compileCascade([
			{
				file: "providers/test.kdl",
				text: 'provider "test" { task-sibling-prompt-cache #true; models "disabled" { task-sibling-prompt-cache #false } }',
			},
		]);
		expect(
			resolveCascadeRules(cascade, {
				provider: "test",
				api: "openai-responses",
				class: "unknown",
				model: "disabled",
				reasoning: false,
			}).catalog.taskSiblingPromptCache,
		).toBe(false);
		expect(() =>
			compileCascade([
				{
					file: "providers/test.kdl",
					text: 'provider "test" { task-sibling-prompt-cache "false" }',
				},
			]),
		).toThrow(/task-sibling-prompt-cache.*rejects value/);
	});
});
