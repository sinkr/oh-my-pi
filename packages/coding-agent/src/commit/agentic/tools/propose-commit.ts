import { type } from "@oh-my-pi/omptype";
import type { CommitAgentState } from "../../../commit/agentic/state";
import {
	capDetails,
	MAX_DETAIL_ITEMS,
	normalizeSummary,
	SUMMARY_MAX_CHARS,
	validateSummaryRules,
} from "../../../commit/agentic/validation";
import { validateAnalysis } from "../../../commit/analysis/validation";
import type { CommitType, ConventionalAnalysis, ConventionalDetail } from "../../../commit/types";
import { normalizeDetails } from "../../../commit/utils";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { commitTypeSchema, detailSchema } from "./schemas.js";

const proposeCommitSchema = type({
	type: commitTypeSchema,
	scope: type("string").or("null"),
	summary: "string",
	details: detailSchema.array(),
	issue_refs: "string[]",
});

interface ProposalResponse {
	valid: boolean;
	errors: string[];
	warnings: string[];
	proposal?: {
		type: CommitType;
		scope: string | null;
		summary: string;
		details: ConventionalDetail[];
		issue_refs: string[];
	};
}

export function createProposeCommitTool(_cwd: string, state: CommitAgentState): CustomTool<typeof proposeCommitSchema> {
	return {
		name: "propose_commit",
		label: "Propose Commit",
		description: "Submit the final conventional commit proposal.",
		parameters: proposeCommitSchema,
		async execute(_toolCallId, params) {
			const scope = params.scope?.trim().toLowerCase() || null;
			const summary = normalizeSummary(params.summary, params.type, scope);
			const details = normalizeDetails(params.details ?? []).filter(detail => detail.text.length > 0);
			const { details: cappedDetails, warnings: detailWarnings } = capDetails(details);
			const analysis: ConventionalAnalysis = {
				type: params.type,
				scope,
				details: cappedDetails,
				issueRefs: params.issue_refs ?? [],
			};

			const summaryValidation = validateSummaryRules(summary);
			const analysisValidation = validateAnalysis(analysis);

			const errors = [...summaryValidation.errors, ...analysisValidation.errors];
			const warnings = [...summaryValidation.warnings, ...detailWarnings];
			const response: ProposalResponse = {
				valid: errors.length === 0,
				errors,
				warnings,
			};

			if (response.valid) {
				response.proposal = {
					type: analysis.type,
					scope: analysis.scope,
					summary,
					details: analysis.details,
					issue_refs: analysis.issueRefs,
				};
				state.proposal = {
					analysis,
					summary,
					warnings,
				};
			}

			const text = JSON.stringify(
				{
					...response,
					constraints: {
						maxSummaryChars: SUMMARY_MAX_CHARS,
						maxDetailItems: MAX_DETAIL_ITEMS,
					},
				},
				null,
				2,
			);

			return {
				content: [{ type: "text", text }],
				details: response,
			};
		},
	};
}
