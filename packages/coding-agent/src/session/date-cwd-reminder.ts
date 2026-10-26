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

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical.
 *
 * Turns are recognised by a key (role, timestamp, content hash), not by object
 * identity: context hooks, secret obfuscation and conversion-cache resets hand
 * the injector equal but newly allocated messages on every request, and an
 * identity miss on the first user turn would read as a new conversation and
 * rewrite the reminder that turn was first sent with.
 */
export class DateCwdReminderInjector {
	#rootKey: string | undefined;
	#currentReminder: string | undefined;
	#injections = new Map<string, { reminder: string; source: UserMessage; injected: UserMessage }>();
	#controls: Array<{ anchorKey: string; anchorTimestamp: number; message: Message }> = [];
	#seen = new Set<string>();
	#keys = new WeakMap<Message, string>();

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	/** The same key for every copy of one turn. */
	#keyOf(message: Message): string {
		let key = this.#keys.get(message);
		if (key === undefined) {
			key = `${message.role}:${message.timestamp}:${Bun.hash(JSON.stringify(message.content)).toString(36)}`;
			this.#keys.set(message, key);
		}
		return key;
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstUser = messages.find((message): message is UserMessage => message.role === "user");
		if (!firstUser) return messages;
		const rootKey = this.#keyOf(firstUser);
		if (this.#rootKey !== rootKey) {
			// A new first user turn: a compaction summary or a different conversation.
			// Turns kept from the earlier history must keep the reminders they were
			// sent with, or their bytes change under signed thinking; reminders on
			// turns that are gone are dropped. The new root gets the current reminder.
			// Only user turns and control anchors carry state; skip hashing every other turn.
			const anchored = new Set(this.#controls.map(control => control.anchorTimestamp));
			const present = new Set<string>();
			for (const message of messages) {
				if (message.role === "user" || anchored.has(message.timestamp)) present.add(this.#keyOf(message));
			}
			for (const key of this.#injections.keys()) {
				if (!present.has(key)) this.#injections.delete(key);
			}
			for (const key of this.#seen) {
				if (!present.has(key)) this.#seen.delete(key);
			}
			this.#controls = this.#controls.filter(control => present.has(control.anchorKey));
			this.#rootKey = rootKey;
			this.#currentReminder = reminder;
			if (!this.#injections.has(rootKey) && !messageStartsWithReminder(firstUser, reminder)) {
				this.#injections.set(rootKey, {
					reminder,
					source: firstUser,
					injected: injectReminder(firstUser, reminder),
				});
			}
		} else if (this.#currentReminder !== reminder) {
			let newUser: UserMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const candidate = messages[index]!;
				if (candidate.role === "user" && !this.#seen.has(this.#keyOf(candidate))) {
					newUser = candidate;
					break;
				}
			}
			if (newUser) {
				this.#injections.set(this.#keyOf(newUser), {
					reminder,
					source: newUser,
					injected: injectReminder(newUser, reminder),
				});
			} else {
				const control: Message = {
					role: "developer",
					content: reminder,
					synthetic: true,
					timestamp: Date.now(),
				};
				reminderControls.add(control);
				const anchor = messages.at(-1)!;
				this.#controls.push({
					anchorKey: this.#keyOf(anchor),
					anchorTimestamp: anchor.timestamp,
					message: control,
				});
			}
			this.#currentReminder = reminder;
		}

		const controlsByAnchor = new Map<string, Message[]>();
		const anchorTimestamps = new Set<number>();
		for (const control of this.#controls) {
			const controls = controlsByAnchor.get(control.anchorKey);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchorKey, [control.message]);
			anchorTimestamps.add(control.anchorTimestamp);
		}

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			// Only user turns carry injections or count as seen; other turns need a key only to anchor controls.
			if (message.role !== "user" && !anchorTimestamps.has(message.timestamp)) {
				out.push(message);
				continue;
			}
			const key = this.#keyOf(message);
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
			if (message.role === "user") this.#seen.add(key);
		}
		return changed ? out : messages;
	}
}
