/**
 * Per-prompt prewalk-suitability classifier for `prewalk.auto`.
 *
 * Asks the native System One judge one {@link ChoiceQuestion} about where a
 * request's expensive reasoning belongs: up front (`prewalk`: the strong model
 * investigates and plans, the cheap target finishes), throughout (`primary`:
 * stay on the strong model), or nowhere (`direct`: nothing worth handing off
 * from). This is not a difficulty classifier (see `auto-thinking/classifier.ts`)
 * and it trusts only the calibrated native probabilities, so a prompted chat or
 * on-device model never stands in for the native judge.
 *
 * Resolves `undefined` when the `judge` role has no native backend. Throws on
 * every other failure (no key, malformed answer, abort, timeout); the caller
 * treats both outcomes as "do not arm".
 */
import type { AgentMessage, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import type { ChoiceAnswer, ChoiceQuestion } from "@oh-my-pi/pi-ai";
import { titleTextFromSkillPrompt } from "@oh-my-pi/pi-tui/chat/skill-title-input";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { assistantText } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { hasNativeJudge, type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import routeQuestionInstructions from "../prompts/system/auto-prewalk-route-question.md" with { type: "text" };
import { preprocessTinyMessage } from "../tiny/message-preproc";
import { isLowSignalTitleInput } from "../tiny/text";

export type PrewalkRoute = "prewalk" | "primary" | "direct";

/** `P(prewalk)` a task needs before auto-prewalk arms: a wrong hand-off costs more than a missed one. */
export const AUTO_PREWALK_MIN_PROBABILITY = 0.7;

/** A judgment slower than this gives way to the unmodified turn; an optimization never makes the user wait longer. */
export const AUTO_PREWALK_TIMEOUT_MS = 4000;

const ROUTES: readonly PrewalkRoute[] = ["prewalk", "primary", "direct"];

const ROUTE_CRITERIA: Record<PrewalkRoute, string> = {
	prewalk:
		"Both hold: starting correctly needs real up-front investigation, repository understanding, diagnosis, design, or planning; and once that fixes the approach, the implementation and verification left are bounded enough for a faster model. Tracing an unfamiliar subsystem before a localized change; reading several interacting files before implementing a clear design; diagnosing a bug down to a concrete fix whose implementation is straightforward; a migration or refactor whose hard part is finding the right transformation and everything it touches.",
	primary:
		"Strong reasoning stays needed while implementing, debugging, or validating, so handing off at the first edit would be premature. Unresolved races, concurrency, or invariant problems; subtle state-machine or lifecycle changes; a bug whose cause is likely still uncertain after a first look; high-risk changes that need iterative reasoning while editing and testing; difficult algorithms; work where the first edit is only the start of the hard thinking.",
	direct:
		"No up-front phase worth handing off from: explanations and read-only questions; trivial or mechanical edits; fully specified changes with an obvious implementation; tiny localized fixes; requests that involve no implementation.",
};

const ROUTE_QUESTION: ChoiceQuestion<PrewalkRoute> = {
	type: "choice",
	instructions: prompt.render(routeQuestionInstructions),
	criteria: ROUTE_CRITERIA,
};

/** The turn to classify. */
export interface AutoPrewalkInput {
	/** The expanded prompt the agent is about to act on. */
	request: string;
	/** Transcript before `request`; only its latest request/reply pair reaches the judge, to resolve follow-ups. */
	history: readonly AgentMessage[];
}

export interface AutoPrewalkDecision {
	/** The judge's winning route. */
	route: PrewalkRoute;
	/** Every route's probability; sums to 1. */
	probabilities: Record<PrewalkRoute, number>;
	/** Concentration of the distribution, 0–1. */
	confidence: number;
	/** Whether to arm prewalk: `prewalk` won with `P(prewalk) >= `{@link AUTO_PREWALK_MIN_PROBABILITY}. */
	arm: boolean;
}

export interface ClassifyAutoPrewalkDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	signal?: AbortSignal;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
}

/** Text of a user-authored request: a typed prompt or a user-invoked skill, never an injected or agent-attributed one. */
function userRequestText(message: AgentMessage): string | undefined {
	if (message.role === "user") {
		return message.synthetic || message.attribution === "agent" ? undefined : textContent(message.content);
	}
	return message.role === "custom" ? titleTextFromSkillPrompt(message) : undefined;
}

/**
 * The newest substantive user request and the agent's newest reply after it.
 * Acknowledgements ("ok", "thanks") are not requests, so the scan looks past them.
 */
function recentContext(history: readonly AgentMessage[]): { request?: string; response?: string } {
	let response: string | undefined;
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]!;
		response ??= assistantText(message);
		const request = userRequestText(message);
		if (request && !isLowSignalTitleInput(request)) return { request, response };
	}
	return { response };
}

/** `request` leads and is authoritative; the earlier pair is included only when the transcript has one. */
function buildState(input: AutoPrewalkInput): Record<string, string> {
	const state: Record<string, string> = { request: preprocessTinyMessage(input.request) };
	const { request, response } = recentContext(input.history);
	if (request) state.previous_request = preprocessTinyMessage(request);
	if (response) state.previous_response = preprocessTinyMessage(response);
	return state;
}

function toDecision({ choice, probabilities, confidence }: ChoiceAnswer<PrewalkRoute>): AutoPrewalkDecision {
	// The judge's wire shape is only checked for answer type upstream; a partial answer must never arm.
	if (
		!ROUTES.includes(choice) ||
		typeof confidence !== "number" ||
		!ROUTES.every(
			route => typeof probabilities?.[route] === "number" && probabilities[route] >= 0 && probabilities[route] <= 1,
		)
	) {
		throw new Error("auto-prewalk: the judge returned a malformed route answer");
	}
	return {
		route: choice,
		probabilities,
		confidence,
		arm: choice === "prewalk" && probabilities.prewalk >= AUTO_PREWALK_MIN_PROBABILITY,
	};
}

/**
 * Classify where `input.request`'s reasoning belongs.
 * @returns `undefined` when the `judge` role does not resolve first to a native System One backend.
 * @throws when the judge cannot produce a usable answer within {@link AUTO_PREWALK_TIMEOUT_MS}.
 */
export async function classifyAutoPrewalk(
	input: AutoPrewalkInput,
	deps: ClassifyAutoPrewalkDeps,
): Promise<AutoPrewalkDecision | undefined> {
	if (!hasNativeJudge(deps.settings, deps.registry)) return undefined;
	// Without a session fallback model the chain holds only native candidates, so no prompted model can answer.
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionId: deps.sessionId,
		purpose: "auto-prewalk",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const timeout = AbortSignal.timeout(AUTO_PREWALK_TIMEOUT_MS);
	const { answers } = await judge.judge(
		{ state: buildState(input), questions: { route: ROUTE_QUESTION } },
		{ signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout },
	);
	return toDecision(answers.route);
}
