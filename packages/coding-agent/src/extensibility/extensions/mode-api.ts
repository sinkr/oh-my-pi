import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import type { GoalModeState } from "../../goals/state";
import type { LoopLimitConfig } from "../../modes/loop-limit";

export type SessionModeName = "plan" | "vibe" | "goal" | "loop";
export type ModeOperation = "enter" | "exit" | "pause" | "resume" | "replace" | "drop" | "budget" | "configure";

export type ModeRequest =
	| { mode: "plan"; action: "enter" | "resume"; workflow?: "parallel" | "iterative" }
	| { mode: "plan"; action: "exit" }
	| { mode: "plan"; action: "pause" }
	| { mode: "vibe"; action: "enter" | "exit" }
	| { mode: "goal"; action: "enter" | "replace"; objective: string; tokenBudget?: number }
	| { mode: "goal"; action: "exit" | "pause" | "resume" | "drop" }
	| { mode: "goal"; action: "budget"; tokenBudget: number | null }
	| {
			mode: "loop";
			action: "enter" | "configure";
			limit?: LoopLimitConfig | null;
			condition?: LoopConditionConfig | null;
			strategy?: "prompt" | "compact" | "reset";
	  }
	| { mode: "loop"; action: "exit" }
	| { mode: "loop"; action: "pause" }
	| { mode: "loop"; action: "resume" };

export interface ModeSnapshot {
	sessionId: string;
	revision: number;
	plan: { status: "inactive" | "active" | "paused"; planFilePath?: string; workflow?: "parallel" | "iterative" };
	vibe: { status: "inactive" | "active" };
	goal: { status: "inactive" | "active" | "paused"; state?: GoalModeState };
	loop: {
		status: "inactive" | "active" | "paused";
		prompt?: string;
		limit?: LoopLimitRuntime;
		condition?: LoopConditionConfig;
		strategy?: "prompt" | "compact" | "reset";
	};
	/** Operations actually implemented by this host, independent of settings gates. */
	capabilities: Record<SessionModeName, readonly ModeOperation[]>;
}

export type ModeResult =
	| { ok: true; changed: boolean; state: ModeSnapshot }
	| {
			ok: false;
			code: "conflict" | "disabled" | "invalid_request" | "unsupported" | "busy" | "session_changed" | "failed";
			message: string;
			state: ModeSnapshot;
			conflictingMode?: SessionModeName;
	  };

export interface ExtensionModeControls {
	/** Detached current state, also available to late-loaded extensions. */
	getState(): ModeSnapshot;
	/** Explicit idempotent transition; never submits a user prompt or opens a dialog. */
	set(request: ModeRequest): Promise<ModeResult>;
}

export interface ModeChangedEvent {
	type: "mode_changed";
	previous: ModeSnapshot;
	state: ModeSnapshot;
}
