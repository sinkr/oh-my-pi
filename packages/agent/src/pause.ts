/**
 * Process-global pause gate for agent loops.
 *
 * Every agent in a process — main session, in-process subagents, advisor —
 * funnels through {@link ../agent-loop!agentLoop}, which polls this gate at its
 * two action boundaries: before each model call and before each tool call
 * starts. Engaging the gate therefore freezes all of them at the next safe
 * point without aborting anything: in-flight provider streams and
 * already-started tool executions run to completion, then every loop parks
 * until {@link AgentPauseGate.resume}. Queued steering/follow-up messages stay
 * queued and deliver normally after resume.
 *
 * A run's own `AbortSignal` still unwinds a parked loop immediately: the park
 * releases on abort (without releasing the gate), so cancelling one run never
 * requires resuming the whole process.
 *
 * Hosts drive the singleton {@link agentPauseGate} (e.g. the TUI `/pause`
 * command); library code only ever reads it.
 */

/** Listener invoked with the new state on every pause/resume transition. */
export type AgentPauseListener = (paused: boolean) => void;

/** Freeze switch shared by every agent loop in the process. See module docs. */
export class AgentPauseGate {
	/** Pending while paused; resolved and cleared on resume. */
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();
	#turns = new Set<AgentPauseTurn>();

	/** True while the gate is engaged. */
	get paused(): boolean {
		return this.#gate !== undefined;
	}

	/** Epoch ms when the current pause began; undefined when running. */
	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	/**
	 * Number of process-wide loops with work not yet parked at the pause gate.
	 * While running, every registered loop is unsettled; while paused, only
	 * loops with active provider, tool, or speculative work (including hooks
	 * and preparation) are counted.
	 */
	get unsettledTurnCount(): number {
		if (!this.#gate) return this.#turns.size;
		let count = 0;
		for (const turn of this.#turns) {
			if (turn.hasActiveWork) count++;
		}
		return count;
	}

	/** @internal Register one full agent-loop lifecycle, including replay and error tails. */
	beginTurn(): AgentPauseTurn {
		const turn = new AgentPauseTurn(
			signal => this.waitUntilResumed(signal),
			() => this.paused,
			() => this.#turns.delete(turn),
		);
		this.#turns.add(turn);
		return turn;
	}

	/** Engage the gate. Returns false (and does nothing) when already paused. */
	pause(): boolean {
		if (this.#gate) return false;
		this.#gate = Promise.withResolvers<void>();
		this.#pausedAt = Date.now();
		this.#notify(true);
		return true;
	}

	/**
	 * Release the gate, waking every parked loop. Returns the pause duration in
	 * ms, or undefined when the gate was not engaged.
	 */
	resume(): number | undefined {
		const gate = this.#gate;
		if (!gate) return undefined;
		this.#gate = undefined;
		gate.resolve();
		this.#notify(false);
		return Date.now() - this.#pausedAt;
	}

	/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Park until the gate is released. Resolves immediately when not paused.
	 * An abort on `signal` releases only this wait — the gate stays engaged —
	 * so a cancelled run unwinds while the rest of the process stays frozen.
	 */
	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		// Loop: resume() swaps the gate promise, so a pause re-engaged while a
		// waiter is between awaits must re-park instead of slipping through.
		while (this.#gate) {
			if (signal?.aborted) return;
			const gate = this.#gate.promise;
			if (!signal) {
				await gate;
				continue;
			}
			const abort = Promise.withResolvers<void>();
			const onAbort = () => abort.resolve();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await Promise.race([gate, abort.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	#notify(paused: boolean): void {
		for (const listener of this.#listeners) {
			try {
				listener(paused);
			} catch {
				// Host UI listeners must never break the gate.
			}
		}
	}
}

/** One loop's active provider/tool work plus its retained participant leases. */
class AgentPauseTurn {
	#activeParticipants = 1;
	#participantCount = 1;
	#rootActive = true;
	#rootRegistered = true;
	#finished = false;
	#released = false;
	#waitForGate: (signal?: AbortSignal) => Promise<void>;
	#isPaused: () => boolean;
	#onFinish: () => void;

	constructor(waitForGate: (signal?: AbortSignal) => Promise<void>, isPaused: () => boolean, onFinish: () => void) {
		this.#waitForGate = waitForGate;
		this.#isPaused = isPaused;
		this.#onFinish = onFinish;
	}

	get hasActiveWork(): boolean {
		return this.#activeParticipants > 0;
	}

	/** Park the loop's orchestration participant at its next safe boundary. */
	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		await this.#waitAsParticipant(
			() => this.#setRootActive(false),
			() => this.#setRootActive(true),
			signal,
		);
	}

	/**
	 * Mark the loop's orchestration participant as waiting while tool tasks run.
	 * Its tool tasks have separate participants, so one parked tool cannot mask
	 * a sibling that is still executing.
	 */
	suspendRoot(): () => void {
		this.#setRootActive(false);
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.#setRootActive(true);
		};
	}

	/** Run tracked work as a participant in this turn. */
	async withParticipant<T>(
		work: (waitUntilResumed: (signal?: AbortSignal) => Promise<void>) => Promise<T>,
	): Promise<T> {
		if (this.#released) throw new Error("Cannot add work to a released agent pause turn");
		this.#participantCount++;
		this.#activeParticipants++;
		let active = true;
		const setActive = (value: boolean): void => {
			if (active === value) return;
			active = value;
			this.#activeParticipants += value ? 1 : -1;
		};
		try {
			return await work(signal =>
				this.#waitAsParticipant(
					() => setActive(false),
					() => setActive(true),
					signal,
				),
			);
		} finally {
			if (active) this.#activeParticipants--;
			this.#participantCount--;
			this.#releaseIfSettled();
		}
	}

	/** End the loop root; outstanding physical work keeps its turn registered. */
	finish(): void {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#rootRegistered) {
			if (this.#rootActive) this.#activeParticipants--;
			this.#rootActive = false;
			this.#rootRegistered = false;
			this.#participantCount--;
		}
		this.#releaseIfSettled();
	}

	async #waitAsParticipant(park: () => void, unpark: () => void, signal?: AbortSignal): Promise<void> {
		while (this.#isPaused()) {
			park();
			try {
				await this.#waitForGate(signal);
			} finally {
				// Abort releases the wait but not the gate. Reactivate briefly while
				// the loop runs its abort/error cleanup; finish() releases the turn
				// after every tracked participant has settled.
				unpark();
			}
			if (signal?.aborted) return;
		}
	}

	#setRootActive(active: boolean): void {
		if (!this.#rootRegistered || this.#rootActive === active) return;
		this.#rootActive = active;
		this.#activeParticipants += active ? 1 : -1;
	}

	#releaseIfSettled(): void {
		if (!this.#finished || this.#participantCount !== 0 || this.#released) return;
		this.#released = true;
		this.#onFinish();
	}
}

/** The process-wide gate polled by the agent loop. */
export const agentPauseGate = new AgentPauseGate();
