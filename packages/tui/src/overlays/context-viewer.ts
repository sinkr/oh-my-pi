import type { TspSpan } from "@oh-my-pi/pi-wire";
import { CONTEXT_PRESENTATION, type ContextCategoryId } from "../chrome/context-presentation";
import { editorKey } from "../chrome/keybinding-hints";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { nativeSlotProps } from "../components/layout/geometry";
import { MenuSelection } from "../components/menu-selection";
import { ScrollView } from "../components/scroll-view";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { col, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeRevealAt, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import { styledSpans } from "../native/spans";
import {
	type ContextBreakdown,
	contextSnapcompactLines,
	contextUsageHead,
	contextUsageSummary,
	describeContextMeter,
} from "../status-line/context-usage";
import { ensureThemeSync, theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import {
	entryHeaderLine,
	entryHeaderSpans,
	entryMetadata,
	entryPreview,
	groupHeaderLine,
	previewHint,
	previewRows,
	safeContent,
	safeText,
} from "./context-viewer-format";
import {
	allocateUsage,
	buildOverviewRows,
	legendItem,
	legendLine,
	MAP_LEGEND_GAP,
	type MapGeometry,
	mapGeometry,
	mapRowLine,
	mapRowSpans,
	type OverviewRow,
	overviewLabel,
	planMapRows,
} from "./context-viewer-overview";

export interface ContextThinkingGroup {
	readonly id: string;
	readonly label: string;
	readonly tokens: number;
	readonly interrupted?: boolean;
}

export interface ContextViewEntry {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	/** Aggregation weight for the unscaled replay estimate; shared blocks contribute through their group. */
	readonly tokens: number;
	readonly interrupted?: boolean;
	readonly thinkingGroup?: ContextThinkingGroup;
	readonly path?: string;
	readonly info?: string;
	readonly timestamp?: number;
	readonly callId?: string;
}

export interface ContextViewCategory {
	id: ContextCategoryId;
	key?: string;
	label: string;
	/** Overview attribution weight, not reported usage; may differ from the entry sum (e.g. Skills subtraction). */
	tokens: number;
	entries: ContextViewEntry[];
	children?: ContextViewCategory[];
}

export interface ContextViewData {
	readonly modelLabel: string;
	readonly window: number;
	/** Current context usage, which may be provider-anchored or locally estimated. */
	readonly usage: number;
	readonly buffer: number;
	readonly free: number;
	readonly breakdown: ContextBreakdown;
	readonly categories: readonly ContextViewCategory[];
}

type ViewState = "overview" | "category" | "entry";

/** Rows of one entry inside the ANSI category preview. */
interface EntryRange {
	start: number;
	end: number;
	complete: boolean;
}

const NATIVE_ENTRY_GUTTER_COLS = 2;
// Wrapper keys around native entry nodes; entry actions arrive at `<list>/<row>/<column>/<entry id>`.
const NATIVE_ENTRY_KEYS = { list: "entries", row: "content", column: "list" } as const;
const NATIVE_ENTRY_KEYPATH = `${NATIVE_ENTRY_KEYS.list}/${NATIVE_ENTRY_KEYS.row}/${NATIVE_ENTRY_KEYS.column}/`;

/**
 * Read-only context snapshot with three states: Overview → category previews → full entry content.
 * Navigation state is shared; `render` (ANSI) and `describe` (native) each draw every state,
 * via `#render<State>` and `#describe<State>` respectively.
 */
export class ContextViewer implements Component {
	readonly #data: ContextViewData;
	readonly #close: () => void;
	readonly #requestRender: () => void;
	readonly #getRows: () => number;
	/** Attributed usage when it can be drawn against the window (meter and map). */
	readonly #scaledUsage: ReadonlyMap<ContextViewCategory, number> | undefined;
	readonly #meter: readonly NativeNode[] | undefined;

	// Navigation.
	#state: ViewState = "overview";
	readonly #overview: MenuSelection<OverviewRow>;
	#category: ContextViewCategory | undefined;
	readonly #entries = new MenuSelection<ContextViewEntry>([], {
		getKey: entry => entry.id,
		getSearchText: entry => entry.label,
	});
	#entry: ContextViewEntry | undefined;
	/** Back target of the entry state; single-entry categories open straight from Overview. */
	#entryParent: "overview" | "category" = "overview";
	#disposed = false;

	// Layout shared by both backends.
	#width = 0;
	#height = 1;
	#hour12: boolean | undefined;
	/** Only ANSI input needs local full-content scroll geometry. */
	#lastRenderMode: "ansi" | "native" = "ansi";
	#entryBodyCache: { entry: ContextViewEntry; text: string } | undefined;

	// ANSI backend.
	readonly #panel = new OverlayPanel("Context");
	readonly #header = new PanelRows();
	readonly #body = new PanelRows();
	readonly #footer = new PanelRows();
	readonly #overviewScroll = new ScrollView([], { height: 1 });
	readonly #ansiPreviewScroll = new ScrollView([], { height: 1 });
	readonly #ansiEntryScroll = new ScrollView([], { height: 1 });
	/** Previews of the open category only. */
	#ansiPreviewCache:
		| { category: ContextViewCategory; width: number; height: number; lines: string[]; ranges: EntryRange[] }
		| undefined;
	#ansiEntryLayoutWidth: number | undefined;

	// Native backend.
	#nativeOverlay:
		| { category: ContextViewCategory | undefined; props: NonNullable<Component["nativeOverlay"]> }
		| undefined;
	/** Previews of the open category only. */
	#nativePreviewCache:
		| {
				category: ContextViewCategory;
				width: number;
				height: number;
				previews: Map<ContextViewEntry, { spans: TspSpan[] | undefined; complete: boolean }>;
		  }
		| undefined;
	#nativePreviewRevealAt: NativeRevealAt = "nearest";
	// Native scroll requests, not a viewport offset. The reconciler repeats each
	// line step by the increment in `n`.
	#nativeScroll: NativeScroll = { by: "start", n: 0 };

	constructor(
		data: ContextViewData,
		options: { onClose: () => void; requestRender: () => void; getRows: () => number },
	) {
		ensureThemeSync();
		this.#data = data;
		this.#close = options.onClose;
		this.#requestRender = options.requestRender;
		this.#getRows = options.getRows;
		const allocated = allocateUsage(data.categories, data.usage);
		this.#scaledUsage = data.window > 0 && Number.isFinite(data.window) ? allocated : undefined;
		const scaled = this.#scaledUsage;
		this.#meter = scaled
			? describeContextMeter({
					contextWindow: data.window,
					usedTokens: data.usage,
					freeTokens: data.free,
					autoCompactBufferTokens: data.buffer,
					thresholdTokens: data.breakdown.thresholdTokens,
					categories: data.categories.map(category => ({
						label: safeText(overviewLabel(category)),
						tokens: scaled.get(category)!,
						color: CONTEXT_PRESENTATION[category.id].color,
					})),
				})
			: undefined;
		this.#overview = new MenuSelection(buildOverviewRows(data, allocated), {
			getKey: item => item.key,
			getSearchText: item => item.label,
			isDisabled: item => !item.category,
		});
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	invalidate(): void {
		this.#ansiPreviewCache = undefined;
		this.#nativePreviewCache = undefined;
		this.#resetEntryLayout();
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#nativePreviewCache = undefined;
		this.#resetEntryLayout();
		this.#overviewScroll.dispose();
		this.#ansiPreviewScroll.dispose();
		this.#ansiEntryScroll.dispose();
		this.#panel.dispose();
	}

	get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
		const category = this.#state === "overview" ? undefined : this.#category;
		if (!this.#nativeOverlay || this.#nativeOverlay.category !== category) {
			this.#nativeOverlay = {
				category,
				props: {
					role: "omp.overlay.report",
					size: "lg",
					anchor: "center",
					head: category
						? [span("Context", "strong"), span(` · ${safeText(category.label)}`, "muted")]
						: contextUsageHead(this.#data.breakdown),
				},
			};
		}
		return this.#nativeOverlay.props;
	}

	// ── Navigation ──────────────────────────────────────────────────────────

	/** Capture only handled navigation keys; the focus path consumes other modal input. */
	capturesInput(data: string): boolean {
		return (
			matchesSelectCancel(data) ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			(this.#state === "entry" && (matchesSelectPageUp(data) || matchesSelectPageDown(data))) ||
			getKeybindings().matches(data, "tui.select.confirm")
		);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (matchesSelectCancel(data)) this.#back();
		else if (getKeybindings().matches(data, "tui.select.confirm")) this.#activate();
		else if (matchesSelectUp(data)) this.#navigate(-1);
		else if (matchesSelectDown(data)) this.#navigate(1);
		else if (matchesSelectPageUp(data)) this.#page(-1);
		else if (matchesSelectPageDown(data)) this.#page(1);
		this.#requestRender();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "action") {
			if (event.act === "close") this.#close();
			else if (event.act === "back") this.#back();
			else if (this.#state === "category" && (event.act === "select-entry" || event.act === "open-entry")) {
				const id = event.key.startsWith(NATIVE_ENTRY_KEYPATH) ? event.key.slice(NATIVE_ENTRY_KEYPATH.length) : "";
				const entry = this.#entries.items.find(entry => entry.id === id);
				if (!entry) return;
				this.#entries.setSelectedKey(entry.id);
				if (event.act === "open-entry") this.#activate();
			}
		} else if (this.#state === "overview" && (event.type === "select" || event.type === "activate")) {
			const item = this.#overview.items.find(item => item.key === event.item);
			if (!item?.category) return;
			this.#overview.setSelectedKey(event.item);
			if (event.type === "activate") this.#activate();
		}
		this.#requestRender();
	}

	#activate(): void {
		if (this.#state === "overview") {
			const activation = this.#overview.requestActivation();
			if (activation.kind !== "confirmed" || !activation.item.category) return;
			this.#category = activation.item.category;
			this.#entries.setItems(this.#category.entries, this.#category.entries[0]?.id);
			this.#nativePreviewRevealAt = "nearest";
			this.#ansiPreviewCache = undefined;
			this.#ansiPreviewScroll.scrollToTop();
			if (this.#category.entries.length === 1) this.#openEntry(this.#category.entries[0]!, "overview");
			else this.#state = "category";
		} else if (this.#state === "category") {
			const entry = this.#entries.selectedItem;
			if (!entry) return;
			this.#openEntry(entry, "category");
		}
	}

	#openEntry(entry: ContextViewEntry, parent: "overview" | "category"): void {
		this.#entry = entry;
		this.#entryParent = parent;
		this.#resetEntryLayout();
		this.#ansiEntryScroll.scrollToTop();
		this.#state = "entry";
		if (this.#lastRenderMode === "ansi" && this.#width > 0) this.#ensureAnsiEntryLayout();
	}

	#back(): void {
		if (this.#state === "entry") {
			this.#state = this.#entryParent;
			if (this.#entryParent === "category") this.#nativePreviewRevealAt = "start";
			this.#entry = undefined;
			this.#resetEntryLayout();
			this.#ansiEntryScroll.setLines([]);
		} else if (this.#state === "category") this.#state = "overview";
		else this.#close();
	}

	#navigate(delta: -1 | 1): void {
		if (this.#state === "entry") {
			if (this.#lastRenderMode === "ansi") {
				if (this.#width > 0) this.#ensureAnsiEntryLayout();
				this.#ansiEntryScroll.scroll(delta);
			}
		} else if (this.#state === "overview") {
			if (!this.#overview.move(delta)) this.#overviewScroll.scroll(delta);
		} else {
			this.#entries.move(delta);
			return;
		}
		this.#nativeScroll = {
			by: delta > 0 ? "line-down" : "line-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	/** Page the full-content view; lists keep single-step selection. */
	#page(direction: -1 | 1): void {
		if (this.#state !== "entry") return;
		if (this.#lastRenderMode === "ansi") {
			if (this.#width > 0) this.#ensureAnsiEntryLayout();
			// Keep one line of overlap so the reading position stays visible.
			this.#ansiEntryScroll.scroll(direction * Math.max(1, this.#height - 1));
		}
		this.#nativeScroll = {
			by: direction > 0 ? "page-down" : "page-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	// ── Shared layout and content ───────────────────────────────────────────

	/** Body height for the current terminal rows; returns the header summary that fits. */
	#layout(): string[] {
		const rows = Math.max(1, this.#getRows());
		const summary = this.#summary().slice(0, Math.max(0, rows - 5));
		this.#height = Math.max(0, rows - summary.length - 4);
		return summary;
	}

	#summary(): string[] {
		if (this.#state !== "overview") return [];
		const { usage, window, free, breakdown } = this.#data;
		const labels = contextUsageSummary({
			contextWindow: window,
			usedTokens: usage,
			freeTokens: free,
			thresholdTokens: breakdown.thresholdTokens,
		});
		return [`Used ${labels.used}${labels.detail}`, labels.room];
	}

	/** Both backends wrap previews to `width` with the same row and source bounds. */
	#preview(entry: ContextViewEntry, width: number): { lines: string[]; complete: boolean } {
		return entryPreview(entry, {
			width,
			rows: previewRows(entry, this.#height),
			sourceWidth: this.#width,
			hour12: this.#hour12,
		});
	}

	#entryBodyText(): string {
		const entry = this.#entry!;
		if (this.#entryBodyCache?.entry !== entry) {
			this.#entryBodyCache = { entry, text: safeContent(entry.text.trimEnd()) };
			this.#ansiEntryLayoutWidth = undefined;
		}
		return this.#entryBodyCache.text;
	}

	#resetEntryLayout(): void {
		this.#entryBodyCache = undefined;
		this.#ansiEntryLayoutWidth = undefined;
	}

	// ── ANSI backend ────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		this.#lastRenderMode = "ansi";
		this.#width = Math.max(1, width - 4);
		const terminalRows = Math.max(1, this.#getRows());
		const summary = this.#layout();
		this.#panel.title =
			this.#state === "overview" ? `Context · ${safeText(this.#data.modelLabel)}` : safeText(this.#category!.label);
		this.#header.setHeight(summary.length);
		this.#header.setLines(summary.map(line => truncateToWidth(theme.fg("dim", line), this.#width)));
		this.#body.setLines(
			this.#state === "overview"
				? this.#renderOverview()
				: this.#state === "category"
					? this.#renderCategory()
					: this.#renderEntry(),
		);
		this.#body.setHeight(this.#height);
		this.#footer.setLines([truncateToWidth(theme.fg("dim", this.#footerHints()), this.#width)]);
		const rendered = this.#panel.render(width);
		// Short terminals keep the top border, footer, and bottom border, in that priority.
		if (terminalRows >= 4) return rendered;
		if (terminalRows === 3) return [rendered[0]!, rendered[rendered.length - 2]!, rendered[rendered.length - 1]!];
		return terminalRows === 2 ? [rendered[0]!, rendered[rendered.length - 1]!] : [rendered[rendered.length - 1]!];
	}

	#footerHints(): string {
		const navigation = [editorKey("tui.select.up"), editorKey("tui.select.down")].filter(Boolean).join("/");
		const canOpen =
			this.#state === "overview"
				? !!this.#overview.selectedItem?.category
				: this.#state === "category" && !!this.#entries.selectedItem;
		const confirm = canOpen ? editorKey("tui.select.confirm") : "";
		const cancel = editorKey("tui.select.cancel");
		const movement = this.#state === "overview" ? "select/scroll" : this.#state === "category" ? "select" : "scroll";
		const paging =
			this.#state === "entry"
				? [editorKey("tui.select.pageUp"), editorKey("tui.select.pageDown")].filter(Boolean).join("/")
				: "";
		return [
			navigation && `${navigation} ${movement}`,
			paging && `${paging} page`,
			confirm && `${confirm} open`,
			cancel && `${cancel} ${this.#state === "overview" ? "close" : "back"}`,
		]
			.filter(Boolean)
			.join(" · ");
	}

	/** Map on the left when it fits; scrollable legend and Snapcompact diagnostics on the right. */
	#renderOverview(): string[] {
		const width = this.#width;
		const height = this.#height;
		const usage = this.#scaledUsage;
		const map = usage ? mapGeometry(width, height) : undefined;
		const listWidth = map ? width - map.width - MAP_LEGEND_GAP : width;
		const source = this.#overview.items.map(item =>
			legendLine(item, this.#overview.selectedKey === item.key, Math.max(0, listWidth - 1)),
		);
		for (const line of contextSnapcompactLines(this.#data.breakdown))
			source.push(...wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, listWidth - 1)));
		this.#overviewScroll.setHeight(height);
		this.#overviewScroll.setLines(source);
		this.#overviewScroll.revealRange(
			{
				id: this.#overview.selectedKey ?? "",
				start: this.#overview.selectedIndex,
				end: this.#overview.selectedIndex + 1,
				margin: 0,
			},
			listWidth,
		);
		const legend = this.#overviewScroll.render(listWidth);
		if (!usage || !map) return [...legend];
		const mapRows = planMapRows(this.#data, usage, map);
		const lines: string[] = [];
		for (let index = 0; index < height; index++) {
			const cells = mapRows[index];
			const grid = cells ? mapRowLine(cells, map) : "";
			const padding = " ".repeat(Math.max(0, map.width - visibleWidth(grid)) + MAP_LEGEND_GAP);
			lines.push(`${grid}${padding}${legend[index] ?? ""}`);
		}
		return lines;
	}

	/** Entry previews with the selected one marked by a gutter bar. */
	#renderCategory(): string[] {
		const contentWidth = Math.max(1, this.#width - 2);
		this.#prepareAnsiPreview(contentWidth, this.#height);
		const range = this.#ansiPreviewCache!.ranges[this.#entries.selectedIndex];
		if (range)
			this.#ansiPreviewScroll.revealRange(
				{ id: this.#entries.selectedKey!, start: range.start, end: range.end, margin: 0, oversized: "start" },
				contentWidth,
			);
		const offset = this.#ansiPreviewScroll.getScrollOffset();
		return this.#ansiPreviewScroll.render(contentWidth).map((line, index) => {
			const selected = range && offset + index >= range.start && offset + index < range.end;
			if (selected && !range.complete && offset + index === range.end - 1)
				line = truncateToWidth(previewHint(true), contentWidth - 1);
			return `${selected ? theme.fg("accent", "┃ ") : "  "}${line}`;
		});
	}

	#prepareAnsiPreview(width: number, height: number): void {
		const category = this.#category!;
		const cached = this.#ansiPreviewCache;
		this.#ansiPreviewScroll.setHeight(height);
		if (cached?.category === category && cached.width === width && cached.height === height) return;
		const lines: string[] = [];
		const ranges: EntryRange[] = [];
		const groups = new Set<string>();
		for (const entry of category.entries) {
			const start = lines.length;
			const group = entry.thinkingGroup;
			const indent = group ? "  " : "";
			if (group && !groups.has(group.id)) {
				groups.add(group.id);
				lines.push(truncateToWidth(groupHeaderLine(group, category.id), Math.max(1, width - 1)));
			}
			const entryWidth = Math.max(1, width - 1 - indent.length);
			lines.push(`${indent}${truncateToWidth(entryHeaderLine(entry, category.id), entryWidth)}`);
			const content = this.#preview(entry, entryWidth);
			lines.push(...content.lines.map(line => `${indent}${line}`));
			if (!content.complete) lines.push(previewHint(false));
			ranges.push({ start, end: lines.length, complete: content.complete });
			lines.push("");
		}
		this.#ansiPreviewCache = { category, width, height, lines, ranges };
		this.#ansiPreviewScroll.setLines(lines);
	}

	#renderEntry(): string[] {
		this.#ensureAnsiEntryLayout();
		return [...this.#ansiEntryScroll.render(this.#width)];
	}

	#ensureAnsiEntryLayout(): void {
		const width = this.#width;
		const content = this.#entryBodyText();
		this.#ansiEntryScroll.setHeight(this.#height);
		if (this.#ansiEntryLayoutWidth !== width) {
			const entry = this.#entry!;
			const contentWidth = Math.max(1, width - 1);
			const lines = [
				truncateToWidth(entryHeaderLine(entry, this.#category!.id), contentWidth),
				...entryMetadata(entry, { hour12: this.#hour12, withGroup: true }).flatMap(line =>
					wrapTextWithAnsi(theme.fg("dim", line), contentWidth),
				),
				...content.split("\n").flatMap(line => (line ? wrapTextWithAnsi(line, contentWidth) : [""])),
			];
			this.#ansiEntryLayoutWidth = width;
			this.#ansiEntryScroll.setLines(lines);
		}
	}

	// ── Native backend ──────────────────────────────────────────────────────

	describe(cx: DescribeContext): NativeNode {
		this.#lastRenderMode = "native";
		this.#width = Math.max(1, cx.cols - 4);
		if (this.#hour12 !== cx.hour12) {
			this.#hour12 = cx.hour12;
			this.invalidate();
		}
		this.#layout();
		const children =
			this.#state === "overview"
				? this.#describeOverview(cx)
				: this.#state === "category"
					? [this.#describeCategory()]
					: this.#describeEntry();
		children.push(
			actionBar([
				null,
				...(this.#state !== "overview" ? [actionButton("Back", "back")] : []),
				actionButton("Close", "close"),
			]),
		);
		return col(children, {
			role: "omp.context",
			...(this.#state === "category" ? { grow: 1, min: { h: 0 } } : {}),
		});
	}

	/** Meter (or summary text) above a scrollable legend, with the map beside it when there is no meter. */
	#describeOverview(cx: DescribeContext): NativeNode[] {
		const meter = cx.supports("meter") ? this.#meter : undefined;
		const items = this.#overview.items.map(item =>
			legendItem(item, this.#overview.selectedKey === item.key, !!meter, this.#data.window),
		);
		const list = selectList("categories", items, { selected: this.#overview.selectedKey, grow: 1 });
		const usage = meter ? undefined : this.#scaledUsage;
		const map = usage ? mapGeometry(this.#width, this.#height) : undefined;
		const body: NativeNode[] = [
			usage && map ? row([this.#describeMap(usage, map), list], { gap: "lg" }) : list,
			...contextSnapcompactLines(this.#data.breakdown).map(line => text([span(line, "dim")], { wrap: "word" })),
		];
		const head = meter ?? this.#summary().map(line => text([span(line, "dim")], { wrap: "word" }));
		return [...head, { ...node("col", { grow: 1 }, body, "overview"), scroll: this.#nativeScroll }];
	}

	#describeMap(usage: ReadonlyMap<ContextViewCategory, number>, map: MapGeometry): NativeNode {
		return col(planMapRows(this.#data, usage, map).map(cells => text(mapRowSpans(cells, map), { wrap: "none" })));
	}

	/** Entry previews in a viewport-bounded list; the list owns wheel scrolling. */
	#describeCategory(): NativeNode {
		const groups = new Set<string>();
		const items = this.#entries.items.flatMap((entry, index) => [
			this.#describePreview(entry, groups),
			{ ...text(" ", { wrap: "none" }), key: `separator-${index}` },
		]);
		// list.max owns a wheel scroller; common max.h would only clip.
		return node(
			"list",
			{
				grow: 1,
				min: { h: 0 },
				max: { lines: Math.max(1, this.#height) },
				hidden: this.#height === 0 ? true : undefined,
			},
			[
				node(
					"row",
					{ gap: "none", align: "start" },
					[
						// Native pick bars paint outside entry boxes, but must stay inside the viewport.
						node("spacer", nativeSlotProps("w", { fixed: NATIVE_ENTRY_GUTTER_COLS }), undefined, "gutter"),
						node("col", { grow: 1, min: { w: 0 }, gap: "none" }, items, NATIVE_ENTRY_KEYS.column),
					],
					NATIVE_ENTRY_KEYS.row,
				),
			],
			NATIVE_ENTRY_KEYS.list,
		);
	}

	/** One entry: group heading on its first member, entry heading, preview, and truncation hint. */
	#describePreview(entry: ContextViewEntry, groups: Set<string>): NativeNode {
		const category = this.#category!.id;
		const selected = entry.id === this.#entries.selectedKey;
		const group = entry.thinkingGroup;
		const parts: NativeNode[] = [];
		if (group && !groups.has(group.id)) {
			groups.add(group.id);
			parts.push({
				...text(styledSpans(groupHeaderLine(group, category)), { wrap: "word", lines: 1 }),
				key: "group",
			});
		}
		const header = entryHeaderSpans(entry, category);
		parts.push({
			...text(group ? [span("  "), ...header] : header, { wrap: "word", lines: 1 }),
			key: "head",
			...(selected ? { reveal: this.#nativePreviewRevealAt } : {}),
		});
		const content = this.#nativePreview(entry);
		if (content.spans) parts.push({ ...text(content.spans, { wrap: "word" }), key: "preview" });
		if (!content.complete)
			parts.push({
				...text(styledSpans(previewHint(selected)), { wrap: "word", lines: 1 }),
				key: "hint",
			});
		return {
			...node(
				"col",
				{
					gap: "none",
					mark: selected ? "pick" : undefined,
					actions: { click: "select-entry", dblclick: "open-entry" },
				},
				parts,
				entry.id,
			),
			...(selected ? { reveal: { at: "nearest" as const, n: 0 } } : {}),
		};
	}

	#nativePreview(entry: ContextViewEntry): { spans: TspSpan[] | undefined; complete: boolean } {
		const category = this.#category!;
		let cache = this.#nativePreviewCache;
		if (cache?.category !== category || cache.width !== this.#width || cache.height !== this.#height) {
			cache = { category, width: this.#width, height: this.#height, previews: new Map() };
			this.#nativePreviewCache = cache;
		}
		let preview = cache.previews.get(entry);
		if (!preview) {
			const indent = entry.thinkingGroup ? 2 : 0;
			const content = this.#preview(entry, Math.max(1, this.#width - 1 - NATIVE_ENTRY_GUTTER_COLS - indent));
			// Tern owns final wrapping; only omitted source creates a more row.
			const spans = content.lines.length ? styledSpans(content.lines.join("\n")) : undefined;
			preview = { spans, complete: content.complete };
			cache.previews.set(entry, preview);
		}
		return preview;
	}

	/** Entry heading above scrollable metadata and full content. */
	#describeEntry(): NativeNode[] {
		const entry = this.#entry!;
		const body = node(
			"col",
			{},
			[
				...entryMetadata(entry, { hour12: this.#hour12, withGroup: true }).map(line => text([span(line, "dim")])),
				text(styledSpans(this.#entryBodyText()), { wrap: "word" }),
			],
			`entry-${entry.id}`,
		);
		return [text(entryHeaderSpans(entry, this.#category!.id)), { ...body, scroll: this.#nativeScroll }];
	}
}
