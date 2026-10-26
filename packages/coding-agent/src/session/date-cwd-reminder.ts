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

/** Trailing `#n` that tells apart turns of one request that are otherwise equal. */
const ORDINAL_SUFFIX = /#\d+$/;

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
 * first sent with.
 */
export class DateCwdReminderInjector {
	#root: string | undefined;
	#rootStamp: string | undefined;
	#currentReminder: string | undefined;
	#injections = new Map<string, { reminder: string; source: UserMessage; injected: UserMessage }>();
	#controls: Array<{ anchor: string; anchorBase: string; message: Message }> = [];
	#seen = new Set<string>();
	#contentHashes = new WeakMap<Message, string>();

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	/**
	 * One key per turn, equal for every copy of it: role and timestamp, a content
	 * hash for user turns (the turns that carry injections), and an ordinal for
	 * the second and later turns that would otherwise share a key.
	 */
	#keysOf(messages: Message[]): string[] {
		const counts = new Map<string, number>();
		return messages.map(message => {
			let key = `${message.role}:${message.timestamp}`;
			if (message.role === "user") {
				let hash = this.#contentHashes.get(message);
				if (hash === undefined) {
					hash = Bun.hash(JSON.stringify(message.content)).toString(36);
					this.#contentHashes.set(message, hash);
				}
				key = `${key}:${hash}`;
			}
			const count = counts.get(key) ?? 0;
			counts.set(key, count + 1);
			return count === 0 ? key : `${key}#${count}`;
		});
	}

	/**
	 * Follow an already placed reminder when its anchoring turn keeps its role and
	 * timestamp but takes another ordinal, as it does when a compaction drops an
	 * earlier turn the anchor shared a key with.
	 */
	#reanchorControls(keys: string[]): void {
		if (this.#controls.length === 0) return;
		const present = new Set(keys);
		for (const control of this.#controls) {
			if (present.has(control.anchor)) continue;
			for (let index = keys.length - 1; index >= 0; index--) {
				if (keys[index]!.replace(ORDINAL_SUFFIX, "") === control.anchorBase) {
					control.anchor = keys[index]!;
					break;
				}
			}
		}
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstIndex = messages.findIndex(message => message.role === "user");
		if (firstIndex === -1) return messages;
		const firstUser = messages[firstIndex] as UserMessage;
		const keys = this.#keysOf(messages);
		const root = keys[firstIndex]!;
		this.#reanchorControls(keys);
		if (this.#root !== undefined && this.#root !== root && this.#rootStamp === `user:${firstUser.timestamp}`) {
			// The same first turn with rewritten content (a newly redacted secret):
			// it keeps the reminder it was first sent with.
			const injection = this.#injections.get(this.#root);
			if (injection) {
				this.#injections.delete(this.#root);
				this.#injections.set(root, injection);
			}
			this.#seen.add(root);
			this.#root = root;
		}
		if (this.#root !== root) {
			// A new first user turn: a compaction summary or a different conversation.
			// Turns kept from the earlier history must keep the reminders they were
			// sent with, or their bytes change under signed thinking; reminders on
			// turns that are gone are dropped. The new root gets the current reminder.
			const present = new Set(keys);
			for (const key of this.#injections.keys()) {
				if (!present.has(key)) this.#injections.delete(key);
			}
			for (const key of this.#seen) {
				if (!present.has(key)) this.#seen.delete(key);
			}
			this.#controls = this.#controls.filter(control => present.has(control.anchor));
			this.#root = root;
			this.#rootStamp = `user:${firstUser.timestamp}`;
			this.#currentReminder = reminder;
			if (!this.#injections.has(root) && !messageStartsWithReminder(firstUser, reminder)) {
				this.#injections.set(root, {
					reminder,
					source: firstUser,
					injected: injectReminder(firstUser, reminder),
				});
			}
		} else if (this.#currentReminder !== reminder) {
			let newUser: number | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				if (messages[index]!.role === "user" && !this.#seen.has(keys[index]!)) {
					newUser = index;
					break;
				}
			}
			if (newUser !== undefined) {
				const message = messages[newUser] as UserMessage;
				this.#injections.set(keys[newUser]!, {
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
				const anchor = keys.at(-1)!;
				this.#controls.push({ anchor, anchorBase: anchor.replace(ORDINAL_SUFFIX, ""), message: control });
			}
			this.#currentReminder = reminder;
		}

		const controlsByAnchor = new Map<string, Message[]>();
		for (const control of this.#controls) {
			const controls = controlsByAnchor.get(control.anchor);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchor, [control.message]);
		}

		let changed = false;
		const out: Message[] = [];
		for (const [index, message] of messages.entries()) {
			const key = keys[index]!;
			const injection = this.#injections.get(key);
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
			this.#seen.add(key);
		}
		return changed ? out : messages;
	}
}
