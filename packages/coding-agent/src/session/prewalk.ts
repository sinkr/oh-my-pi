import type { Agent, AgentMessage, AgentToolResult, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AutoPrewalkDecision } from "../auto-prewalk/classifier";
import type { Settings } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../plan-mode/plan-autosave";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import type { PlanModeState } from "../plan-mode/state";
import planYoloHandoffPrompt from "../prompts/system/plan-yolo-handoff.md" with { type: "text" };
import prewalkChecklistPrompt from "../prompts/system/prewalk-checklist.md" with { type: "text" };
import prewalkContinuePrompt from "../prompts/system/prewalk-continue.md" with { type: "text" };
import prewalkPlanPrompt from "../prompts/system/prewalk-plan.md" with { type: "text" };
import { type ConfiguredThinkingLevel, prewalkWouldBeNoop } from "@oh-my-pi/pi-tui/thinking";
import { isMCPToolName } from "../tools/builtin-names";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import type { PlanProposalHandler } from "../tools/resolve";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { PlanYolo, Prewalk } from "./agent-session-types";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
import type { SessionManager } from "./session-manager";
import { cfgPrewalkAuto } from "./settings";
const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

/** Hidden plan steering is consumed within the live run and must not reappear after a context rebuild. */
export function isPrewalkPlanNudge(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PREWALK_PLAN_MESSAGE_TYPE;
}
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};
const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

/**
 * Whether a completed tool result is the first workspace-mutating action that
 * arms the prewalk hand-off. A direct `edit`/`write` call always counts; a
 * `write` that dispatched an `xd://` device (e.g. `lsp`, `ast_edit`, `debug`)
 * counts only when the wrapped tool resolved to a `write`/`exec` approval tier.
 * Read-only device calls — LSP navigation, `debug` inspection, `ast_edit` on
 * internal URLs, help lookups — leave the tier `read` (or absent) and must not
 * switch the model mid-investigation (issue #7312). MCP approval stays
 * conservatively `write`, so an MCP tool the server declared read-only is
 * excluded through the hint the dispatch recorded for the tool that ran.
 */
function isPrewalkImplementationAction(result: ToolResultMessage): boolean {
	if (!PREWALK_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;
	// A direct filesystem edit/write carries no `xd://` dispatch metadata.
	if (!details || typeof details !== "object" || !("xdev" in details) || !details.xdev) return true;
	const xdev = details.xdev;
	// Device dispatch: switch only on a genuine mutation tier. An absent tier
	// (help lookup, unresolved approval) declines the switch.
	if (typeof xdev !== "object" || !("tier" in xdev)) return false;
	if (xdev.tier !== "write" && xdev.tier !== "exec") return false;
	return !("readOnlyHint" in xdev && xdev.readOnlyHint === true);
}

/** Capabilities the prewalk coordinator borrows from its owning session. */
export interface PrewalkCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	restoreThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	resolveDefaultPrewalk(): Prewalk | undefined;
	/**
	 * Resolves `prewalk.autoSource` and `prewalk.autoTarget` through the model-role resolver and verifies a
	 * usable credential for both. Warns and resolves undefined when either cannot be used.
	 */
	resolveAutoPrewalk(signal: AbortSignal): Promise<AutoPrewalkSelection | undefined>;
	/** Snapshots configured and effective thinking (including an auto-resolved effort); the returned function restores it exactly. */
	captureThinking(): () => void;
	promptGeneration(): number;
	/** Judges the request about to run for `prewalk.auto`; resolves undefined when the judge role has no native backend. */
	classifyAutoPrewalk(request: string, signal: AbortSignal): Promise<AutoPrewalkDecision | undefined>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean; isCurrent?: () => boolean },
	): Promise<void>;
	setActiveToolsByName(names: string[]): Promise<void>;
	restoreNonMCPToolPresentation(nonMCPToolNames: string[], nonMCPMountedToolNames: string[]): Promise<void>;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	getMountedXdevToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	getPlanReferencePath(): string;
	setPlanProposalHandler(handler: PlanProposalHandler | null): void;
	waitForSessionMessagePersistence(message: AgentMessage): Promise<void>;
	localProtocolOptions(): LocalProtocolOptions;
}

/** Initial state for prewalk and plan-yolo startup flows. */
export interface PrewalkCoordinatorOptions {
	prewalk?: Prewalk;
	planYolo?: PlanYolo;
	/** Keep `prewalk.auto` away from this session until `/new` (`--no-prewalk`). */
	suppressAutoPrewalk?: boolean;
}

/** Planning source and one-way target `prewalk.auto` switches between. */
export interface AutoPrewalkSelection {
	source: { model: Model; thinkingLevel?: ConfiguredThinkingLevel };
	target: Prewalk;
}

/** Selection and arm ownership retained only until the prepared prompt is dispatched. */
interface AutoPrewalkTurn {
	generation: number;
	signal: AbortSignal;
	onAbort: () => void;
	arm?: Prewalk;
	planArm?: Prewalk;
	planMessage?: AgentMessage;
	restoreSelection?: () => Promise<void>;
	rollback?: Promise<void>;
}

/** The models around a completed handoff, kept to return to the planning model on `/new`. */
interface PrewalkHandoff {
	source: Model;
	sourceThinkingLevel: ConfiguredThinkingLevel | undefined;
	target: Model;
	targetThinkingLevel: ConfiguredThinkingLevel | undefined;
}

/** Coordinates one-way model prewalks and automatic plan-yolo handoffs. */

export type PrewalkRestartResult = "armed" | "reset" | "rejected";
export class PrewalkCoordinator {
	readonly #host: PrewalkCoordinatorHost;
	#prewalk: Prewalk | undefined;
	#planInjected = false;
	#continuePending = false;
	#todoSeen = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousNonMCPPresentation: { enabled: string[]; mounted: string[] } | undefined;
	#planYoloArmed = false;
	/** Session-local opt-out from auto-prewalk: `/prewalk off`, or `--no-prewalk` at startup. `/new` clears it. */
	#autoSuppressed: boolean;
	#handoff: PrewalkHandoff | undefined;
	#autoTurn: AutoPrewalkTurn | undefined;
	#selectionEpoch = 0;

	constructor(host: PrewalkCoordinatorHost, options: PrewalkCoordinatorOptions = {}) {
		this.#host = host;
		this.#prewalk = options.prewalk;
		this.#planYolo = options.planYolo;
		this.#autoSuppressed = options.suppressAutoPrewalk === true;
	}

	/** Current prewalk target, if the one-way switch remains armed. */
	get state(): Prewalk | undefined {
		return this.#prewalk;
	}

	/** Whether the armed prewalk would perform a model or thinking-level handoff. */
	get willHandoff(): boolean {
		const prewalk = this.#prewalk;
		return prewalk !== undefined && !this.#isNoop(prewalk);
	}

	#isNoop(prewalk: Prewalk): boolean {
		return prewalkWouldBeNoop(
			this.#host.model(),
			this.#host.configuredThinkingLevel(),
			prewalk.target,
			prewalk.thinkingLevel,
		);
	}

	#clearPrewalkState(): void {
		this.#prewalk = undefined;
		this.#planInjected = false;
		this.#continuePending = false;
		this.#todoSeen = false;
	}

	get selectionEpoch(): number {
		return this.#selectionEpoch;
	}

	/** A later model/effort selection owns the active model, even if its identity is unchanged. */
	releaseHandoff(): void {
		this.#handoff = undefined;
		this.#selectionEpoch++;
	}

	/** Retire the outgoing cycle and prepare a configured prewalk for a fresh main session. */
	async resetForNewSession(enabled: boolean): Promise<void> {
		const handoff = this.#handoff;
		const restoreSource = enabled && handoff !== undefined && this.#onHandoffTarget(handoff) ? handoff : undefined;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.releaseHandoff();
		this.#autoSuppressed = false;
		// Best-effort: /new has already committed the transcript switch, so an
		// unusable planning model must not abort the rest of session setup.
		if (restoreSource) await this.#restoreSource(restoreSource);
		if (!enabled) return;
		const prewalk = this.#host.resolveDefaultPrewalk();
		if (!prewalk) return;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		// Like startup, inject guidance at the first completed turn, not into an empty transcript.
		this.#prewalk = prewalk;
	}

	#disarmNoop(prewalk: Prewalk): void {
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: target ${prewalk.target.provider}/${prewalk.target.id} already matches the active model and thinking level; nothing to switch.`,
			"prewalk",
		);
	}

	/** Whether the session still sits on the model and effort `handoff` switched to. */
	#onHandoffTarget(handoff: PrewalkHandoff): boolean {
		const current = this.#host.model();
		return (
			current?.provider === handoff.target.provider &&
			current?.id === handoff.target.id &&
			this.#host.configuredThinkingLevel() === handoff.targetThinkingLevel
		);
	}

	/** Returns to `handoff`'s planning model and effort. Best-effort: an unusable planning model must not abort the caller. */
	async #restoreSource(handoff: PrewalkHandoff): Promise<boolean> {
		try {
			await this.#host.setModelTemporary(handoff.source, handoff.sourceThinkingLevel, { ephemeral: true });
			// Temporary selection treats undefined as "keep/default"; restoration must preserve
			// the original selector, including auto or an explicitly inherited effort.
			this.#host.restoreThinkingLevel(handoff.sourceThinkingLevel);
			return true;
		} catch (error) {
			this.#host.emitNotice(
				"warning",
				`Prewalk: could not restore ${handoff.source.provider}/${handoff.source.id}: ${error instanceof Error ? error.message : String(error)}`,
				"prewalk",
			);
			return false;
		}
	}

	/** Dispatch transfers the automatic selection and arm from prompt setup to the running turn. */
	commitAuto(generation: number, signal?: AbortSignal): AgentMessage | undefined {
		if (this.#autoTurn?.generation === generation && (!signal || this.#autoTurn.signal === signal)) {
			const turn = this.#autoTurn;
			turn.signal.removeEventListener("abort", turn.onAbort);
			this.#autoTurn = undefined;
			return turn.planArm && turn.planArm === this.#prewalk ? turn.planMessage : undefined;
		}
	}

	/** Preparation and dispatch must not overtake an abandoned claim's source restoration. */
	get autoRollback(): Promise<void> | undefined {
		return this.#autoTurn?.rollback;
	}

	/** Drop only this prompt's auto mutation; explicit selections and replacement arms keep ownership. */
	async rollbackAuto(generation: number, signal?: AbortSignal): Promise<void> {
		const turn = this.#autoTurn;
		if (!turn || turn.generation !== generation || (signal && turn.signal !== signal)) return;
		return (turn.rollback ??= this.#rollbackAutoTurn(turn));
	}

	async #rollbackAutoTurn(turn: AutoPrewalkTurn): Promise<void> {
		try {
			if (turn.arm && this.#prewalk === turn.arm) {
				this.#scrubPlanNudge(undefined, true);
				this.#clearPrewalkState();
			}
			await turn.restoreSelection?.();
			if (turn.planArm && turn.planArm === this.#prewalk && turn.planMessage) {
				this.#host.agent.steer(turn.planMessage);
			}
		} finally {
			turn.signal.removeEventListener("abort", turn.onAbort);
			if (this.#autoTurn === turn) this.#autoTurn = undefined;
		}
	}

	/** `/prewalk off`: keep auto-prewalk out of this session until `/new`. */
	suppressAuto(): void {
		this.#autoSuppressed = true;
	}

	/**
	 * Auto-prewalk leaves this turn alone: an arm already exists (manual, configured, or its own — all
	 * authoritative), the session opted out, or plan mode owns the turn (a plan-file write would trip the handoff).
	 */
	#autoBlocked(): boolean {
		return this.#autoSuppressed || this.#prewalk !== undefined || this.#host.getPlanModeState()?.enabled === true;
	}

	/** Eligible queued steering must wait until the next provider-call boundary. */
	needsAutoRouting(): boolean {
		return cfgPrewalkAuto.get(this.#host.settings) !== "off" && !this.#autoBlocked();
	}

	/**
	 * Auto-prewalk: classify the expanded request about to run. In `on`, a confident
	 * prewalk switches to the planning source and arms the target; `suggest` only reports the decision, and
	 * every other outcome leaves model, effort, and arm alone. Fails open and quiet: no decision means nothing
	 * changes, and a classification the prompt outlived is dropped.
	 * @returns whether the active model changed, so the caller can rebuild model-dependent prompt state.
	 */
	async applyAuto(
		request: string,
		generation: number,
		signal: AbortSignal,
		selectionEpoch = this.#selectionEpoch,
	): Promise<boolean> {
		if (this.#autoTurn && this.#autoTurn.signal !== signal) {
			await this.rollbackAuto(this.#autoTurn.generation, this.#autoTurn.signal);
		}
		const mode = cfgPrewalkAuto.get(this.#host.settings);
		if (signal.aborted || selectionEpoch !== this.#selectionEpoch || mode === "off" || this.#autoBlocked())
			return false;
		try {
			const decision = await this.#host.classifyAutoPrewalk(request, signal);
			if (
				!decision ||
				signal.aborted ||
				selectionEpoch !== this.#selectionEpoch ||
				this.#host.promptGeneration() !== generation ||
				this.#autoBlocked()
			)
				return false;
			if (mode === "on" && decision.arm) return await this.#switchAndArm(generation, signal, selectionEpoch);
			const chance = decision.probabilities.prewalk.toFixed(2);
			const summary =
				decision.route !== "prewalk"
					? `${decision.route} (prewalk ${chance})`
					: decision.arm
						? `prewalk ${chance}`
						: `prewalk ${chance} (below threshold)`;
			this.#host.emitNotice("info", `Auto-prewalk: ${summary}`, "prewalk");
		} catch (error) {
			logger.debug("auto-prewalk: skipped after a failure", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return false;
	}

	/**
	 * Both selectors resolve and authenticate before anything moves. Then the planning source becomes active and
	 * the target arms; if either step cannot proceed, model and thinking return exactly to what they were.
	 */
	async #switchAndArm(generation: number, signal: AbortSignal, selectionEpoch: number): Promise<boolean> {
		const selection = await this.#host.resolveAutoPrewalk(signal);
		if (
			!selection ||
			signal.aborted ||
			selectionEpoch !== this.#selectionEpoch ||
			this.#host.promptGeneration() !== generation ||
			this.#autoBlocked()
		)
			return false;
		const { source, target } = selection;
		const previous = this.#host.model();
		const previousConfigured = this.#host.configuredThinkingLevel();
		const restoreThinking = this.#host.captureThinking();
		const switching =
			previous?.provider !== source.model.provider ||
			previous?.id !== source.model.id ||
			source.thinkingLevel !== undefined;
		const turn: AutoPrewalkTurn = {
			generation,
			signal,
			onAbort: () => {
				void this.rollbackAuto(generation, signal);
			},
		};
		const ownsSelection = () => this.#autoTurn === turn && this.#selectionEpoch === selectionEpoch;
		turn.restoreSelection = async () => {
			if (!ownsSelection()) return;
			if (!switching || !previous) {
				restoreThinking();
				return;
			}
			try {
				await this.#host.setModelTemporary(previous, previousConfigured, {
					ephemeral: true,
					isCurrent: ownsSelection,
				});
				if (ownsSelection()) restoreThinking();
			} catch (error) {
				this.#host.emitNotice(
					"warning",
					`Auto-prewalk: could not restore ${previous.provider}/${previous.id}: ${error instanceof Error ? error.message : String(error)}`,
					"prewalk",
				);
			}
		};
		this.#autoTurn = turn;
		signal.addEventListener("abort", turn.onAbort, { once: true });
		let armed = false;
		try {
			if (switching) {
				await this.#host.setModelTemporary(source.model, source.thinkingLevel, {
					ephemeral: true,
					isCurrent: () => ownsSelection() && !signal.aborted && this.#host.promptGeneration() === generation,
				});
			}
			if (
				ownsSelection() &&
				!signal.aborted &&
				this.#host.promptGeneration() === generation &&
				!this.#autoBlocked()
			) {
				armed = this.#arm(target.target, target.thinkingLevel, turn);
			}
		} catch (error) {
			this.#host.emitNotice(
				"warning",
				`Auto-prewalk: could not switch to ${source.model.provider}/${source.model.id}: ${error instanceof Error ? error.message : String(error)}`,
				"prewalk",
			);
		}
		if (armed) {
			if (switching) {
				this.#host.emitNotice(
					"info",
					`Auto-prewalk: planning on ${source.model.provider}/${source.model.id} for this task.`,
					"prewalk",
				);
			}
			return switching;
		}
		await this.rollbackAuto(generation, signal);
		return false;
	}

	/** Advances the one-way prewalk switch at a completed assistant-turn boundary. */
	async advanceAtTurnEnd(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;
		if (this.#isNoop(prewalk)) {
			this.#scrubPlanNudge(liveMessages);
			this.#disarmNoop(prewalk);
			return;
		}
		if (context.toolResults.some(result => result.toolName === "todo" && !result.isError)) this.#todoSeen = true;

		const hasToolResults = context.toolResults.length > 0;
		if (this.#planInjected && hasToolResults) {
			this.#continuePending = true;
		} else if (this.#continuePending) {
			this.#continuePending = false;
			this.#host.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: prewalkContinuePrompt,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		const todoGateOpen = this.#todoSeen || !this.#host.getActiveToolNames().includes("todo");
		const action = todoGateOpen
			? context.toolResults.find(result => isPrewalkImplementationAction(result))
			: undefined;
		if (!action) {
			if (!this.#planInjected) {
				this.#planInjected = true;
				this.#continuePending = true;
				this.#host.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: prewalkPlanPrompt,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				this.#host.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await this.#host.waitForSessionMessagePersistence(context.message);
		for (const toolResult of context.toolResults) {
			await this.#host.waitForSessionMessagePersistence(toolResult);
		}
		this.#scrubPlanNudge(liveMessages);
		const target = prewalk.target;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		const source = this.#host.model();
		const sourceThinkingLevel = this.#host.configuredThinkingLevel();
		await this.#host.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#clearPrewalkState();
		if (source) {
			this.#handoff = {
				source,
				sourceThinkingLevel,
				target,
				targetThinkingLevel: this.#host.configuredThinkingLevel(),
			};
		}
		this.#host.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: prewalkChecklistPrompt,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	/** Drops a pending prewalk hand-off (e.g. `prewalk.enabled` turned off); no-op when none is armed. */
	disarm(): void {
		const active = this.#prewalk;
		if (!active) return;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: disarmed; staying on the active model instead of switching to ${active.target.provider}/${active.target.id}.`,
			"prewalk",
		);
	}

	/** Arms a prewalk immediately. */
	arm(target: Model, thinkingLevel?: ConfiguredThinkingLevel): boolean {
		return this.#arm(target, thinkingLevel);
	}

	#arm(target: Model, thinkingLevel?: ConfiguredThinkingLevel, autoTurn?: AutoPrewalkTurn): boolean {
		const active = this.#prewalk;
		if (active) {
			this.#host.emitNotice(
				"info",
				`Prewalk: already armed for ${active.target.provider}/${active.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			const matches =
				active.target.provider === target.provider &&
				active.target.id === target.id &&
				active.thinkingLevel === thinkingLevel;
			if (matches && this.#autoTurn?.arm === active) this.#autoTurn.arm = undefined;
			return matches;
		}
		const candidate = { target, thinkingLevel };
		if (this.#isNoop(candidate)) {
			this.#disarmNoop(candidate);
			return false;
		}
		this.#prewalk = candidate;
		if (autoTurn) autoTurn.arm = candidate;
		this.#planInjected = true;
		this.#continuePending = true;
		this.#todoSeen = false;
		const planMessage: AgentMessage = {
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: prewalkPlanPrompt,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		// A queued claim may be preparing after the loop's steering drain; deliver its nudge with its commit.
		const planTurn = autoTurn ?? this.#autoTurn;
		if (planTurn) {
			planTurn.planArm = candidate;
			planTurn.planMessage = planMessage;
		} else {
			this.#host.agent.steer(planMessage);
		}
		this.#host.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
		return true;
	}

	/**
	 * Restores the planning model and reuses or creates the requested one-shot handoff.
	 * A different active arm rejects the restart before the current model changes.
	 */
	async restart(
		source: Model,
		sourceThinkingLevel: ConfiguredThinkingLevel | undefined,
		target: Model,
		targetThinkingLevel: ConfiguredThinkingLevel | undefined,
	): Promise<PrewalkRestartResult> {
		const active = this.#prewalk;
		if (
			active &&
			(active.target.provider !== target.provider ||
				active.target.id !== target.id ||
				active.thinkingLevel !== targetThinkingLevel)
		) {
			this.arm(target, targetThinkingLevel);
			return "rejected";
		}

		await this.#host.setModelTemporary(source, sourceThinkingLevel, { ephemeral: true });
		this.releaseHandoff();
		if (active && this.#autoTurn?.arm === active) this.#autoTurn.arm = undefined;
		if (!active) return this.arm(target, targetThinkingLevel) ? "armed" : "reset";
		if (this.#isNoop(active)) {
			this.#scrubPlanNudge();
			this.#disarmNoop(active);
			return "reset";
		}
		return "armed";
	}

	/** Lazily enables plan-yolo's plan phase before the first prompt is built. */
	async armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousEnabledTools = this.#host.getEnabledToolNames();
		const previousMountedTools = this.#host.getMountedXdevToolNames();
		const previousPlanModeState = this.#host.getPlanModeState();
		const planModeState: PlanModeState = {
			enabled: true,
			planFilePath: this.#host.getPlanReferencePath() || "local://PLAN.md",
			workflow: "parallel",
		};
		// PlanYolo's injected write is a plan transport, not a user grant. Publish
		// plan mode before applying the tool set so SessionTools keeps an existing
		// device-only write restricted.
		this.#host.setPlanModeState(planModeState);
		// Only the built-in write carries the xd:// propose transport. A shadowing
		// extension `write` would answer every proposal as a file write and the plan
		// phase would never end (#14030), so it is left out of the plan tool set.
		const planTools = this.#host.hasBuiltInTool("write")
			? [...previousEnabledTools, "write"]
			: previousEnabledTools.filter(name => name !== "write");
		try {
			await this.#host.setActiveToolsByName([...new Set(planTools)]);
		} catch (error) {
			this.#host.setPlanModeState(previousPlanModeState);
			this.#planYoloArmed = false;
			throw error;
		}
		this.#planYoloPreviousNonMCPPresentation = {
			enabled: previousEnabledTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		};
		this.#host.setPlanProposalHandler(title => this.#finalizePlanYoloProposal(title));
	}

	#scrubPlanNudge(liveMessages?: AgentMessage[], includeContinuation = false): void {
		if (liveMessages) {
			for (let index = liveMessages.length - 1; index >= 0; index--) {
				if (!isPrewalkPlanNudge(liveMessages[index])) continue;
				invalidateMessageCache(liveMessages[index]);
				liveMessages.splice(index, 1);
			}
		}
		const stateMessages = this.#host.agent.state.messages;
		const filtered = stateMessages.filter(message => !isPrewalkPlanNudge(message));
		if (filtered.length !== stateMessages.length) this.#host.agent.replaceMessages(filtered);
		// Delivered continuations are persisted history; only pending ones can be canceled.
		const isPendingNudge = (message: AgentMessage): boolean =>
			isPrewalkPlanNudge(message) ||
			(includeContinuation && message.role === "custom" && message.customType === PREWALK_CONTINUE_MESSAGE_TYPE);
		const steering = this.#host.agent.peekSteeringQueue();
		if (steering.some(isPendingNudge)) {
			this.#host.agent.replaceQueue(
				"steering",
				steering.filter(message => !isPendingNudge(message)),
			);
		}
	}

	async #finalizePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		const planYolo = this.#planYolo;
		const state = this.#host.getPlanModeState();
		if (!planYolo || !state?.enabled) throw new ToolError("Plan mode is not active.");
		const {
			planFilePath,
			planContent,
			title: resolvedTitle,
		} = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url =>
				readPlanFile(url, {
					localProtocolOptions: this.#host.localProtocolOptions(),
					cwd: this.#host.sessionManager.getCwd(),
				}),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: this.#host.localProtocolOptions() }),
		});
		let autosavedPlan: string | null = null;
		try {
			autosavedPlan = await autosaveApprovedPlan({
				settings: this.#host.settings,
				cwd: this.#host.sessionManager.getCwd(),
				title: resolvedTitle,
				planContent,
			});
			if (autosavedPlan) {
				const displayPath = truncateToWidth(replaceTabs(shortenPath(autosavedPlan)), TRUNCATE_LENGTHS.CONTENT);
				this.#host.emitNotice("info", `Plan autosaved to ${displayPath}.`, "plan-yolo");
			}
		} catch (error) {
			logger.warn("Failed to autosave approved plan", { error });
			const detail = truncateToWidth(
				shortenEmbeddedPaths(
					replaceTabs(error instanceof Error ? error.message : String(error))
						.replace(/[\r\n]+/g, " ")
						.trim(),
				),
				TRUNCATE_LENGTHS.CONTENT,
			);
			this.#host.emitNotice(
				"warning",
				`Plan autosave failed: ${detail} Continuing with implementation.`,
				"plan-yolo",
			);
		}
		this.#host.setPlanModeState(undefined);
		const previousPresentation = this.#planYoloPreviousNonMCPPresentation;
		try {
			if (previousPresentation) {
				await this.#host.restoreNonMCPToolPresentation(previousPresentation.enabled, previousPresentation.mounted);
			}
		} catch (error) {
			this.#host.setPlanModeState(state);
			throw error;
		}
		this.#host.setPlanProposalHandler(null);
		this.#planYolo = undefined;
		this.#planYoloPreviousNonMCPPresentation = undefined;
		await this.#host.setModelTemporary(planYolo.target, planYolo.thinkingLevel, { ephemeral: true });
		this.#host.emitNotice(
			"info",
			`Plan-yolo: plan approved, switched to ${planYolo.target.provider}/${planYolo.target.id} to implement "${resolvedTitle}".`,
			"plan-yolo",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
			content: prompt.render(planYoloHandoffPrompt, { planFilePath, title: resolvedTitle }),
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
		return {
			content: [{ type: "text", text: `Plan approved. Implementing now with ${planYolo.target.id}.` }],
			details: { planFilePath, title: resolvedTitle, planExists: true },
		};
	}
}
