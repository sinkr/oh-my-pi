import { validateSummary } from "../../commit/analysis/validation";
import { stripTypePrefix } from "../../commit/conventional/markdown";
import type { CommitType, ConventionalDetail } from "../../commit/types";
import { normalizeUnicode } from "../../edit/normalize";

export const SUMMARY_MAX_CHARS = 72;
export const MAX_DETAIL_ITEMS = 6;

export function normalizeSummary(summary: string, type: CommitType, scope: string | null): string {
	const stripped = stripTypePrefix(summary, type, scope);
	return normalizeUnicode(stripped).replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
}

export function validateSummaryRules(summary: string): { errors: string[]; warnings: string[] } {
	const basic = validateSummary(summary, SUMMARY_MAX_CHARS);
	return { errors: basic.errors, warnings: [] };
}

export function capDetails(details: ConventionalDetail[]): { details: ConventionalDetail[]; warnings: string[] } {
	if (details.length <= MAX_DETAIL_ITEMS) {
		return { details, warnings: [] };
	}
	return { details: details.slice(0, MAX_DETAIL_ITEMS), warnings: [] };
}

export function validateTypeConsistency(
	_type: CommitType,
	_files: string[],
	_options: { diffText?: string; summary?: string; details?: ConventionalDetail[] } = {},
): { errors: string[]; warnings: string[] } {
	return { errors: [], warnings: [] };
}
