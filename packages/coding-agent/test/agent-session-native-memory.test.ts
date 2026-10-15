import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sumParameters = type({ a: "number", b: "number" });
const sumTool: AgentTool<typeof sumParameters> = {
	name: "sum",
	label: "Sum",
	description: "Add two numbers",
	parameters: sumParameters,
	execute: async (_id, { a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
};

function toolTurn(): MockResponse[] {
	return [
		{
			content: [
				{ type: "toolCall", name: "sum", arguments: { a: 2, b: 3 } },
				{ type: "toolCall", name: "sum", arguments: { a: 7, b: 4 } },
			],
		},
		{ content: ["The sums are 5 and 11."] },
	];
}

describe("AgentSession native memory maintenance", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-native-memory-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			vi.restoreAllMocks();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	function createSession(responses: MockResponseSource): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [sumTool] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		return session;
	}

	it("trims once after a completed tool turn and consumes that turn's maintenance request", async () => {
		const order: string[] = [];
		const trim = vi.spyOn(natives, "trimNativeMemory").mockImplementation(async () => {
			order.push("trim");
			return true;
		});
		const current = createSession([...toolTurn(), { content: ["No further tools are needed."] }]);
		current.subscribe(event => {
			if (event.type === "tool_execution_end") order.push("tool");
			if (event.type === "agent_end") order.push(event.isTerminal ? "terminal" : "continuing");
		});

		await current.prompt("Compute both sums.");
		await current.waitForIdle();

		expect(order).toEqual(["tool", "tool", "terminal", "trim"]);
		expect(
			current.state.messages.filter(message => message.role === "toolResult").map(message => message.content),
		).toEqual([[{ type: "text", text: "5" }], [{ type: "text", text: "11" }]]);

		await current.prompt("Summarize without tools.");
		await current.waitForIdle();

		expect(trim).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["tool", "tool", "terminal", "trim", "terminal"]);
	});

	it("does not request native maintenance for a text-only session", async () => {
		const trim = vi.spyOn(natives, "trimNativeMemory").mockResolvedValue(true);
		const current = createSession([{ content: ["A text-only answer."] }]);
		const terminal: boolean[] = [];
		current.subscribe(event => {
			if (event.type === "agent_end") terminal.push(event.isTerminal === true);
		});

		await current.prompt("Answer without tools.");
		await current.waitForIdle();

		expect(terminal).toEqual([true]);
		expect(trim).not.toHaveBeenCalled();
	});

	it("retains tool maintenance across a queued continuation until its text-only turn finishes", async () => {
		const trim = vi.spyOn(natives, "trimNativeMemory").mockResolvedValue(true);
		const continuationStarted = Promise.withResolvers<void>();
		const releaseContinuation = Promise.withResolvers<void>();
		const current = createSession([
			...toolTurn(),
			async () => {
				continuationStarted.resolve();
				await releaseContinuation.promise;
				return { content: ["The queued request is complete."] };
			},
		]);
		const terminal: boolean[] = [];
		current.subscribe(event => {
			if (event.type === "agent_end") terminal.push(event.isTerminal === true);
		});
		let queued = false;
		current.agent.subscribe(event => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			current.agent.followUp({ role: "user", content: "Finish the queued request.", timestamp: Date.now() });
		});

		const running = current.prompt("Compute both sums.");
		try {
			await withTimeout(continuationStarted.promise, 2_000, "Queued continuation did not start");
			expect(terminal).toEqual([false]);
			expect(trim).not.toHaveBeenCalled();
		} finally {
			releaseContinuation.resolve();
			await running;
			await current.waitForIdle();
		}

		expect(terminal).toEqual([false, true]);
		expect(trim).toHaveBeenCalledTimes(1);
		expect(current.state.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
	});

	it("cancels queued maintenance when a terminal subscriber begins disposal", async () => {
		const trim = vi.spyOn(natives, "trimNativeMemory").mockResolvedValue(true);
		const current = createSession(toolTurn());
		let terminalReceived = false;
		current.subscribe(event => {
			if (event.type !== "agent_end" || !event.isTerminal) return;
			terminalReceived = true;
			current.beginDispose();
		});

		await current.prompt("Compute both sums.");
		await current.waitForIdle();

		expect(terminalReceived).toBe(true);
		expect(current.state.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
		expect(trim).not.toHaveBeenCalled();
	});

	it("delivers the completed tool turn when native maintenance rejects", async () => {
		const trim = vi.spyOn(natives, "trimNativeMemory").mockRejectedValue(new Error("Native trim failed"));
		const current = createSession(toolTurn());
		const terminal: boolean[] = [];
		current.subscribe(event => {
			if (event.type === "agent_end") terminal.push(event.isTerminal === true);
		});

		await current.prompt("Compute both sums.");
		await current.waitForIdle();

		expect(trim).toHaveBeenCalledTimes(1);
		expect(terminal).toEqual([true]);
		expect(
			current.state.messages.filter(message => message.role === "toolResult").map(message => message.content),
		).toEqual([[{ type: "text", text: "5" }], [{ type: "text", text: "11" }]]);
	});
});
