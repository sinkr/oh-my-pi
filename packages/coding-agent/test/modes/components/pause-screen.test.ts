import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { Settings } from "../../../src/config/settings";
import {
	PauseScreenComponent,
	type PauseScreenHost,
	type PauseWorkStatus,
	renderPauseScreen,
	runPauseScreen,
} from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

// Strip SGR colors so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

interface FakeHost {
	host: PauseScreenHost;
	shown: Component[];
	statuses: string[];
	requestCount(): number;
	hiddenCount(): number;
}
function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const statuses: string[] = [];
	let hidden = 0;
	let requests = 0;
	const host: PauseScreenHost = {
		ui: {
			showOverlay(component) {
				shown.push(component);
				return {
					hide: () => {
						hidden++;
					},
					setHidden() {},
					isHidden: () => false,
				};
			},
			setFocus() {},
			requestRender() {
				requests++;
			},
			terminal: { rows },
		},
		showStatus(message) {
			statuses.push(message);
		},
	};
	return { host, shown, statuses, requestCount: () => requests, hiddenCount: () => hidden };
}

describe("pause screen", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		agentPauseGate.resume();
		setNativeRendering(false);
		vi.useRealTimers();
	});

	describe("renderPauseScreen", () => {
		it("paints exactly the requested rows with title and clock", () => {
			const lines = renderPauseScreen(80, 24, 65_000);
			expect(lines.length).toBe(24);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("P A U S E D");
			expect(text).toContain("paused for 1:05");
			expect(text).toContain("█".repeat(5));
		});
		it("keeps every work count visible within the compact ANSI layout", () => {
			const lines = renderPauseScreen(48, 12, 3_000, undefined, { unfinishedJobs: 12, backgroundProcesses: 3 }, 4);
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(12);
			expect(text).toContain("Draining — agent turns not parked");
			expect(text).toContain("Unsettled turns: 4");
			expect(text).toContain("Unfinished jobs: 12");
			expect(text).toContain("Background processes: 3");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});

		it("drops to the compact card on small terminals", () => {
			const lines = renderPauseScreen(40, 10, 3_000);
			expect(lines.length).toBe(10);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("▌▌ P A U S E D");
			expect(text).toContain("paused for 0:03");
			expect(text).not.toContain("█".repeat(5)); // no room for the big glyph
		});

		it("rolls the clock into hours past 60 minutes", () => {
			const text = renderPauseScreen(80, 24, 3_725_000).map(stripAnsi).join("\n");
			expect(text).toContain("paused for 1:02:05");
		});

		it("displays the session name when provided in full mode", () => {
			const lines = renderPauseScreen(80, 24, 65_000, "My Awesome Session");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("My Awesome Session");
			expect(text).toContain("P A U S E D");
		});

		it("displays the session name when provided in compact mode", () => {
			const lines = renderPauseScreen(40, 10, 3_000, "Compact Session Title");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("Compact Session Title");
			expect(text).not.toContain("Unsettled turns:");
			expect(text).not.toContain("Unfinished jobs:");
			expect(text).not.toContain("Background processes:");
			expect(text).toContain("to resume");
			expect(text).toContain("▌▌ P A U S E D");
		});
	});

	describe("native sheet", () => {
		// Every described node, depth-first (components inside are not walked).
		const nodes = (root: NativeChild): NativeNode[] => {
			if (!("k" in root)) return [];
			return [root, ...(root.c ?? []).flatMap(nodes)];
		};
		const texts = (root: NativeNode): string =>
			nodes(root)
				.map(n => {
					const p = n.p as { text?: string; spans?: { t: string }[] } | undefined;
					return p?.text ?? p?.spans?.map(s => s.t).join("") ?? "";
				})
				.join("\n");
		const countRoles: Record<string, true> = {
			"omp.pause.unsettled-turn-count": true,
			"omp.pause.unfinished-job-count": true,
			"omp.pause.background-process-count": true,
		};
		const countNodes = (root: NativeChild): NativeNode[] =>
			nodes(root).filter(n => countRoles[(n.p as { role?: string } | undefined)?.role ?? ""] === true);
		const wireNodes = (root: TspNode): TspNode[] => [root, ...(root.c ?? []).flatMap(wireNodes)];
		const wireCountNodes = (root: TspNode): TspNode[] =>
			wireNodes(root).filter(n => countRoles[(n.p as { role?: string } | undefined)?.role ?? ""] === true);

		it("shows the live settlement state and counts in semantic text nodes", () => {
			const { host } = makeHost();
			const sheet = new PauseScreenComponent(
				{ ...host, sessionName: "Credit backpressure" },
				{ getWorkStatus: () => ({ unfinishedJobs: 2, backgroundProcesses: 1 }) },
			);
			const root = sheet.describe();
			const all = nodes(root);
			const clock = all.find(n => n.k === "elapsed");
			expect(clock?.p).toMatchObject({ format: "clock" });
			const shown = texts(root);
			expect(shown).toContain("Credit backpressure");
			expect(shown).toContain("Waiting — tracked work remains");
			expect(shown).toContain("Unsettled turns: 0");
			expect(shown).toContain("Unfinished jobs: 2");
			expect(shown).toContain("Background processes: 1");
			expect(shown).toContain("Counts cover tracked OMP work only.");

			const buttons = all.filter(n => (n.p as { role?: string } | undefined)?.role === "omp.btn");
			expect(buttons.length).toBe(1);
			const resume = buttons[0]!.p as { tone?: string; title?: string; actions?: { click?: string } };
			expect(resume.tone).toBe("accent");
			expect(resume.actions?.click).toBe("resume");
			expect(resume.title).toStartWith("Resume  esc");
			expect(sheet.nativeOverlay).toMatchObject({ role: "omp.overlay.pause", head: "Paused" });
		});

		it("names the whole session when it has no name", () => {
			const { host } = makeHost();
			expect(texts(new PauseScreenComponent(host).describe())).toContain("Every agent in this session");
		});
		it("polls ANSI status while open, including settled and late work transitions in both layouts", async () => {
			vi.useFakeTimers();
			setNativeRendering(false);
			const work: PauseWorkStatus = { unfinishedJobs: 1, backgroundProcesses: 0 };
			const { host, requestCount } = makeHost(24);
			const sheet = new PauseScreenComponent(host, { getWorkStatus: () => work });
			const layouts = () => [80, 48].map(width => sheet.render(width).map(stripAnsi).join("\n"));
			const counters = ["Unsettled turns:", "Unfinished jobs:", "Background processes:"];
			for (const text of layouts()) {
				expect(text).toContain("Waiting — tracked work remains");
				for (const counter of counters) expect(text).toContain(counter);
			}

			const running = sheet.run();
			try {
				work.unfinishedJobs = 0;
				vi.advanceTimersByTime(1_000);
				const settledLayouts = layouts();
				for (const settled of settledLayouts) {
					expect(settled).toContain("Settled — tracked work is paused or finished");
					for (const counter of counters) expect(settled).not.toContain(counter);
					expect(settled).toContain("Counts cover tracked OMP work only.");
					expect(settled).toContain("paused for");
					expect(settled).toContain("resume");
				}
				const rendersAfterSettlement = requestCount();

				work.backgroundProcesses = 2;
				vi.advanceTimersByTime(1_000);
				for (const lateWork of layouts()) {
					expect(lateWork).toContain("Waiting — tracked work remains");
					expect(lateWork).toContain("Unsettled turns: 0");
					expect(lateWork).toContain("Unfinished jobs: 0");
					expect(lateWork).toContain("Background processes: 2");
				}
				expect(requestCount()).toBeGreaterThan(rendersAfterSettlement);
			} finally {
				sheet.handleInput("\r");
				sheet.dispose();
				await running;
			}
		});

		it("invalidates the cached native tree only when the live status changes", async () => {
			vi.useFakeTimers();
			setNativeRendering(true);
			const work: PauseWorkStatus = { unfinishedJobs: 1, backgroundProcesses: 0 };
			const { host, requestCount } = makeHost();
			const sheet = new PauseScreenComponent(host, { getWorkStatus: () => work });
			const context: DescribeContext = {
				cols: 80,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			};
			const reconciler = new Reconciler("pause");
			const document = new TspDocument("pause");
			const regions = { main: [], dock: [], layer: [sheet] };
			let sequence = 0;
			const reconcile = () => {
				const ops = reconciler.reconcile(regions, context);
				expect(document.applyFrame({ sf: document.surface, s: ++sequence, ops })).toEqual([]);
				return ops;
			};
			const initial = sheet.describe();
			expect(sheet.describe()).toBe(initial);
			reconcile();
			const initialCountIds = wireCountNodes(document.snapshot()).map(n => n.id);
			expect(initialCountIds).toHaveLength(3);

			const running = sheet.run();
			try {
				work.unfinishedJobs = 0;
				vi.advanceTimersByTime(1_000);
				const settled = sheet.describe();
				const settledOps = reconcile();
				expect(settled).not.toBe(initial);
				expect(texts(settled)).toContain("Settled — tracked work is paused or finished");
				const settledNodes = nodes(settled);
				expect(settledNodes.some(n => n.k === "elapsed")).toBe(true);
				expect(texts(settled)).toContain("Counts cover tracked OMP work only.");
				const settledButtons = settledNodes.filter(n => (n.p as { role?: string } | undefined)?.role === "omp.btn");
				expect(settledButtons).toHaveLength(1);
				expect(settledButtons[0]!.p).toMatchObject({ tone: "accent", actions: { click: "resume" } });
				expect(countNodes(settled)).toHaveLength(0);
				expect(wireCountNodes(document.snapshot())).toHaveLength(0);
				for (const id of initialCountIds) expect(settledOps).toContainEqual(["del", id]);
				expect(requestCount()).toBe(2);

				vi.advanceTimersByTime(1_000);
				expect(sheet.describe()).toBe(settled);
				expect(requestCount()).toBe(2);

				work.backgroundProcesses = 2;
				vi.advanceTimersByTime(1_000);
				const lateWork = sheet.describe();
				const lateWorkOps = reconcile();
				expect(lateWork).not.toBe(settled);
				expect(texts(lateWork)).toContain("Waiting — tracked work remains");
				expect(countNodes(lateWork)).toHaveLength(3);
				expect(wireCountNodes(document.snapshot())).toHaveLength(3);
				expect(
					lateWorkOps.flatMap(op => (op[0] === "add" ? wireCountNodes(op[4]) : [])).map(n => n.p?.role),
				).toEqual(
					expect.arrayContaining([
						"omp.pause.unsettled-turn-count",
						"omp.pause.unfinished-job-count",
						"omp.pause.background-process-count",
					]),
				);
				expect(texts(lateWork)).toContain("Unsettled turns: 0");
				expect(texts(lateWork)).toContain("Unfinished jobs: 0");
				expect(texts(lateWork)).toContain("Background processes: 2");
				const buttons = wireNodes(document.snapshot()).filter(
					n => (n.p as { role?: string } | undefined)?.role === "omp.btn",
				);
				expect(buttons).toHaveLength(1);
				expect(buttons[0]!.p).toMatchObject({ tone: "accent", actions: { click: "resume" } });
				expect(requestCount()).toBe(3);
			} finally {
				sheet.handleInput("\r");
				sheet.dispose();
				await running;
			}
		});

		it("resumes from the Resume button", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host); // shows the sheet synchronously, before its first await
			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleNativeEvent({ type: "action", key: "actions/resume", act: "resume", mods: [] });
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});
	});

	describe("runPauseScreen", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			const { host, shown, statuses, hiddenCount } = makeHost();
			expect(agentPauseGate.paused).toBe(false);

			const run = runPauseScreen(host);
			await Bun.sleep(1);
			expect(agentPauseGate.paused).toBe(true);
			expect(shown.length).toBe(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x1b"); // escape → resume
			}
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x03"); // ctrl+c
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const { host, shown } = makeHost();
			await runPauseScreen(host); // must resolve immediately, not park
			expect(shown.length).toBe(0);
			expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
		});
	});
});
