import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/**
 * Models the loader lifecycle InteractiveMode owns: `agent_start` creates the
 * loader via `ensureLoadingAnimation`; `agent_end` stops and drops it. The
 * streaming getter is backed by mutable flags the tests drive directly.
 */
function createContext() {
	const streamState: { isStreaming: boolean; viewIsStreaming?: boolean; hasPostPromptWork: boolean } = {
		isStreaming: false,
		hasPostPromptWork: false,
	};
	const ctx = createInteractiveModeContext({
		session: {
			get isStreaming() {
				return streamState.isStreaming;
			},
		},
		viewSession: {
			isCompacting: false,
			getLastAssistantMessage: () => undefined,
			get isStreaming() {
				return streamState.viewIsStreaming ?? streamState.isStreaming;
			},
			get hasPostPromptWork() {
				return streamState.hasPostPromptWork;
			},
		},
	});
	const loader = new Loader(
		ctx.ui,
		text => text,
		text => text,
	);
	vi.spyOn(loader, "stop");
	ctx.ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation ??= loader;
	});
	return { ctx, streamState, loader };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;

describe("EventController superseded agent_end", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("keeps the loader alive when a stale agent_end lands after the resumed turn's agent_start", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		// Turn 1 begins and creates the loader.
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// User abort of a queued steer: the resumed turn's agent_start arrives and
		// the agent is streaming again. The interrupted turn's agent_end is still in
		// flight through the async event pipeline.
		streamState.isStreaming = true;
		await controller.handleEvent(AGENT_START);

		// The interrupted turn's agent_end finally propagates. Because the agent is
		// already streaming the resumed turn, it must not tear down the live loader —
		// otherwise "Working…" vanishes while the agent keeps running.
		await controller.handleEvent(AGENT_END);

		expect(loader.stop).not.toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeDefined();
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();
	});

	it("tears the loader down on the live turn's own final agent_end", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// A genuine turn boundary: the agent is no longer streaming, so the guard
		// must not fire and the loader is torn down as before.
		streamState.isStreaming = false;
		await controller.handleEvent(AGENT_END);

		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	it("clears the run flag when a focused worker ends while the main session still streams", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);

		// The viewed worker finishes; the main session's run keeps going underneath.
		streamState.isStreaming = true;
		streamState.viewIsStreaming = false;
		await controller.handleEvent(AGENT_END);

		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	it("keeps a focused worker active through async wait and ends it when its own background work drains", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);
		const settling = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		let pending = true;
		const mainWait = vi.spyOn(ctx.session, "waitForIdle");
		const workerWait = vi.spyOn(ctx.viewSession, "waitForIdle");
		vi.spyOn(ctx.viewSession, "hasPendingAsyncWork").mockImplementation(() => pending);
		vi.spyOn(ctx.viewSession, "settleAsyncWork").mockImplementation(() => {
			settling.resolve();
			return drained.promise;
		});
		vi.spyOn(ctx.composer, "setRunActive").mockImplementation(active => {
			if (!active) finished.resolve();
		});

		streamState.isStreaming = true;
		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		streamState.viewIsStreaming = false;
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
			awaitingAsyncWork: true,
		});

		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		expect(loader.stop).not.toHaveBeenCalled();
		expect(workerWait).toHaveBeenCalled();
		expect(mainWait).not.toHaveBeenCalled();
		await settling.promise;

		pending = false;
		drained.resolve();
		await finished.promise;
		await controller.dispatchSessionEvent({ type: "turn_start" });
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(streamState.isStreaming).toBe(true);
	});

	it("ends a focused worker when its scheduled continuation is cancelled without a terminal event", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);
		const continuation = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		vi.spyOn(ctx.viewSession, "waitForIdle").mockImplementation(() => continuation.promise);
		vi.spyOn(ctx.composer, "setRunActive").mockImplementation(active => {
			if (!active) finished.resolve();
		});
		streamState.isStreaming = true;
		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		streamState.viewIsStreaming = false;
		streamState.hasPostPromptWork = true;
		await controller.handleEvent({ type: "agent_end", messages: [], isTerminal: false });

		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		expect(loader.stop).not.toHaveBeenCalled();
		streamState.hasPostPromptWork = false;
		continuation.resolve();
		await finished.promise;
		await controller.dispatchSessionEvent({ type: "turn_start" });
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
		expect(loader.stop).toHaveBeenCalledTimes(1);
	});

	it("ignores a stale worker end while a newer worker run streams even if the main session is idle", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(AGENT_END);

		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		expect(loader.stop).not.toHaveBeenCalled();
		streamState.viewIsStreaming = false;
		await controller.handleEvent(AGENT_END);
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
		expect(loader.stop).toHaveBeenCalledTimes(1);
	});

	it("does not let a detached worker's settle watch tear down the newly focused view", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);
		const continuation = Promise.withResolvers<void>();
		const waitFinished = Promise.withResolvers<void>();
		vi.spyOn(ctx.viewSession, "waitForIdle").mockImplementation(async () => {
			await continuation.promise;
			waitFinished.resolve();
		});
		streamState.isStreaming = true;
		streamState.viewIsStreaming = false;
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "agent_end", messages: [], isTerminal: false });

		Object.defineProperty(ctx, "viewSession", { get: () => ctx.session });
		// The replacement view can itself pause without emitting agent_start here.
		streamState.isStreaming = false;
		continuation.resolve();
		await waitFinished.promise;
		await Promise.resolve();
		// A serialized event is a barrier after the old watch's queued teardown.
		await controller.dispatchSessionEvent({ type: "turn_start" });
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		expect(loader.stop).not.toHaveBeenCalled();
	});

	it("flushes queued command panels at a non-terminal settle", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		// An async fan-out settles the loop without ending the run. `isStreaming`
		// is already false here, so any command issued now mounts immediately —
		// panels queued during the turn have to mount too, or they render out of
		// order whenever the terminal settle finally lands.
		streamState.isStreaming = false;
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
		} as unknown as AgentSessionEvent);

		expect(ctx.flushPendingModelSwitch).toHaveBeenCalled();
		expect(ctx.flushPendingCommandOutput).toHaveBeenCalled();
	});
});
