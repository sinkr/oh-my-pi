import type { ExtensionUIContext } from "./types";

/** Runs a dialog that waits for the user's answer, so its session can treat the time as the user's, not the agent's. */
export type UserWaitTracker = <T>(dialog: () => Promise<T>) => Promise<T>;

/** The {@link ExtensionUIContext} methods that wait for the user's answer. */
const DIALOGS: Record<string, true> = {
	select: true,
	confirm: true,
	input: true,
	editor: true,
	custom: true,
	askDialog: true,
	approve: true,
};

/** `ui` with each dialog run through `track`; every other member passes through. */
export function trackUserWaits(ui: ExtensionUIContext, track: UserWaitTracker): ExtensionUIContext {
	const methods = new Map<PropertyKey, unknown>();
	return new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			let method = methods.get(property);
			if (!method) {
				method = Object.hasOwn(DIALOGS, property)
					? (...args: unknown[]) => track(() => value.apply(target, args))
					: value.bind(target);
				methods.set(property, method);
			}
			return method;
		},
	});
}
