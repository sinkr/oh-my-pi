import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentLoop, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}
function makeEchoTool(executed: string[], beforeExecute?: (message: string) => void | Promise<void>): AgentTool {
	const schema = type({ msg: "string" });
	const tool: AgentTool<typeof schema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: schema,
		concurrency: "shared",
		async execute(_id, params) {
			await beforeExecute?.(params.msg);
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return tool as AgentTool;
}
const echoCall = (msg: string) => ({ type: "toolCall" as const, name: "echo", arguments: { msg } });
type LoopOptions = Omit<Partial<AgentLoopConfig>, "model" | "convertToLlm">;
function runLoop(mock: MockModel, tools: AgentTool[] = [], options: LoopOptions = {}, signal?: AbortSignal) {
	return agentLoop(
		[createUserMessage("hi")],
		{ systemPrompt: ["Test"], messages: [], tools },
		{ model: mock.model, convertToLlm: identityConverter, ...options },
		signal,
		mock.stream,
	).result();
}
function observeGateWait(): Promise<void> {
	const parked = Promise.withResolvers<void>();
	const wait = agentPauseGate.waitUntilResumed.bind(agentPauseGate);
	vi.spyOn(agentPauseGate, "waitUntilResumed").mockImplementation(signal => {
		parked.resolve();
		return wait(signal);
	});
	return parked.promise;
}

describe("agentPauseGate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		agentPauseGate.resume();
	});
	it("holds the next model call while paused and releases it on resume", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] }),
			parked = observeGateWait();
		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false);
		const result = runLoop(mock);
		await parked;
		expect(mock.calls).toHaveLength(0);
		agentPauseGate.resume();
		expect((await result).at(-1)?.role).toBe("assistant");
		expect(mock.calls).toHaveLength(1);
	});
	it("holds tool execution at the tool boundary when paused mid-turn", async () => {
		const executed: string[] = [],
			boundary = observeGateWait();
		const mock = createMockModel({
			responses: [
				() => {
					agentPauseGate.pause();
					return { content: [echoCall("frozen")] };
				},
				{ content: ["done"] },
			],
		});
		const result = runLoop(mock, [makeEchoTool(executed)]);
		await boundary;
		expect(executed).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		agentPauseGate.resume();
		await result;
		expect(executed).toEqual(["frozen"]);
		expect(mock.calls).toHaveLength(2);
	});
	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] }),
			controller = new AbortController();
		const parked = observeGateWait();
		agentPauseGate.pause();
		const result = runLoop(mock, [], {}, controller.signal);
		await parked;
		controller.abort("user interrupt");
		const last = (await result).at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") expect(last.stopReason).toBe("aborted");
		expect(agentPauseGate.paused).toBe(true);
	});
	it("re-parks a waiter when the gate is re-engaged in the same tick as resume", async () => {
		agentPauseGate.pause();
		let released = false;
		const waiter = agentPauseGate.waitUntilResumed().then(() => {
			released = true;
		});
		agentPauseGate.resume();
		agentPauseGate.pause();
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
	it("acknowledges a provider-boundary pause before executing a returned tool", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			resumed = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					started.resolve();
					await release.promise;
					return { content: [echoCall("once")] };
				},
				{ content: ["done"] },
			],
		});
		const result = runLoop(mock, [makeEchoTool(executed)], {
			onPauseChange: value => {
				transitions.push(value);
				if (value) paused.resolve();
				else if (transitions.includes(true)) resumed.resolve();
			},
		});
		let finished = false;
		void result.then(() => {
			finished = true;
		});
		await started.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(executed).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(finished).toBe(false);
		agentPauseGate.resume();
		await result;
		await resumed.promise;
		expect(executed).toEqual(["once"]);
		expect(transitions).toContain(true);
		expect(transitions.at(-1)).toBe(false);
	});
	it("waits for a running parallel tool before acknowledging and releasing the next", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const secondAtGate = Promise.withResolvers<void>(),
			paused = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [{ content: [echoCall("first"), echoCall("second")] }, { content: ["done"] }],
		});
		const wait = agentPauseGate.waitUntilResumed.bind(agentPauseGate);
		vi.spyOn(agentPauseGate, "waitUntilResumed").mockImplementation(signal => {
			secondAtGate.resolve();
			return wait(signal);
		});
		const result = runLoop(
			mock,
			[
				makeEchoTool(executed, async msg => {
					if (msg === "first") {
						agentPauseGate.pause();
						started.resolve();
						await release.promise;
					}
				}),
			],
			{
				onPauseChange: value => {
					transitions.push(value);
					if (value) paused.resolve();
				},
			},
		);
		await started.promise;
		await secondAtGate.promise;
		expect(transitions).not.toContain(true);
		expect(executed).toEqual([]);
		release.resolve();
		await paused.promise;
		expect(transitions).toContain(true);
		expect(executed).toEqual(["first"]);
		agentPauseGate.resume();
		await result;
		expect(executed).toEqual(["first", "second"]);
		expect(mock.calls).toHaveLength(2);
	});
	it("pauses after asynchronous beforeModelCall preparation and before the provider call", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			mock = createMockModel({ responses: [{ content: ["done"] }] });
		const result = runLoop(mock, [], {
			beforeModelCall: async () => {
				entered.resolve();
				await release.promise;
			},
			onPauseChange: value => {
				if (value) paused.resolve();
			},
		});
		await entered.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(mock.calls).toHaveLength(0);
		agentPauseGate.resume();
		await result;
		expect(mock.calls).toHaveLength(1);
	});
	it("clears Agent pause acknowledgement on re-pause and abort", async () => {
		const parked = Promise.withResolvers<void>(),
			wait = agentPauseGate.waitUntilResumed.bind(agentPauseGate);
		vi.spyOn(agentPauseGate, "waitUntilResumed").mockImplementation(signal => {
			parked.resolve();
			return wait(signal);
		});
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		agentPauseGate.pause();
		const prompt = agent.prompt("hi");
		await parked.promise;
		expect(agent.isPaused).toBe(true);
		expect(agent.state.isStreaming).toBe(true);
		agentPauseGate.resume();
		expect(agent.isPaused).toBe(false);
		agentPauseGate.pause();
		expect(agent.isPaused).toBe(true);
		await Promise.resolve();
		expect(agent.isPaused).toBe(true);
		agent.abort();
		expect(agent.isPaused).toBe(false);
		await prompt;
		expect(agent.state.isStreaming).toBe(false);
	});
});
