/**
 * Contract: computer runs keep the display awake for the whole agent turn (the `power.sleepPrevention` in-flight
 * bracket), however long its non-computer steps take, and the turn's end lets the display sleep at once; the next
 * turn holds it again. A subagent marks no turns, so its runs keep the native grace period.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computerTurnInFlight, registerComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession computer display hold per turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let unregister: (() => void) | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-computer-turn-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		unregister?.();
		unregister = undefined;
		if (session) await session.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Turns whose end released the display on the session's computer controller. */
	const releases: number[] = [];
	/** Per non-computer step: the turn computer runs would hold the display for, and the releases so far. */
	const steps: Array<{ turn: number | undefined; releases: number }> = [];
	let owner = "";
	const stepSchema = type({});
	/** A non-computer step of the turn (a build, a long read): it never touches the computer session. */
	const stepTool: AgentTool<typeof stepSchema, undefined> = {
		name: "step",
		label: "Step",
		description: "Step",
		parameters: stepSchema,
		async execute() {
			steps.push({ turn: computerTurnInFlight(owner), releases: releases.length });
			return { content: [{ type: "text", text: "stepped" }], details: undefined };
		},
	};
	let streaming = Promise.withResolvers<void>();

	function createSession(responses: MockResponse[], agentKind: "main" | "sub" = "main"): AgentSession {
		streaming = Promise.withResolvers<void>();
		releases.length = 0;
		steps.length = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [stepTool as AgentTool], messages: [] },
			convertToLlm,
			streamFn: (model, context, options) => {
				streaming.resolve();
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[stepTool.name, stepTool as AgentTool]]),
			agentKind,
		});
		owner = session.getEvalKernelOwnerId();
		unregister = registerComputerController(owner, {
			async run() {
				throw new Error("not used");
			},
			async capabilities() {
				return undefined;
			},
			releaseDisplay(turn) {
				releases.push(turn);
			},
			async close() {},
		});
		return session;
	}

	const step: MockResponse = { content: [{ type: "toolCall", name: "step", arguments: {} }], stopReason: "toolUse" };

	it("keeps the hold through every step of a turn, releases at its end, and holds again next turn", async () => {
		const target = createSession([step, step, { content: ["done"] }, step, { content: ["done again"] }]);
		expect(computerTurnInFlight(owner)).toBeUndefined();

		await target.prompt("go");
		expect(steps).toEqual([
			{ turn: 1, releases: 0 },
			{ turn: 1, releases: 0 },
		]);
		expect(releases).toEqual([1]);
		expect(computerTurnInFlight(owner)).toBeUndefined();

		await target.prompt("again");
		expect(steps[2]).toEqual({ turn: 2, releases: 1 });
		expect(releases).toEqual([1, 2]);
		expect(computerTurnInFlight(owner)).toBeUndefined();
	});

	it("releases when the user interrupts the turn", async () => {
		const target = createSession([{ content: ["slow"], delayMs: 5_000 }]);
		const running = target.prompt("go").catch(() => undefined);
		await streaming.promise;
		expect(computerTurnInFlight(owner)).toBe(1);
		await target.abort();
		await running;
		expect(releases).toEqual([1]);
		expect(computerTurnInFlight(owner)).toBeUndefined();
	});

	it("releases at an interrupt while the prompt's setup is still unwinding", async () => {
		const entered = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		const getApiKey = spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			entered.resolve();
			await unblock.promise;
			return "test-key";
		});
		try {
			const target = createSession([{ content: ["done"] }]);
			const running = target.prompt("go").catch(() => undefined);
			await entered.promise;
			expect(computerTurnInFlight(owner)).toBe(1);
			await target.abort();
			expect(computerTurnInFlight(owner)).toBeUndefined();
			expect(releases).toEqual([1]);
			unblock.resolve();
			await running;
			expect(releases).toEqual([1]);
		} finally {
			getApiKey.mockRestore();
		}
	});

	it("marks no turn in a subagent, so its runs keep the grace period", async () => {
		const target = createSession([step, { content: ["done"] }], "sub");
		await target.prompt("go");
		expect(steps).toEqual([{ turn: undefined, releases: 0 }]);
		expect(releases).toEqual([]);
	});
});
