import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { TspText } from "@oh-my-pi/pi-wire";
import {
	getKeybindings,
	KeybindingsManager,
	type KeybindingsConfig,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "../src/keybindings";
import type { NativeNode } from "../src/native/node";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import {
	ContextViewer,
	type ContextThinkingGroup,
	type ContextViewData,
	type ContextViewCategory,
	type ContextViewEntry,
} from "../src/overlays/context-viewer";
import { createTheme, getBuiltinThemes } from "../src/theme/loader";
import { ensureThemeSync, setThemeInstance, theme, type Theme } from "../src/theme/theme";
import { CONTEXT_PRESENTATION } from "../src/chrome/context-presentation";
import { sliceWithWidth, visibleWidth } from "../src/utils";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => false, feature: () => true };
const meterCx = { ...cx, supports: () => true };
const viewers: ContextViewer[] = [];
let previous: Theme;
let previousBindings: KeybindingsManager;
beforeEach(() => {
	ensureThemeSync();
	previous = theme;
	previousBindings = getKeybindings();
});
afterEach(() => {
	for (const viewer of viewers) viewer.dispose();
	viewers.length = 0;
	setThemeInstance(previous);
	setKeybindings(previousBindings);
});

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(child => ("k" in child ? nodes(child) : []))];
}

function textValue(value: TspText | undefined): string | undefined {
	return typeof value === "string" ? value : value?.map(span => span.t).join("");
}

function itemLabel(item: NativeNode | undefined) {
	return item?.k === "item" && Array.isArray(item.p?.label) ? item.p.label : undefined;
}

function usageColumns(item: NativeNode | undefined): string[] | undefined {
	return item?.k === "item" ? textValue(item.p?.value)?.split(" · ") : undefined;
}

function fixture(firstOutput?: ContextViewEntry, secondOutput?: ContextViewEntry): ContextViewData {
	const output: ContextViewCategory = {
		id: "tool-output",
		label: "Tool Output",
		tokens: 30000,
		entries: [
			firstOutput ?? {
				id: "result/0",
				label: "read result",
				tokens: 20000,
				timestamp: 0,
				callId: "call-123",
				text:
					Array.from({ length: 100 }, (_, index) => `line ${index}\t${"long ".repeat(30)}`).join("\n") +
					"\ncontext-output-tail",
			},
			secondOutput ?? {
				id: "result/1",
				label: "bash result",
				tokens: 10000,
				text: "short result",
				timestamp: 60_000,
			},
		],
	};
	output.children = [
		{ ...output, key: "tool-output/read", label: "read", entries: output.entries.slice(0, 1), tokens: 20000 },
		{ ...output, key: "tool-output/bash", label: "bash", entries: output.entries.slice(1), tokens: 10000 },
	];
	return {
		modelLabel: "Fixture",
		window: 200000,
		usage: 85000,
		buffer: 20000,
		free: 95000,
		breakdown: {
			model: undefined,
			contextWindow: 200000,
			categories: [],
			thresholdTokens: 180000,
			snapcompact: {
				visionCapable: true,
				savedTokens: 6000,
				systemPrompt: {
					applied: true,
					textTokens: 10000,
					imageTokens: 4000,
					frames: 2,
					savedTokens: 6000,
					scope: "all",
				},
			},
			usedTokens: 85000,
			freeTokens: 95000,
			autoCompactBufferTokens: 20000,
		},
		categories: [
			{
				id: "system-prompt",
				label: "System Prompt",
				tokens: 20000,
				entries: [{ id: "system/0", label: "system block", tokens: 20000, text: "entire system source" }],
			},
			{
				id: "skills",
				label: "Skills",
				tokens: 10000,
				entries: [{ id: "skill/0", label: "fixture skill", tokens: 10000, text: "skill hint" }],
			},
			{
				id: "built-in-tools",
				label: "Built-in Tools",
				tokens: 10000,
				entries: [{ id: "tool/0", label: "builtin read", tokens: 10000, text: "schema definition" }],
			},
			{ id: "custom-tools", label: "Custom Tools", tokens: 0, entries: [] },
			{
				id: "user-messages",
				label: "User / Developer Messages",
				tokens: 10000,
				entries: [{ id: "user/0", label: "user", tokens: 10000, text: "question" }],
			},
			output,
		],
	};
}

function harness(data = fixture()) {
	let rows = 24;
	let closed = 0;
	const viewer = new ContextViewer(data, { onClose: () => closed++, requestRender: () => {}, getRows: () => rows });
	viewers.push(viewer);
	const render = (width = 100) => viewer.render(width).map(line => Bun.stripANSI(line));
	return { viewer, render, closed: () => closed, resize: (height: number) => (rows = height) };
}

function select(viewer: ContextViewer, key: string, activate = true): void {
	viewer.handleNativeEvent({ type: activate ? "activate" : "select", key: "categories", item: key });
}

function nativeText(root: NativeNode): string {
	return nodes(root)
		.flatMap(node => (node.k === "text" ? [textValue(node.p?.spans) ?? node.p?.text ?? ""] : []))
		.join("\n");
}

function selected(root: NativeNode): string | null | undefined {
	const all = nodes(root);
	const list = all.find(node => node.k === "list" && node.p?.selected !== undefined);
	return list?.k === "list" ? list.p?.selected : all.find(node => node.p?.mark === "pick")?.key;
}

function scrollToText(viewer: ContextViewer, render: () => readonly string[], value: string): void {
	for (let step = 0; step < 5000; step++) {
		if (render().some(line => line.includes(value))) return;
		viewer.handleInput("\x1b[B");
	}
	throw new Error(`Could not reach ${value} with down navigation`);
}

describe("ContextViewer keybindings", () => {
	const navigationBindings: {
		name: string;
		bindings: KeybindingsConfig;
		up?: string;
		down?: string;
	}[] = [
		{ name: "default arrows", bindings: {}, up: "\x1b[A", down: "\x1b[B" },
		{
			name: "remapped control keys",
			bindings: { "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n" },
			up: "\x10",
			down: "\x0e",
		},
		{ name: "unbound navigation", bindings: { "tui.select.up": [], "tui.select.down": [] } },
	];
	for (const { name, bindings, up, down } of navigationBindings) {
		it(`captures and navigates only with configured keys: ${name}`, () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
			const h = harness();
			h.render();
			for (const key of ["\x1b[A", "\x1b[B", "\x10", "\x0e", "k", "j"]) {
				select(h.viewer, "built-in-tools", false);
				expect(h.viewer.capturesInput(key)).toBe(key === up || key === down);
				h.viewer.handleInput(key);
				// Down skips the empty Custom Tools row, which has nothing to open.
				expect(selected(h.viewer.describe(cx))).toBe(
					key === up ? "system-prompt" : key === down ? "user-messages" : "built-in-tools",
				);
			}
		});
	}

	it("remaps opening and returning without retaining Enter or Escape aliases", () => {
		const h = harness();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": "o",
				"tui.select.cancel": "b",
			}),
		);
		h.render();
		for (const key of ["\r", "\x1b"]) {
			expect(h.viewer.capturesInput(key)).toBe(false);
			h.viewer.handleInput(key);
		}
		expect(h.closed()).toBe(0);
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		for (const key of ["o", "b"]) expect(h.viewer.capturesInput(key)).toBe(true);
		select(h.viewer, "tool-output", false);
		h.viewer.handleInput("o");
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("o");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		h.viewer.handleInput("b");
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("b");
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		h.viewer.handleInput("b");
		expect(h.closed()).toBe(1);
	});

	it("keeps Native open, Back and Close usable when their keyboard actions are unbound", () => {
		const h = harness();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": [],
				"tui.select.cancel": [],
			}),
		);
		h.render();
		for (const key of ["\r", "\x1b", "\x03"]) {
			expect(h.viewer.capturesInput(key)).toBe(false);
			h.viewer.handleInput(key);
		}
		expect(h.closed()).toBe(0);
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		select(h.viewer, "tool-output");
		h.viewer.handleNativeEvent({ type: "action", key: "entries/content/list/result/0", act: "open-entry", mods: [] });
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		h.viewer.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
		expect(h.closed()).toBe(1);
	});
});

describe("ContextViewer navigation", () => {
	it("keeps Skills token totals visible while native and keyboard navigation cannot focus or open them", () => {
		const h = harness();
		expect(
			h
				.render()
				.find(line => /\sSkills\s+\d/.test(line))
				?.match(/\d+K|\d+\.\d%/g),
		).toEqual(["11K", "5.3%"]);
		for (const context of [cx, meterCx]) {
			const root = h.viewer.describe(context);
			const skills = nodes(root).find(node => node.key === "skills");
			expect(usageColumns(skills)).toEqual(["11K", "5.3%"]);
			for (const activate of [false, true]) {
				select(h.viewer, "skills", activate);
				const unchanged = h.viewer.describe(context);
				expect(selected(unchanged)).toBe("system-prompt");
				expect(nodes(unchanged).some(node => node.key === "overview")).toBe(true);
				expect(nodes(unchanged).some(node => node.key === "entry-skill/0")).toBe(false);
			}
		}
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe(cx))).toBe("built-in-tools");
		h.viewer.handleInput("\r");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-tool/0")).toBe(true);
		h.viewer.handleInput("\x1b");
		h.viewer.handleInput("\x1b[A");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		h.viewer.handleInput("\r");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-system/0")).toBe(true);
	});

	it("opens a single-entry category directly and returns to its overview selection", () => {
		const h = harness();
		select(h.viewer, "system-prompt");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-system/0")).toBe(true);
		expect(h.render().join("\n")).toContain("entire system source");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "overview")).toBe(true);
	});

	it("keeps an empty category closed and unselectable in both renderers", () => {
		const h = harness();
		select(h.viewer, "custom-tools");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "overview")).toBe(true);
		expect(h.render()[0]).not.toContain("Custom Tools");
	});

	it("skips capacity rows at the navigation boundary before and after resizing", () => {
		const h = harness();
		select(h.viewer, "tool-output/bash", false);
		h.render();
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
		h.resize(12);
		h.render(48);
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("tool-output/bash");
	});

	it("moves the active category into the native sheet title through open and back transitions only", () => {
		const data = fixture();
		const system = data.categories[0]!;
		system.entries.push({ id: "system/1", label: "second system block", tokens: 100, text: "second source" });
		const h = harness(data);
		const overviewHead = textValue(h.viewer.nativeOverlay.head);
		const checkCategory = (category: ContextViewCategory): NativeNode => {
			const root = h.viewer.describe(cx);
			expect(textValue(h.viewer.nativeOverlay.head)).toContain(category.label);
			expect(textValue(h.viewer.nativeOverlay.head)).not.toBe(overviewHead);
			expect(
				root.c?.some(child => "k" in child && child.k === "text" && textValue(child.p?.spans) === category.label),
			).toBe(false);
			expect(h.render()[0]).toContain(category.label);
			expect(h.render()[0]).not.toContain("Context ·");
			return root;
		};
		const back = () => h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		select(h.viewer, system.id);
		let root = checkCategory(system);
		expect(nodes(root).some(node => node.key === "system/0")).toBe(true);
		expect(nodes(root).some(node => node.key === "system/1")).toBe(true);
		h.viewer.handleInput("\r");
		root = checkCategory(system);
		expect(nodes(root).some(node => node.key === "entry-system/0")).toBe(true);
		expect(
			nodes(root).some(node => node.k === "text" && textValue(node.p?.spans)?.includes(system.entries[0]!.label)),
		).toBe(true);
		back();
		checkCategory(system);
		back();
		expect(textValue(h.viewer.nativeOverlay.head)).toBe(overviewHead);
		expect(h.render()[0]).toContain(data.modelLabel);

		const output = data.categories.find(category => category.id === "tool-output")!;
		const read = output.children![0]!;
		select(h.viewer, read.key!);
		root = checkCategory(read);
		expect(nodes(root).some(node => node.key === "entry-result/0")).toBe(true);
		back();
		expect(textValue(h.viewer.nativeOverlay.head)).toBe(overviewHead);
	});

	it("selects and opens native list items through reconciled events without activating the buffer", () => {
		const h = harness();
		const reconciler = new Reconciler("context-swatches");
		const pending = reconciler
			.reconcile({ main: [h.viewer], dock: [], layer: [] }, meterCx)
			.flatMap(op => (op[0] === "add" ? [op[4]] : []));
		let listPath: string | undefined;
		for (let index = 0; index < pending.length; index++) {
			const wire = pending[index]!;
			if (wire.k === "list") listPath = reconciler.target(wire.id)?.keypath;
			pending.push(...(wire.c ?? []));
		}
		if (!listPath) throw new Error("Missing category list path");
		h.viewer.handleNativeEvent({ type: "select", key: listPath, item: "tool-output/read" });
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
		h.viewer.handleNativeEvent({ type: "activate", key: listPath, item: "buffer" });
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
		h.viewer.handleNativeEvent({ type: "activate", key: listPath, item: "tool-output/read" });
		expect(JSON.stringify(h.viewer.describe(meterCx))).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
		h.viewer.handleInput("\x1b[A");
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output");
	});

	it("keeps buffer and free totals at normal contrast without opening them", () => {
		const h = harness();
		const root = h.viewer.describe(meterCx);
		const list = nodes(root).find(node => node.key === "categories");
		if (list?.k !== "list") throw new Error("Missing category list");
		for (const key of ["buffer", "free"]) {
			const summary = nodes(list).find(node => node.key === key);
			if (summary?.k !== "item") throw new Error(`Missing summary item: ${key}`);
			expect(summary.p?.disabled).not.toBe(true);
			expect(usageColumns(summary)).toEqual(key === "buffer" ? ["20K", "10.0%"] : ["95K", "47.5%"]);
			select(h.viewer, key);
			expect(selected(h.viewer.describe(meterCx))).toBe("system-prompt");
		}
	});
});

describe("ContextViewer preview and scrolling", () => {
	it("reaches saved output tail and restores the initial preview and selection through Back", () => {
		const h = harness();
		h.render();
		select(h.viewer, "tool-output");
		const preview = h.render();
		h.viewer.handleInput("\r");
		scrollToText(h.viewer, () => h.render(), "context-output-tail");
		expect(h.render().join("\n")).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		expect(h.render()).toEqual(preview);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		expect(h.closed()).toBe(0);
		h.viewer.handleInput("\x1b");
		expect(h.closed()).toBe(1);
	});

	it("preserves the first ANSI scroll before a full-content frame after a Native-only visit", () => {
		const h = harness(
			fixture({
				id: "result/0",
				label: "scroll probe",
				tokens: 1,
				text: Array.from({ length: 60 }, (_, index) => `row ${String(index).padStart(3, "0")}`).join("\n"),
			}),
		);
		const context = { ...cx, cols: 48 };
		h.viewer.describe(context);
		select(h.viewer, "tool-output/read");
		expect(nativeText(h.viewer.describe(context))).toContain("row 059");
		h.viewer.handleInput("\x1b[B");
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		h.render(48);
		select(h.viewer, "tool-output/read");
		h.viewer.handleInput("\x1b[B");
		expect(h.render(48)[1]).toContain("row 000");
		h.viewer.handleInput("\x1b[A");
		expect(h.render(48)[1]).toContain("[scroll probe]");
	});

	it("opens a short multiline entry through Native activation and Enter, then returns to the same selection", () => {
		const data = fixture({
			id: "result/0",
			label: "short multiline",
			tokens: 1,
			text: "first line\nmiddle line\nshort-multiline-tail",
		});
		const h = harness(data);
		h.viewer.describe(cx);
		select(h.viewer, "tool-output");
		const preview = h.render();
		h.viewer.handleNativeEvent({ type: "action", key: "entries/content/list/result/0", act: "open-entry", mods: [] });
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		expect(h.render().join("\n")).toContain("short-multiline-tail");
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(h.render()).toEqual(preview);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\r");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
	});

	it("changes Native preview selection directly after resize or mouse selection, without local scroll requests", () => {
		const data = fixture(
			{
				id: "result/0",
				label: "long output",
				tokens: 1,
				info: `${"output detail\n".repeat(60)}metadata-tail`,
				text: "native-output-tail",
			},
			{ id: "result/1", label: "next output", tokens: 1, text: "next body" },
		);
		const h = harness(data);
		h.resize(12);
		let nativeCx = { ...cx, cols: 48 };
		const reconciler = new Reconciler("context-test");
		const document = new TspDocument("context-test");
		let frame = 0;
		const reconcile = () => {
			const ops = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, nativeCx);
			expect(document.applyFrame({ sf: document.surface, s: ++frame, ops })).toEqual([]);
			expect(ops.some(op => op[0] === "scroll")).toBe(false);
			return ops;
		};
		reconcile();
		select(h.viewer, "tool-output");
		reconcile();
		for (const [key, id] of [
			["\x1b[B", "result/1"],
			["\x1b[A", "result/0"],
		] as const) {
			h.viewer.handleInput(key);
			expect(reconcile().some(op => op[0] === "reveal" && op[2] === "nearest")).toBe(true);
			expect(selected(h.viewer.describe(nativeCx))).toBe(id);
		}
		h.resize(8);
		nativeCx = { ...nativeCx, cols: 24 };
		reconcile();
		h.viewer.handleInput("\x1b[B");
		reconcile();
		expect(selected(h.viewer.describe(nativeCx))).toBe("result/1");
		h.viewer.handleInput("\x1b[B");
		reconcile();
		expect(selected(h.viewer.describe(nativeCx))).toBe("result/1");
		h.viewer.handleNativeEvent({
			type: "action",
			key: "entries/content/list/result/0",
			act: "select-entry",
			mods: [],
		});
		reconcile();
		h.viewer.handleInput("\x1b[B");
		reconcile();
		expect(selected(h.viewer.describe(nativeCx))).toBe("result/1");
		h.viewer.handleInput("\r");
		reconcile();
		expect(nativeText(h.viewer.describe(nativeCx))).toContain("next body");
		h.viewer.handleInput("\x1b");
		expect(reconcile().filter(op => op[0] === "reveal")).toEqual([
			["reveal", expect.stringMatching(/entries\/content\/list\/result%2F1\/head$/), "start"],
		]);
		expect(selected(h.viewer.describe(nativeCx))).toBe("result/1");
		h.viewer.handleInput("\x1b[A");
		expect(
			reconcile()
				.filter(op => op[0] === "reveal")
				.map(op => op[2]),
		).toEqual(["nearest"]);
		h.viewer.handleInput("\r");
		reconcile();
		const full = nativeText(h.viewer.describe(nativeCx));
		expect(full).toContain("metadata-tail");
		expect(full).toContain("native-output-tail");
		h.viewer.handleInput("\x1b");
		reconcile();
		h.viewer.handleInput("\x1b");
		reconcile();
		select(h.viewer, "tool-output");
		expect(
			reconcile()
				.filter(op => op[0] === "reveal")
				.map(op => op[2]),
		).toEqual(["nearest"]);
	});

	it("bounds ANSI metadata and body together while preserving hidden content through Enter and Back", () => {
		const h = harness(
			fixture({
				id: "result/0",
				label: "metadata-heavy",
				tokens: 1,
				info: `${"output detail\n".repeat(60)}metadata-tail`,
				text: "output-body-tail",
			}),
		);
		h.resize(12);
		h.render(48);
		select(h.viewer, "tool-output");
		const preview = h.render(48);
		expect(preview.join("\n")).toContain("[metadata-heavy]");
		expect(preview.join("\n")).toContain("output detail");
		expect(preview.join("\n")).toContain("… more");
		expect(preview.join("\n")).toContain("View Content");
		expect(preview.join("\n")).not.toContain("metadata-tail");
		expect(preview.join("\n")).not.toContain("output-body-tail");
		h.viewer.handleInput("\x1b[B");
		expect(h.render(48).find(line => line.includes("bash result"))).toContain("┃ ");
		h.viewer.handleInput("\x1b[A");
		expect(h.render(48)).toEqual(preview);
		h.viewer.handleInput("\r");
		scrollToText(h.viewer, () => h.render(48), "output-body-tail");
		expect(h.render(48).join("\n")).toContain("metadata-tail");
		expect(h.render(48).join("\n")).toContain("output-body-tail");
		h.viewer.handleInput("\x1b");
		expect(h.render(48)).toEqual(preview);
	});

	it("does not add an opening hint or a row when selecting a complete Native preview", () => {
		const h = harness(
			fixture(
				{ id: "result/0", label: "multiline", tokens: 1, text: "first line\nsecond line" },
				{ id: "result/1", label: "short", tokens: 1, text: "short body" },
			),
		);
		h.resize(12);
		const context = { ...cx, cols: 48 };
		const reconciler = new Reconciler("complete-preview");
		h.viewer.describe(context);
		select(h.viewer, "tool-output");
		reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, context);
		for (const key of ["\x1b[B", "\x1b[A"]) {
			h.viewer.handleInput(key);
			const ops = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, context);
			expect(ops.filter(op => op[0] === "add" || op[0] === "del")).toEqual([]);
			const preview = nativeText(h.viewer.describe(context));
			expect(preview).not.toContain("View Content");
			expect(preview).not.toContain("… more");
		}
	});

	for (const [name, content] of [
		["multiline body", { text: `${"short row\n".repeat(20)}hidden-tail` }],
		["wide single-line body", { text: `${"中文字 ".repeat(80)}hidden-tail` }],
		["multiline metadata", { info: `${"metadata row\n".repeat(20)}hidden-tail`, text: "body after metadata" }],
	] as const) {
		it(`keeps a persistent Native more row when selecting a truncated ${name}`, () => {
			const h = harness(
				fixture(
					{ id: "result/0", label: "truncated", tokens: 1, ...content },
					{ id: "result/1", label: "complete", tokens: 1, text: "short body" },
				),
			);
			h.resize(12);
			const context = { ...cx, cols: 48 };
			const reconciler = new Reconciler(`truncated-preview-${name}`);
			h.viewer.describe(context);
			select(h.viewer, "tool-output");
			reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, context);
			const selectedPreview = nativeText(h.viewer.describe(context));
			expect(selectedPreview).toContain("… more");
			expect(selectedPreview).toContain("View Content");
			expect(selectedPreview).not.toContain("hidden-tail");
			h.viewer.handleInput("\x1b[B");
			const deselected = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, context);
			expect(deselected.filter(op => op[0] === "add" || op[0] === "del")).toEqual([]);
			const unselectedPreview = nativeText(h.viewer.describe(context));
			expect(unselectedPreview).toContain("… more");
			expect(unselectedPreview).not.toContain("View Content");
			h.viewer.handleInput("\x1b[A");
			const reselected = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, context);
			expect(reselected.filter(op => op[0] === "add" || op[0] === "del")).toEqual([]);
			expect(nativeText(h.viewer.describe(context))).toEqual(selectedPreview);
			h.viewer.handleInput("\r");
			expect(nativeText(h.viewer.describe(context))).toContain("hidden-tail");
		});
	}

	it("emits a new Native scroll request for each repeated down input", () => {
		const h = harness();
		const reconciler = new Reconciler("context-repeated-scroll");
		h.viewer.describe(cx);
		select(h.viewer, "tool-output/read");
		reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, cx);
		for (const n of [1, 2]) {
			h.viewer.handleInput("\x1b[B");
			const scroll = nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll;
			expect(scroll).toMatchObject({ by: "line-down", n });
			const ops = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, cx);
			expect(ops.filter(op => op[0] === "scroll").map(op => op[2])).toEqual(["line-down"]);
		}
	});

	it("pages the full-content view in both renderers and keeps list selection single-step", () => {
		const h = harness();
		const pageDown = "\x1b[6~";
		const pageUp = "\x1b[5~";
		select(h.viewer, "tool-output");
		expect(h.viewer.capturesInput(pageDown)).toBe(false);
		h.viewer.handleInput(pageDown);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.render();
		h.viewer.handleInput("\r");
		expect(h.viewer.capturesInput(pageDown)).toBe(true);
		const top = h.render().join("\n");
		expect(top).toContain("line 1 ");
		h.viewer.handleInput(pageDown);
		const paged = h.render().join("\n");
		expect(paged).not.toContain("line 1 ");
		expect(paged).toMatch(/line [1-9]\d /);
		h.viewer.handleInput(pageUp);
		expect(h.render().join("\n")).toEqual(top);
		// Native owns its scroll position; the viewer only emits page requests.
		h.viewer.describe(cx);
		h.viewer.handleInput(pageDown);
		expect(nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll).toMatchObject({
			by: "page-down",
		});
	});

	it("renders no empty rows for an entry's trailing newlines in either renderer", () => {
		const h = harness(fixture({ id: "result/0", label: "read result", tokens: 1, text: "trailing body\n\n\n" }));
		select(h.viewer, "tool-output");
		const preview = h.render();
		const body = preview.findIndex(line => line.includes("trailing body"));
		// One separator row, then the next entry's header.
		expect(preview[body + 2]).toContain("[bash result]");
		expect(nativeText(h.viewer.describe(cx))).not.toContain("trailing body\n\n");
		h.viewer.handleInput("\r");
		// The body text node ends at the source text; the action bar follows directly.
		expect(nativeText(h.viewer.describe(cx))).toContain("trailing body\nBack");
	});

	it("opens the tail of a single source line even when only part of that line fits the preview", () => {
		const data = fixture({
			id: "result/0",
			label: "single line",
			tokens: 100,
			text: `${"寬字 ".repeat(10000)}single-line-tail`,
		});
		const h = harness(data);
		h.resize(12);
		h.render(48);
		select(h.viewer, "tool-output");
		expect(h.render(48).join("\n")).toContain("… more");
		h.viewer.handleInput("\r");
		h.render(48);
		scrollToText(h.viewer, () => h.render(48), "single-line-tail");
		expect(h.render(48).join("\n")).toContain("single-line-tail");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("result/0");
	});

	it("reserves gutter and scrollbar columns before wrapping a wide-character preview", () => {
		const body = `${"寬".repeat(18)}END`;
		const data = fixture(
			{ id: "result/0", label: "wide", tokens: 1, text: body },
			{ id: "result/1", label: "overflow", tokens: 1, text: "overflow\n".repeat(100) },
		);
		const h = harness(data);
		h.resize(18);
		h.render(48);
		select(h.viewer, "tool-output");
		const lines = h.render(48);
		const content = lines.find(line => line.includes("END"));
		expect(content).toContain(`┃   ${body}`);
		expect(content).toMatch(/[│█] │$/);
		expect(lines.every(line => visibleWidth(line) <= 48)).toBe(true);
	});

	it("moves the selected gutter with the entry without marking separators or the previous entry", () => {
		const h = harness(
			fixture({
				id: "result/0",
				label: "first title",
				info: "metadata",
				tokens: 1,
				text: "first body\n\n寬字 body\nlast body",
			}),
		);
		h.render(48);
		select(h.viewer, "tool-output");
		const before = h.render(48);
		for (const value of ["first title", "metadata", "first body", "寬字 body", "last body"]) {
			expect(before.find(line => line.includes(value))).toContain("┃ ");
		}
		const lastBody = before.findIndex(line => line.includes("last body"));
		expect(before[lastBody + 1]).not.toContain("┃ ");
		h.viewer.handleInput("\x1b[B");
		const next = h.render(48);
		expect(next.find(line => line.includes("bash result"))).toContain("┃ ");
		expect(next.find(line => line.includes("short result"))).toContain("┃ ");
		for (const value of ["first title", "metadata", "first body", "寬字 body", "last body"]) {
			expect(next.find(line => line.includes(value))).not.toContain("┃ ");
		}
		expect(next.every(line => visibleWidth(line) <= 48)).toBe(true);
	});
});

describe("ContextViewer usage and allocation", () => {
	it.each([
		{ name: "zero", tokens: 0, share: "0.0%" },
		{ name: "below the rounding boundary", tokens: 99, share: "<0.1%" },
		{ name: "at the rounding boundary", tokens: 100, share: "0.1%" },
	])("formats usage $name consistently in ANSI and Native output", ({ tokens, share }) => {
		const data = fixture();
		const h = harness({
			...data,
			usage: tokens,
			categories: [{ ...data.categories[0]!, tokens: 1 }],
		});
		for (const width of [48, 100]) {
			const line = h.render(width).find(line => line.includes("System Prompt"))!;
			expect(line.match(/<?\d+\.\d%/)?.[0]).toBe(share);
		}
		for (const context of [cx, meterCx]) {
			const item = nodes(h.viewer.describe(context)).find(item => item.key === "system-prompt");
			expect(usageColumns(item)?.[1]).toBe(share);
		}
	});

	it("conserves Used across top-level allocations and splits only the parent's budget among children", () => {
		const data = fixture();
		const categories = data.categories.filter(category => category.tokens > 0);
		for (const category of categories) category.tokens = 1;
		const output = categories.at(-1)!;
		for (const child of output.children!) child.tokens = 1;
		const h = harness({ ...data, usage: 7, window: 100, buffer: 10, free: 83, categories });
		const value = (key: string) => {
			const item = nodes(h.viewer.describe(cx)).find(node => node.key === key);
			return usageColumns(item);
		};
		expect(categories.map(category => value(category.id))).toEqual([
			["2", "2.0%"],
			["2", "2.0%"],
			["1", "1.0%"],
			["1", "1.0%"],
			["1", "1.0%"],
		]);
		expect(value("tool-output/read")).toEqual(["1", "1.0%"]);
		expect(value("tool-output/bash")).toEqual(["0", "0.0%"]);
		expect(value("buffer")).toEqual(["10", "10.0%"]);
		expect(value("free")).toEqual(["83", "83.0%"]);
		expect(categories.map(category => category.tokens)).toEqual([1, 1, 1, 1, 1]);
	});

	it("assigns leftover tokens by descending remainder before category order", () => {
		const data = fixture();
		const categories = data.categories.slice(0, 3);
		for (const [index, category] of categories.entries()) category.tokens = [1, 2, 4][index]!;
		const h = harness({ ...data, categories, usage: 5, window: 100 });
		const values = nodes(h.viewer.describe(cx)).filter(
			node => node.k === "item" && categories.some(category => category.id === node.key),
		);
		expect(values.map(node => usageColumns(node))).toEqual([
			["1", "1.0%"],
			["1", "1.0%"],
			["3", "3.0%"],
		]);
	});

	it("keeps original usage without inventing category shares when estimates are unavailable", () => {
		const data = fixture();
		for (const category of data.categories) category.tokens = 0;
		const h = harness(data);
		expect(h.render(160).join("\n")).toContain("85K");
		const items = nodes(h.viewer.describe(cx)).filter(node => node.k === "item");
		expect(usageColumns(items.find(node => node.key === "system-prompt"))).toEqual(["—"]);
	});

	it("omits percentages and the meter when capacity is zero", () => {
		const h = harness({ ...fixture(), window: 0, usage: 0, buffer: 0, free: 0 });
		expect(h.render(160).join("\n")).not.toMatch(/NaN|Infinity/);
		const root = h.viewer.describe(meterCx);
		expect(nodes(root).some(node => node.k === "meter")).toBe(false);
		const top = nodes(root).find(node => node.key === "system-prompt");
		expect(usageColumns(top)).toEqual(["0", "—"]);
	});

	it("shows over-capacity usage without clamping its percentage or category allocation", () => {
		const h = harness({ ...fixture(), window: 10, usage: 15, buffer: 0, free: 0 });
		expect(h.render(160)[1]).toMatch(/15.*10.*150%/);
		const top = nodes(h.viewer.describe(cx)).find(node => node.key === "system-prompt");
		expect(usageColumns(top)).toEqual(["4", "40.0%"]);
	});

	it("keeps a zero-usage allocation at zero without hiding free capacity", () => {
		const data = fixture();
		const zero = harness({ ...data, usage: 0, buffer: 20000, free: 180000 });
		const values = nodes(zero.viewer.describe(cx)).filter(node => node.k === "item");
		expect(usageColumns(values.find(node => node.key === "tool-output"))).toEqual(["0", "0.0%"]);
		expect(usageColumns(values.find(node => node.key === "free"))).toEqual(["180K", "90.0%"]);
	});
});

describe("ContextViewer overview and meter", () => {
	it("keeps usage in two overview rows and gives preview and full content the reclaimed rows", () => {
		const data = fixture();
		const usage = { contextWindow: 272000, usedTokens: 71000, freeTokens: 160200, thresholdTokens: 231200 };
		const h = harness({
			...data,
			modelLabel: "GPT-6 Luna",
			window: usage.contextWindow,
			usage: usage.usedTokens,
			free: usage.freeTokens,
			buffer: 40800,
			breakdown: { ...data.breakdown, ...usage },
		});
		data.categories[0]!.entries = [
			{ id: "first", label: "first source", tokens: 1, text: "one\ntwo\nthree\nfour\nfive\nsource-tail" },
			{ id: "second", label: "second source", tokens: 1, text: "other source" },
		];
		const overview = h.render();
		expect(overview[0]).toContain("Context · GPT-6 Luna");
		expect(overview[1]).toMatch(/71K.*272K.*26%/);
		expect(overview[2]).toMatch(/160K.*85%/);
		expect(overview[3]).toContain("System Prompt");
		h.resize(12);
		h.viewer.handleInput("\r");
		const preview = h.render();
		expect(preview[1]).toContain("[first source]");
		expect(preview.join("\n")).toContain("source-tail");
		h.viewer.handleInput("\r");
		const full = h.render();
		expect(full[1]).toContain("[first source]");
		expect(full.join("\n")).toContain("source-tail");
		h.viewer.handleInput("\x1b");
		h.render();
		h.viewer.handleInput("\x1b");
		expect(h.render()[1]).toMatch(/71K.*272K.*26%/);
	});

	it.each([
		{ name: "without meter support", supportsMeter: false, emptyWeights: false },
		{ name: "without category weights", supportsMeter: true, emptyWeights: true },
	])("shows usage and compaction totals $name", ({ supportsMeter, emptyWeights }) => {
		const data = fixture();
		data.breakdown.thresholdTokens = 160000;
		if (emptyWeights) for (const category of data.categories) category.tokens = 0;
		const h = harness(data);
		const root = h.viewer.describe({ ...cx, supports: () => supportsMeter });
		const lines = nodes(root).flatMap(node => (node.k === "text" ? [textValue(node.p?.spans)] : []));
		expect(lines.some(line => /85K.*200K/.test(line ?? ""))).toBe(true);
		expect(lines.some(line => /75K.*80%/.test(line ?? ""))).toBe(true);
	});

	it("keeps category swatches matched to the usage bar", () => {
		const h = harness();
		const root = h.viewer.describe(meterCx);
		const all = nodes(root);
		const meter = all.find(node => node.k === "meter");
		if (meter?.k !== "meter") throw new Error("Missing context meter");
		const list = all.find(node => node.key === "categories");
		if (!list) throw new Error("Missing categories");
		const item = (key: string) => {
			const row = nodes(list).find(node => node.key === key);
			if (!row) throw new Error(`Missing category: ${key}`);
			return row;
		};
		const expected = [
			{
				row: item("system-prompt"),
				glyph: "■",
				color: CONTEXT_PRESENTATION["system-prompt"].color,
				bar: item("system-prompt"),
			},
			{ row: item("skills"), glyph: "■", color: CONTEXT_PRESENTATION.skills.color },
			{
				row: item("tool-output/read"),
				glyph: "■",
				color: CONTEXT_PRESENTATION["tool-output"].color,
				bar: item("tool-output"),
			},
		];
		for (const item of expected) {
			const swatch = itemLabel(item.row)?.[0];
			expect(swatch?.t.trim()).toBe(item.glyph);
			expect(swatch?.s).toBe(item.color);
			if (item.bar) {
				const label = itemLabel(item.bar)?.[1]?.t;
				expect(meter.p?.parts?.find(part => part.label?.startsWith(`${label} ·`))?.token).toBe(item.color);
			}
		}
		expect(selected(root)).toBe("system-prompt");
		const fallback = nodes(h.viewer.describe(cx)).find(node => node.key === "system-prompt");
		expect(itemLabel(fallback)?.[0]?.t.trim()).toBe(theme.symbol("context.content"));
	});

	it("places a stacked meter above selectable categories on meter-capable terminals", () => {
		const data = fixture();
		const h = harness(data);
		for (const cols of [48, 100]) {
			const root = h.viewer.describe({ ...meterCx, cols });
			const all = nodes(root);
			const meter = all.find(node => node.k === "meter");
			if (meter?.k !== "meter") throw new Error("Missing context meter");
			expect(meter.p?.value).toBe(data.usage / data.window);
			expect(meter.p?.parts?.map(part => part.value)).toEqual([
				21250 / 200000,
				10625 / 200000,
				10625 / 200000,
				10625 / 200000,
				31875 / 200000,
				95000 / 200000,
				20000 / 200000,
			]);
			expect(meter.p?.parts?.at(-1)).toMatchObject({ token: "warning", hatch: true });
			expect(meter.p?.marks?.[0]?.at).toBe(data.breakdown.thresholdTokens! / data.window);
			const body = root.c?.findIndex(child => "k" in child && child.key === "overview");
			const bar = root.c?.findIndex(child => "k" in child && child.k === "meter");
			expect(bar).toBeLessThan(body!);
		}
		expect(nodes(h.viewer.describe(cx)).some(node => node.k === "meter")).toBe(false);
	});
});

describe("ContextViewer entry content", () => {
	it("shows a shared replay total once before unknown children and preserves it when opening either child", () => {
		const data = fixture();
		const group: ContextThinkingGroup = {
			id: "thinking-group",
			label: "Assistant thinking · turn 1",
			tokens: 1250,
		};
		const categories: ContextViewCategory[] = [
			{
				id: "assistant-thinking",
				label: "Assistant Thinking",
				tokens: 1275,
				entries: [
					...["first", "second"].map(id => ({
						id,
						label: `${id} block`,
						tokens: 0,
						thinkingGroup: group,
						text: `${id} thinking body`,
					})),
					{ id: "ordinary", label: "ordinary block", tokens: 25, text: "ordinary body" },
				],
			},
		];
		const h = harness({ ...data, categories });
		h.resize(32);
		h.render(160);
		select(h.viewer, "assistant-thinking");
		for (const preview of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
			expect(preview.match(/1,250 tokens/g)).toHaveLength(1);
			expect(preview.indexOf(group.label)).toBeLessThan(preview.indexOf("[first block]"));
			expect(preview).toContain("  [first block] —");
			expect(preview).toContain("  [second block] —");
			expect(preview).toContain("[ordinary block] 25 tokens");
			expect(preview).not.toContain("] 0 tokens");
			expect(preview).not.toContain("unavailable");
		}
		for (const id of ["first", "second"]) {
			h.viewer.handleNativeEvent({ type: "action", key: `entries/content/list/${id}`, act: "open-entry", mods: [] });
			for (const detail of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
				expect(detail).toContain(`[${id} block] —`);
				expect(detail).toContain(`${group.label} · 1,250 tokens`);
				expect(detail).toContain(`${id} thinking body`);
			}
			h.viewer.handleInput("\x1b");
		}
	});

	it("renders interrupted single and grouped estimates as unavailable rather than zero tokens", () => {
		const data = fixture();
		const group: ContextThinkingGroup = {
			id: "interrupted-group",
			label: "Interrupted thinking turn",
			tokens: 0,
			interrupted: true,
		};
		data.categories[0]!.entries = [
			{
				id: "interrupted-single",
				label: "interrupted single",
				tokens: 0,
				interrupted: true,
				text: "[interrupted]",
			},
			...["first", "second"].map(id => ({
				id,
				label: `${id} interrupted block`,
				tokens: 0,
				thinkingGroup: group,
				text: "[interrupted]",
			})),
		];
		const h = harness(data);
		h.resize(32);
		h.render(160);
		select(h.viewer, "system-prompt");
		for (const preview of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
			expect(preview).toContain("[interrupted single] N/A · Interrupted");
			expect(preview).toContain(`${group.label} · N/A · Interrupted`);
			expect(preview).not.toContain("0 tokens");
		}
		for (const id of ["interrupted-single", "second"]) {
			h.viewer.handleNativeEvent({ type: "action", key: `entries/content/list/${id}`, act: "open-entry", mods: [] });
			for (const detail of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
				expect(detail).toContain("N/A · Interrupted");
				expect(detail).not.toContain("0 tokens");
			}
			h.viewer.handleInput("\x1b");
		}
	});

	it("preserves body paths while sanitizing terminal controls in ANSI and native content", () => {
		const data = fixture();
		const path = `${os.homedir()}/context-viewer/source.txt`;
		data.categories[0]!.entries[0] = {
			id: "source",
			label: "source",
			tokens: 1,
			path,
			text: `Source: ${path}\n\tbody\x1b[31m visible\x1b[0m`,
		};
		const h = harness(data);
		h.render();
		select(h.viewer, "system-prompt");
		const ansi = h.render(160).join("\n");
		expect(ansi).toContain(`Source: ${path}`);
		expect(ansi).not.toContain("\t");
		const body = nodes(h.viewer.describe({ ...cx, cols: 160 }))
			.filter(node => node.k === "text")
			.flatMap(node =>
				node.k === "text" ? [node.p?.text ?? "", ...(node.p?.spans?.map(span => span.t) ?? [])] : [],
			)
			.join("\n");
		expect(body).toContain(`Source: ${path}`);
		expect(body).not.toContain("\x1b");
	});

	it.each([
		{ name: "12-hour", hour12: true },
		{ name: "24-hour", hour12: false },
	])("shows $name message times and call IDs in ANSI and Native content", ({ hour12 }) => {
		const h = harness();
		const context = { ...cx, hour12 };
		const expectedTime = new Date(0).toLocaleString([], {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12,
		});
		h.viewer.describe(context);
		select(h.viewer, "tool-output");
		const preview = h.render().join("\n");
		expect(preview).toContain("call-123");
		expect(preview).toContain(expectedTime);
		expect(preview).toContain("[read result]");
		const narrowPreview = h.render(48).join("\n");
		expect(narrowPreview).toContain("call-123");
		expect(narrowPreview).toContain(
			new Date(0).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" }),
		);
		const nativePreview = nodes(h.viewer.describe(context)).find(node => node.key === "result/0")!;
		expect(nativeText(nativePreview)).toContain(expectedTime);
		h.viewer.handleInput("\r");
		const full = h.render().join("\n");
		expect(full).toContain("call-123");
		expect(full).toContain(expectedTime);
		const nativeFull = nativeText(h.viewer.describe(context));
		expect(nativeFull).toContain("call-123");
		expect(nativeFull).toContain(expectedTime);
		h.viewer.handleInput("\x1b");
		expect(h.render(48).join("\n")).toContain("call-123");
	});

	it("refreshes cached preview and full-content timestamps when the clock format changes at the same width", () => {
		const h = harness();
		const context = { ...cx, cols: 160, hour12: true };
		h.resize(32);
		h.viewer.describe(context);
		select(h.viewer, "tool-output");
		for (const page of ["preview", "full"]) {
			if (page === "full")
				h.viewer.handleNativeEvent({
					type: "action",
					key: "entries/content/list/result/0",
					act: "open-entry",
					mods: [],
				});
			for (const hour12 of [true, false, true]) {
				const expected = new Date(0).toLocaleString([], {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hour12,
				});
				expect(nativeText(h.viewer.describe({ ...context, hour12 }))).toContain(expected);
				expect(h.render(160).join("\n")).toContain(expected);
			}
		}
	});
});

describe("ContextViewer Snapcompact", () => {
	it("shows estimated wire savings in the overview without a diagnostics navigation level", () => {
		const data = fixture();
		const h = harness(data);
		const overview = h.render(160);
		expect(h.viewer.capturesInput("d")).toBe(false);
		h.viewer.handleInput("d");
		expect(h.render(160)).toEqual(overview);
		scrollToText(h.viewer, () => h.render(160), "2 frames");
		expect(h.render(160).join("\n")).toContain("2 frames");
		expect(nodes(h.viewer.describe(cx)).some(node => node.p?.actions?.click === "diagnostics")).toBe(false);
		h.viewer.handleInput("\x1b");
		expect(h.closed()).toBe(1);
	});

	it("keeps inactive Snapcompact reasons visible in the overview", () => {
		const data = fixture();
		const inactive = harness({
			...data,
			breakdown: {
				...data.breakdown,
				snapcompact: { visionCapable: false, savedTokens: 0 },
			},
		});
		scrollToText(inactive.viewer, () => inactive.render(160), "no image input");
		expect(inactive.render(160).join("\n")).toContain("no image input");
	});
});

describe("ContextViewer theme and responsive layout", () => {
	it("resolves map cells and interactive legend swatches from the same live theme, including overrides after invalidate", () => {
		const base = getBuiltinThemes().dark!;
		const h = harness();
		for (const override of ["A", "寬寬"]) {
			setThemeInstance(
				createTheme({
					...base,
					symbols: {
						preset: "unicode",
						overrides: {
							"context.content": override,
							"context.messages": "msg",
							"context.buffer": "buf",
							"context.free": "free",
						},
					},
				}),
			);
			h.viewer.invalidate();
			const lines = h.viewer.render(100);
			const system = lines.find(line => Bun.stripANSI(line).includes("System Prompt"))!;
			const p = CONTEXT_PRESENTATION["system-prompt"];
			const swatch = theme.styledSymbol(p.symbol, p.color);
			const native = nodes(h.viewer.describe(cx));
			const grid = native.filter(node => node.k === "text" && node.p?.wrap === "none");
			expect(
				grid.some(
					node =>
						node.k === "text" &&
						node.p?.spans?.some(span => span.t.startsWith(override) && span.s?.split(" ")[0] === p.color),
				),
			).toBe(true);
			for (const key of ["skills", "built-in-tools", "tool-output", "buffer", "free"] as const) {
				const legend = native.find(node => node.key === key);
				const presentation = CONTEXT_PRESENTATION[key];
				const swatch = itemLabel(legend)?.[0];
				expect(
					grid.some(
						node =>
							node.k === "text" &&
							node.p?.spans?.some(
								cell => cell.t.trim() === swatch?.t.trim() && cell.s?.split(" ")[0] === swatch?.s,
							),
					),
				).toBe(true);
				expect(swatch?.s).toBe(presentation.color);
			}
			const top = native.find(node => node.key === "tool-output");
			const child = native.find(node => node.key === "tool-output/read");
			const topSwatch = itemLabel(top)?.[0];
			const childSwatch = itemLabel(child)?.[0];
			expect(childSwatch?.s).toBe(topSwatch?.s);
			expect(childSwatch?.t.trim()).toBe(topSwatch?.t.trim());
			if (override === "A") {
				expect(sliceWithWidth(system, 2, 31, true).text).toContain(swatch);
				expect(sliceWithWidth(system, 36, 60, true).text).toContain(swatch);
			}
		}
	});

	it("aligns token and usage columns across categories, children, and capacity rows", () => {
		const data = fixture();
		data.categories[0]!.label = "寬".repeat(80);
		const h = harness(data);
		for (const width of [48, 100]) {
			const lines = h.render(width).filter(line => /\d+K?\s+\d+\.\d%/.test(line));
			const ends = lines.map(line => {
				const match = /(\d+K?)\s+(\d+\.\d%)/.exec(line)!;
				const start = visibleWidth(line.slice(0, match.index));
				return [start + match[1]!.length, start + match[0].length];
			});
			expect(ends.length).toBeGreaterThan(1);
			expect(ends.every(end => end[0] === ends[0]![0] && end[1] === ends[0]![1])).toBe(true);
			expect(h.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("preserves the footer divider and bottom border at short heights in overview, preview and full content", () => {
		const h = harness();
		for (const page of ["overview", "category", "entry"]) {
			if (page === "category") select(h.viewer, "tool-output");
			if (page === "entry") h.viewer.handleInput("\r");
			for (const height of [18, 6, 4]) {
				h.resize(height);
				const lines = h.render(48);
				expect(lines).toHaveLength(height);
				expect(lines.at(-3)).toMatch(/^├.*┤$/);
				expect(lines.at(-1)).toMatch(/^╰.*╯$/);
				expect(lines.every(line => visibleWidth(line) <= 48)).toBe(true);
			}
			h.resize(24);
			h.render();
		}
	});

	it("keeps wide symbols and content inside all responsive widths, and remains usable after width-only and height-only resizes", () => {
		const base = getBuiltinThemes().dark!;
		setThemeInstance(
			createTheme({
				...base,
				symbols: { preset: "ascii", overrides: { "context.content": "寬寬", "context.messages": "multi" } },
			}),
		);
		const h = harness();
		for (const width of [48, 64, 100]) {
			const lines = h.viewer.render(width);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		}
		select(h.viewer, "tool-output/read");
		h.render(48);
		scrollToText(h.viewer, () => h.render(48), "context-output-tail");
		expect(h.render(48).join("\n")).toContain("context-output-tail");
		h.resize(18);
		h.render(48);
		scrollToText(h.viewer, () => h.render(48), "context-output-tail");
		expect(h.render(48).join("\n")).toContain("context-output-tail");
		h.render(100);
		scrollToText(h.viewer, () => h.render(100), "context-output-tail");
		expect(h.render(100).join("\n")).toContain("context-output-tail");
	});
});
