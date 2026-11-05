import type { ConventionalAnalysis } from "../../commit/types";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateSummary(summary: string, _maxChars?: number): ValidationResult {
	const errors: string[] = [];
	if (!summary.trim()) {
		errors.push("Summary is empty");
	}
	if (summary.includes("\n")) {
		errors.push("Summary must be a single line");
	}
	return { valid: errors.length === 0, errors };
}

export function validateScope(scope: string | null): ValidationResult {
	if (!scope) return { valid: true, errors: [] };
	const errors: string[] = [];
	const segments = scope.split("/");
	for (const segment of segments) {
		if (!segment.trim()) {
			errors.push("Scope segments cannot be empty");
		}
	}
	return { valid: errors.length === 0, errors };
}

export function validateAnalysis(analysis: ConventionalAnalysis): ValidationResult {
	const errors: string[] = [];
	const scopeResult = validateScope(analysis.scope);
	if (!scopeResult.valid) {
		errors.push(...scopeResult.errors);
	}
	for (const detail of analysis.details) {
		if (!detail.text.trim()) {
			errors.push("Detail text is empty");
		}
	}
	return { valid: errors.length === 0, errors };
}
