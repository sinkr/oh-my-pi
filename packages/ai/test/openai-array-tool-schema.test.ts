import { describe, expect, it } from "bun:test";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { adaptSchemaForStrict, sanitizeSchemaForOpenAIResponses } from "@oh-my-pi/pi-ai/utils/schema";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { createCodexModel } from "./helpers";

describe("OpenAI itemless array schemas", () => {
	it.each([
		{
			name: "top-level array",
			schema: { type: "array" },
			expected: { type: "array", items: true },
		},
		{
			name: "nullable array",
			schema: { type: ["array", "null"] },
			expected: { type: ["array", "null"], items: true },
		},
		{
			name: "nested property",
			schema: { type: "object", properties: { listeners: { type: "array" } } },
			expected: { type: "object", properties: { listeners: { type: "array", items: true } } },
		},
		{
			name: "anyOf branch",
			schema: { anyOf: [{ type: "array" }, { type: "null" }] },
			expected: { anyOf: [{ type: "array", items: true }, { type: "null" }] },
		},
		{
			name: "nested array items",
			schema: { type: "array", items: { type: "array" } },
			expected: { type: "array", items: { type: "array", items: true } },
		},
	])("adds open items to $name and falls back to non-strict", ({ schema, expected }) => {
		const original = structuredClone(schema);
		const sanitized = sanitizeSchemaForOpenAIResponses(schema);
		expect(sanitized).toEqual(expected);
		expect(adaptSchemaForStrict(sanitized, true)).toEqual({ schema: expected, strict: false });
		expect(schema).toEqual(original);
		expect(sanitizeSchemaForOpenAIResponses(sanitized)).toBe(sanitized);
	});

	it("preserves typed items and strict mode when no repair is needed", () => {
		const schema = {
			type: "object",
			properties: { listeners: { type: "array", items: { type: "string" } } },
			required: ["listeners"],
			additionalProperties: false,
		};
		expect(sanitizeSchemaForOpenAIResponses(schema)).toBe(schema);
		expect(adaptSchemaForStrict(schema, true)).toEqual({ schema, strict: true });
	});

	it.each([
		{ type: "array", items: true },
		{ type: "array", items: false },
		{ type: "array", prefixItems: [{ type: "string" }] },
		{ type: "array", prefixItems: [] },
	])("preserves existing items or prefixItems: %j", schema => {
		expect(sanitizeSchemaForOpenAIResponses(schema)).toBe(schema);
	});

	it("does not rewrite itemless array-shaped literal values", () => {
		const literal = { type: "array" };
		const schema = { type: "string", enum: [literal], const: literal, default: literal, examples: [literal] };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toBe(schema);
	});

	const providers = [
		{
			name: "Responses",
			convert: (tool: Tool) => convertTools([tool], true, getBundledModel("openai", "gpt-5-mini"))[0],
		},
		{
			name: "Codex",
			convert: (tool: Tool) => convertOpenAICodexResponsesTools([tool], createCodexModel("gpt-5.5"))[0],
		},
	];

	for (const provider of providers) {
		it(`${provider.name} emits open array items without strict mode`, () => {
			const tool: Tool = {
				name: "list",
				description: "List results",
				strict: true,
				parameters: {
					type: "object",
					properties: { listeners: { type: "array" } },
					required: ["listeners"],
					additionalProperties: false,
				},
			};
			expect(provider.convert(tool)).toEqual({
				type: "function",
				name: "list",
				description: "List results",
				parameters: {
					type: "object",
					properties: { listeners: { type: "array", items: true } },
					required: ["listeners"],
					additionalProperties: false,
				},
			});
		});

		it(`${provider.name} retains strict mode for typed array items`, () => {
			const tool: Tool = {
				name: "list",
				description: "List results",
				strict: true,
				parameters: {
					type: "object",
					properties: { listeners: { type: "array", items: { type: "string" } } },
					required: ["listeners"],
					additionalProperties: false,
				},
			};
			expect(provider.convert(tool)).toMatchObject({ strict: true, parameters: tool.parameters });
		});

		it(`${provider.name} repairs a real YieldTool without changing task-level validation`, () => {
			const tool = new YieldTool({
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				outputSchema: {
					type: "object",
					properties: { listeners: { type: "array" } },
					required: ["listeners"],
					additionalProperties: false,
				},
			});
			expect(tool.strict).toBe(true);
			expect(provider.convert(tool)).toMatchObject({
				type: "function",
				name: "yield",
				parameters: {
					properties: {
						data: {
							anyOf: [
								{
									type: "object",
									properties: { listeners: { type: "array", items: true } },
									required: ["listeners"],
								},
								{ type: "array", items: true },
							],
						},
					},
				},
			});
			expect(provider.convert(tool)).not.toHaveProperty("strict");
		});
	}
});
