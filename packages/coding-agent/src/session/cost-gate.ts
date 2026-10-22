export interface CostGateController {
	warnCost?: number;
	maxCost?: number;
	/** One-time warn flag, shared across the whole session tree. */
	warned: boolean;
	/**
	 * Live cumulative cost across the whole session tree. Every session in
	 * the tree registers its own stats source, so a running child session's
	 * completed turns count immediately instead of only after the parent
	 * rolls them up on task write-back (#7978 review).
	 */
	getCost?: () => number;
	/** Register a session's live stats source (idempotent per session). */
	addCostSource?(source: () => number): void;
	/** Drop a session's source once its spend is rolled into a parent. */
	removeCostSource?(source: () => number): void;
}

export class CostCapExceededError extends Error {
	constructor(public readonly cap: number) {
		super(`Cost cap reached ($${cap.toFixed(2)}). Raise session.maxCost or remove --max-cost to continue.`);
		this.name = "CostCapExceededError";
	}
}

export function createCostGateController(options: { warnCost?: number; maxCost?: number }): CostGateController {
	const sources = new Set<() => number>();
	// Lazily installed: until the first source registers, getCost stays
	// undefined so applyCostGate still binds a caller-supplied getter.
	const aggregate = (): number => {
		let total = 0;
		for (const source of sources) total += source();
		return total;
	};
	const controller: CostGateController = {
		warnCost: options.warnCost,
		maxCost: options.maxCost,
		warned: false,
		getCost: undefined,
		addCostSource: source => {
			sources.add(source);
			controller.getCost = aggregate;
		},
		removeCostSource: source => {
			sources.delete(source);
			controller.getCost = sources.size > 0 ? aggregate : undefined;
		},
	};
	return controller;
}

export type CostGateDecision = "ok" | "warn" | "cap";

export function evaluateCostGate(controller: CostGateController, cost: number): CostGateDecision {
	if (controller.maxCost !== undefined && cost >= controller.maxCost) return "cap";
	if (controller.warnCost !== undefined && cost >= controller.warnCost && !controller.warned) {
		controller.warned = true;
		return "warn";
	}
	return "ok";
}

export function applyCostGate<T>(
	gate: CostGateController,
	getCost: () => number,
	onWarn: (message: string) => void,
	dispatch: () => T,
): T {
	gate.getCost ??= getCost;
	const cost = gate.getCost();
	const decision = evaluateCostGate(gate, cost);
	if (decision === "cap") {
		throw new CostCapExceededError(gate.maxCost!);
	}
	if (decision === "warn") {
		onWarn(
			`Cost warning: cumulative session cost $${cost.toFixed(2)} reached the warn threshold ($${gate.warnCost!.toFixed(2)}).`,
		);
	}
	return dispatch();
}

// A negative or non-finite threshold can never be crossed by a cumulative
// cost, so it most likely means a misconfigured settings value; treat it as
// unset rather than enforcing a broken contract.
function normalizeThreshold(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveCostGate(
	flags: { warnCost?: number; maxCost?: number },
	configured: { warnCost?: number; maxCost?: number },
): CostGateController | undefined {
	const warnCost = normalizeThreshold(flags.warnCost ?? configured.warnCost);
	const maxCost = normalizeThreshold(flags.maxCost ?? configured.maxCost);
	if (warnCost === undefined && maxCost === undefined) return undefined;
	return createCostGateController({ warnCost, maxCost });
}
