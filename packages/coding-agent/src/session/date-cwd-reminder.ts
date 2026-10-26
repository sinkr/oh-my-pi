/**
 * Date/cwd reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). The per-request date/cwd line used to live at the tail of the
 * system prompt (`project-prompt.md`), which invalidated the whole tool array
 * on every directory change or day rollover. It now rides on the first user
 * turn of each provider request instead: built at request time (never stored
 * in the session), deterministic per `(date, cwd)`, so the bytes are stable
 * for the lifetime of a session/day and refresh automatically at midnight.
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };

/** Renders the reminder text for the given local calendar date and cwd. */
export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}

function messageStartsWithReminder(message: UserMessage, reminder: string): boolean {
	if (typeof message.content === "string") return message.content.startsWith(reminder);
	return message.content[0]?.type === "text" && message.content[0].text === reminder;
}

function injectReminder(message: UserMessage, reminder: string): UserMessage {
	const content: UserMessage["content"] =
		typeof message.content === "string"
			? `${reminder}\n\n${message.content}`
			: [{ type: "text", text: reminder }, ...message.content];
	return { ...message, content };
}

/** Developer turns the injector inserted; every other output message maps to an input one. */
const reminderControls = new WeakSet<Message>();

/** Whether `message` is a developer turn a {@link DateCwdReminderInjector} inserted. */
export function isDateCwdReminderControl(message: Message): boolean {
	return reminderControls.has(message);
}

/** Trailing `#n` that tells apart turns of one request that would otherwise share a key. */
const ORDINAL_SUFFIX = /#(\d+)$/;

/** A reminder already sent with one user turn, and the copy carrying it. */
interface Injection {
	reminder: string;
	source: UserMessage;
	injected: UserMessage;
}

/** A developer reminder and the key of the turn it was placed after. */
interface AnchoredControl {
	anchor: string;
	message: Message;
}

/** Everything the injector remembers about one conversation. */
interface RootState {
	/** The reminder the conversation was last sent. */
	reminder: string | undefined;
	injections: Map<string, Injection>;
	controls: AnchoredControl[];
	seen: Set<string>;
	/** How many turns of the previous request shared each key, before ordinals. */
	counts: Map<string, number>;
}

/**
 * How many conversations the injector keeps state for. A session interleaves its
 * own requests with its advisors', which carry their own history, and each
 * compaction starts another conversation; the oldest is forgotten first.
 */
const MAX_ROOTS = 8;

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical.
 *
 * Turns are recognised by a key, not by object identity: context hooks, secret
 * obfuscation and conversion-cache resets hand the injector equal but newly
 * allocated messages on every request, and an identity miss on the first user
 * turn would read as a new conversation and rewrite the reminder that turn was
 * first sent with. The key leaves content out, so a turn whose content a later
 * request rewrites (a newly redacted secret, a clamped image) stays the same turn.
 *
 * One session sends more than one conversation through the same injector: an
 * advisor shares the main loop's provider transform and carries its own
 * history. State is therefore held per conversation root, so a request for one
 * conversation leaves the reminders of the others alone.
 */
export class DateCwdReminderInjector {
	#states = new Map<string, RootState>();
	/** The root of the most recent request. */
	#active: string | undefined;

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	/**
	 * One key per turn, equal for every copy of it: role, timestamp and, for user
	 * and developer turns, attribution (the identity session persistence uses),
	 * plus an ordinal for the second and later turns that would otherwise share a key.
	 */
	#keysOf(messages: Message[]): { keys: string[]; counts: Map<string, number> } {
		const counts = new Map<string, number>();
		const keys = messages.map(message => {
			const key =
				message.role === "user" || message.role === "developer"
					? `${message.role}:${message.timestamp}:${message.attribution ?? ""}`
					: `${message.role}:${message.timestamp}`;
			const count = counts.get(key) ?? 0;
			counts.set(key, count + 1);
			return count === 0 ? key : `${key}#${count}`;
		});
		return { keys, counts };
	}

	/**
	 * Move a conversation's state to the ordinals its turns hold now, for the keys
	 * that fewer turns share than in its previous request.
	 *
	 * With a new first turn the history lost its start (a compaction), so every
	 * survivor's ordinal falls by the number of turns lost and the state of the
	 * dropped turns goes with them. With the same first turn the history only lost
	 * its end (an aborted turn's messages are not resent), so the ordinals that
	 * remain keep their state and the state above the new count is dropped.
	 */
	#followOrdinals(state: RootState, counts: Map<string, number>, rootChanged: boolean): void {
		const shift = (key: string): string | undefined => {
			const match = ORDINAL_SUFFIX.exec(key);
			const base = match ? key.slice(0, match.index) : key;
			const now = counts.get(base) ?? 0;
			const lost = (state.counts.get(base) ?? 0) - now;
			if (lost <= 0) return key;
			const ordinal = match ? Number(match[1]) : 0;
			if (!rootChanged) return ordinal < now ? key : undefined;
			const shifted = ordinal - lost;
			if (shifted < 0) return undefined;
			return shifted === 0 ? base : `${base}#${shifted}`;
		};
		const injections = new Map<string, Injection>();
		for (const [key, injection] of state.injections) {
			const shifted = shift(key);
			if (shifted !== undefined) injections.set(shifted, injection);
		}
		state.injections = injections;
		const seen = new Set<string>();
		for (const key of state.seen) {
			const shifted = shift(key);
			if (shifted !== undefined) seen.add(shifted);
		}
		state.seen = seen;
		const controls: AnchoredControl[] = [];
		for (const control of state.controls) {
			const shifted = shift(control.anchor);
			if (shifted !== undefined) controls.push({ anchor: shifted, message: control.message });
		}
		state.controls = controls;
		state.counts = counts;
	}

	/**
	 * The conversation a request with an unserved first turn continues: the most
	 * recent one that sent any of this request's turns. A compaction keeps the end
	 * of the history it summarises, so its state is the one to inherit, and it is
	 * not always the last conversation served: an advisor request can sit between
	 * a conversation's last request before a compaction and its first after it.
	 */
	#predecessorOf(keys: string[]): RootState | undefined {
		const present = new Set(keys);
		const states = [...this.#states.values()];
		for (let index = states.length - 1; index >= 0; index--) {
			const state = states[index]!;
			for (const key of present) {
				if (state.seen.has(key) || state.injections.has(key)) return state;
			}
		}
		return undefined;
	}

	/**
	 * State for a first user turn this injector has not served yet: a compaction
	 * summary, another conversation, or the first request of all. Turns the
	 * conversation it continues shares with this one keep the reminders they were
	 * sent with, or their bytes change under signed thinking; its other turns are
	 * left out. That conversation keeps its own state, because a later request can
	 * return to it: an advisor request does not end the turn that asked for it.
	 */
	#newRootState(keys: string[], counts: Map<string, number>, reminder: string): RootState {
		const previous = this.#predecessorOf(keys);
		const state: RootState = {
			reminder,
			injections: new Map(previous?.injections),
			controls: previous ? [...previous.controls] : [],
			seen: new Set(previous?.seen),
			counts: previous ? previous.counts : new Map(),
		};
		this.#followOrdinals(state, counts, true);
		const present = new Set(keys);
		for (const key of state.injections.keys()) {
			if (!present.has(key)) state.injections.delete(key);
		}
		for (const key of state.seen) {
			if (!present.has(key)) state.seen.delete(key);
		}
		state.controls = state.controls.filter(control => present.has(control.anchor));
		return state;
	}

	/** Make `root` the most recent conversation, forgetting the oldest over the cap. */
	#activate(root: string, state: RootState): void {
		this.#states.delete(root);
		this.#states.set(root, state);
		this.#active = root;
		while (this.#states.size > MAX_ROOTS) {
			const oldest = this.#states.keys().next().value;
			if (oldest === undefined) break;
			this.#states.delete(oldest);
		}
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstIndex = messages.findIndex(message => message.role === "user");
		if (firstIndex === -1) return messages;
		const firstUser = messages[firstIndex] as UserMessage;
		const { keys, counts } = this.#keysOf(messages);
		const root = keys[firstIndex]!;
		let state = this.#states.get(root);
		if (state) {
			this.#followOrdinals(state, counts, false);
		} else {
			state = this.#newRootState(keys, counts, reminder);
			if (!state.injections.has(root) && !messageStartsWithReminder(firstUser, reminder)) {
				state.injections.set(root, {
					reminder,
					source: firstUser,
					injected: injectReminder(firstUser, reminder),
				});
			}
		}
		this.#activate(root, state);
		if (state.reminder !== reminder) {
			let newUser: number | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				if (messages[index]!.role === "user" && !state.seen.has(keys[index]!)) {
					newUser = index;
					break;
				}
			}
			if (newUser !== undefined) {
				const message = messages[newUser] as UserMessage;
				state.injections.set(keys[newUser]!, {
					reminder,
					source: message,
					injected: injectReminder(message, reminder),
				});
			} else {
				const control: Message = {
					role: "developer",
					content: reminder,
					synthetic: true,
					timestamp: Date.now(),
				};
				reminderControls.add(control);
				state.controls.push({ anchor: keys.at(-1)!, message: control });
			}
			state.reminder = reminder;
		}

		const controlsByAnchor = new Map<string, Message[]>();
		for (const control of state.controls) {
			const controls = controlsByAnchor.get(control.anchor);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchor, [control.message]);
		}

		let changed = false;
		const out: Message[] = [];
		for (const [index, message] of messages.entries()) {
			const key = keys[index]!;
			const injection = state.injections.get(key);
			if (injection && message.role === "user") {
				// A new copy of an injected turn gets the reminder that turn was first sent with.
				if (injection.source !== message) {
					injection.source = message;
					injection.injected = injectReminder(message, injection.reminder);
				}
				out.push(injection.injected);
				changed = true;
			} else {
				out.push(message);
			}
			const controls = controlsByAnchor.get(key);
			if (controls) {
				out.push(...controls);
				changed = true;
			}
			state.seen.add(key);
		}
		return changed ? out : messages;
	}
}
