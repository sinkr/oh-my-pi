import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

function createComponent(settings?: StatusLineSettings) {
	const session = {
		sessionFile: undefined,
		isStreaming: false,
		state: { model: undefined, messages: [] },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
	const host = {
		getSettings: () => settings ?? {},
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => null,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: () => Promise.resolve(null),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
		lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
		resolveActiveRepo: () => null,
	} as unknown as StatusLineHost<StatusLineSession>;
	const component = new StatusLineComponent(session, host);
	const repaint = vi.fn();
	component.watchBranch(repaint);
	return { component, repaint };
}

/**
 * Contract: while a turn's active-processing window is open, the status line
 * repaints itself on its own timer. The `pi` segment's spinner and turn timer
 * are painted from the wall clock, so without this ticker any path that stops
 * the working-row loader mid-turn (error banner, stale retry/compaction
 * loader reference) froze the animation until the next keystroke.
 */
describe("status line active-window repaint ticker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	beforeAll(async () => {
		await initTheme();
	});

	it("repaints on its own cadence while a turn window is open, with no loader running", () => {
		vi.useFakeTimers();
		const { component, repaint } = createComponent();

		component.markActivityStart();
		vi.advanceTimersByTime(250);
		expect(repaint.mock.calls.length).toBe(1);
		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(5);

		component.markActivityEnd();
		vi.advanceTimersByTime(2000);
		expect(repaint.mock.calls.length).toBe(5);

		component.dispose();
	});

	it("stays silent while idle, re-arms for the next turn, and stops on dispose", () => {
		vi.useFakeTimers();
		const { component, repaint } = createComponent();

		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(0);

		component.markActivityStart();
		vi.advanceTimersByTime(250);
		expect(repaint.mock.calls.length).toBe(1);

		component.markActivityEnd();
		component.markActivityStart();
		vi.advanceTimersByTime(500);
		expect(repaint.mock.calls.length).toBe(3);

		component.dispose();
		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(3);
	});

	it("renders an advancing spinner glyph while a turn window is open and freezes once idle", () => {
		vi.useFakeTimers();
		const { component } = createComponent({ leftSegments: ["pi"], rightSegments: [] });

		component.markActivityStart();
		vi.advanceTimersByTime(250);
		const activeA = Bun.stripANSI(component.renderBottomBar(80, "full"));
		vi.advanceTimersByTime(250);
		const activeB = Bun.stripANSI(component.renderBottomBar(80, "full"));
		// 250 ms spans at least three 80 ms spinner frames, so the rendered
		// bar must differ while the turn window is open.
		expect(activeB).not.toBe(activeA);

		component.markActivityEnd();
		vi.advanceTimersByTime(1000); // settle the brand fade past its 450 ms window
		const idleA = Bun.stripANSI(component.renderBottomBar(80, "full"));
		vi.advanceTimersByTime(250);
		const idleB = Bun.stripANSI(component.renderBottomBar(80, "full"));
		expect(idleB).toBe(idleA);

		component.dispose();
	});
});
