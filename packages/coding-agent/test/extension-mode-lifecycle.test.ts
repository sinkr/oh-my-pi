import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionContext,
	ExtensionFactory,
	ModeChangedEvent,
	ModeRequest,
	ModeResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";

const missionPath = path.resolve(import.meta.dir, "../examples/extensions/mission.ts");

function success(result: ModeResult): void {
	if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
}

function failure(result: ModeResult): string {
	if (result.ok) throw new Error("Expected transition refusal");
	return result.code;
}

describe("extension built-in mode lifecycle", () => {
	let root: TempDir;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const dirs: TempDir[] = [];
	const modes: InteractiveMode[] = [];

	beforeAll(async () => {
		initTheme();
		root = TempDir.createSync("omp-mode-api-auth-");
		await Settings.init({ inMemory: true, cwd: root.path() });
		registry = new ModelRegistry(await discoverAuthStorage(root.path()));
		registry.authStorage.keys.setRuntime("openai", "test-key");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const mode of modes.splice(0)) mode.stop();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const dir of dirs.splice(0)) dir.removeSync();
	});
	afterAll(() => {
		registry.authStorage.close();
		root.removeSync();
	});

	async function harness(host: "tui" | "rpc" | "print" | "json" = "tui", extra?: ExtensionFactory) {
		const dir = TempDir.createSync("omp-mode-api-");
		dirs.push(dir);
		const events: ModeChangedEvent[] = [];
		const observed: ExtensionContext[] = [];
		const observer: ExtensionFactory = pi => {
			pi.on("session_start", (_event, ctx) => {
				observed.push(ctx);
			});
			pi.on("mode_changed", (event, ctx) => {
				events.push(event);
				observed.push(ctx);
			});
		};
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({
				"plan.enabled": true,
				"goal.enabled": true,
				"goal.continuationModes": [],
				"compaction.enabled": false,
			}),
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [missionPath],
			extensions: extra ? [observer, extra] : [observer],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: false,
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		sessions.push(session);
		const provider = createMockModel({ handler: () => ({ content: ["Mission received"] }) });
		session.agent.streamFn = provider.stream;
		let mode: InteractiveMode | undefined;
		if (host === "tui") {
			mode = new InteractiveMode(session, "test");
			modes.push(mode);
			await mode.initHooksAndCustomTools();
		} else {
			await initializeExtensions(session, {
				mode: host,
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: error => {
					throw new Error(error.error);
				},
			});
		}
		const runner = session.extensionRunner!;
		return { session, mode, runner, ctx: runner.createContext(), events, observed, provider };
	}

	it("mission enters directly, sends separately, and exits without approving or deleting its draft", async () => {
		const { session, runner, ctx, provider } = await harness();
		const before = session.getEnabledToolNames();
		const entered = await ctx.sessionModes.set({ mode: "plan", action: "enter" });
		success(entered);
		expect(provider.calls).toEqual([]);
		expect(session.messages.filter(message => message.role === "user")).toEqual([]);
		const draft = entered.state.plan.planFilePath!;
		const localDraft = resolveLocalUrlToPath(draft, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(localDraft, "# Mission draft\nKeep this draft.\n");
		const started = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start") started.resolve();
		});
		await runner
			.getCommand("mission")!
			.handler("Inspect the workspace without executing changes", runner.createCommandContext());
		await started.promise;
		unsubscribe();
		await session.waitForIdle();
		expect(provider.calls[0]?.context.messages.some(message => message.role === "user")).toBe(true);
		expect(ctx.sessionModes.getState().plan.status).toBe("active");
		// Dispatch bookkeeping can outlive agent idle by a few ticks (post-turn
		// teardown inside the admission window); exit must wait for it to settle.
		await session.waitForAdmittedSubmissions();
		await runner.getCommand("mission-exit")!.handler("", runner.createCommandContext());
		expect(ctx.sessionModes.getState().plan.status).toBe("inactive");
		expect(await Bun.file(localDraft).text()).toContain("Keep this draft.");
		expect(session.getEnabledToolNames()).toEqual(before);
		expect(provider.calls).toHaveLength(1);
	});

	it("arbitrates competing entries, preserves conflicts and makes repeated operations no-ops", async () => {
		const { ctx } = await harness();
		const [plan, vibe] = await Promise.all([
			ctx.sessionModes.set({ mode: "plan", action: "enter" }),
			ctx.sessionModes.set({ mode: "vibe", action: "enter" }),
		]);
		success(plan);
		expect(failure(vibe)).toBe("busy");
		const again = await ctx.sessionModes.set({ mode: "plan", action: "enter" });
		success(again);
		if (again.ok) expect(again.changed).toBe(false);
		success(await ctx.sessionModes.set({ mode: "plan", action: "pause" }));
		expect(failure(await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: "Build a release" }))).toBe(
			"conflict",
		);
		success(await ctx.sessionModes.set({ mode: "plan", action: "resume" }));
		success(await ctx.sessionModes.set({ mode: "plan", action: "exit" }));
		const exited = await ctx.sessionModes.set({ mode: "plan", action: "exit" });
		success(exited);
		if (exited.ok) expect(exited.changed).toBe(false);
	});

	it("goal replacement, pause/resume, budget and drop preserve tools", async () => {
		const { session, ctx, provider } = await harness();
		const before = session.getEnabledToolNames();
		success(
			await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: "Ship alpha", tokenBudget: 1000 }),
		);
		expect(provider.calls).toEqual([]);
		success(
			await ctx.sessionModes.set({ mode: "goal", action: "replace", objective: "Ship beta", tokenBudget: 2000 }),
		);
		expect(ctx.sessionModes.getState().goal.state?.goal.objective).toBe("Ship beta");
		success(await ctx.sessionModes.set({ mode: "goal", action: "budget", tokenBudget: null }));
		expect(ctx.sessionModes.getState().goal.state?.goal.tokenBudget).toBeUndefined();
		success(await ctx.sessionModes.set({ mode: "goal", action: "pause" }));
		expect(ctx.sessionModes.getState().goal.status).toBe("paused");
		success(await ctx.sessionModes.set({ mode: "goal", action: "resume" }));
		expect(ctx.sessionModes.getState().goal.status).toBe("active");
		success(await ctx.sessionModes.set({ mode: "goal", action: "drop" }));
		expect(ctx.sessionModes.getState().goal.status).toBe("inactive");
		expect(session.getEnabledToolNames()).toEqual(before);
		expect(provider.calls).toEqual([]);
	});

	it("vibe exit unregisters worker tools and restores the original tool presentation", async () => {
		const { session, ctx } = await harness();
		const before = session.getEnabledToolNames();
		success(await ctx.sessionModes.set({ mode: "vibe", action: "enter" }));
		expect(session.getEnabledToolNames()).not.toContain("bash");
		expect(session.getVibeModeState()?.enabled).toBe(true);
		success(await ctx.sessionModes.set({ mode: "vibe", action: "exit" }));
		expect(session.getVibeModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(before);
	});

	it("loop controls bounds independently from plan and pauses without submitting a turn", async () => {
		const { ctx, provider } = await harness();
		success(await ctx.sessionModes.set({ mode: "plan", action: "enter" }));
		success(
			await ctx.sessionModes.set({
				mode: "loop",
				action: "enter",
				limit: { kind: "iterations", iterations: 3 },
				strategy: "prompt",
			}),
		);
		expect(ctx.sessionModes.getState().loop.status).toBe("active");
		const bounded = ctx.sessionModes.getState().loop.limit;
		const strategyOnly = await ctx.sessionModes.set({ mode: "loop", action: "configure", strategy: "compact" });
		success(strategyOnly);
		expect(strategyOnly.state.loop).toMatchObject({ status: "active", strategy: "compact", limit: bounded });
		const repeated = await ctx.sessionModes.set({ mode: "loop", action: "configure", strategy: "compact" });
		success(repeated);
		if (repeated.ok) expect(repeated.changed).toBe(false);
		success(
			await ctx.sessionModes.set({
				mode: "loop",
				action: "configure",
				limit: { kind: "duration", durationMs: 10000 },
			}),
		);
		success(await ctx.sessionModes.set({ mode: "loop", action: "pause" }));
		expect(ctx.sessionModes.getState().loop.status).toBe("paused");
		success(await ctx.sessionModes.set({ mode: "loop", action: "resume" }));
		success(await ctx.sessionModes.set({ mode: "loop", action: "exit" }));
		expect(ctx.sessionModes.getState().loop.status).toBe("inactive");
		expect(ctx.sessionModes.getState().plan.status).toBe("active");
		expect(provider.calls).toEqual([]);
	});

	it("headless new sessions keep the vibe gate and leave plan mode with original tools restored", async () => {
		const { session, runner, ctx } = await harness("print");
		const before = session.getEnabledToolNames();
		success(await ctx.sessionModes.set({ mode: "vibe", action: "enter" }));
		await expect(runner.createCommandContext().newSession()).rejects.toThrow("Exit vibe mode first");
		expect(ctx.sessionModes.getState().vibe.status).toBe("active");
		success(await ctx.sessionModes.set({ mode: "vibe", action: "exit" }));
		success(await ctx.sessionModes.set({ mode: "plan", action: "enter" }));
		expect((await runner.createCommandContext().newSession()).cancelled).toBe(false);
		expect(ctx.sessionModes.getState().plan.status).toBe("inactive");
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(before);
	});

	it("state copies and reconnected contexts discover state after a real session reload", async () => {
		const { session, ctx, runner } = await harness("rpc");
		success(await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: "Preserve state" }));
		const snapshot = ctx.sessionModes.getState();
		snapshot.goal.state!.goal.objective = "corrupted externally";
		expect(runner.createContext().sessionModes.getState().goal.state?.goal.objective).toBe("Preserve state");
		await session.sessionManager.ensureOnDisk();
		await session.reload();
		const reconnected = runner.createContext();
		expect(reconnected.sessionModes.getState().goal.state?.goal.objective).toBe("Preserve state");
		expect(reconnected.sessionModes.getState().goal.status).toBe("active");
	});

	it("committed events agree with queries and handlers can invoke another transition", async () => {
		const seen: string[] = [];
		const completed = Promise.withResolvers<void>();
		const { ctx } = await harness("tui", pi => {
			pi.on("mode_changed", async (event, context) => {
				if (event.state.plan.status !== "active") return;
				seen.push(context.sessionModes.getState().plan.status);
				const result = await context.sessionModes.set({ mode: "plan", action: "exit" });
				if (!result.ok) completed.reject(new Error(result.message));
				else completed.resolve();
			});
		});
		success(await ctx.sessionModes.set({ mode: "plan", action: "enter" }));
		await completed.promise;
		expect(seen).toEqual(["active"]);
		expect(ctx.sessionModes.getState().plan.status).toBe("inactive");
	});

	it("refuses an active-turn transition without aborting or changing tools, then succeeds after yield", async () => {
		const { session, ctx } = await harness();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const provider = createMockModel({
			handler: async () => {
				started.resolve();
				await release.promise;
				return { content: ["Turn released"] };
			},
		});
		session.agent.streamFn = provider.stream;
		const before = session.getEnabledToolNames();
		const turn = session.prompt("Hold this turn until released");
		try {
			await started.promise;
			expect(failure(await ctx.sessionModes.set({ mode: "vibe", action: "enter" }))).toBe("busy");
			expect(session.isStreaming).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(before);
			expect(ctx.sessionModes.getState().vibe.status).toBe("inactive");
		} finally {
			release.resolve();
			await turn;
		}
		success(await ctx.sessionModes.set({ mode: "vibe", action: "enter" }));
		success(await ctx.sessionModes.set({ mode: "vibe", action: "exit" }));
	});

	it("failed tool activation leaves no goal or tool changes behind", async () => {
		const { session, ctx } = await harness();
		const before = session.getEnabledToolNames();
		vi.spyOn(session, "setActiveToolsByName").mockRejectedValueOnce(new Error("Tool activation failed"));
		expect(
			failure(
				await ctx.sessionModes.set({
					mode: "goal",
					action: "enter",
					objective: "Must not survive failed activation",
				}),
			),
		).toBe("failed");
		expect(ctx.sessionModes.getState().goal.status).toBe("inactive");
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(before);
	});

	it("goal mutation handlers receive a busy refusal rather than deadlocking their own accounting lock", async () => {
		const nested: string[] = [];
		const { session, ctx } = await harness("tui", pi => {
			pi.on("goal_updated", async (_event, context) => {
				// The busy refusal must come from the accounting-mutation guard, not
				// a generic busy flag — otherwise a real turn would have masked the
				// deadlock this guards against.
				expect(session.goalRuntime.mutationInFlight).toBe(true);
				nested.push(failure(await context.sessionModes.set({ mode: "goal", action: "drop" })));
			});
		});
		success(await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: "Avoid reentrant deadlock" }));
		expect(nested).toEqual(["busy"]);
		expect(ctx.sessionModes.getState().goal.status).toBe("active");
	});

	it("automatic goal completion restores tools before reporting inactive state to a loaded extension", async () => {
		const completed = Promise.withResolvers<void>();
		const { session, ctx } = await harness("print", pi => {
			pi.on("mode_changed", (event, context) => {
				if (event.previous.goal.status === "active" && event.state.goal.status === "inactive") {
					expect(context.sessionModes.getState().goal.status).toBe("inactive");
					completed.resolve();
				}
			});
		});
		const before = session.getEnabledToolNames();
		success(await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: "Complete this goal" }));
		const tool = session.getToolByName("goal") as AgentTool;
		const result = await tool.execute("goal-completion", { op: "complete" });
		expect(result.content).toContainEqual({ type: "text", text: expect.stringContaining("Status: complete") });
		await completed.promise;
		expect(session.getEnabledToolNames()).toEqual(before);
	});

	it("validates invalid budgets and bounds without changing modes", async () => {
		const { ctx } = await harness();
		const requests: ModeRequest[] = [
			{ mode: "goal", action: "enter", objective: "", tokenBudget: 1 },
			{ mode: "goal", action: "enter", objective: "Build", tokenBudget: -1 },
			{ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 0 } },
			{ mode: "loop", action: "enter", limit: { kind: "duration", durationMs: Number.NaN } },
		];
		for (const request of requests) expect(failure(await ctx.sessionModes.set(request))).toBe("invalid_request");
		expect(ctx.sessionModes.getState().goal.status).toBe("inactive");
		expect(ctx.sessionModes.getState().loop.status).toBe("inactive");
	});

	it("headless hosts expose implemented controls and refuse unsupported continuation explicitly", async () => {
		const { ctx, provider } = await harness("rpc");
		const state = ctx.sessionModes.getState();
		expect(state.capabilities.goal).toContain("enter");
		success(await ctx.sessionModes.set({ mode: "goal", action: "enter", objective: "Headless objective" }));
		success(await ctx.sessionModes.set({ mode: "goal", action: "drop" }));
		expect(provider.calls).toEqual([]);
		expect(state.capabilities.loop).toEqual([]);
		expect(failure(await ctx.sessionModes.set({ mode: "loop", action: "enter" }))).toBe("unsupported");
	});
});
