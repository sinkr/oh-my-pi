import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as transcription from "@oh-my-pi/pi-ai/transcription";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcDictationBridge, type RpcDictationController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-dictation";
import type { RpcDictationFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as asr from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController, type SttCallbacks, type SttState, type SttTarget } from "@oh-my-pi/pi-coding-agent/stt";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

class FakeController implements RpcDictationController {
	state: SttState = "idle";
	callbacks!: SttCallbacks;
	target!: SttTarget;
	pendingStart = false;
	startGate = Promise.withResolvers<void>();
	flushGate: Promise<void> | undefined;
	stopped = false;
	disposed = false;

	async start(target: SttTarget, callbacks: SttCallbacks): Promise<void> {
		this.target = target;
		this.callbacks = callbacks;
		if (this.pendingStart) await this.startGate.promise;
		if (this.stopped || this.disposed) return;
		this.state = "recording";
		callbacks.onStateChange("recording");
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.startGate.resolve();
		if (this.state !== "recording") return;
		this.state = "transcribing";
		this.callbacks.onStateChange("transcribing");
		await this.flushGate;
		this.state = "idle";
		this.callbacks.onStateChange("idle");
	}

	dispose(): void {
		this.disposed = true;
		this.startGate.resolve();
		this.state = "idle";
	}
}

function harness(controller = new FakeController()) {
	const frames: RpcDictationFrame[] = [];
	const session = {} as AgentSession;
	const bridge = new RpcDictationBridge(
		session,
		frame => frames.push(frame),
		() => controller,
	);
	return { bridge, frames, controller };
}

afterEach(() => vi.restoreAllMocks());

describe("RpcDictationBridge", () => {
	test("publishes replacing previews across committed segments and ends only after the flush", async () => {
		const { bridge, frames, controller } = harness();
		const flush = Promise.withResolvers<void>();
		controller.flushGate = flush.promise;
		await bridge.start("capture-1");
		expect(controller.callbacks.manualSubmit).toBe(true);
		controller.target.setVolatileText("first");
		controller.target.setVolatileText("first");
		controller.target.commitVolatileText("first");
		controller.target.setVolatileText(" sec");
		controller.target.setVolatileText(" second");
		const stopping = bridge.stop();
		const duplicateStop = bridge.stop();
		expect(frames.at(-1)).toEqual({ type: "dictation_state", captureId: "capture-1", state: "transcribing" });
		controller.target.commitVolatileText(" second");
		flush.resolve();
		expect(await stopping).toEqual({ text: "first second" });
		expect(await duplicateStop).toEqual({ text: "first second" });
		expect(frames).toEqual([
			{ type: "dictation_state", captureId: "capture-1", state: "starting" },
			{ type: "dictation_state", captureId: "capture-1", state: "recording" },
			{ type: "dictation_transcript", captureId: "capture-1", text: "first" },
			{ type: "dictation_transcript", captureId: "capture-1", text: "first sec" },
			{ type: "dictation_transcript", captureId: "capture-1", text: "first second" },
			{ type: "dictation_state", captureId: "capture-1", state: "transcribing" },
			{ type: "dictation_end", captureId: "capture-1", text: "first second" },
		]);
		controller.target.commitVolatileText("late");
		controller.callbacks.onStateChange("recording");
		controller.callbacks.onStateChange("idle");
		controller.callbacks.showWarning("late error");
		await Promise.resolve();
		expect(frames.at(-1)).toEqual({ type: "dictation_end", captureId: "capture-1", text: "first second" });
		expect(await bridge.stop()).toEqual({ text: "" });
	});

	test("stop cancels a pending start before recording and releases the microphone slot", async () => {
		const controller = new FakeController();
		controller.pendingStart = true;
		const { bridge, frames } = harness(controller);
		const start = bridge.start("cancelled");
		const rejected = start.catch((error: unknown) => error);
		expect(bridge.active).toBe(true);
		await expect(bridge.start("other")).rejects.toThrow("already active");
		expect(await bridge.stop()).toEqual({ text: "" });
		expect(await rejected).toHaveProperty("message", expect.stringContaining("cancelled"));
		expect(controller.disposed).toBe(true);
		expect(bridge.active).toBe(false);
		expect(frames).toEqual([
			{ type: "dictation_state", captureId: "cancelled", state: "starting" },
			{ type: "dictation_end", captureId: "cancelled", text: "" },
		]);
	});

	test("capture failure reports the warning after idle, preserves committed text, and ignores late callbacks", async () => {
		const { bridge, frames, controller } = harness();
		await bridge.start("failure");
		controller.target.commitVolatileText("kept");
		controller.state = "idle";
		controller.callbacks.onStateChange("idle");
		controller.callbacks.showWarning("microphone disconnected");
		await Promise.resolve();
		expect(frames.at(-1)).toEqual({
			type: "dictation_end",
			captureId: "failure",
			text: "kept",
			error: "microphone disconnected",
		});
		controller.callbacks.onStateChange("idle");
		controller.target.setVolatileText("late");
		await Promise.resolve();
		expect(frames.filter(frame => frame.type === "dictation_end")).toHaveLength(1);
		expect(bridge.active).toBe(false);
	});

	test("rejects malformed or oversized capture IDs without opening a capture", async () => {
		const { bridge, frames } = harness();
		for (const id of ["", "   ", "x".repeat(129), undefined]) {
			await expect(bridge.start(id as string)).rejects.toThrow("captureId");
		}
		expect(frames).toEqual([]);
		expect(bridge.active).toBe(false);
	});

	test("failed start and failed flush surface one terminal error and release the capture", async () => {
		const failingStart = new FakeController();
		vi.spyOn(failingStart, "start").mockRejectedValue(new Error("microphone denied"));
		const first = harness(failingStart);
		await expect(first.bridge.start("start-error")).rejects.toThrow("microphone denied");
		expect(first.frames.at(-1)).toEqual({
			type: "dictation_end",
			captureId: "start-error",
			text: "",
			error: "microphone denied",
		});
		expect(first.bridge.active).toBe(false);

		const second = harness();
		await second.bridge.start("flush-error");
		second.controller.target.commitVolatileText("saved");
		vi.spyOn(second.controller, "stop").mockRejectedValue(new Error("recognizer failed"));
		await expect(second.bridge.stop()).rejects.toThrow("recognizer failed");
		expect(second.frames.at(-1)).toEqual({
			type: "dictation_end",
			captureId: "flush-error",
			text: "saved",
			error: "recognizer failed",
		});
		expect(second.bridge.active).toBe(false);
	});

	test("streaming STT combines committed segments with replacing partials and flushes the last segment", async () => {
		const model = getBundledModel("local", "whisper-base");
		const settings = Settings.isolated();
		settings.setModelRole("dictation", "local/whisper-base");
		const registry = {
			getError: () => undefined,
			getAvailable: () => [model],
			getAll: () => [model],
			resolver: vi.fn(() => vi.fn().mockResolvedValue("unused")),
		};
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue();
		let streamOptions: asr.SttStreamOptions | undefined;
		const micStop = vi.fn();
		vi.spyOn(asr.sttClient, "startStream").mockImplementation((_key, options) => {
			streamOptions = options;
			return {
				pushAudio: () => {},
				cancel: () => {},
				stop: async () => {
					streamOptions?.onSegment?.("world", 1);
					return "hello world";
				},
			};
		});
		const session = { settings, modelRegistry: registry, sessionId: "session-1" } as unknown as AgentSession;
		const frames: RpcDictationFrame[] = [];
		const bridge = new RpcDictationBridge(
			session,
			frame => frames.push(frame),
			() => new STTController(() => ({ stop: micStop }), { settings, registry }),
		);
		await bridge.start("local");
		streamOptions?.onPartial?.("hel");
		streamOptions?.onPartial?.("hello");
		streamOptions?.onSegment?.("hello", 0);
		streamOptions?.onPartial?.("wor");
		expect(await bridge.stop()).toEqual({ text: "hello world" });
		expect(micStop).toHaveBeenCalledTimes(1);
		expect(frames.filter(frame => frame.type === "dictation_transcript")).toEqual([
			{ type: "dictation_transcript", captureId: "local", text: "hel" },
			{ type: "dictation_transcript", captureId: "local", text: "hello" },
			{ type: "dictation_transcript", captureId: "local", text: "hello wor" },
			{ type: "dictation_transcript", captureId: "local", text: "hello world" },
		]);
	});

	test("cancels the real STT preflight before it can open the microphone", async () => {
		const model = getBundledModel("local", "whisper-base");
		const settings = Settings.isolated();
		settings.setModelRole("dictation", "local/whisper-base");
		const registry = {
			getError: () => undefined,
			getAvailable: () => [model],
			getAll: () => [model],
			resolver: vi.fn(() => vi.fn().mockResolvedValue("unused")),
		};
		const preflight = Promise.withResolvers<void>();
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		vi.spyOn(downloader, "downloadSttModel").mockImplementation((_key, _progress, options) => {
			const pending = Promise.withResolvers<void>();
			options?.signal?.addEventListener("abort", () => pending.reject(new Error("cancelled")), { once: true });
			preflight.resolve();
			return pending.promise;
		});
		const openMic = vi.fn(() => ({ stop: vi.fn() }));
		const session = { settings, modelRegistry: registry, sessionId: "session-1" } as unknown as AgentSession;
		const frames: RpcDictationFrame[] = [];
		const bridge = new RpcDictationBridge(
			session,
			frame => frames.push(frame),
			() => new STTController(openMic, { settings, registry }),
		);
		const start = bridge.start("preflight");
		const rejected = start.catch((error: unknown) => error);
		await preflight.promise;
		expect(await bridge.stop()).toEqual({ text: "" });
		expect(await rejected).toHaveProperty("message", expect.stringContaining("cancelled"));
		expect(openMic).not.toHaveBeenCalled();
		expect(frames.at(-1)).toEqual({ type: "dictation_end", captureId: "preflight", text: "" });
	});

	test("uses the configured cloud STT engine and never submits a spoken submit trigger", async () => {
		const model = getBundledModel("openai", "whisper-1");
		const settings = Settings.isolated({ "stt.submitTrigger": "say-submit" });
		settings.setModelRole("dictation", "openai/whisper-1");
		const registry = {
			getError: () => undefined,
			getAvailable: () => [model],
			getAll: () => [model],
			resolver: vi.fn(() => vi.fn().mockResolvedValue("cloud-key")),
		};
		const result = Promise.withResolvers<transcription.TranscriptionResult>();
		const transcribe = vi.spyOn(transcription, "transcribeAudio").mockReturnValue(result.promise);
		const micStop = vi.fn();
		let audio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const session = { settings, modelRegistry: registry, sessionId: "session-1" } as unknown as AgentSession;
		const frames: RpcDictationFrame[] = [];
		const bridge = new RpcDictationBridge(
			session,
			frame => frames.push(frame),
			() =>
				new STTController(
					callback => {
						audio = callback;
						return { stop: micStop };
					},
					{ settings, registry, getSessionId: () => session.sessionId },
				),
		);
		await bridge.start("cloud");
		audio?.(null, new Float32Array([0.1, -0.1]));
		const stopping = bridge.stop();
		expect(micStop).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(registry.resolver).toHaveBeenCalledWith(model, "session-1");
		result.resolve({
			text: "please review this submit.",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(await stopping).toEqual({ text: "please review this submit." });
		expect(frames.at(-1)).toEqual({ type: "dictation_end", captureId: "cloud", text: "please review this submit." });
	});
});

async function rpcHarness(slow = false) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-dictation-"));
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "live-rpc-agent.ts")], {
		cwd: dir,
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_NO_TITLE: "1", RPC_SLOW_DICTATION: slow ? "1" : "" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
	const decoder = new TextDecoder();
	const frames: Record<string, unknown>[] = [];
	const receive = async () => {
		const line = await lines.next();
		if (line.done) throw new Error(await stderr);
		const frame = JSON.parse(decoder.decode(line.value)) as Record<string, unknown>;
		frames.push(frame);
		return frame;
	};
	const send = async (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};
	const command = async (id: string, frame: object) => {
		await send({ ...frame, id });
		for (;;) {
			const reply = await receive();
			if (reply.type === "response" && reply.id === id) return reply;
		}
	};
	while ((await receive()).type !== "ready") {}
	return { child, dir, stderr, frames, receive, send, command };
}

async function cleanup(h: { child: { kill(): void; exited: Promise<number> }; stderr: Promise<string>; dir: string }) {
	h.child.kill();
	await h.child.exited;
	await h.stderr;
	await removeWithRetries(h.dir);
}

describe("dictation over RPC", () => {
	test("wire commands are exclusive with live, previews bypass filters, and EOF closes the microphone", async () => {
		const h = await rpcHarness();
		try {
			expect(await h.command("filter", { type: "set_event_filter", events: [] })).toMatchObject({ success: true });
			expect(await h.command("live", { type: "live_start" })).toMatchObject({ success: true });
			expect(await h.command("blocked", { type: "dictation_start", captureId: "a" })).toMatchObject({
				success: false,
			});
			await h.command("live-stop", { type: "live_stop" });
			expect(await h.command("start", { type: "dictation_start", captureId: "a" })).toMatchObject({ success: true });
			expect(await h.command("live-blocked", { type: "live_start" })).toMatchObject({ success: false });
			expect(await h.command("stop", { type: "dictation_stop" })).toMatchObject({
				success: true,
				data: { text: "hello world" },
			});
			expect(h.frames.filter(frame => frame.type === "dictation_transcript")).toEqual([
				{ type: "dictation_transcript", captureId: "a", text: "hello" },
				{ type: "dictation_transcript", captureId: "a", text: "hello world" },
			]);
			expect(h.frames.filter(frame => frame.type === "dictation_end")).toEqual([
				{ type: "dictation_end", captureId: "a", text: "hello world" },
			]);
			await h.command("session-capture", { type: "dictation_start", captureId: "session-change" });
			expect(await h.command("new-session", { type: "new_session" })).toMatchObject({ success: true });
			expect(h.frames).toContainEqual({ type: "dictation_end", captureId: "session-change", text: "hello world" });
			await h.command("start-again", { type: "dictation_start", captureId: "b" });
			await h.child.stdin.end();
			expect(await h.child.exited).toBe(0);
			expect(await Bun.file(path.join(h.dir, "dictation-stopped.json")).json()).toEqual({ state: "recording" });
		} finally {
			await cleanup(h);
		}
	}, 60_000);

	test("an extension session change flushes and releases dictation before completing", async () => {
		const h = await rpcHarness();
		try {
			const before = await h.command("before", { type: "get_state" });
			await h.command("start", { type: "dictation_start", captureId: "extension" });
			await h.send({ id: "change", type: "prompt", message: "/dictation-new-session" });
			let result: Record<string, unknown>;
			do {
				result = await h.receive();
			} while (result.type !== "prompt_result" || result.id !== "change");
			expect(result).toMatchObject({ status: "completed", agentInvoked: false });
			const endIndex = h.frames.findIndex(
				frame => frame.type === "dictation_end" && frame.captureId === "extension",
			);
			const resultIndex = h.frames.indexOf(result);
			expect(endIndex).toBeGreaterThanOrEqual(0);
			expect(endIndex).toBeLessThan(resultIndex);
			expect(h.frames[endIndex]).toEqual({ type: "dictation_end", captureId: "extension", text: "hello world" });
			expect(await Bun.file(path.join(h.dir, "dictation-stopped.json")).json()).toEqual({ state: "idle" });
			const after = await h.command("after", { type: "get_state" });
			const beforeData = before.data;
			const afterData = after.data;
			if (!beforeData || typeof beforeData !== "object" || !("sessionId" in beforeData)) {
				throw new Error("Missing initial session ID");
			}
			if (!afterData || typeof afterData !== "object" || !("sessionId" in afterData)) {
				throw new Error("Missing changed session ID");
			}
			expect(typeof beforeData.sessionId).toBe("string");
			expect(typeof afterData.sessionId).toBe("string");
			expect(afterData.sessionId).not.toBe(beforeData.sessionId);
		} finally {
			await cleanup(h);
		}
	}, 60_000);

	test("nested extension transitions keep voice starts blocked until the outer change completes", async () => {
		const h = await rpcHarness();
		try {
			await h.send({ id: "change", type: "prompt", message: "/dictation-nested-session" });
			let request: Record<string, unknown>;
			do {
				request = await h.receive();
			} while (request.type !== "extension_ui_request" || request.method !== "confirm");
			expect(await h.command("blocked-dictation", { type: "dictation_start", captureId: "blocked" })).toMatchObject({
				success: false,
				error: "Session is changing or shutting down",
			});
			expect(await h.command("blocked-live", { type: "live_start" })).toMatchObject({
				success: false,
				error: "Session is changing or shutting down",
			});
			await h.send({ type: "extension_ui_response", id: request.id, confirmed: true });
			let result: Record<string, unknown>;
			do {
				result = await h.receive();
			} while (result.type !== "prompt_result" || result.id !== "change");
			expect(result).toMatchObject({ status: "completed", agentInvoked: false });
			expect(await h.command("after", { type: "dictation_start", captureId: "after" })).toMatchObject({
				success: true,
			});
			await h.command("stop", { type: "dictation_stop" });
		} finally {
			await cleanup(h);
		}
	}, 60_000);

	test("typed client sends commands and dispatches subscribed frames", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-dictation-client-"));
		using client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "live-rpc-agent.ts")],
			cwd: dir,
			env: { PI_CODING_AGENT_DIR: dir, PI_NO_TITLE: "1", RPC_SLOW_DICTATION: "" },
		});
		try {
			const frames: RpcDictationFrame[] = [];
			const unsubscribe = client.onDictation(frame => frames.push(frame));
			await client.start();
			await client.dictationStart("client");
			expect(await client.dictationStop()).toEqual({ text: "hello world" });
			expect(frames).toContainEqual({ type: "dictation_transcript", captureId: "client", text: "hello" });
			expect(frames).toContainEqual({ type: "dictation_end", captureId: "client", text: "hello world" });
			unsubscribe();
			const count = frames.length;
			await client.dictationStart("unsubscribed");
			await client.dictationStop();
			expect(frames).toHaveLength(count);
		} finally {
			await client.stop();
			await removeWithRetries(dir);
		}
	}, 60_000);

	test("stop overtakes a pending start and responds only after cancellation", async () => {
		const h = await rpcHarness(true);
		try {
			await h.send({ id: "start", type: "dictation_start", captureId: "slow" });
			while ((await h.receive()).type !== "dictation_state") {}
			await h.send({ id: "stop", type: "dictation_stop" });
			const replies = new Map<string, Record<string, unknown>>();
			while (replies.size < 2) {
				const frame = await h.receive();
				if (frame.type === "response" && typeof frame.id === "string") replies.set(frame.id, frame);
			}
			expect(replies.get("start")).toMatchObject({ success: false, error: expect.stringContaining("cancelled") });
			expect(replies.get("stop")).toMatchObject({ success: true, data: { text: "" } });
			expect(h.frames.filter(frame => frame.type === "dictation_end")).toEqual([
				{ type: "dictation_end", captureId: "slow", text: "" },
			]);
			expect(await Bun.file(path.join(h.dir, "dictation-stopped.json")).json()).toEqual({ state: "idle" });
		} finally {
			await cleanup(h);
		}
	}, 60_000);
});
