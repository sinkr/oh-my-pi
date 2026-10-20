/**
 * An IRC message that reaches a message-result subagent from anyone but its
 * parent (or as a broadcast) during or right after its final report turn is
 * answered in its own wake turn: the report stays the run's result, and a
 * direct sender still gets the reply.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "Reporter";
const PARENT_ID = "Main";
const PEER_ID = "Peer";
const REPORT = "FULL_REPORT: findings one, two, three.";
const PEER_BODY = "Quick question?";
const PARENT_BODY = "Parent asks: anything else?";
const WAKE_BODY = "Parent wake: recheck one thing.";
const MOCK_API_SOURCE = "test/peer-message-after-report";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-peer-after-report-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Text of the newest non-assistant message the model sees. */
function latestInput(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "assistant") continue;
		const content = message.content as unknown;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
				.join("");
		}
		return "";
	}
	return "";
}

/** Answers whatever the newest input asks: a peer question, a parent request, a parent wake, else the report. */
function answer(context: Context): MockResponse {
	const input = latestInput(context);
	if (input.includes(PEER_BODY)) return { content: ["PEER_REPLY"] };
	if (input.includes(PARENT_BODY)) return { content: ["PARENT_ANSWER"] };
	if (input.includes(WAKE_BODY)) return { content: ["WAKE_ANSWER"] };
	return { content: [REPORT] };
}

/** Starts a plain (message-result) subagent run; `beforeResponse` gates request `n` so a test can deliver mid-turn. */
async function startRun(options: {
	beforeResponse?: (request: number) => Promise<void> | void;
	respond?: (request: number, context: Context) => MockResponse;
}) {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	await Bun.write(path.join(cwd, "notes.txt"), "notes\n");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	let request = 0;
	const mock = createMockModel({
		handler: async context => {
			const n = ++request;
			await options.beforeResponse?.(n);
			return options.respond?.(n, context) ?? answer(context);
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const deliveries: string[] = [];
	const unregisterSink = manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
		deliveries.push(text);
	});
	// The peer has no session: what the subagent sends it lands on this bus waiter.
	AgentRegistry.global().register({ id: PEER_ID, displayName: "peer", kind: "sub", session: null });
	const peerInbox = IrcBus.global().wait(PEER_ID, { from: AGENT_ID }, 10_000);
	const run = runSubprocess({
		cwd,
		artifactsDir,
		agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
		task: "report",
		index: 0,
		id: AGENT_ID,
		parentAgentId: PARENT_ID,
		asyncJobManager: manager,
		structured: false,
		modelOverride: "mock/mock-model",
		authStorage,
		modelRegistry,
		settings: Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: "mock/mock-model" },
		}),
		enableLsp: false,
		enableMCP: false,
		enableIrc: true,
	});
	const close = (): void => {
		unregisterSink();
		authStorage.close();
	};
	return { run, artifact: path.join(artifactsDir, `${AGENT_ID}.md`), deliveries, peerInbox, close, mock };
}

/** Lets the subagent's current turn, its relays and the parent's deliveries settle. */
async function settle(): Promise<void> {
	const session = AgentRegistry.global().get(AGENT_ID)?.session;
	if (session) {
		await session.waitForIdle();
		await session.waitForIrcReplies();
	}
	await manager.waitForOwnerJobs(PARENT_ID);
	await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
}

/** Gate for request `n`: `started` resolves when the request begins, which then waits for `release`. */
function gate(n: number) {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		started: started.promise,
		release: () => release.resolve(),
		beforeResponse: async (request: number) => {
			if (request !== n) return;
			started.resolve();
			await release.promise;
		},
	};
}

it("keeps the report when a peer message arrives during the final report turn, and relays the reply to the peer", async () => {
	const report = gate(1);
	const child = await startRun({ beforeResponse: report.beforeResponse });
	try {
		await report.started;
		const receipt = await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		expect(receipt.outcome).toBe("injected");
		report.release();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe(REPORT);
		expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
	} finally {
		report.release();
		child.close();
	}
}, 20_000);

it("returns the report without waiting for the turn that answers a peer", async () => {
	const report = gate(1);
	const peerTurn = gate(2);
	const child = await startRun({
		beforeResponse: async request => {
			await report.beforeResponse(request);
			await peerTurn.beforeResponse(request);
		},
	});
	try {
		await report.started;
		await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		report.release();
		// The peer's turn stays gated until the run returns: a run that waited on it never would.
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		peerTurn.release();
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
	} finally {
		report.release();
		peerTurn.release();
		child.close();
	}
}, 20_000);

it("keeps the report when answering the peer takes tool calls", async () => {
	const report = gate(1);
	const child = await startRun({
		beforeResponse: report.beforeResponse,
		// Report, then answer the peer after looking something up.
		respond: request => {
			if (request === 1) return { content: [REPORT] };
			if (request === 2) {
				return { content: [{ type: "toolCall", id: "call-peer", name: "read", arguments: { path: "notes.txt" } }] };
			}
			return { content: ["PEER_REPLY"] };
		},
	});
	try {
		await report.started;
		await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		report.release();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe(REPORT);
	} finally {
		report.release();
		child.close();
	}
}, 20_000);

it("keeps the report when a peer message arrives right after the final report turn", async () => {
	let sent: Promise<{ outcome: string }> | undefined;
	const child = await startRun({
		beforeResponse: request => {
			if (request !== 1) return;
			// Deliver once the report's turn has ended but before the run settles.
			const session = AgentRegistry.global().get(AGENT_ID)?.session;
			const unsubscribe = session?.subscribe(event => {
				if (event.type !== "agent_end") return;
				unsubscribe?.();
				sent = IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
			});
		},
	});
	try {
		const result = await child.run;
		expect(sent).toBeDefined();
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe(REPORT);
		expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
	} finally {
		child.close();
	}
}, 20_000);

for (const from of [PEER_ID, PARENT_ID]) {
	it(`keeps the report when a broadcast from ${from === PARENT_ID ? "the parent" : "a peer"} arrives during the final report turn, without replying to it`, async () => {
		const report = gate(1);
		const broadcastTurn = gate(2);
		const child = await startRun({
			beforeResponse: async request => {
				await report.beforeResponse(request);
				await broadcastTurn.beforeResponse(request);
			},
		});
		try {
			await report.started;
			const receipt = await IrcBus.global().send({ from, to: AGENT_ID, body: PEER_BODY, broadcast: true });
			expect(receipt.outcome).toBe("injected");
			report.release();
			const result = await child.run;
			expect(result.output).toBe(REPORT);
			// The broadcast still gets its own turn; nothing is sent back for it.
			broadcastTurn.release();
			await broadcastTurn.started;
			await settle();
			expect(await Bun.file(child.artifact).text()).toBe(REPORT);
			expect(IrcBus.global().sentSince(AGENT_ID, from, 0)).toBe(false);
			expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
		} finally {
			report.release();
			broadcastTurn.release();
			child.close();
		}
	}, 20_000);
}

it("delivers a parent wake turn's answer, not its reply to a peer message that arrived during it", async () => {
	const wake = gate(2);
	const child = await startRun({ beforeResponse: wake.beforeResponse });
	try {
		expect((await child.run).output).toBe(REPORT);
		const woken = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: WAKE_BODY });
		expect(woken.outcome).toBe("woken");
		await wake.started;
		const receipt = await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		expect(receipt.outcome).toBe("injected");
		wake.release();
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(child.deliveries.join("\n")).toContain("WAKE_ANSWER");
		expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
		expect(await Bun.file(child.artifact).text()).toBe("WAKE_ANSWER");
	} finally {
		wake.release();
		child.close();
	}
}, 20_000);

it("still answers the parent's own request that arrives during the final report turn", async () => {
	const report = gate(1);
	const child = await startRun({ beforeResponse: report.beforeResponse });
	try {
		await report.started;
		const receipt = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: PARENT_BODY });
		expect(receipt.outcome).toBe("injected");
		report.release();
		const result = await child.run;
		expect(result.output).toBe("PARENT_ANSWER");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe("PARENT_ANSWER");
	} finally {
		report.release();
		child.close();
	}
}, 20_000);

it("still shows a peer message to the agent within the run when it arrives while the agent works", async () => {
	const work = gate(1);
	const child = await startRun({
		beforeResponse: work.beforeResponse,
		respond: request =>
			request === 1
				? { content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } }] }
				: { content: [REPORT] },
	});
	try {
		await work.started;
		const receipt = await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		expect(receipt.outcome).toBe("injected");
		work.release();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		// The run's second request already carried the peer's message.
		expect(JSON.stringify(child.mock.calls[1]?.context.messages)).toContain(PEER_BODY);
		expect(child.mock.calls).toHaveLength(2);
	} finally {
		work.release();
		child.close();
	}
}, 20_000);
