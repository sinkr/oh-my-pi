import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop, agentLoopContinue, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}
async function waitForUnsettledTurnCount(count: number): Promise<void> {
	// Candidate settlement runs through promise continuations; drain them without a wall-clock wait.
	for (let attempt = 0; agentPauseGate.unsettledTurnCount !== count; attempt++) {
		if (attempt >= 100) {
			throw new Error(
				`Timed out waiting for unsettled turn count ${count}; got ${agentPauseGate.unsettledTurnCount}`,
			);
		}
		await Promise.resolve();
	}
}

function makeEchoTool(executed: string[]): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

describe("agentPauseGate", () => {
	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	it("holds the next model call while paused and releases it on resume", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false); // already engaged

		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await parked.promise;
		expect(mock.calls.length).toBe(0); // parked before the first provider call
		expect(agentPauseGate.unsettledTurnCount).toBe(0);

		try {
			expect(agentPauseGate.resume()).toBeGreaterThanOrEqual(0);
			const messages = await result;
			expect(mock.calls.length).toBe(1);
			expect(messages[messages.length - 1].role).toBe("assistant");
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("holds tool execution at the tool boundary when paused mid-turn", async () => {
		const executed: string[] = [];
		// Signal exactly when the loop parks on the gate. A test-local manual
		// patch (not vi.spyOn) so a sibling file's restoreAllMocks cannot remove
		// it, and a gate regression that never parks hangs this await (test
		// timeout) instead of racing past a vacuous assertion.
		const toolBoundary = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			toolBoundary.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		const mock = createMockModel({
			responses: [
				() => {
					// Engage the gate while the model response is being produced: the
					// turn's tool batch must park before the tool starts.
					agentPauseGate.pause();
					return { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "frozen" } }] };
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [makeEchoTool(executed)] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("run echo")], context, config, undefined, mock.stream).result();
			await toolBoundary.promise;
			expect(executed).toEqual([]); // tool parked, not started
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
			expect(mock.calls.length).toBe(1); // and no follow-up model call either

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["frozen"]);
			expect(mock.calls.length).toBe(2);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});
	it("counts process-wide provider runs until each one ends", async () => {
		const leftStarted = Promise.withResolvers<void>();
		const rightStarted = Promise.withResolvers<void>();
		const releaseLeft = Promise.withResolvers<void>();
		const releaseRight = Promise.withResolvers<void>();
		const left = createMockModel({
			responses: [
				async () => {
					leftStarted.resolve();
					await releaseLeft.promise;
					return { content: ["left done"] };
				},
			],
		});
		const right = createMockModel({
			responses: [
				async () => {
					rightStarted.resolve();
					await releaseRight.promise;
					return { content: ["right done"] };
				},
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: left.model, convertToLlm: identityConverter };
		const leftResult = agentLoop([createUserMessage("left")], context, config, undefined, left.stream).result();
		const rightResult = agentLoop(
			[createUserMessage("right")],
			context,
			{ ...config, model: right.model },
			undefined,
			right.stream,
		).result();

		expect(agentPauseGate.unsettledTurnCount).toBe(2);
		try {
			await Promise.all([leftStarted.promise, rightStarted.promise]);
			agentPauseGate.pause();
			expect(agentPauseGate.unsettledTurnCount).toBe(2);

			releaseLeft.resolve();
			await leftResult;
			expect(agentPauseGate.unsettledTurnCount).toBe(1);

			releaseRight.resolve();
			await rightResult;
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			releaseLeft.resolve();
			releaseRight.resolve();
			agentPauseGate.resume();
		}
	});

	it("reports an in-flight provider as draining, then a parked tool as settled", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const executed: string[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					providerStarted.resolve();
					await releaseProvider.promise;
					return {
						content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "drained" } }],
					};
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [],
			tools: [makeEchoTool(executed)],
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};

		try {
			const result = agentLoop([createUserMessage("drain")], context, config, undefined, mock.stream).result();
			await providerStarted.promise;
			expect(agentPauseGate.unsettledTurnCount).toBe(1);

			agentPauseGate.pause();
			expect(agentPauseGate.unsettledTurnCount).toBe(1);
			releaseProvider.resolve();
			await parked.promise;

			expect(executed).toEqual([]);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["drained"]);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			releaseProvider.resolve();
			agentPauseGate.resume();
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});
	it("keeps speculative physical execution counted while tool dispatch is parked", async () => {
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		const dispatchParked = Promise.withResolvers<void>();
		let ordinaryExecutions = 0;
		const toolSchema = type({ value: "string" });
		const speculativeTool: AgentTool<typeof toolSchema, { source: string }> = {
			name: "speculative-read",
			label: "Speculative read",
			description: "Executes a speculative read",
			parameters: toolSchema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						physicalStarted.resolve();
						agentPauseGate.pause();
						await releasePhysical.promise;
						return {
							kind: "result",
							result: {
								content: [{ type: "text", text: "speculative result" }],
								details: { source: "speculative" },
							},
							isError: false,
						};
					},
				},
			},
			async execute() {
				ordinaryExecutions++;
				return { content: [], details: { source: "ordinary" } };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "speculative-call",
							name: "speculative-read",
							arguments: { value: "file.txt" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [speculativeTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			speculativeToolExecution: { enabled: true },
		};
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			dispatchParked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};

		try {
			const result = agentLoop(
				[createUserMessage("read the file")],
				context,
				config,
				undefined,
				mock.stream,
			).result();
			await Promise.all([physicalStarted.promise, dispatchParked.promise]);
			expect(agentPauseGate.unsettledTurnCount).toBe(1);

			releasePhysical.resolve();
			await waitForUnsettledTurnCount(0);
			expect(agentPauseGate.paused).toBe(true);
			expect(ordinaryExecutions).toBe(0);

			agentPauseGate.resume();
			await result;
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
			expect(ordinaryExecutions).toBe(0);
		} finally {
			releasePhysical.resolve();
			agentPauseGate.resume();
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("retains a speculative participant after its loop aborts until physical work settles", async () => {
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		const dispatchParked = Promise.withResolvers<void>();
		const toolSchema = type({ value: "string" });
		const speculativeTool: AgentTool<typeof toolSchema, { source: string }> = {
			name: "speculative-read",
			label: "Speculative read",
			description: "Executes a speculative read",
			parameters: toolSchema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						physicalStarted.resolve();
						agentPauseGate.pause();
						await releasePhysical.promise;
						return {
							kind: "result",
							result: { content: [], details: { source: "speculative" } },
							isError: false,
						};
					},
				},
			},
			async execute() {
				return { content: [], details: { source: "ordinary" } };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "speculative-call",
							name: "speculative-read",
							arguments: { value: "file.txt" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [speculativeTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			speculativeToolExecution: { enabled: true },
		};
		const abortController = new AbortController();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			dispatchParked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};

		try {
			const result = agentLoop(
				[createUserMessage("read the file")],
				context,
				config,
				abortController.signal,
				mock.stream,
			).result();
			await Promise.all([physicalStarted.promise, dispatchParked.promise]);
			abortController.abort("user interrupt");
			const messages = await result;
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") expect(last.stopReason).toBe("aborted");
			expect(agentPauseGate.paused).toBe(true);
			expect(agentPauseGate.unsettledTurnCount).toBe(1);

			releasePhysical.resolve();
			await waitForUnsettledTurnCount(0);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			releasePhysical.resolve();
			agentPauseGate.resume();
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("counts a parallel batch as draining until every executing tool is parked", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondParked = Promise.withResolvers<void>();
		let secondWaits = 0;
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			secondWaits++;
			if (secondWaits === 1) secondParked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		const executed: string[] = [];
		const emptySchema = type({});
		const tools: AgentTool[] = [
			{
				name: "first",
				label: "First",
				description: "Waits after starting",
				parameters: emptySchema,
				async execute() {
					firstStarted.resolve();
					agentPauseGate.pause();
					await releaseFirst.promise;
					executed.push("first");
					return { content: [], details: {} };
				},
			},
			{
				name: "second",
				label: "Second",
				description: "Starts after resume",
				parameters: emptySchema,
				async execute() {
					executed.push("second");
					return { content: [], details: {} };
				},
			},
		];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "first-call", name: "first", arguments: {} },
						{ type: "toolCall", id: "second-call", name: "second", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("parallel")], context, config, undefined, mock.stream).result();
			await Promise.all([firstStarted.promise, secondParked.promise]);
			expect(agentPauseGate.unsettledTurnCount).toBe(1);

			releaseFirst.resolve();
			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["first", "second"]);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			releaseFirst.resolve();
			agentPauseGate.resume();
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("reports settled when every tool in a parallel batch is parked", async () => {
		const allParked = Promise.withResolvers<void>();
		let parkedCount = 0;
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parkedCount++;
			if (parkedCount === 2) allParked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		const executed: string[] = [];
		const emptySchema = type({});
		const tools: AgentTool[] = ["first", "second"].map(name => ({
			name,
			label: name,
			description: "Runs after resume",
			parameters: emptySchema,
			async execute() {
				executed.push(name);
				return { content: [], details: {} };
			},
		}));
		const mock = createMockModel({
			responses: [
				() => {
					agentPauseGate.pause();
					return {
						content: [
							{ type: "toolCall", id: "first-call", name: "first", arguments: {} },
							{ type: "toolCall", id: "second-call", name: "second", arguments: {} },
						],
					};
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("all parked")], context, config, undefined, mock.stream).result();
			await allParked.promise;
			expect(executed).toEqual([]);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["first", "second"]);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			agentPauseGate.resume();
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("tracks resume-tail replay through the tool gate and cleans up after errors", async () => {
		const executed: string[] = [];
		const echo = makeEchoTool(executed);
		const resumeTail = {
			role: "assistant" as const,
			stopReason: "toolUse" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "replayed-call",
					name: "echo",
					arguments: { msg: "replayed" },
				},
			],
		} as unknown as AgentMessage;
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [createUserMessage("replay"), resumeTail],
			tools: [echo],
		};
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		agentPauseGate.pause();

		try {
			const result = agentLoopContinue(context, config, undefined, mock.stream).result();
			await parked.promise;
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
			expect(executed).toEqual([]);

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["replayed"]);
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			agentPauseGate.resume();
			agentPauseGate.waitUntilResumed = originalWait;
		}

		const failingContext: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const failingConfig: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getSteeringMessages: () => {
				throw new Error("queue read failed");
			},
		};
		await expect(
			agentLoop([createUserMessage("error")], failingContext, failingConfig, undefined, mock.stream).result(),
		).rejects.toThrow("queue read failed");
		expect(agentPauseGate.unsettledTurnCount).toBe(0);
	});

	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await parked.promise;
		abortController.abort("user interrupt");

		// The run must terminate as aborted promptly (not stay parked until
		// resume). The provider request itself carries the aborted signal, so
		// whether the transport is entered at all is an implementation detail.
		try {
			const messages = await result;
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
			}
			expect(agentPauseGate.paused).toBe(true); // aborting one run never resumes the process
			expect(agentPauseGate.unsettledTurnCount).toBe(0);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("re-parks a waiter when the gate is re-engaged in the same tick as resume", async () => {
		agentPauseGate.pause();
		let released = false;
		const waiter = agentPauseGate.waitUntilResumed().then(() => {
			released = true;
		});

		agentPauseGate.resume();
		agentPauseGate.pause(); // re-engage before the waiter's microtask runs
		await Promise.resolve();
		expect(released).toBe(false);

		agentPauseGate.resume();
		await waiter;
		expect(released).toBe(true);
	});

	it("reports pause state transitions to onChange subscribers", () => {
		const transitions: boolean[] = [];
		const unsubscribe = agentPauseGate.onChange(paused => transitions.push(paused));
		agentPauseGate.pause();
		agentPauseGate.resume();
		unsubscribe();
		agentPauseGate.pause();
		agentPauseGate.resume();
		expect(transitions).toEqual([true, false]);
	});
});
