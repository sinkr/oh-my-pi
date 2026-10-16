import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, type Context, Effort, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AUTO_PREWALK_TIMEOUT_MS, type PrewalkRoute } from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { PrewalkCoordinator } from "@oh-my-pi/pi-coding-agent/session/prewalk";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgPrewalkAuto, cfgPrewalkAutoSource, cfgPrewalkAutoTarget } from "@oh-my-pi/pi-coding-agent/session/settings";
import { EAGER_TODO_PRELUDE_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

/**
 * `prewalk.auto`: the native judge decides per user task whether to arm the
 * existing prewalk handoff. The judge is the real TypeSafe client against a
 * stubbed `fetch`, so the whole path — classifier, judge chain, coordinator,
 * handoff — runs without network.
 */
describe("AgentSession auto-prewalk", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-prewalk-auto-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		vi.restoreAllMocks();
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	const toolSchema = type({});
	const todoTool: AgentTool<typeof toolSchema, undefined> = {
		name: "todo",
		label: "Todo",
		description: "Track tasks",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "listed" }], details: undefined };
		},
	};
	const writeTool: AgentTool<typeof toolSchema, undefined> = {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "wrote" }], details: undefined };
		},
	};
	const toolRegistry = new Map<string, AgentTool>([
		[todoTool.name, todoTool as AgentTool],
		[writeTool.name, writeTool as AgentTool],
	]);

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	/** One task that plans, writes its todo list, then edits: the shape that crosses the handoff. */
	const cycle = (): MockResponse[] => [toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }];
	const done = (label: string): MockResponse => ({ content: [`done ${label}`] });

	const TASK = "trace the sync engine, then fix the stale cursor";

	function verdict(prewalk: number, primary: number, direct: number) {
		const probabilities: Record<PrewalkRoute, number> = { prewalk, primary, direct };
		const choice: PrewalkRoute =
			prewalk >= primary && prewalk >= direct ? "prewalk" : primary >= direct ? "primary" : "direct";
		return { type: "choice", choice, probabilities, confidence: probabilities[choice] };
	}
	const PREWALK = verdict(0.9, 0.07, 0.03);
	const PRIMARY = verdict(0.1, 0.8, 0.1);
	const DIRECT = verdict(0.05, 0.1, 0.85);
	const WEAK_PREWALK = verdict(0.55, 0.35, 0.1);
	const MALFORMED = { type: "choice", choice: "prewalk" };

	type Reply = "http-400" | { type: string; [key: string]: unknown };
	interface JudgeCall {
		questions: string[];
		state: Record<string, string>;
		/** Session state at the moment the judge was asked. */
		model: string | undefined;
		configured: ConfiguredThinkingLevel | undefined;
	}

	/**
	 * Answer System One requests from `replies` (then `DIRECT`) and record each one.
	 * Auto-thinking's `level` question never consumes a reply.
	 * `gate` parks the selected question (route by default) until its promise settles.
	 */
	function stubJudge(
		replies: Reply[] = [],
		gate?: { hold: Promise<void>; requested: () => void; question?: "route" | "level"; skip?: number },
	): JudgeCall[] {
		const calls: JudgeCall[] = [];
		const usage = { input_tokens: 8, output_tokens: 2 };
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).endsWith("/v1/systemone")) throw new Error(`unexpected request: ${String(input)}`);
				const body = JSON.parse(String(init?.body)) as {
					state: Record<string, string>;
					questions: Record<string, unknown>;
				};
				const questions = Object.keys(body.questions);
				calls.push({
					questions,
					state: body.state,
					model: session?.model?.id,
					configured: session?.configuredThinkingLevel(),
				});
				if (questions.includes(gate?.question ?? "route") && gate) {
					if (gate.skip) gate.skip--;
					else {
						gate.requested();
						await gate.hold;
					}
				}
				if (questions.includes("level")) {
					const probabilities = { low: 0, medium: 0, high: 1, xhigh: 0 };
					const level = { type: "choice", choice: "high", probabilities, confidence: 1 };
					return Response.json({ model: "jev", answers: { level }, usage });
				}
				const reply = replies.shift() ?? DIRECT;
				if (reply === "http-400") return new Response("bad request", { status: 400 });
				return Response.json({ model: "jev", answers: { route: reply }, usage });
			}),
		);
		return calls;
	}

	const asked = (calls: JudgeCall[]) => calls.filter(call => call.questions.includes("route"));

	interface FixtureOptions {
		auto?: "off" | "suggest" | "on";
		/** Credential the native judge (default true). */
		judge?: boolean;
		agentKind?: "main" | "sub";
		/** Arm prewalk at startup, as `--prewalk`/`prewalk.enabled` (true = the default `@smol` target) or task prewalk would. */
		startupArm?: boolean | Model;
		suppressAutoPrewalk?: boolean;
		/** `todo.eager`, which adds a first-turn reminder before the judge is asked. */
		todoEager?: "preferred" | "always";
		extensionRunner?: ExtensionRunner;
		/** Rebuild the base system prompt per active model, so a model switch changes it. */
		rebuildBase?: boolean;
		/** Park a rebuild for `model` after its bytes are captured, before it can publish. */
		renderGate?: { model: string; requested: () => void; hold: Promise<void> };
		/** Extra model roles, e.g. a custom planner. */
		roles?: Record<string, string>;
		autoSource?: string;
		autoTarget?: string;
		beforeStream?: (context: Context, options?: SimpleStreamOptions) => Promise<void>;
	}

	function createFixture(responses: MockResponse[], options: FixtureOptions = {}) {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		if (options.judge !== false) authStorage.keys.setRuntime("typesafe", "ts-key");
		// Only the credentials set here exist. Ambient provider keys (TYPESAFE_API_KEY, OPENROUTER_API_KEY, …) must
		// neither conjure a native judge nor give the chain a fallback candidate that reaches the network.
		const credentialed = options.judge === false ? ["anthropic"] : ["anthropic", "typesafe"];
		const source = authStorage.keys.source.bind(authStorage.keys);
		vi.spyOn(authStorage.keys, "source").mockImplementation((provider, sourceOptions) =>
			credentialed.includes(provider) ? source(provider, sourceOptions) : undefined,
		);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"prewalk.enabled": false,
			modelRoles: { judge: "typesafe/jev-latest" },
			...(options.auto ? { "prewalk.auto": options.auto } : {}),
			...(options.todoEager ? { "todo.eager": options.todoEager } : {}),
		});
		settings.setModelRole("smol", `${target.provider}/${target.id}:low`);
		settings.setModelRole("slow", `${primary.provider}/${primary.id}`);
		for (const [role, value] of Object.entries(options.roles ?? {})) settings.setModelRole(role, value);
		if (options.autoSource) cfgPrewalkAutoSource.override(settings, options.autoSource);
		if (options.autoTarget) cfgPrewalkAutoTarget.override(settings, options.autoTarget);
		const mock = createMockModel({ responses });
		const requested: string[] = [];
		const efforts: Array<string | undefined> = [];
		const nudges: string[][] = [];
		const customs: string[][] = [];
		const systemPrompts: string[] = [];
		const rebuiltModels: Array<string | undefined> = [];
		let requestCustoms: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [todoTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.High,
			},
			convertToLlm: messages => {
				requestCustoms = messages.flatMap(message => (message.role === "custom" ? [message.customType] : []));
				return convertToLlm(messages);
			},
			streamFn: async (model, context, streamOptions) => {
				requested.push(model.id);
				efforts.push(agent.state.thinkingLevel);
				nudges.push(requestCustoms.filter(customType => customType.startsWith("prewalk-")));
				customs.push(requestCustoms);
				systemPrompts.push((context.systemPrompt ?? []).join("\n"));
				await options.beforeStream?.(context, streamOptions);
				return mock.stream(model, context, streamOptions);
			},
		});
		const startupTarget = options.startupArm === true ? target : options.startupArm || undefined;
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.High,
			prewalk: startupTarget ? { target: startupTarget, thinkingLevel: Effort.Low } : undefined,
			agentKind: options.agentKind,
			extensionRunner: options.extensionRunner,
			rebuildSystemPrompt: options.rebuildBase
				? async () => {
						const id = session?.model?.id;
						rebuiltModels.push(id);
						const bytes = [`base for ${id}`];
						const gate = options.renderGate;
						if (gate && gate.model === id) {
							gate.requested();
							await gate.hold;
						}
						return { systemPrompt: bytes };
					}
				: undefined,
			suppressAutoPrewalk: options.suppressAutoPrewalk,
		});
		session = created;
		const notices: string[] = [];
		created.subscribe(event => {
			if (event.type === "notice" && event.source === "prewalk") notices.push(event.message);
		});
		const ctx = {
			session: created,
			sessionManager: created.sessionManager,
			settings,
			collabGuest: false,
			showStatus: vi.fn(),
			editor: { setText: vi.fn() },
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;
		return {
			session: created,
			settings,
			modelRegistry,
			primary,
			target,
			requested,
			efforts,
			nudges,
			customs,
			systemPrompts,
			rebuiltModels,
			notices,
			ctx,
		};
	}

	describe("modes", () => {
		it("does nothing and asks the judge nothing while prewalk.auto is off, the default", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(cycle());

			await f.session.prompt(TASK);

			expect(calls).toEqual([]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id]);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
		});

		it("suggest reports each decision without arming, nudging, or switching models", async () => {
			const calls = stubJudge([PREWALK, PRIMARY]);
			const f = createFixture([...cycle(), done("two")], { auto: "suggest" });

			await f.session.prompt(TASK);
			expect(f.notices).toEqual(["Auto-prewalk: prewalk 0.90"]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id]);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.nudges.flat()).toEqual([]);

			await f.session.prompt("what races in the cache layer?");
			expect(f.notices).toEqual(["Auto-prewalk: prewalk 0.90", "Auto-prewalk: primary (prewalk 0.10)"]);
			expect(asked(calls)).toHaveLength(2);
			expect(f.session.model?.id).toBe(f.primary.id);
		});

		it("on arms a confident prewalk, and the todo-gated first write still does the switch", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(
				[toolCall("early", "write"), toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
				{ auto: "on" },
			);

			await f.session.prompt(TASK);

			expect(asked(calls)).toHaveLength(1);
			// The write before the todo list leaves the gate shut; the one after it hands off.
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id, f.target.id]);
			expect(f.session.model?.id).toBe(f.target.id);
			expect(f.nudges[0]).toContain("prewalk-plan");
			expect(f.nudges[3]).toContain("prewalk-checklist");
			// arm() already announces the arm; auto-prewalk adds no second line.
			expect(f.notices.filter(message => message.startsWith("Prewalk: armed"))).toHaveLength(1);
			expect(f.notices.some(message => message.startsWith("Auto-prewalk"))).toBe(false);
			// The judgment is billed to the session under its own purpose.
			const usage = f.session.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
			expect(usage).toEqual([expect.objectContaining({ purpose: "auto-prewalk", role: "typesafe" })]);
		});

		it.each([
			["an arm drops the eager todo reminder, as a configured prewalk would", "on", false],
			["a suggestion leaves the eager todo reminder alone", "suggest", true],
		] as const)("todo.eager: %s", async (_label, auto, keeps) => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto, todoEager: "preferred" });

			await f.session.prompt(TASK);

			// An arm owns todo creation, plan first, as with a configured prewalk; a mere suggestion changes nothing.
			expect(f.customs[0]?.includes(EAGER_TODO_PRELUDE_MESSAGE_TYPE)).toBe(keeps);
			expect(f.nudges[0]?.includes("prewalk-plan")).toBe(!keeps);
		});

		it("on keeps the coordinator's no-op rule when @smol already is the active model and effort", async () => {
			stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });
			f.settings.setModelRole("smol", `${f.primary.provider}/${f.primary.id}:high`);

			await f.session.prompt(TASK);

			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices.some(message => message.includes("nothing to switch"))).toBe(true);
			expect(f.requested).toEqual([f.primary.id]);
		});

		it("on arms nothing for primary, direct, or a prewalk that wins below the threshold", async () => {
			stubJudge([PRIMARY, DIRECT, WEAK_PREWALK]);
			const f = createFixture([done("one"), done("two"), done("three")], { auto: "on" });

			await f.session.prompt("fix the race in the lock manager");
			await f.session.prompt("what does this function return?");
			await f.session.prompt("maybe tidy up the retry code");

			expect(f.requested).toEqual(Array(3).fill(f.primary.id));
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([
				"Auto-prewalk: primary (prewalk 0.10)",
				"Auto-prewalk: direct (prewalk 0.05)",
				"Auto-prewalk: prewalk 0.55 (below threshold)",
			]);
		});

		it("suggest never moves models, even over an earlier auto handoff", async () => {
			stubJudge([PREWALK, PRIMARY]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt(TASK);
			expect(f.session.model?.id).toBe(f.target.id);

			cfgPrewalkAuto.override(f.settings, "suggest");
			await f.session.prompt("what races in the cache layer?");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.notices.at(-1)).toBe("Auto-prewalk: primary (prewalk 0.10)");
		});
	});

	describe("failing open", () => {
		it("continues the turn without arming when the judge errors, answers garbage, or times out", async () => {
			stubJudge(["http-400", MALFORMED, PREWALK]);
			const f = createFixture([done("one"), done("two"), done("three")], { auto: "on" });

			await f.session.prompt("first");
			await f.session.prompt("second");
			// A stuck judge: the timeout fires before the request is ever sent.
			const realTimeout = AbortSignal.timeout.bind(AbortSignal);
			vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
				ms === AUTO_PREWALK_TIMEOUT_MS
					? AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
					: realTimeout(ms),
			);
			await f.session.prompt("third");

			expect(f.requested).toEqual(Array(3).fill(f.primary.id));
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
		});

		it("drops a classification that lands after the prompt was aborted", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([PREWALK], { hold: hold.promise, requested: requested.resolve });
			const f = createFixture([done("never requested")], { auto: "on" });

			const first = f.session.prompt(TASK);
			await requested.promise;
			await f.session.abort();
			hold.resolve();
			await first.catch(() => {});

			expect(asked(calls)).toHaveLength(1);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.requested).toEqual([]);
			expect(f.notices).toEqual([]);
		});

		it.each([false, true])(
			"rolls back an aborted source switch with previously resolved auto thinking: %s",
			async resolved => {
				const hold = Promise.withResolvers<void>();
				const requested = Promise.withResolvers<void>();
				const calls = stubJudge(resolved ? [DIRECT, PREWALK, DIRECT] : [PREWALK, DIRECT], {
					hold: hold.promise,
					requested: requested.resolve,
					question: "level",
					skip: resolved ? 1 : 0,
				});
				const f = createFixture([done("warmup"), done("next")], {
					auto: "on",
					autoSource: "anthropic/claude-opus-4-6",
				});
				f.session.setThinkingLevel(AUTO_THINKING);
				if (resolved) {
					await f.session.prompt("warmup");
					await f.session.waitForIdle();
				}
				const previous = {
					configured: f.session.configuredThinkingLevel(),
					effective: f.session.thinkingLevel,
					autoResolved: f.session.autoResolvedThinkingLevel(),
				};
				expect(previous.autoResolved).toBe(resolved ? Effort.High : undefined);
				const boundary = f.requested.length;
				const pending = f.session.prompt(TASK);
				await requested.promise;
				const sourceId = f.session.model?.id;
				const armedTarget = f.session.getPrewalkState()?.target.id;
				try {
					await f.session.abort();
					expect(f.session.model).toBe(f.primary);
					expect(f.session.configuredThinkingLevel()).toBe(previous.configured);
					expect(f.session.thinkingLevel).toBe(previous.effective);
					expect(f.session.autoResolvedThinkingLevel()).toBe(previous.autoResolved);
					expect(f.session.getPrewalkState()).toBeUndefined();
				} finally {
					hold.resolve();
					await pending.catch(() => {});
					await f.session.waitForIdle();
				}

				expect(f.requested).toHaveLength(boundary);
				expect(sourceId).toBe("claude-opus-4-6");
				expect(armedTarget).toBe(f.target.id);
				expect(f.session.model).toBe(f.primary);
				expect(f.session.configuredThinkingLevel()).toBe(previous.configured);
				expect(f.session.thinkingLevel).toBe(previous.effective);
				expect(f.session.autoResolvedThinkingLevel()).toBe(previous.autoResolved);
				expect(f.session.getPrewalkState()).toBeUndefined();
				await f.session.prompt("next task");
				expect(asked(calls)).toHaveLength(resolved ? 3 : 2);
				expect(f.requested.at(-1)).toBe(f.primary.id);
			},
		);

		it("does not publish an auto source render that finishes after abort restored the primary", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("never requested")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6",
				rebuildBase: true,
				renderGate: { model: "claude-opus-4-6", requested: requested.resolve, hold: hold.promise },
			});
			await f.session.refreshBaseSystemPrompt();
			const primaryPrompt = [`base for ${f.primary.id}`];
			expect(f.session.systemPrompt).toEqual(primaryPrompt);
			const thinking = f.session.configuredThinkingLevel();

			const restored = Promise.withResolvers<void>();
			const setModel = f.session.agent.setModel.bind(f.session.agent);
			vi.spyOn(f.session.agent, "setModel").mockImplementation(model => {
				setModel(model);
				if (model === f.primary) restored.resolve();
			});
			const pending = f.session.prompt(TASK);
			await requested.promise;
			const aborting = f.session.abort();
			try {
				// Rollback restores the model at once; its prompt sync queues behind the held source render.
				await restored.promise;
				expect(f.session.model).toBe(f.primary);
			} finally {
				hold.resolve();
				await aborting;
				await pending.catch(() => {});
				await f.session.waitForIdle();
			}

			expect(f.session.systemPrompt).toEqual(primaryPrompt);
			expect(f.session.model).toBe(f.primary);
			expect(f.session.configuredThinkingLevel()).toBe(thinking);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.requested).toEqual([]);
			expect(asked(calls)).toHaveLength(1);
		});

		it.each([
			["classification", "model"],
			["classification", "effort"],
			["authentication", "model"],
			["authentication", "effort"],
			["recall", "model"],
			["recall", "effort"],
		] as const)("preserves manual %s-time %s selection through automatic routing", async (phase, selection) => {
			const hold = Promise.withResolvers<void>();
			const reached = Promise.withResolvers<void>();
			stubJudge(
				[PREWALK],
				phase === "classification" ? { hold: hold.promise, requested: reached.resolve } : undefined,
			);
			if (phase === "recall") {
				const backend: MemoryBackend = {
					id: "mnemopi",
					async start() {},
					async buildDeveloperInstructions() {
						return undefined;
					},
					async clear() {},
					async enqueue() {},
					async beforeAgentStartPrompt() {
						reached.resolve();
						await hold.promise;
						return { context: "<memories>manual selection wins</memories>", commit: () => true };
					},
				};
				vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
			}
			const f = createFixture([done("selected")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6:high",
			});
			if (phase === "authentication") {
				const getApiKey = f.modelRegistry.getApiKey.bind(f.modelRegistry);
				vi.spyOn(f.modelRegistry, "getApiKey").mockImplementation(async (model, ...rest) => {
					if (model.id === "claude-opus-4-6") {
						reached.resolve();
						await hold.promise;
					}
					return getApiKey(model, ...rest);
				});
			}

			const pending = f.session.prompt(TASK);
			await reached.promise;
			try {
				if (selection === "model") await f.session.setModel(f.target);
				else f.session.setThinkingLevel(Effort.Low);
			} finally {
				hold.resolve();
			}
			await pending;
			await f.session.waitForIdle();

			expect(f.requested).toEqual([selection === "model" ? f.target.id : f.primary.id]);
			expect(f.efforts).toEqual([selection === "effort" ? Effort.Low : Effort.High]);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.nudges.flat()).toEqual([]);
		});

		it("still routes a positive task after an explicit selection made before submission", async () => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on", autoSource: "anthropic/claude-opus-4-6:high" });
			await f.session.setModel(f.target);
			f.session.setThinkingLevel(Effort.Low);

			await f.session.prompt(TASK);

			expect(f.requested).toEqual(["claude-opus-4-6", "claude-opus-4-6", f.target.id]);
			expect(f.nudges[0]).toContain("prewalk-plan");
			expect(f.nudges[2]).toContain("prewalk-checklist");
		});

		it.each(["different model", "same source", "different thinking", "same thinking"] as const)(
			"preserves an explicit %s selection made after auto arming",
			async selection => {
				const hold = Promise.withResolvers<void>();
				const requested = Promise.withResolvers<void>();
				stubJudge([PREWALK], { hold: hold.promise, requested: requested.resolve, question: "level" });
				const f = createFixture([done("never requested")], {
					auto: "on",
					autoSource: "anthropic/claude-opus-4-6",
				});
				f.session.setThinkingLevel(AUTO_THINKING);
				const pending = f.session.prompt(TASK);
				await requested.promise;
				const source = f.session.model!;
				if (selection === "different model") await f.session.setModel(f.target);
				else if (selection === "same source") await f.session.setModel(source);
				else f.session.setThinkingLevel(selection === "same thinking" ? AUTO_THINKING : Effort.Low);
				const chosenModel = f.session.model;
				const chosenThinking = f.session.configuredThinkingLevel();
				await f.session.abort();
				hold.resolve();
				await pending.catch(() => {});

				expect(f.requested).toEqual([]);
				expect(source.id).toBe("claude-opus-4-6");
				expect(f.session.model).toBe(chosenModel);
				expect(f.session.configuredThinkingLevel()).toBe(chosenThinking);
				expect(f.session.getPrewalkState()).toBeUndefined();
			},
		);

		it.each(["takeover", "disarm", "replacement"] as const)(
			"preserves manual pending-arm %s when preparation is aborted",
			async action => {
				const hold = Promise.withResolvers<void>();
				const requested = Promise.withResolvers<void>();
				stubJudge([PREWALK], { hold: hold.promise, requested: requested.resolve, question: "level" });
				const f = createFixture([done("never requested")], {
					auto: "on",
					autoSource: "anthropic/claude-opus-4-6",
				});
				f.session.setThinkingLevel(AUTO_THINKING);
				const pending = f.session.prompt(TASK);
				await requested.promise;
				const armedTarget = f.session.getPrewalkState()?.target.id;
				let accepted = true;
				if (action !== "takeover") f.session.disarmPrewalk();
				if (action !== "disarm") {
					accepted = f.session.armPrewalk(action === "takeover" ? f.target : f.primary, Effort.Low);
				}
				await f.session.abort();
				hold.resolve();
				await pending.catch(() => {});

				expect(f.requested).toEqual([]);
				expect(armedTarget).toBe(f.target.id);
				expect(accepted).toBe(true);
				expect(f.session.model).toBe(f.primary);
				expect(f.session.getPrewalkState()?.target.id).toBe(
					action === "disarm" ? undefined : action === "takeover" ? f.target.id : f.primary.id,
				);
				if (action === "takeover") {
					await f.session.waitForIdle();
					await f.session.prompt("continue the manually adopted plan");
					expect(f.nudges[0]).toContain("prewalk-plan");
					expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);
				}
			},
		);

		it("rolls back a stale generation after navigating history without aborting the prompt", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([DIRECT, PREWALK, DIRECT], {
				hold: hold.promise,
				requested: requested.resolve,
				question: "level",
				skip: 1,
			});
			const f = createFixture([done("warmup"), done("next")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6",
			});
			f.session.setThinkingLevel(AUTO_THINKING);
			await f.session.prompt("warmup");
			await f.session.waitForIdle();
			const target = f.session.sessionManager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "user");
			expect(target).toBeDefined();
			const boundary = f.requested.length;
			const previousEffort = f.session.thinkingLevel;
			const previousAutoResolved = f.session.autoResolvedThinkingLevel();
			const pending = f.session.prompt(TASK);
			await requested.promise;
			const sourceId = f.session.model?.id;
			const armedTarget = f.session.getPrewalkState()?.target.id;
			try {
				const navigation = await f.session.navigateTree(target!.id, { summarize: false });
				expect(navigation.cancelled).toBe(false);
			} finally {
				hold.resolve();
				await pending.catch(() => {});
				await f.session.waitForIdle();
			}

			expect(f.requested).toHaveLength(boundary);
			expect(sourceId).toBe("claude-opus-4-6");
			expect(armedTarget).toBe(f.target.id);
			expect(f.session.model).toBe(f.primary);
			expect(f.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
			expect(f.session.thinkingLevel).toBe(previousEffort);
			expect(f.session.autoResolvedThinkingLevel()).toBe(previousAutoResolved);
			expect(f.session.getPrewalkState()).toBeUndefined();
			await f.session.prompt("fresh task");
			expect(asked(calls)).toHaveLength(3);
			expect(f.requested.at(-1)).toBe(f.primary.id);
		});

		it("does not restore model or thinking for an aborted negative classification", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			stubJudge([DIRECT], { hold: hold.promise, requested: requested.resolve, question: "level" });
			const f = createFixture([done("never requested")], { auto: "on" });
			f.session.setThinkingLevel(AUTO_THINKING);
			const pending = f.session.prompt(TASK);
			await requested.promise;
			const setModel = vi.spyOn(f.session.agent, "setModel");
			const setThinking = vi.spyOn(f.session.agent, "setThinkingLevel");
			await f.session.abort();
			hold.resolve();
			await pending.catch(() => {});

			expect(f.requested).toEqual([]);
			expect(f.session.model).toBe(f.primary);
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinking).not.toHaveBeenCalled();
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it.each(["manual", "configured", "task"] as const)("keeps an existing %s arm on cancellation", async kind => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			const calls = stubJudge([PREWALK], {
				hold: hold.promise,
				requested: requested.resolve,
				question: "level",
			});
			const f = createFixture([done("never requested")], {
				auto: "on",
				startupArm: kind !== "manual",
				agentKind: kind === "task" ? "sub" : "main",
			});
			if (kind === "manual") f.session.armPrewalk(f.target, Effort.Low);
			f.session.setThinkingLevel(AUTO_THINKING);
			const pending = f.session.prompt(TASK);
			await requested.promise;
			await f.session.abort();
			hold.resolve();
			await pending.catch(() => {});

			expect(asked(calls)).toHaveLength(0);
			expect(f.requested).toEqual([]);
			expect(f.session.model).toBe(f.primary);
			expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);
		});

		it("does not overwrite a manual selection made while rollback metadata is refreshing", async () => {
			const hold = Promise.withResolvers<void>();
			const requested = Promise.withResolvers<void>();
			stubJudge([PREWALK], { hold: hold.promise, requested: requested.resolve, question: "level" });
			const f = createFixture([done("never requested")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6",
			});
			f.session.setThinkingLevel(AUTO_THINKING);
			const pending = f.session.prompt(TASK);
			await requested.promise;
			const rollbackHold = Promise.withResolvers<void>();
			const rollbackRequested = Promise.withResolvers<void>();
			const refresh = f.modelRegistry.refreshSelectedModelMetadata.bind(f.modelRegistry);
			vi.spyOn(f.modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
				if (model.id === f.primary.id) {
					rollbackRequested.resolve();
					await rollbackHold.promise;
				}
				return refresh(model);
			});
			const aborting = f.session.abort();
			await rollbackRequested.promise;
			try {
				await f.session.setModel(f.target);
				f.session.setThinkingLevel(Effort.Low);
			} finally {
				rollbackHold.resolve();
			}
			try {
				await aborting;
			} finally {
				hold.resolve();
			}
			await pending.catch(() => {});

			expect(f.requested).toEqual([]);
			expect(f.session.model).toBe(f.target);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("rolls back source selection and its arm when later prompt compaction fails", async () => {
			stubJudge([PREWALK]);
			const f = createFixture([done("never requested")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6:low",
			});
			f.session.setThinkingLevel(AUTO_THINKING);
			const previousEffort = f.session.thinkingLevel;
			const failure = new Error("pre-prompt compaction failed");
			vi.spyOn(SessionMaintenance.prototype, "runPrePromptCompactionIfNeeded").mockRejectedValueOnce(failure);

			await expect(f.session.prompt(TASK)).rejects.toThrow(failure.message);

			expect(f.requested).toEqual([]);
			expect(f.session.model).toBe(f.primary);
			expect(f.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
			expect(f.session.thinkingLevel).toBe(previousEffort);
			expect(f.session.autoResolvedThinkingLevel()).toBeUndefined();
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("makes no judgment and no change without a native judge", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on", judge: false });

			await f.session.prompt(TASK);

			expect(calls).toEqual([]);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, f.primary.id]);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices).toEqual([]);
		});
	});

	describe("eligibility", () => {
		it.each([
			["a synthetic continuation", { synthetic: true }],
			["an agent-attributed prompt", { attribution: "agent" }],
		] as const)("never classifies %s", async (_label, promptOptions) => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });

			await f.session.prompt(TASK, promptOptions);

			expect(calls).toEqual([]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("never classifies a plan-mode turn, whose plan-file write would trip the handoff", async () => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on" });
			f.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" });

			await f.session.prompt(TASK);

			expect(calls).toEqual([]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});
	});

	describe("context", () => {
		it("hands a short follow-up the earlier request and the agent's reply", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			const reply = "The cursor resets because sync() reads a stale offset. Fix: persist it before awaiting.";
			const f = createFixture([{ content: [reply] }, ...cycle()], { auto: "on" });

			await f.session.prompt("why does the sync cursor reset after a reconnect?");
			await f.session.prompt("do that");

			const [first, second] = asked(calls);
			expect(first!.state).toEqual({ request: "why does the sync cursor reset after a reconnect?" });
			expect(second!.state).toEqual({
				request: "do that",
				previous_request: "why does the sync cursor reset after a reconnect?",
				previous_response: reply,
			});
			expect(f.session.model?.id).toBe(f.target.id);
		});
	});

	describe("queued task delivery", () => {
		it("keeps visible live steering on the old response until its source is selected at the next boundary", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			const contexts: string[] = [];
			let liveClaimSettled = false;
			let liveWaitSettled = false;
			const f = createFixture([done("first"), ...cycle()], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6:high",
				rebuildBase: true,
				beforeStream: async (context, options) => {
					contexts.push(JSON.stringify(context.messages));
					if (contexts.length !== 1) return;
					const live = options?.liveSteering;
					if (!live) throw new Error("Expected the streaming provider's live steering channel");
					await f.session.steer(TASK);
					const controller = new AbortController();
					const waiting = live.wait(controller.signal).then(() => {
						liveWaitSettled = true;
					});
					const claiming = live.claim(controller.signal).then(claim => {
						liveClaimSettled = true;
						return claim;
					});
					await Promise.resolve();
					await Promise.resolve();
					expect(liveWaitSettled).toBe(false);
					expect(liveClaimSettled).toBe(false);
					expect(asked(calls).map(call => call.state.request)).toEqual(["explain the sync engine"]);
					expect(f.session.model?.id).toBe(f.primary.id);
					expect(f.session.agent.peekSteeringQueue()).toHaveLength(1);
					controller.abort();
					await waiting;
					expect(await claiming).toBeUndefined();
				},
			});

			await f.session.prompt("explain the sync engine");
			await f.session.waitForIdle();

			expect(asked(calls).map(call => call.state.request)).toEqual(["explain the sync engine", TASK]);
			expect(f.requested).toEqual([f.primary.id, "claude-opus-4-6", "claude-opus-4-6", f.target.id]);
			expect(contexts[0]).not.toContain(TASK);
			expect(contexts[1]).toContain(TASK);
			expect(f.systemPrompts[1]).toContain("base for claude-opus-4-6");
			expect(f.nudges[1]).toContain("prewalk-plan");
		});

		it("judges a queued follow-up separately in suggest mode without selecting a source", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			const f = createFixture([done("first"), done("follow-up")], {
				auto: "suggest",
				autoSource: "anthropic/claude-opus-4-6:high",
			});
			const getApiKey = vi.spyOn(f.modelRegistry, "getApiKey");
			let queued = false;
			f.session.agent.setOnBeforeYield(async () => {
				if (queued) return;
				queued = true;
				await f.session.followUp("fix the cursor next");
			});

			await f.session.prompt("explain the sync engine");
			await f.session.waitForIdle();

			expect(asked(calls).map(call => call.state.request)).toEqual([
				"explain the sync engine",
				"fix the cursor next",
			]);
			expect(f.notices).toEqual(["Auto-prewalk: direct (prewalk 0.05)", "Auto-prewalk: prewalk 0.90"]);
			expect(getApiKey.mock.calls.some(([model]) => model.id === "claude-opus-4-6")).toBe(false);
			expect(f.requested).toEqual([f.primary.id, f.primary.id]);
			expect(f.nudges.flat()).toEqual([]);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("prepares queued thinking, recall, and hooks on the selected source before handing off", async () => {
			const calls = stubJudge([DIRECT, PREWALK]);
			const recall = "<memories>queued source recall</memories>";
			const recallModels: Array<string | undefined> = [];
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async buildDeveloperInstructions() {
					return undefined;
				},
				async clear() {},
				async enqueue() {},
				async beforeAgentStartPrompt() {
					recallModels.push(session?.model?.id);
					return { context: recall, commit: () => true };
				},
			};
			vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
			const hookModels: Array<string | undefined> = [];
			const extensionRunner = {
				emitBeforeAgentStart: vi.fn(async () => {
					hookModels.push(session?.model?.id);
					return { messages: [{ customType: "queued-hook", content: "source hook", display: false }] };
				}),
				emit: vi.fn().mockResolvedValue(undefined),
				hasHandlers: vi.fn().mockReturnValue(false),
			} as unknown as ExtensionRunner;
			const f = createFixture([done("first"), ...cycle()], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6",
				rebuildBase: true,
				extensionRunner,
			});
			f.session.setThinkingLevel(AUTO_THINKING);
			let queued = false;
			f.session.agent.setOnBeforeYield(async () => {
				if (queued) return;
				queued = true;
				await f.session.followUp(TASK);
			});

			await f.session.prompt("explain the sync engine");
			await f.session.waitForIdle();

			expect(asked(calls).map(call => call.state.request)).toEqual(["explain the sync engine", TASK]);
			expect(calls.filter(call => call.questions.includes("level")).map(call => call.model)).toEqual([
				f.primary.id,
				"claude-opus-4-6",
			]);
			expect(hookModels).toEqual([f.primary.id, "claude-opus-4-6"]);
			expect(recallModels.at(-1)).toBe("claude-opus-4-6");
			expect(f.requested).toEqual([f.primary.id, "claude-opus-4-6", "claude-opus-4-6", f.target.id]);
			expect(f.systemPrompts[1]).toContain("base for claude-opus-4-6");
			expect(f.systemPrompts[1]).toContain(recall);
			expect(f.customs[1]).toContain("queued-hook");
			expect(f.nudges[1]).toContain("prewalk-plan");
			expect(f.nudges[3]).toContain("prewalk-checklist");
			expect(f.efforts[1]).toBe(Effort.High);
			expect(f.efforts[3]).toBe(Effort.Low);
		});

		it.each(["classification", "selection", "rebuild"] as const)(
			"withdraws queued routing during %s without changing the running prompt generation",
			async phase => {
				const hold = Promise.withResolvers<void>();
				const reached = Promise.withResolvers<void>();
				const calls = stubJudge(
					[DIRECT, PREWALK, DIRECT],
					phase === "classification" ? { hold: hold.promise, requested: reached.resolve, skip: 1 } : undefined,
				);
				const f = createFixture([done("first"), done("replacement")], {
					auto: "on",
					autoSource: "anthropic/claude-opus-4-6:low",
					rebuildBase: true,
					...(phase === "rebuild"
						? { renderGate: { model: "claude-opus-4-6", hold: hold.promise, requested: reached.resolve } }
						: {}),
				});
				if (phase === "selection") {
					const getApiKey = f.modelRegistry.getApiKey.bind(f.modelRegistry);
					vi.spyOn(f.modelRegistry, "getApiKey").mockImplementation(async (model, ...rest) => {
						if (model.id === "claude-opus-4-6") {
							reached.resolve();
							await hold.promise;
						}
						return getApiKey(model, ...rest);
					});
				}
				const generations: number[] = [];
				const applyAuto = PrewalkCoordinator.prototype.applyAuto;
				vi.spyOn(PrewalkCoordinator.prototype, "applyAuto").mockImplementation(function (
					this: PrewalkCoordinator,
					...args: Parameters<PrewalkCoordinator["applyAuto"]>
				) {
					generations.push(args[1]);
					return applyAuto.call(this, ...args);
				});
				let queued = false;
				f.session.agent.setOnBeforeYield(async () => {
					if (queued) return;
					queued = true;
					await f.session.followUp("withdraw this task");
				});

				const run = f.session.prompt("first task");
				await reached.promise;
				try {
					expect(f.session.removeQueuedMessage("withdraw this task", "followUp")).toBe(true);
					await f.session.followUp("replacement task");
				} finally {
					hold.resolve();
				}
				await run;
				await f.session.waitForIdle();

				expect(asked(calls).map(call => call.state.request)).toEqual([
					"first task",
					"withdraw this task",
					"replacement task",
				]);
				expect(generations).toHaveLength(3);
				expect(new Set(generations).size).toBe(1);
				expect(f.requested).toEqual([f.primary.id, f.primary.id]);
				expect(f.session.model).toBe(f.primary);
				expect(f.session.configuredThinkingLevel()).toBe(Effort.High);
				expect(f.session.getPrewalkState()).toBeUndefined();
				expect(f.systemPrompts.at(-1)).not.toContain("base for claude-opus-4-6");
				expect(
					f.session.messages.some(
						message => message.role === "user" && JSON.stringify(message.content).includes("withdraw this task"),
					),
				).toBe(false);
			},
		);

		it.each([
			["adoption", false],
			["adoption", true],
			["restart", false],
			["restart", true],
			["disarm", false],
			["replacement", false],
		] as const)("keeps queued plan nudge ownership after manual %s (withdrawn: %s)", async (action, withdrawn) => {
			const hold = Promise.withResolvers<void>();
			const reached = Promise.withResolvers<void>();
			const calls = stubJudge([DIRECT, PREWALK], {
				hold: hold.promise,
				requested: reached.resolve,
				question: "level",
				skip: 1,
			});
			const f = createFixture([done("first"), done("queued")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6",
			});
			f.session.setThinkingLevel(AUTO_THINKING);
			let queued = false;
			f.session.agent.setOnBeforeYield(async () => {
				if (queued) return;
				queued = true;
				await f.session.followUp("queued plan");
			});

			const run = f.session.prompt("first task");
			await reached.promise;
			try {
				expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);
				if (action === "restart") {
					expect(await f.session.restartPrewalk(f.session.model!, AUTO_THINKING, f.target, Effort.Low)).toBe(
						"armed",
					);
				} else {
					if (action === "disarm" || action === "replacement") f.session.disarmPrewalk();
					if (action !== "disarm") {
						expect(f.session.armPrewalk(action === "replacement" ? f.primary : f.target, Effort.Low)).toBe(true);
					}
				}
				if (withdrawn) {
					expect(f.session.removeQueuedMessage("queued plan", "followUp")).toBe(true);
					await f.session.followUp("continue manual plan");
				}
			} finally {
				hold.resolve();
			}
			await run;
			await f.session.waitForIdle();

			expect(asked(calls).map(call => call.state.request)).toEqual(["first task", "queued plan"]);
			expect(f.nudges[0]).toEqual([]);
			if (!withdrawn) expect(f.requested[1]).toBe("claude-opus-4-6");
			expect(f.nudges[1].filter(customType => customType === "prewalk-plan")).toHaveLength(
				action === "disarm" ? 0 : 1,
			);
			expect(f.session.getPrewalkState()?.target.id).toBe(
				action === "disarm" ? undefined : action === "replacement" ? f.primary.id : f.target.id,
			);
			expect(
				f.session.messages.some(
					message =>
						message.role === "user" &&
						JSON.stringify(message.content).includes(withdrawn ? "continue manual plan" : "queued plan"),
				),
			).toBe(true);
			if (withdrawn) {
				expect(
					f.session.messages.some(
						message => message.role === "user" && JSON.stringify(message.content).includes("queued plan"),
					),
				).toBe(false);
			}
		});

		it.each(["commit", "rollback"] as const)(
			"does not let a stale %s finalize a replacement auto selection in the same generation",
			async finalizer => {
				stubJudge([DIRECT, PREWALK, PREWALK]);
				const f = createFixture([done("first")], {
					auto: "on",
					autoSource: "anthropic/claude-opus-4-6:low",
				});
				let coordinator: PrewalkCoordinator | undefined;
				let generation = -1;
				const applyAuto = PrewalkCoordinator.prototype.applyAuto;
				vi.spyOn(PrewalkCoordinator.prototype, "applyAuto").mockImplementation(function (
					this: PrewalkCoordinator,
					...args: Parameters<PrewalkCoordinator["applyAuto"]>
				) {
					coordinator = this;
					generation = args[1];
					return applyAuto.call(this, ...args);
				});
				await f.session.prompt("first task");
				await f.session.waitForIdle();
				if (!coordinator) throw new Error("Expected the session's prewalk coordinator");
				const first = new AbortController();
				const replacement = new AbortController();
				expect(await coordinator.applyAuto("first selection", generation, first.signal)).toBe(true);
				expect(await coordinator.applyAuto("replacement selection", generation, replacement.signal)).toBe(true);

				if (finalizer === "commit") coordinator.commitAuto(generation, first.signal);
				else await coordinator.rollbackAuto(generation, first.signal);

				expect(f.session.model?.id).toBe("claude-opus-4-6");
				expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);
				await coordinator.rollbackAuto(generation, replacement.signal);
				expect(f.session.model).toBe(f.primary);
				expect(f.session.configuredThinkingLevel()).toBe(Effort.High);
				expect(f.session.getPrewalkState()).toBeUndefined();
			},
		);
	});

	describe("one task at a time", () => {
		it.each([
			["primary", PRIMARY],
			["direct", DIRECT],
			["a prewalk below the threshold", WEAK_PREWALK],
		] as const)("stays on the handoff model and exact effort for %s", async (_label, reply) => {
			const calls = stubJudge([PREWALK, reply]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			expect(f.session.model?.id).toBe(f.target.id);

			await f.session.prompt("task two");

			// Judged on the model the session was on, and nothing moved.
			expect(asked(calls).at(-1)?.model).toBe(f.target.id);
			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.efforts.at(-1)).toBe(Effort.Low);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("stays on the handoff model and effort when the next task's judgment fails", async () => {
			stubJudge([PREWALK, "http-400"]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.session.model?.id).toBe(f.target.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("a later positive task moves to the configured source and arms the target again", async () => {
			const calls = stubJudge([PREWALK, PREWALK]);
			const f = createFixture([...cycle(), ...cycle()], {
				auto: "on",
				roles: { slow: "anthropic/claude-sonnet-4-5:high" },
			});
			await f.session.prompt("task one");
			expect(f.session.model?.id).toBe(f.target.id);
			const boundary = f.requested.length;

			await f.session.prompt("task two");

			// Classified on the handoff model, then planned on the source and handed off again.
			expect(asked(calls).at(-1)?.model).toBe(f.target.id);
			expect(f.requested.slice(boundary)).toEqual([f.primary.id, f.primary.id, f.target.id]);
			expect(f.efforts[boundary]).toBe(Effort.High);
			expect(f.nudges[boundary]).toContain("prewalk-plan");
			expect(f.notices).toContain(`Auto-prewalk: planning on ${f.primary.provider}/${f.primary.id} for this task.`);
		});

		it("auto thinking is judged on the source after a positive task and on the current model otherwise", async () => {
			const calls = stubJudge([PREWALK, PREWALK, PRIMARY]);
			const f = createFixture([...cycle(), ...cycle(), done("three")], { auto: "on" });
			await f.session.prompt("task one");

			f.session.setThinkingLevel(AUTO_THINKING);
			await f.session.prompt("task two");
			expect(calls.slice(-2).map(call => [call.questions[0], call.model])).toEqual([
				["route", f.target.id],
				["level", f.primary.id],
			]);

			f.session.setThinkingLevel(AUTO_THINKING);
			await f.session.prompt("task three");
			expect(calls.slice(-2).map(call => [call.questions[0], call.model])).toEqual([
				["route", f.target.id],
				["level", f.target.id],
			]);
		});

		it.each([
			["default @slow and @smol roles", {}],
			[
				"custom roles",
				{
					roles: { planner: "anthropic/claude-opus-4-6:high", worker: "anthropic/claude-sonnet-4-6:low" },
					autoSource: "@planner",
					autoTarget: "@worker",
				},
			],
			[
				"concrete selectors",
				{
					autoSource: "anthropic/claude-opus-4-6:high",
					autoTarget: "anthropic/claude-sonnet-4-6:low",
				},
			],
		] as const)("resolves source and target from %s", async (label, options) => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on", ...options });

			await f.session.prompt(TASK);

			const source = label === "default @slow and @smol roles" ? f.primary : modelOrThrow("claude-opus-4-6");
			expect(f.requested).toEqual([source.id, source.id, f.target.id]);
		});

		it.each([
			["an unknown source", { autoSource: "anthropic/no-such-model" }, undefined],
			["an unknown target", { autoTarget: "anthropic/no-such-model" }, undefined],
			["a source without a usable credential", { autoSource: "anthropic/claude-opus-4-6:high" }, "claude-opus-4-6"],
			["a target without a usable credential", { autoTarget: "anthropic/claude-opus-4-6:high" }, "claude-opus-4-6"],
		] as const)("changes nothing when %s cannot be resolved", async (_label, options, withoutKey) => {
			stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on", ...options });
			if (withoutKey) {
				const getApiKey = f.modelRegistry.getApiKey.bind(f.modelRegistry);
				vi.spyOn(f.modelRegistry, "getApiKey").mockImplementation((model, ...rest) =>
					model.id === withoutKey ? Promise.resolve(undefined) : getApiKey(model, ...rest),
				);
			}

			await f.session.prompt(TASK);

			expect(f.requested).toEqual([f.primary.id]);
			expect(f.session.model?.id).toBe(f.primary.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.High);
			expect(f.session.getPrewalkState()).toBeUndefined();
			expect(f.notices.some(message => message.startsWith("Auto-prewalk skipped"))).toBe(true);
		});

		it.each([
			["resolves the source before the target", false, ["claude-opus-4-6", "claude-sonnet-4-6"]],
			["never resolves the target once the source fails", true, ["claude-opus-4-6"]],
		] as const)("%s", async (_label, sourceFails, expected) => {
			stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "on", autoSource: "anthropic/claude-opus-4-6:high" });
			const getApiKey = f.modelRegistry.getApiKey.bind(f.modelRegistry);
			const resolved: string[] = [];
			vi.spyOn(f.modelRegistry, "getApiKey").mockImplementation((model, ...rest) => {
				if (model.id === "claude-opus-4-6" || model.id === f.target.id) resolved.push(model.id);
				return sourceFails && model.id === "claude-opus-4-6"
					? Promise.resolve(undefined)
					: getApiKey(model, ...rest);
			});

			await f.session.prompt(TASK);

			expect(resolved).toEqual([...expected]);
		});

		it.each([
			["keeps the recall and hook messages on the rebuilt base prompt", undefined],
			["leaves a hook's system prompt override untouched", ["OVERRIDE"]],
		] as const)(
			"runs before_agent_start once on a switch that rebuilds the prompt, and %s",
			async (_label, override) => {
				stubJudge([PREWALK]);
				const recall = "<memories>remember blue</memories>";
				const backend: MemoryBackend = {
					id: "mnemopi",
					async start() {},
					async buildDeveloperInstructions() {
						return undefined;
					},
					async clear() {},
					async enqueue() {},
					async beforeAgentStartPrompt() {
						return { context: recall, commit: () => true };
					},
				};
				vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
				const emitBeforeAgentStart = vi.fn().mockResolvedValue({
					messages: [{ customType: "hook-note", content: "from hook", display: false }],
					...(override ? { systemPrompt: [...override] } : {}),
				});
				const extensionRunner = {
					emitBeforeAgentStart,
					emit: vi.fn().mockResolvedValue(undefined),
					hasHandlers: vi.fn().mockReturnValue(false),
				} as unknown as ExtensionRunner;
				const f = createFixture(cycle(), {
					auto: "on",
					autoSource: "anthropic/claude-opus-4-6:high",
					extensionRunner,
					rebuildBase: true,
				});

				await f.session.prompt(TASK);

				expect(f.requested[0]).toBe("claude-opus-4-6");
				expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
				expect(f.customs[0]).toContain("hook-note");
				if (override) {
					expect(f.systemPrompts[0]).toBe("OVERRIDE");
				} else {
					expect(f.systemPrompts[0]).toContain("base for claude-opus-4-6");
					expect(f.systemPrompts[0]).toContain(recall);
				}
			},
		);

		it("suggest resolves no selector and switches nothing", async () => {
			stubJudge([PREWALK]);
			const f = createFixture([done("one")], { auto: "suggest", autoSource: "anthropic/claude-opus-4-6:high" });
			const getApiKey = vi.spyOn(f.modelRegistry, "getApiKey");

			await f.session.prompt(TASK);

			const asked = getApiKey.mock.calls.map(([model]) => model.id);
			expect(asked.filter(id => id === "claude-opus-4-6" || id === f.target.id)).toEqual([]);
			expect(f.session.model?.id).toBe(f.primary.id);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("preserves committed recall when an unarmable target rolls the rebuilt source prompt back", async () => {
			stubJudge([PREWALK]);
			const recall = "<memories>remember blue after rollback</memories>";
			const commit = vi.fn(() => true);
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async buildDeveloperInstructions() {
					return undefined;
				},
				async clear() {},
				async enqueue() {},
				async beforeAgentStartPrompt() {
					return { context: recall, commit };
				},
			};
			vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
			const selector = "anthropic/claude-opus-4-6:high";
			const f = createFixture([done("one")], {
				auto: "on",
				autoSource: selector,
				autoTarget: selector,
				rebuildBase: true,
			});
			f.session.setThinkingLevel(AUTO_THINKING);
			const applyAuto = vi.spyOn(PrewalkCoordinator.prototype, "applyAuto");

			await f.session.prompt(TASK);

			expect(f.session.model).toBe(f.primary);
			expect(f.session.isAutoThinking).toBe(true);
			expect(f.requested).toEqual([f.primary.id]);
			expect(f.systemPrompts[0]).toContain(`base for ${f.primary.id}`);
			expect(f.systemPrompts[0]).toContain(recall);
			expect(commit).toHaveBeenCalledTimes(1);
			expect(f.rebuiltModels).toContain("claude-opus-4-6");
			expect(f.rebuiltModels.at(-1)).toBe(f.primary.id);
			expect(await applyAuto.mock.results[0]!.value).toBe(false);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});

		it("an explicit model selection after the handoff keeps the session where the user put it", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			const manual = modelOrThrow("claude-opus-4-6");
			await f.session.setModel(manual);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(manual.id);
			expect(f.session.model?.id).toBe(manual.id);
		});

		it("reselecting the handoff model explicitly also takes ownership", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			await f.session.setModel(f.target);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.session.model?.id).toBe(f.target.id);
		});

		it("an explicit effort selection after the handoff keeps the model and effort the user chose", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			await f.session.prompt("task one");
			f.session.setThinkingLevel(Effort.High);

			await f.session.prompt("task two");

			expect(f.requested.at(-1)).toBe(f.target.id);
			expect(f.efforts.at(-1)).toBe(Effort.High);
		});

		it("never restores a handoff that /prewalk made, though the model is the @smol target", async () => {
			const calls = stubJudge([DIRECT]);
			const f = createFixture([...cycle(), done("two")], { auto: "on" });
			expect(f.session.armPrewalk(f.target, Effort.Low)).toBe(true);
			await f.session.prompt("task one");
			expect(f.session.model?.id).toBe(f.target.id);

			await f.session.prompt("task two");

			// The second task is judged (nothing is armed), but no auto handoff exists to restore.
			expect(asked(calls)).toHaveLength(1);
			expect(f.requested.at(-1)).toBe(f.target.id);
		});

		it("/new stays on an auto handoff's model unless a configured prewalk re-arms", async () => {
			stubJudge([PREWALK]);
			const f = createFixture(cycle(), { auto: "on" });
			await f.session.prompt(TASK);
			expect(f.session.model?.id).toBe(f.target.id);

			expect(await f.session.newSession()).toBe(true);

			expect(f.session.model?.id).toBe(f.target.id);
			expect(f.session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(f.session.getPrewalkState()).toBeUndefined();
		});
	});

	describe("manual control", () => {
		it("leaves a configured arm untouched: no judgment, no retargeting", async () => {
			const calls = stubJudge([PREWALK]);
			const configured = modelOrThrow("claude-opus-4-6");
			const f = createFixture(cycle(), { auto: "on", startupArm: configured });

			await f.session.prompt(TASK);

			expect(asked(calls)).toHaveLength(0);
			expect(f.requested).toEqual([f.primary.id, f.primary.id, configured.id]);
			expect(f.notices.some(message => message.startsWith("Auto-prewalk"))).toBe(false);
		});

		it("keeps its own pending arm instead of judging the next message again", async () => {
			const calls = stubJudge([PREWALK, PRIMARY]);
			const f = createFixture([{ content: ["plan only"] }, { content: ["still planning"] }, done("two")], {
				auto: "on",
				autoSource: "anthropic/claude-opus-4-6",
			});

			await f.session.prompt(TASK);
			expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);
			await f.session.prompt("keep going");

			expect(asked(calls)).toHaveLength(1);
			expect(f.requested).toContain("claude-opus-4-6");
			expect(f.requested.every(id => id === "claude-opus-4-6")).toBe(true);
			expect(f.session.model?.id).toBe("claude-opus-4-6");
			expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);
		});

		it("an explicit /prewalk on its pending arm takes it over and the handoff completes", async () => {
			stubJudge([PREWALK, DIRECT]);
			const f = createFixture(
				[{ content: ["plan only"] }, { content: ["still planning"] }, ...cycle(), done("three")],
				{ auto: "on" },
			);
			await f.session.prompt(TASK);
			expect(f.session.getPrewalkState()?.target.id).toBe(f.target.id);

			expect(f.session.armPrewalk(f.target, Effort.Low)).toBe(true);
			await f.session.prompt("go ahead");
			expect(f.session.model?.id).toBe(f.target.id);
			await f.session.prompt("task three");

			expect(f.requested.at(-1)).toBe(f.target.id);
		});

		it("/prewalk off keeps auto-prewalk out of the session until /new", async () => {
			const calls = stubJudge([PREWALK, PREWALK]);
			const f = createFixture([done("one"), ...cycle()], { auto: "on" });
			expect(await executeBuiltinSlashCommand("/prewalk off", { ctx: f.ctx })).toBe(true);

			await f.session.prompt(TASK);
			expect(asked(calls)).toHaveLength(0);
			expect(f.requested).toEqual([f.primary.id]);

			expect(await f.session.newSession()).toBe(true);
			const boundary = f.requested.length;
			await f.session.prompt(TASK);

			expect(asked(calls)).toHaveLength(1);
			expect(f.requested.slice(boundary)).toEqual([f.primary.id, f.primary.id, f.target.id]);
		});

		it("--no-prewalk keeps auto-prewalk out of the startup session only", async () => {
			const calls = stubJudge([PREWALK, PREWALK]);
			const f = createFixture([done("one"), ...cycle()], { auto: "on", suppressAutoPrewalk: true });

			await f.session.prompt(TASK);
			expect(asked(calls)).toHaveLength(0);
			expect(f.session.getPrewalkState()).toBeUndefined();

			expect(await f.session.newSession()).toBe(true);
			const boundary = f.requested.length;
			await f.session.prompt(TASK);

			expect(f.requested.slice(boundary)).toEqual([f.primary.id, f.primary.id, f.target.id]);
		});
	});

	describe("subagents", () => {
		it.each([
			["task prewalk still hands off and is never restored", true, [0, 1, 2, 2]],
			["no auto-arming happens at all", false, [0, 0]],
		] as const)("%s", async (_label, startupArm, expected) => {
			const calls = stubJudge([PREWALK]);
			const f = createFixture(startupArm ? [...cycle(), done("two")] : [done("one"), done("two")], {
				auto: "on",
				agentKind: "sub",
				startupArm,
			});

			await f.session.prompt("task one");
			await f.session.prompt("task two");

			const ids = [f.primary.id, f.primary.id, f.target.id, f.target.id];
			expect(f.requested).toEqual(expected.map(index => ids[index]!));
			expect(asked(calls)).toHaveLength(0);
		});
	});
});
