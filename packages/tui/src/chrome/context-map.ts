/** Pure occupancy calculations for contiguous token segments, independent of themes and renderers. */
export interface ContextMapSegment<T> {
	readonly id: T;
	readonly tokens: number;
}

export interface ContextMapCell<T> {
	readonly id: T;
	readonly full: boolean;
}

export function planContextMap<T>(
	segments: readonly ContextMapSegment<T>[],
	scale: number,
	columns: number,
	rows: number,
): ContextMapCell<T>[] {
	if (
		!Number.isFinite(scale) ||
		scale <= 0 ||
		!Number.isInteger(columns) ||
		!Number.isInteger(rows) ||
		columns <= 0 ||
		rows <= 0
	)
		return [];
	const count = columns * rows;
	const step = scale / count;
	const ranges: { id: T; start: number; end: number }[] = [];
	let cursor = 0;
	for (const segment of segments) {
		if (!Number.isFinite(segment.tokens) || segment.tokens <= 0) continue;
		const end = Math.min(scale, cursor + segment.tokens);
		if (end > cursor) ranges.push({ id: segment.id, start: cursor, end });
		cursor = end;
		if (cursor >= scale) break;
	}
	const cells: ContextMapCell<T>[] = [];
	let first = 0;
	for (let index = 0; index < count; index++) {
		const start = index * step;
		const end = (index + 1) * step;
		while (first < ranges.length && ranges[first]!.end <= start) first++;
		let winner: T | undefined;
		let overlap = 0;
		for (let part = first; part < ranges.length && ranges[part]!.start < end; part++) {
			const range = ranges[part]!;
			const covered = Math.min(end, range.end) - Math.max(start, range.start);
			if (covered > overlap) {
				overlap = covered;
				winner = range.id;
			}
		}
		if (winner !== undefined) cells.push({ id: winner, full: overlap / step >= 0.7 });
	}
	return cells;
}
