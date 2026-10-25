import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model, ProviderSessionState, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildRequest as buildGeminiRequest } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildParams as buildResponsesParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import type { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("task sibling prompt-cache routing", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	// Rows whose parent runs on a different lane than its children: the parent
	// stays on the bundled, non-caching openai/gpt-5.4 lane while the mocked
	// agent definition overrides the siblings onto the row's child lane.
	const unoptedParentLanes: Record<string, readonly [provider: string, modelId: string]> = {
		"unopted parent seeds the Go Luna family key for eligible siblings": ["openai", "gpt-5.4"],
		"unopted parent passes explicit cache lineage to eligible Go Luna siblings": ["openai", "gpt-5.4"],
		"unopted parent keeps an ineligible child on its own wire identity": ["openai", "gpt-5.4"],
	};

	it.each([
		[
			"Muse standard provider-session fallback",
			"muse-code",
			"muse-spark-1.3",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Muse provider-session fallback",
			"muse-code",
			"muse-spark-1.3-contributor",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Wonder provider-session fallback",
			"muse-code",
			"muse-wonder-1.0",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Wonder Contributor provider-session fallback",
			"muse-code",
			"muse-wonder-1.0-contributor",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Wonder Full provider-session fallback",
			"muse-code",
			"muse-wonder-full-1.0",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Wonder Full Contributor provider-session fallback",
			"muse-code",
			"muse-wonder-full-1.0-contributor",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Wonder explicit parent key",
			"muse-code",
			"muse-wonder-full-1.0-contributor",
			"explicit-parent",
			"automatic-parent",
			"explicit-parent:task",
		],
		[
			"Muse explicit parent key",
			"muse-code",
			"muse-spark-1.3-contributor",
			"explicit-parent",
			"automatic-parent",
			"explicit-parent:task",
		],
		["Muse nested lineage", "muse-code", "muse-spark-1.3-contributor", undefined, "root:task", "root:task:task"],
		[
			"Go Muse contributor sibling key",
			"opencode-go",
			"muse-spark-1.3-contributor",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			// The standard Go Muse 1.3 id was never exactly lane-verified;
			// the opt-in covers Contributor 1.3 only, so a standard-id child
			// keeps its own native session identity on the wire.
			"Go Muse standard keeps child keys",
			"opencode-go",
			"muse-spark-1.3",
			undefined,
			undefined,
			undefined,
		],
		[
			"Go Muse 1.2 contributor sibling key",
			"opencode-go",
			"muse-spark-1.2-contributor",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Go MiMo Completions sibling key",
			"opencode-go",
			"mimo-v2.6-flash",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Go Kimi Completions sibling key",
			"opencode-go",
			"kimi-k2.7-code",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Go DeepSeek Completions sibling key",
			"opencode-go",
			"deepseek-v4.1-flash",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Go Haiku Anthropic sibling key",
			"opencode-go",
			"claude-haiku-5-5",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"Go DeepSeek Pro Completions sibling key",
			"opencode-go",
			"deepseek-v4-pro",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			// Verified on the Go Responses lane, so the child now shares the
			// family key while its own conversation id stays per-child.
			"Go Luna sibling key",
			"opencode-go",
			"gpt-6-luna",
			"explicit-parent",
			"automatic-parent",
			"explicit-parent:task",
		],
		["Luna keeps child keys", "openai-codex", "gpt-6-luna", "explicit-parent", "automatic-parent", undefined],
		["OpenAI keeps child keys", "openai", "gpt-5.4", undefined, undefined, undefined],
		["Gemini omits cache keys", "google-antigravity", "gemini-3.8-flash", "explicit-parent", undefined, undefined],
		[
			// Unopted-parent rows: the parent never opts into task caching, yet an
			// agent override onto an eligible lane must still mint one family key
			// both siblings stream on (never on the parent's lane), while an
			// ineligible overridden child keeps its own wire identity.
			"unopted parent seeds the Go Luna family key for eligible siblings",
			"opencode-go",
			"gpt-6-luna",
			undefined,
			undefined,
			"parent-provider-lineage:task",
		],
		[
			"unopted parent passes explicit cache lineage to eligible Go Luna siblings",
			"opencode-go",
			"gpt-6-luna",
			"explicit-parent",
			undefined,
			"explicit-parent:task",
		],
		[
			"unopted parent keeps an ineligible child on its own wire identity",
			"openai-codex",
			"gpt-6-luna",
			"explicit-parent",
			undefined,
			undefined,
		],
	] as const)(
		"%s without sharing child conversation or response state",
		async (_name, provider, modelId, parentCacheKey, parentTaskKey, expected) => {
			using directory = TempDir.createSync("@omp-task-cache-");
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
			const authStorage = await AuthStorage.create(directory.join("auth.db"));
			const parentOverride = unoptedParentLanes[_name];
			const [parentProvider, parentModelId] = parentOverride ?? [provider, modelId];
			authStorage.keys.setRuntime(
				provider,
				provider === "muse-code"
					? JSON.stringify({ oauthAccessToken: "test-oauth", apiKey: "test-key" })
					: "test-key",
			);
			if (parentOverride && parentProvider !== provider) authStorage.keys.setRuntime(parentProvider, "test-key");
			const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"), {
				fetch: async () =>
					Response.json({ data: [{ id: modelId, object: "model", created: 0, owned_by: "meta" }] }),
			});
			if (provider === "muse-code" || provider === "opencode-go")
				await modelRegistry.refreshProvider(provider, "online");
			const model = modelRegistry.find(provider, modelId);
			if (!model) throw new Error(`Model missing from offline catalog fixture: ${provider}/${modelId}`);
			const parentModel = parentOverride ? modelRegistry.find(parentProvider, parentModelId) : model;
			if (!parentModel)
				throw new Error(`Model missing from offline catalog fixture: ${parentProvider}/${parentModelId}`);
			const requests: Array<{
				modelId: string;
				sessionId: string | undefined;
				cacheKey: string | undefined;
				state: Map<string, ProviderSessionState> | undefined;
				hasSiblingResponseState: boolean | undefined;
				wireKey: unknown;
			}> = [];
			const realCreateSession = sdk.createAgentSession;
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [
					{
						name: "task",
						description: "Review",
						systemPrompt: "Review the assignment.",
						source: "bundled",
						...(parentOverride ? { model: [`${provider}/${modelId}`] } : {}),
					},
				],
				projectAgentsDir: null,
			});
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
				const result = await realCreateSession(options);
				sessions.push(result.session);
				return result;
			});
			const mock = createMockModel({
				handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { findings: [] } } }] },
			});
			const followup = createMockModel({ handler: { content: [{ type: "text", text: "Review complete." }] } });
			const realSettingsStream = settingsStream.createSettingsAwareStreamFn;
			vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
				realSettingsStream(
					settings,
					async (requestModel, context, streamOptions) => {
						const cacheOptions = {
							sessionId: streamOptions?.sessionId,
							promptCacheKey: streamOptions?.promptCacheKey,
							providerSessionState: streamOptions?.providerSessionState,
						};
						let wireKey: unknown;
						if (requestModel.api === "openai-codex-responses") {
							wireKey = (
								await buildTransformedCodexRequestBody(
									requestModel as Model<"openai-codex-responses">,
									context,
									cacheOptions,
								)
							).prompt_cache_key;
						} else if (requestModel.api === "openai-responses") {
							wireKey = buildResponsesParams(
								requestModel as Model<"openai-responses">,
								context,
								cacheOptions,
								undefined,
							).params.prompt_cache_key;
						} else if (requestModel.api === "google-gemini-cli") {
							const request = buildGeminiRequest(
								requestModel as Model<"google-gemini-cli">,
								context,
								"test-project",
								cacheOptions,
								true,
							);
							wireKey = JSON.stringify(request).includes('"prompt_cache_key"');
						}
						requests.push({
							modelId: requestModel.id,
							sessionId: streamOptions?.sessionId,
							cacheKey: streamOptions?.promptCacheKey,
							state: streamOptions?.providerSessionState,
							hasSiblingResponseState: streamOptions?.providerSessionState?.has("test-response-state"),
							wireKey,
						});
						streamOptions?.providerSessionState?.set("test-response-state", { close() {} });
						return (requests.length <= 2 ? mock : followup).stream(requestModel, context, streamOptions);
					},
					slowMode,
				),
			);
			try {
				const { session: parent } = await sdk.createAgentSession({
					cwd: directory.path(),
					agentDir: directory.path(),
					authStorage,
					modelRegistry,
					model: parentModel,
					providerSessionId: "parent-provider-lineage",
					providerPromptCacheKey: parentCacheKey,
					taskPromptCacheKey: parentTaskKey,
					sessionManager: SessionManager.create(directory.path(), directory.join("parent")),
					settings: Settings.isolated({
						"async.enabled": false,
						"task.structured": true,
						"marketplace.autoUpdate": "off",
						"compaction.enabled": false,
					}),
					toolNames: ["task"],
					spawns: "*",
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					rules: [],
					enableMCP: false,
					enableLsp: false,
				});
				const tool = parent.getToolByName("task") as TaskTool;
				for (const name of ["SiblingA", "SiblingB"]) {
					const result = await tool.execute(name, {
						name,
						task: `Review ${name}.`,
					});
					expect(result.isError, JSON.stringify(result)).not.toBe(true);
					expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
				}
				expect(requests).toHaveLength(2);
				expect(requests.map(request => request.modelId)).toEqual([modelId, modelId]);
				expect(requests.map(request => request.cacheKey)).toEqual([expected, expected]);
				expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
				expect(requests[0]?.sessionId).not.toBe("parent-provider-lineage");
				expect(requests.map(request => request.hasSiblingResponseState)).toEqual([false, false]);
				expect(requests[0]?.state).toBeInstanceOf(Map);
				expect(requests[1]?.state).toBeInstanceOf(Map);
				expect(requests[0]?.state).not.toBe(requests[1]?.state);
				if (model.api !== "openai-completions" && model.api !== "anthropic-messages") {
					expect(requests.map(request => request.wireKey)).toEqual(
						provider === "google-antigravity"
							? [false, false]
							: requests.map(request => expected ?? request.sessionId),
					);
				}
				if (provider === "openai" || provider === "openai-codex") {
					const child = AgentRegistry.global()
						.list()
						.find(candidate => candidate.session && candidate.session !== parent)?.session;
					if (!child) throw new Error("Expected a live Task child");
					const originalKey = child.agent.sessionId;
					const originalFile = child.sessionManager.getSessionFile();
					if (!originalFile) throw new Error("Expected a persisted Task child");
					expect(await child.fork(undefined, { requireIdle: true })).toBe(true);
					await child.prompt("Continue after forking.");
					expect(requests.at(-1)?.wireKey).toBe(originalKey);
					expect(requests.at(-1)?.sessionId).not.toBe(originalKey);
					await child.sessionManager.flush();
					const forkFile = child.sessionManager.getSessionFile()!;
					await child.dispose();
					const forked = await SessionManager.forkFrom(originalFile, directory.path(), directory.join("fork"));
					const reopened = await SessionManager.open(forkFile, directory.path());
					for (const sessionManager of [forked, reopened]) {
						const { session } = await sdk.createAgentSession({
							cwd: directory.path(),
							agentDir: directory.path(),
							authStorage,
							modelRegistry,
							sessionManager,
							settings: parent.settings,
							disableExtensionDiscovery: true,
							skills: [],
							contextFiles: [],
							promptTemplates: [],
							rules: [],
							enableMCP: false,
							enableLsp: false,
						});
						await session.prompt("Continue the copied review.");
						expect(requests.at(-1)?.wireKey).toBe(originalKey);
						expect(requests.at(-1)?.sessionId).not.toBe(originalKey);
						expect(sessionManager.getHeader()?.taskPromptCacheKey).toBeUndefined();
					}
				}
				if (_name === "Muse provider-session fallback") {
					const ref = AgentRegistry.global()
						.list()
						.find(candidate => candidate.session && candidate.session !== parent);
					if (!ref?.session || !ref.sessionFile) throw new Error("Expected a revivable Task child");
					await ref.session.sessionManager.setTaskPromptCacheKey("persisted:task");
					const lifecycle = AgentLifecycleManager.global();
					await lifecycle.park(ref.id);
					const restored = await lifecycle.ensureLive(ref.id);
					await restored.prompt("Continue the review.");
					expect(requests.findLast(request => request.sessionId === restored.agent.sessionId)?.wireKey).toBe(
						"persisted:task",
					);
					await lifecycle.park(ref.id);
					const records = Bun.JSONL.parse(await Bun.file(ref.sessionFile).text()) as Array<{
						type: string;
						taskPromptCacheKey?: string;
					}>;
					for (const record of records) {
						if (record.type === "session") delete record.taskPromptCacheKey;
					}
					await Bun.write(ref.sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
					const withoutCandidate = await lifecycle.ensureLive(ref.id);
					await withoutCandidate.prompt("Continue without inherited affinity.");
					expect(
						requests.findLast(request => request.sessionId === withoutCandidate.agent.sessionId)?.wireKey,
					).toBe(withoutCandidate.agent.sessionId);
				}
			} finally {
				await Promise.all(sessions.splice(0).map(session => session.dispose()));
				authStorage.close();
			}
		},
	);

	// Two independent parents both pin the explicit empty provider cache key:
	// the SDK must hand that empty lineage to the Task boundary verbatim, and
	// the executor must not derive a shared ":task" family candidate from it —
	// each child keeps its own wire identity instead of coalescing every
	// empty-lineage parent onto one cache family.
	it("explicit empty parent lineage keeps independent parents' children on their own wire identity", async () => {
		using directory = TempDir.createSync("@omp-task-cache-empty-");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
		const authStorage = await AuthStorage.create(directory.join("auth.db"));
		authStorage.keys.setRuntime("opencode-go", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"), {
			fetch: async () =>
				Response.json({ data: [{ id: "gpt-6-luna", object: "model", created: 0, owned_by: "meta" }] }),
		});
		await modelRegistry.refreshProvider("opencode-go", "online");
		const model = modelRegistry.find("opencode-go", "gpt-6-luna");
		if (!model) throw new Error("Model missing from offline catalog fixture: opencode-go/gpt-6-luna");
		const requests: Array<{
			sessionId: string | undefined;
			cacheKey: string | undefined;
			wireKey: unknown;
		}> = [];
		const realCreateSession = sdk.createAgentSession;
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "Review",
					systemPrompt: "Review the assignment.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const result = await realCreateSession(options);
			sessions.push(result.session);
			return result;
		});
		const mock = createMockModel({
			handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { findings: [] } } }] },
		});
		const realSettingsStream = settingsStream.createSettingsAwareStreamFn;
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
			realSettingsStream(
				settings,
				async (requestModel, context, streamOptions) => {
					const cacheOptions = {
						sessionId: streamOptions?.sessionId,
						promptCacheKey: streamOptions?.promptCacheKey,
						providerSessionState: streamOptions?.providerSessionState,
					};
					const wireKey = buildResponsesParams(
						requestModel as Model<"openai-responses">,
						context,
						cacheOptions,
						undefined,
					).params.prompt_cache_key;
					requests.push({
						sessionId: streamOptions?.sessionId,
						cacheKey: streamOptions?.promptCacheKey,
						wireKey,
					});
					return mock.stream(requestModel, context, streamOptions);
				},
				slowMode,
			),
		);
		try {
			for (const suffix of ["a", "b"]) {
				// Registry ownership is keyed by the invocation id, so each
				// independent parent's spawn needs its own id; the agent type
				// stays "task", keeping the derived family key ":task".
				const lineage = `parent-lineage-${suffix}`;
				const childName = `sibling-${suffix}`;
				const { session: parent } = await sdk.createAgentSession({
					cwd: directory.path(),
					agentDir: directory.path(),
					authStorage,
					modelRegistry,
					model,
					providerSessionId: lineage,
					providerPromptCacheKey: "",
					sessionManager: SessionManager.create(directory.path(), directory.join(lineage)),
					settings: Settings.isolated({
						"async.enabled": false,
						"task.structured": true,
						"marketplace.autoUpdate": "off",
						"compaction.enabled": false,
					}),
					toolNames: ["task"],
					spawns: "*",
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					rules: [],
					enableMCP: false,
					enableLsp: false,
				});
				// The explicit empty key survives the nullish fallbacks into the Task
				// boundary verbatim; only the derivation step may decline to use it.
				expect(parent.getPromptCacheKeyForModel(parent.agent.state.model)).toBe("");
				const tool = parent.getToolByName("task") as TaskTool;
				const result = await tool.execute(childName, { name: childName, task: "Review the sibling." });
				expect(result.isError, JSON.stringify(result)).not.toBe(true);
				expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
			}
			expect(requests).toHaveLength(2);
			// Break caught: deriving `${empty}:${agent.name}` yields ":task" for
			// every empty-lineage parent, coalescing unrelated families. Eligible
			// children instead keep their own wire identity (no family key).
			expect(requests.map(request => request.cacheKey)).toEqual([undefined, undefined]);
			expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
			expect(requests.map(request => request.sessionId)).not.toContain("parent-lineage-a");
			expect(requests.map(request => request.sessionId)).not.toContain("parent-lineage-b");
			expect(requests.map(request => request.wireKey)).toEqual(requests.map(request => request.sessionId));
		} finally {
			await Promise.all(sessions.splice(0).map(session => session.dispose()));
			authStorage.close();
		}
	});

	// The executor seeds the sibling family candidate from the nonempty parent
	// lineage once the child session exists; the per-request policy gate then
	// decides whether a given request uses it. A child that starts on an
	// unopted lane and later switches to an opted Go lane (the runtime retry
	// fallback's model change after creation) must find the candidate at the
	// first opted-in consumer request, while: ineligible initial requests stay
	// child-scoped, siblings keep isolated conversation and response state, an
	// explicit session key keeps priority, and an explicitly empty parent
	// lineage still derives no candidate across the switch.
	it("shares the family key across siblings after an initially unopted child switches to an opted lane", async () => {
		using directory = TempDir.createSync("@omp-task-cache-transition-");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
		const authStorage = await AuthStorage.create(directory.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		authStorage.keys.setRuntime("opencode-go", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"), {
			fetch: async () =>
				Response.json({ data: [{ id: "gpt-6-luna", object: "model", created: 0, owned_by: "meta" }] }),
		});
		await modelRegistry.refreshProvider("opencode-go", "online");
		const initialModel = modelRegistry.find("openai", "gpt-5.4");
		const optedModel = modelRegistry.find("opencode-go", "gpt-6-luna");
		if (!initialModel) throw new Error("Model missing from offline catalog fixture: openai/gpt-5.4");
		if (!optedModel) throw new Error("Model missing from offline catalog fixture: opencode-go/gpt-6-luna");
		const requests: Array<{
			sessionId: string | undefined;
			cacheKey: string | undefined;
			wireKey: unknown;
			state: Map<string, ProviderSessionState> | undefined;
		}> = [];
		const realCreateSession = sdk.createAgentSession;
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "Review",
					systemPrompt: "Review the assignment.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const result = await realCreateSession(options);
			sessions.push(result.session);
			return result;
		});
		const taskMock = createMockModel({
			handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { findings: [] } } }] },
		});
		const chatMock = createMockModel({ handler: { content: [{ type: "text", text: "Review complete." }] } });
		let inTaskExecute = false;
		const realSettingsStream = settingsStream.createSettingsAwareStreamFn;
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
			realSettingsStream(
				settings,
				async (model, context, options) => {
					const cacheOptions = {
						sessionId: options?.sessionId,
						promptCacheKey: options?.promptCacheKey,
						providerSessionState: options?.providerSessionState,
					};
					requests.push({
						sessionId: options?.sessionId,
						cacheKey: options?.promptCacheKey,
						wireKey: buildResponsesParams(model as Model<"openai-responses">, context, cacheOptions, undefined)
							.params.prompt_cache_key,
						state: options?.providerSessionState,
					});
					return (inTaskExecute ? taskMock : chatMock).stream(model, context, options);
				},
				slowMode,
			),
		);
		async function createParent(lineage: string, model: Model, explicitKey?: string) {
			const { session } = await sdk.createAgentSession({
				cwd: directory.path(),
				agentDir: directory.path(),
				authStorage,
				modelRegistry,
				model,
				providerSessionId: lineage,
				providerPromptCacheKey: explicitKey,
				sessionManager: SessionManager.create(directory.path(), directory.join(lineage)),
				settings: Settings.isolated({
					"async.enabled": false,
					"task.structured": true,
					"marketplace.autoUpdate": "off",
					"compaction.enabled": false,
				}),
				toolNames: ["task"],
				spawns: "*",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
			});
			return session;
		}
		async function runTask(tool: TaskTool, name: string) {
			inTaskExecute = true;
			try {
				const result = await tool.execute(name, { name, task: `Review ${name}.` });
				expect(result.isError, JSON.stringify(result)).not.toBe(true);
				expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
			} finally {
				inTaskExecute = false;
			}
		}
		function childFor(sessionId: string | undefined) {
			const child = sessions.find(session => session.agent.sessionId === sessionId);
			if (!child) throw new Error(`Expected a live Task child for ${sessionId}`);
			return child;
		}
		try {
			const parent = await createParent("parent-lineage", initialModel);
			const tool = parent.getToolByName("task") as TaskTool;
			await runTask(tool, "SiblingA");
			await runTask(tool, "SiblingB");
			// Initial requests stay child-scoped: the child's own unopted model
			// fails the per-request gate, so each child keeps its own wire
			// session identity and response state.
			expect(requests).toHaveLength(2);
			expect(requests.map(request => request.cacheKey)).toEqual([undefined, undefined]);
			expect(requests[0]?.sessionId).not.toBe("parent-lineage");
			expect(requests[1]?.sessionId).not.toBe("parent-lineage");
			expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
			expect(requests.map(request => request.wireKey)).toEqual([requests[0]?.sessionId, requests[1]?.sessionId]);
			expect(requests[0]?.state).toBeInstanceOf(Map);
			expect(requests[1]?.state).toBeInstanceOf(Map);
			expect(requests[0]?.state).not.toBe(requests[1]?.state);

			// Runtime model change after creation: the retry-fallback walk would
			// re-request on the opted Go lane here. The consumer request must find
			// the parent-derived candidate even though the initial model was
			// unopted, and both siblings must land on the same family key.
			const childA = childFor(requests[0]?.sessionId);
			const childB = childFor(requests[1]?.sessionId);
			childA.agent.setModel(optedModel);
			childB.agent.setModel(optedModel);
			await childA.agent.prompt("Continue on the fallback lane.");
			await childB.agent.prompt("Continue on the fallback lane.");
			expect(requests).toHaveLength(4);
			expect(requests.slice(2).map(request => request.cacheKey)).toEqual([
				"parent-lineage:task",
				"parent-lineage:task",
			]);
			expect(requests.slice(2).map(request => request.wireKey)).toEqual([
				"parent-lineage:task",
				"parent-lineage:task",
			]);
			// Conversation and response state stay per-child across the switch.
			expect(requests[2]?.sessionId).toBe(requests[0]?.sessionId);
			expect(requests[3]?.sessionId).toBe(requests[1]?.sessionId);
			expect(requests[2]?.sessionId).not.toBe(requests[3]?.sessionId);
			expect(requests[2]?.state).toBeInstanceOf(Map);
			expect(requests[3]?.state).toBeInstanceOf(Map);
			expect(requests[2]?.state).not.toBe(requests[3]?.state);

			// An explicit session key keeps priority over the family candidate.
			childA.agent.promptCacheKey = "explicit-child";
			await childA.agent.prompt("Explicit key still wins after the switch.");
			expect(requests).toHaveLength(5);
			expect(requests[4]?.cacheKey).toBe("explicit-child");
			expect(requests[4]?.wireKey).toBe("explicit-child");

			// An explicitly empty parent lineage still derives no candidate, both
			// before and across the model switch.
			const emptyParent = await createParent("parent-lineage-empty", initialModel, "");
			expect(emptyParent.getPromptCacheKeyForModel(emptyParent.agent.state.model)).toBe("");
			await runTask(emptyParent.getToolByName("task") as TaskTool, "SiblingC");
			expect(requests).toHaveLength(6);
			expect(requests[5]?.cacheKey).toBeUndefined();
			expect(requests[5]?.wireKey).toBe(requests[5]?.sessionId);
			expect(requests[5]?.sessionId).not.toBe("parent-lineage-empty");
			const childC = childFor(requests[5]?.sessionId);
			childC.agent.setModel(optedModel);
			await childC.agent.prompt("Continue on the fallback lane.");
			expect(requests).toHaveLength(7);
			expect(requests[6]?.cacheKey).toBeUndefined();
			expect(requests[6]?.wireKey).toBe(requests[6]?.sessionId);
			expect(requests[6]?.sessionId).toBe(requests[5]?.sessionId);
		} finally {
			await Promise.all(sessions.splice(0).map(session => session.dispose()));
			authStorage.close();
		}
	});

	it.each([
		["muse-code/muse-spark-1.3-contributor", "openai-codex", "gpt-6-luna", undefined],
		["openai-codex/gpt-6-luna", "muse-code", "muse-spark-1.3-contributor", "parent:task"],
	] as const)(
		"gates the authenticated fallback after deferred %s selection",
		async (requested, provider, modelId, expected) => {
			using directory = TempDir.createSync("@omp-task-cache-fallback-");
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
			const requests: Array<{ model: Model; cacheKey: string | undefined }> = [];
			const mock = createMockModel({ handler: { content: [{ type: "text", text: "Done." }] } });
			const realSettingsStream = settingsStream.createSettingsAwareStreamFn;
			vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
				realSettingsStream(
					settings,
					(model, context, options) => {
						requests.push({ model, cacheKey: options?.promptCacheKey });
						return mock.stream(model, context, options);
					},
					slowMode,
				),
			);
			const authStorage = await AuthStorage.create(directory.join("auth.db"));
			authStorage.keys.setRuntime(provider, "test-key");
			try {
				const { session } = await sdk.createAgentSession({
					cwd: directory.path(),
					agentDir: directory.path(),
					authStorage,
					modelPattern: requested,
					modelPatternAuthFallback: `${provider}/${modelId}`,
					taskPromptCacheKey: "parent:task",
					sessionManager: SessionManager.inMemory(directory.path()),
					settings: Settings.isolated({
						"async.enabled": false,
						"marketplace.autoUpdate": "off",
						"compaction.enabled": false,
					}),
					toolNames: [],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					rules: [],
					enableMCP: false,
					enableLsp: false,
				});
				sessions.push(session);
				await session.agent.prompt("Review the change.");
				expect(requests).toHaveLength(1);
				expect(requests[0]?.model.provider).toBe(provider);
				expect(requests[0]?.model.id).toBe(modelId);
				expect(requests[0]?.cacheKey).toBe(expected);
			} finally {
				await Promise.all(sessions.splice(0).map(session => session.dispose()));
				authStorage.close();
			}
		},
	);

	const cacheModels = ["muse-spark-1.3-contributor", "muse-wonder-full-1.0-contributor"];
	it.each(cacheModels)("rechecks %s while explicit session and request keys win", async modelId => {
		using directory = TempDir.createSync("@omp-task-cache-model-");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
		const requests: Array<{ provider: string; options: SimpleStreamOptions | undefined; wireKey: unknown }> = [];
		const mock = createMockModel({ handler: { content: [{ type: "text", text: "Done." }] } });
		const realSettingsStream = settingsStream.createSettingsAwareStreamFn;
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
			realSettingsStream(
				settings,
				async (model, context, options) => {
					const cacheOptions = {
						sessionId: options?.sessionId,
						promptCacheKey: options?.promptCacheKey,
						providerSessionState: options?.providerSessionState,
					};
					const wireKey =
						model.api === "openai-codex-responses"
							? (
									await buildTransformedCodexRequestBody(
										model as Model<"openai-codex-responses">,
										context,
										cacheOptions,
									)
								).prompt_cache_key
							: buildResponsesParams(model as Model<"openai-responses">, context, cacheOptions, undefined).params
									.prompt_cache_key;
					requests.push({ provider: model.provider, options, wireKey });
					return mock.stream(model, context, options);
				},
				slowMode,
			),
		);
		const authStorage = await AuthStorage.create(directory.join("auth.db"));
		authStorage.keys.setRuntime("muse-code", JSON.stringify({ oauthAccessToken: "test-oauth", apiKey: "test-key" }));
		authStorage.keys.setRuntime("openai-codex", "test-key");
		try {
			const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"), {
				fetch: async () =>
					Response.json({ data: [{ id: modelId, object: "model", created: 0, owned_by: "meta" }] }),
			});
			await modelRegistry.refreshProvider("muse-code", "online");
			const muse = modelRegistry.find("muse-code", modelId);
			if (!muse) throw new Error(`Model missing from offline catalog fixture: muse-code/${modelId}`);
			const luna = getBundledModel("openai-codex", "gpt-6-luna");
			const { session } = await sdk.createAgentSession({
				cwd: directory.path(),
				agentDir: directory.path(),
				authStorage,
				modelRegistry,
				modelPattern: `muse-code/${modelId}`,
				providerSessionId: "child-conversation",
				providerPromptCacheKey: "configured-child",
				taskPromptCacheKey: "parent:task",
				sessionManager: SessionManager.inMemory(directory.path()),
				settings: Settings.isolated({
					"async.enabled": false,
					"marketplace.autoUpdate": "off",
					"compaction.enabled": false,
				}),
				toolNames: [],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
			});
			sessions.push(session);
			await session.agent.prompt("Review first.");
			session.agent.setModel(luna);
			await session.agent.prompt("Review second.");
			session.agent.promptCacheKey = undefined;
			await session.agent.prompt("Review third.");
			session.agent.setModel(muse);
			await session.agent.prompt("Review fourth.");
			const fallback = await session.agent.streamFn(luna, { messages: [] }, { sessionId: "fallback-conversation" });
			await fallback.result();
			session.agent.promptCacheKey = "explicit-child";
			session.agent.setModel(luna);
			await session.agent.prompt("Review fifth.");
			const explicit = await session.agent.streamFn(
				luna,
				{ messages: [] },
				{
					sessionId: "request-conversation",
					promptCacheKey: "explicit-request",
				},
			);
			await explicit.result();
			expect(requests.map(request => request.provider)).toEqual([
				"muse-code",
				"openai-codex",
				"openai-codex",
				"muse-code",
				"openai-codex",
				"openai-codex",
				"openai-codex",
			]);
			expect(requests.map(request => request.options?.promptCacheKey)).toEqual([
				"configured-child",
				"configured-child",
				undefined,
				"parent:task",
				undefined,
				"explicit-child",
				"explicit-request",
			]);
			expect(requests.map(request => request.wireKey)).toEqual([
				"configured-child",
				"configured-child",
				"child-conversation",
				"parent:task",
				"fallback-conversation",
				"explicit-child",
				"explicit-request",
			]);
			expect(requests.map(request => request.options?.sessionId)).toEqual([
				"child-conversation",
				"child-conversation",
				"child-conversation",
				"child-conversation",
				"fallback-conversation",
				"child-conversation",
				"request-conversation",
			]);
		} finally {
			await Promise.all(sessions.splice(0).map(session => session.dispose()));
			authStorage.close();
		}
	});
});
