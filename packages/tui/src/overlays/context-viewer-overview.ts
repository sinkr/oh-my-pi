/**
 * Overview model: usage attribution, legend rows, and the occupancy map. Legend and
 * map rows have an ANSI form (`render`) and a native form (`describe`); keep the twins visually identical.
 */
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { type ContextMapCell, planContextMap } from "../chrome/context-map";
import { CONTEXT_PRESENTATION, type ContextPresentationId } from "../chrome/context-presentation";
import { item, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { theme } from "../theme/theme";
import { truncateToWidth, visibleWidth } from "../utils";
import type { ContextViewCategory, ContextViewData } from "./context-viewer";
import { safeLine, safeText } from "./context-viewer-format";

/** The map is hidden below this body width. */
const MAP_MIN_WIDTH = 52;
/** Map cells are separated by a space from this body width. */
const MAP_GAP_MIN_WIDTH = 72;
/** Maximum map columns and rows. */
const MAP_MAX_CELLS = 16;
/** Width reserved for the legend beside the map. */
const LEGEND_MIN_WIDTH = 32;
/** Columns between the map and the legend. */
export const MAP_LEGEND_GAP = 3;

export interface OverviewRow {
	readonly key: string;
	readonly id: ContextPresentationId;
	readonly label: string;
	/** Attributed usage; undefined when the weights cannot scale current usage. */
	readonly tokens: number | undefined;
	/** Category opened on confirm; undefined rows are listed but not selectable. */
	readonly category?: ContextViewCategory;
	readonly child?: boolean;
	/** Right-aligned token column. */
	readonly value: string;
	/** Right-aligned share column, including its leading separator. */
	readonly share: string;
}

export interface MapGeometry {
	readonly columns: number;
	readonly rows: number;
	readonly cellWidth: number;
	readonly gap: string;
	readonly width: number;
}

/** Largest-remainder split of `total` by `weights`; undefined when the weights cannot scale. */
function allocateTokens(weights: readonly number[], total: number): number[] | undefined {
	const sum = weights.reduce((value, weight) => value + weight, 0);
	if (!(sum > 0) || !Number.isFinite(sum)) return;
	const shares = weights.map((weight, index) => {
		const exact = (total * weight) / sum;
		return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	const remaining = total - shares.reduce((value, share) => value + share.tokens, 0);
	const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let index = 0; index < remaining; index++) ranked[index]!.tokens++;
	return shares.map(share => share.tokens);
}

/**
 * Attribute current usage to categories by weight, then each category's share to its children.
 * Attributed values are not entry sums: entries keep their unscaled content/replay estimates.
 * Undefined when the top-level weights cannot scale; unscalable children stay unattributed.
 */
export function allocateUsage(
	categories: readonly ContextViewCategory[],
	usage: number,
): Map<ContextViewCategory, number> | undefined {
	const allocated = new Map<ContextViewCategory, number>();
	const allocate = (siblings: readonly ContextViewCategory[], total: number): boolean => {
		const shares = allocateTokens(
			siblings.map(category => category.tokens),
			total,
		);
		if (!shares) return false;
		for (const [index, category] of siblings.entries()) {
			allocated.set(category, shares[index]!);
			if (category.children) allocate(category.children, shares[index]!);
		}
		return true;
	};
	return allocate(categories, usage) ? allocated : undefined;
}

/** Only Overview excludes the Skills attribution; content views retain complete system blocks. */
export function overviewLabel(category: ContextViewCategory): string {
	return category.id === "system-prompt" ? `${category.label} (excluding Skills)` : category.label;
}

export function formatShare(tokens: number, window: number): string {
	if (window <= 0) return "—";
	const percent = (tokens / window) * 100;
	return percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** Category and child rows, then buffer and free space, with aligned value columns. */
export function buildOverviewRows(
	data: ContextViewData,
	allocated: ReadonlyMap<ContextViewCategory, number> | undefined,
): OverviewRow[] {
	const rows: Omit<OverviewRow, "value" | "share">[] = [];
	for (const category of data.categories) {
		rows.push({
			key: category.id,
			id: category.id,
			label: overviewLabel(category),
			tokens: allocated?.get(category),
			// Skills is an estimate without entries; empty categories have nothing to open.
			category: category.id === "skills" || category.entries.length === 0 ? undefined : category,
		});
		for (const child of category.children ?? [])
			rows.push({
				key: child.key!,
				id: category.id,
				label: child.label,
				tokens: allocated?.get(child),
				category: category.id === "skills" || child.id === "skills" ? undefined : child,
				child: true,
			});
	}
	rows.push(
		{ key: "buffer", id: "buffer", label: "Auto-Compact Buffer", tokens: data.buffer },
		{ key: "free", id: "free", label: "Free Space", tokens: data.free },
	);
	const tokenWidth = Math.max(...rows.map(row => (row.tokens === undefined ? 1 : formatNumber(row.tokens).length)));
	const shareWidth = Math.max(
		...rows.map(row => (row.tokens === undefined ? 1 : formatShare(row.tokens, data.window).length)),
	);
	return rows.map(row => ({
		...row,
		value: row.tokens === undefined ? "—" : formatNumber(row.tokens).padStart(tokenWidth),
		share: row.tokens === undefined ? "" : `  ${formatShare(row.tokens, data.window).padStart(shareWidth)}`,
	}));
}

/** ANSI legend row: cursor, swatch, label padded to `width`, value columns. */
export function legendLine(row: OverviewRow, selected: boolean, width: number): string {
	const presentation = CONTEXT_PRESENTATION[row.id];
	const glyph = theme.styledSymbol(presentation.symbol, presentation.color);
	const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ".repeat(visibleWidth(theme.nav.cursor));
	const prefix = `${cursor} ${row.child ? "  " : ""}${glyph} `;
	const suffix = ` ${theme.fg(selected ? presentation.color : "text", row.value)}${theme.fg(selected ? presentation.color : "dim", row.share)}`;
	const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
	const label = truncateToWidth(safeLine(row.label), budget);
	const name = selected ? theme.fg(presentation.color, theme.bold(label)) : label;
	return truncateToWidth(`${prefix}${name}${" ".repeat(Math.max(0, budget - visibleWidth(label)))}${suffix}`, width);
}

/** Native legend item; `meter` swaps map glyphs for the meter's bar glyphs. */
export function legendItem(row: OverviewRow, selected: boolean, meter: boolean, window: number): NativeNode {
	const presentation = CONTEXT_PRESENTATION[row.id];
	const glyph = meter
		? row.id === "buffer"
			? "▨"
			: row.id === "free"
				? "□"
				: "■"
		: theme.symbol(presentation.symbol);
	const value = row.tokens === undefined ? "—" : `${formatNumber(row.tokens)} · ${formatShare(row.tokens, window)}`;
	return item(row.key, {
		label: [
			span(`${row.child ? "  " : ""}${glyph} `, presentation.color),
			span(safeText(row.label), selected ? `${presentation.color} strong` : undefined),
		],
		value: selected ? [span(value, presentation.color)] : value,
	});
}

/** Map size beside a legend in a `width` × `height` body; undefined when either would not fit. */
export function mapGeometry(width: number, height: number): MapGeometry | undefined {
	if (width < MAP_MIN_WIDTH || height < 2) return;
	const gap = width >= MAP_GAP_MIN_WIDTH ? " " : "";
	const cellWidth = Math.max(
		1,
		...Object.values(CONTEXT_PRESENTATION).map(presentation => visibleWidth(theme.symbol(presentation.symbol))),
	);
	const columns = Math.min(
		MAP_MAX_CELLS,
		Math.floor((width - LEGEND_MIN_WIDTH - MAP_LEGEND_GAP + gap.length) / (cellWidth + gap.length)),
	);
	if (columns < 1) return;
	const rows = Math.min(MAP_MAX_CELLS, height);
	return { columns, rows, cellWidth, gap, width: columns * (cellWidth + gap.length) - gap.length };
}

/** Map cells per row, in window order: categories, free space, then buffer. */
export function planMapRows(
	data: ContextViewData,
	allocated: ReadonlyMap<ContextViewCategory, number>,
	geometry: MapGeometry,
): ContextMapCell<ContextPresentationId>[][] {
	const cells = planContextMap<ContextPresentationId>(
		[
			...data.categories.map(category => ({ id: category.id, tokens: allocated.get(category) ?? 0 })),
			{ id: "free", tokens: data.free },
			{ id: "buffer", tokens: data.buffer },
		],
		data.window,
		geometry.columns,
		geometry.rows,
	);
	return Array.from({ length: geometry.rows }, (_, row) =>
		cells.slice(row * geometry.columns, (row + 1) * geometry.columns),
	);
}

/** ANSI map row; partially filled cells are dim. */
export function mapRowLine(cells: readonly ContextMapCell<ContextPresentationId>[], geometry: MapGeometry): string {
	return cells
		.map(cell => {
			const presentation = CONTEXT_PRESENTATION[cell.id];
			const glyph = theme.symbol(presentation.symbol);
			const value = theme.fg(presentation.color, glyph);
			return `${cell.full ? value : `\x1b[2m${value}\x1b[22m`}${" ".repeat(Math.max(0, geometry.cellWidth - visibleWidth(glyph)))}`;
		})
		.join(geometry.gap);
}

/** Native map row; partially filled cells are dim. */
export function mapRowSpans(cells: readonly ContextMapCell<ContextPresentationId>[], geometry: MapGeometry): TspSpan[] {
	return cells.map(cell => {
		const presentation = CONTEXT_PRESENTATION[cell.id];
		const glyph = theme.symbol(presentation.symbol);
		return span(
			`${glyph}${" ".repeat(Math.max(0, geometry.cellWidth - visibleWidth(glyph)))}${geometry.gap}`,
			`${presentation.color}${cell.full ? "" : " dim"}`,
		);
	});
}
