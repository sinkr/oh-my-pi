import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Api, clearCustomApis, type Model, type ModelSpec, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { runCli } from "@oh-my-pi/pi-coding-agent/cli";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	applyCostGate,
	CostCapExceededError,
	createCostGateController,
	evaluateCostGate,
	resolveCostGate,
} from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgSessionMaxCost, cfgSessionWarnCost } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("evaluateCostGate", () => {
	it("is ok when no thresholds are set", () => {
		expect(evaluateCostGate(createCostGateController({}), 999)).toBe("ok");
	});

	it("is ok below both thresholds", () => {
		const gate = createCostGateController({ warnCost: 8, maxCost: 10 });
		expect(evaluateCostGate(gate, 5)).toBe("ok");
	});

	it("warns once at warnCost and stays ok afterwards", () => {
		const gate = createCostGateController({ warnCost: 8, maxCost: 10 });
		expect(evaluateCostGate(gate, 8)).toBe("warn");
		expect(evaluateCostGate(gate, 9)).toBe("ok");
	});

	it("caps at maxCost regardless of prior warning", () => {
		const gate = createCostGateController({ warnCost: 8, maxCost: 10 });
		expect(evaluateCostGate(gate, 10)).toBe("cap");
		expect(evaluateCostGate(gate, 10)).toBe("cap");
	});
});

describe("applyCostGate", () => {
	it("dispatches below thresholds", () => {
		const gate = createCostGateController({ maxCost: 10 });
		const dispatch = () => "sent";
		expect(
			applyCostGate(
				gate,
				() => 1,
				() => {},
				dispatch,
			),
		).toBe("sent");
	});

	it("throws CostCapExceededError at maxCost without dispatching", () => {
		const gate = createCostGateController({ maxCost: 10 });
		const dispatched = { called: false };
		expect(() =>
			applyCostGate(
				gate,
				() => 10,
				() => {},
				() => {
					dispatched.called = true;
				},
			),
		).toThrow(CostCapExceededError);
		expect(dispatched.called).toBe(false);
	});

	it("invokes onWarn once at warnCost", () => {
		const gate = createCostGateController({ warnCost: 8 });
		const warned: string[] = [];
		applyCostGate(
			gate,
			() => 8,
			m => warned.push(m),
			() => "sent",
		);
		applyCostGate(
			gate,
			() => 9,
			m => warned.push(m),
			() => "sent",
		);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("$8.00");
	});

	it("binds the cost getter on first use", () => {
		const gate = createCostGateController({ maxCost: 10 });
		applyCostGate(
			gate,
			() => 3,
			() => {},
			() => {},
		);
		expect(gate.getCost?.()).toBe(3);
	});
});

describe("resolveCostGate", () => {
	it("returns undefined when neither flags nor config are set", () => {
		expect(resolveCostGate({}, {})).toBeUndefined();
	});

	it("prefers flags over configured values", () => {
		const gate = resolveCostGate({ warnCost: 8, maxCost: 10 }, { warnCost: 1, maxCost: 2 });
		expect(gate?.warnCost).toBe(8);
		expect(gate?.maxCost).toBe(10);
	});

	it("falls back to configured values", () => {
		const gate = resolveCostGate({}, { warnCost: 8, maxCost: 10 });
		expect(gate?.warnCost).toBe(8);
		expect(gate?.maxCost).toBe(10);
		expect(gate?.warned).toBe(false);
	});

	it("ignores negative or non-finite configured thresholds", () => {
		expect(resolveCostGate({}, { warnCost: -5, maxCost: Number.NaN })).toBeUndefined();
		const gate = resolveCostGate({}, { warnCost: -5, maxCost: 10 });
		expect(gate?.warnCost).toBeUndefined();
		expect(gate?.maxCost).toBe(10);
	});
});

describe("session cost settings (issue #7802)", () => {
	it("defaults warnCost and maxCost to undefined", () => {
		const settings = Settings.isolated();
		expect(cfgSessionWarnCost.get(settings)).toBeUndefined();
		expect(cfgSessionMaxCost.get(settings)).toBeUndefined();
	});

	it("honors explicit overrides", () => {
		const settings = Settings.isolated({ "session.warnCost": 8, "session.maxCost": 10 });
		expect(cfgSessionWarnCost.get(settings)).toBe(8);
		expect(cfgSessionMaxCost.get(settings)).toBe(10);
	});
});

describe("--warn-cost / --max-cost parsing (issue #7802)", () => {
	it("parses valid numbers", () => {
		const parsed = parseArgs(["--warn-cost", "8", "--max-cost", "10", "--print", "hello"]);
		expect(parsed.warnCost).toBe(8);
		expect(parsed.maxCost).toBe(10);
		expect(parsed.print).toBe(true);
	});

	it("throws a visible parse error for invalid values", () => {
		for (const value of ["-1", "Infinity", "NaN", "abc"]) {
			let thrown: unknown;
			try {
				parseArgs(["--max-cost", value]);
			} catch (error) {
				thrown = error;
			}
			if (!(thrown instanceof Error)) {
				throw new Error(`--max-cost ${value} did not throw a visible parse error`);
			}
			expect(thrown.message).toContain("--max-cost");
		}
	});

	it("reports invalid values as CLI usage errors", async () => {
		const previousExitCode = process.exitCode;
		let observedExitCode: string | number | null | undefined;
		const captured: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		try {
			await runCli(["--warn-cost", "abc", "--print", "hello"]);
			observedExitCode = process.exitCode;
		} finally {
			vi.restoreAllMocks();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(observedExitCode).toBe(2);
		expect(stderr).toContain("Invalid --warn-cost value");
		expect(stderr).toContain("Run `omp --help` for available flags.");
	});
});

describe("cost gate wiring in runRootCommand (issue #7802)", () => {
	it("passes flag-derived costGate into createAgentSession options", async () => {
		using tempDir = TempDir.createSync("@omp-cost-gate-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--warn-cost", "8", "--max-cost", "10", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, ["--warn-cost", "8", "--max-cost", "10", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}

		expect(observedOptions?.costGate?.warnCost).toBe(8);
		expect(observedOptions?.costGate?.maxCost).toBe(10);
	});

	it("falls back to session settings when flags are absent", async () => {
		using tempDir = TempDir.createSync("@omp-cost-gate-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"session.warnCost": 8,
			"session.maxCost": 10,
		});
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, ["--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}

		expect(observedOptions?.costGate?.warnCost).toBe(8);
		expect(observedOptions?.costGate?.maxCost).toBe(10);
	});
});

describe("cost gate session-tree aggregation (issue #7978)", () => {
	it("sums live sources across sessions and drops removed ones", () => {
		const gate = createCostGateController({ maxCost: 10 });
		const root = { cost: 1 };
		const child = { cost: 2 };
		const rootSource = () => root.cost;
		const childSource = () => child.cost;
		gate.addCostSource?.(rootSource);
		gate.addCostSource?.(childSource);
		expect(gate.getCost?.()).toBe(3);
		// A child's completed turn counts immediately, not only after the
		// parent rolls it up on task write-back.
		child.cost = 5;
		expect(gate.getCost?.()).toBe(6);
		gate.removeCostSource?.(childSource);
		expect(gate.getCost?.()).toBe(1);
	});

	it("leaves getCost undefined until a source registers, so applyCostGate binds its own getter", () => {
		const gate = createCostGateController({ maxCost: 10 });
		expect(gate.getCost).toBeUndefined();
		gate.addCostSource?.(() => 4);
		expect(gate.getCost?.()).toBe(4);
	});

	it("is idempotent when the same source registers twice", () => {
		const gate = createCostGateController({ maxCost: 10 });
		const source = () => 3;
		gate.addCostSource?.(source);
		gate.addCostSource?.(source);
		expect(gate.getCost?.()).toBe(3);
	});
});

describe("cost gate observable contract (issue #7978)", () => {
	const sessions: { dispose(): Promise<void> }[] = [];
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
	});

	function createCostModel(api: string): Model<Api> {
		// "llama.cpp" is a keyless provider, so dispatch does not need auth.
		return buildModel({
			id: "cost-gate-model",
			name: "Cost Gate Model",
			api,
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
	}

	function createCostStubApi(api: string, costPerTurn = 0): { count(): number } {
		let dispatches = 0;
		registerCustomApi(api, (_model, _context, _options) => {
			dispatches++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				message.usage.cost.total = costPerTurn;
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		return { count: () => dispatches };
	}

	/** Append a completed assistant turn's usage to the session state. */
	function recordSpend(session: { agent: { state: { messages: AgentMessage[] } } }, cost: number): void {
		session.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "expensive turn" }],
			api: "cost-gate-model",
			provider: "llama.cpp",
			model: "cost-gate-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	async function createGatedSession(api: string, costGate: object) {
		const tempDir = TempDir.createSync("@omp-cost-gate-contract-");
		const storage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage = storage;
		const modelRegistry = new ModelRegistry(storage, path.join(tempDir.path(), "models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage: storage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: createCostModel(api),
			costGate: costGate as never,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session;
	}

	it("dispatches below the threshold, warns once, and refuses at the cap without calling the provider", async () => {
		// The stub adds $6 of usage per completed turn, so the gate reads the
		// cumulative cost *before* each dispatch: turn 1 reads $0 (ok), turn 2
		// reads $6 (warn), turn 3 reads $12 (cap).
		const gate = createCostGateController({ warnCost: 5, maxCost: 12 });
		const api = "test-cost-gate-contract";
		const stub = createCostStubApi(api, 6);
		const session = await createGatedSession(api, gate);
		const warnings: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push(event.message);
		});

		// Below threshold: dispatch proceeds.
		await session.sendUserMessage("first");
		expect(stub.count()).toBe(1);
		expect(warnings).toHaveLength(0);

		// At/above the warn threshold: still proceeds, but warns exactly once.
		await session.sendUserMessage("second");
		expect(stub.count()).toBe(2);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("$5.00");

		// At/above the cap: the turn ends without invoking the provider, and
		// the one-time warning is not re-emitted.
		await session.sendUserMessage("third");
		expect(stub.count()).toBe(2);
		expect(session.getSessionStats().cost).toBe(12);
		expect(warnings).toHaveLength(1);
	});

	it("counts a child session's completed turns before the parent rolls them up", async () => {
		const gate = createCostGateController({ maxCost: 10 });
		const api = "test-cost-gate-child";
		const stub = createCostStubApi(api);
		const parent = await createGatedSession(api, gate);
		const child = await createGatedSession(api, gate);

		// The parent is already at the cap; the child's own stats are zero,
		// but the shared controller reads the whole tree, so the child's first
		// dispatch is refused without invoking the provider.
		recordSpend(parent, 10);
		expect(stub.count()).toBe(0);
		await child.sendUserMessage("child turn");
		expect(stub.count()).toBe(0);
		expect(child.getSessionStats().cost).toBe(0);
	});
});
