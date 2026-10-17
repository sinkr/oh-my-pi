import type { ExtensionModeControls, ModeResult, ModeSnapshot, SessionModeName } from "./mode-api";

/**
 * Typed lifecycle rejection: thrown inside a mode transition and surfaced as
 * the corresponding {@link ModeResult} failure, replacing sentinel-prefixed
 * error messages.
 */
export class ModeRequestError extends Error {
	constructor(
		readonly code: Extract<ModeResult, { ok: false }>["code"],
		message: string,
		readonly conflictingMode?: SessionModeName,
	) {
		super(message);
	}
}

/**
 * Change-detection key for {@link ModeSnapshot}: mode-level fields only.
 * Goal accounting (`tokensUsed`, `timeUsedSeconds`, `updatedAt`) mutates on
 * every tool completion and would otherwise fire `mode_changed` per tick.
 * The snapshot payload still carries the fresh counters for `getState()`
 * callers — only the dedup key ignores them.
 */
export function modeChangeKey(snapshot: Omit<ModeSnapshot, "revision">): string {
	const goal = snapshot.goal.state;
	const normalized = {
		...snapshot,
		goal: {
			...snapshot.goal,
			state: goal
				? {
						...goal,
						goal: {
							...goal.goal,
							tokensUsed: 0,
							timeUsedSeconds: 0,
							updatedAt: 0,
						},
					}
				: undefined,
		},
	};
	return JSON.stringify(normalized);
}

/** Unbound extension hosts expose no operations rather than reporting successful no-ops. */
export function unsupportedModeControls(sessionId: () => string): ExtensionModeControls {
	const getState = (): ModeSnapshot => ({
		sessionId: sessionId(),
		revision: 0,
		plan: { status: "inactive" },
		vibe: { status: "inactive" },
		goal: { status: "inactive" },
		loop: { status: "inactive" },
		capabilities: { plan: [], vibe: [], goal: [], loop: [] },
	});
	return {
		getState,
		set: async request => ({
			ok: false,
			code: "unsupported",
			message: `This host has no ${request.mode} lifecycle controller.`,
			state: getState(),
		}),
	};
}
