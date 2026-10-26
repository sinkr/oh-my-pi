import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Api, AssistantMessage, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DateCwdReminderInjector, renderDateCwdReminder } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("date-cwd-reminder", () => {
	afterEach(() => {
		clearCustomApis();
	});

	describe("DateCwdReminderInjector", () => {
		it("injects the first reminder without mutating the context", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }, createAssistantMessage("hi")];
			const context: Context = { systemPrompt, messages };
			const injector = new DateCwdReminderInjector();

			const out = injector.transform(context, "2026-08-14", "/work/omp");

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages).not.toBe(messages);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nhello`,
				timestamp: 1,
			});
			expect(out.messages[1]).toBe(messages[1]);
			expect(context.messages).toBe(messages);
		});

		it("prepends a text part before image parts", () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "img", mimeType: "image/png" }],
						timestamp: 1,
					},
				],
			};

			const out = new DateCwdReminderInjector().transform(context, "2026-08-14", "/work/omp");

			expect(out.messages[0]?.content).toEqual([
				{ type: "text", text: renderDateCwdReminder("2026-08-14", "/work/omp") },
				{ type: "image", data: "img", mimeType: "image/png" },
			]);
		});

		it("leaves contexts without a system prompt or user message untouched", () => {
			const injector = new DateCwdReminderInjector();
			const noSystem: Context = {
				systemPrompt: [],
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			};
			const noUser: Context = { systemPrompt: ["system"], messages: [createAssistantMessage("hi")] };

			expect(injector.transform(noSystem, "2026-08-14", "/cwd")).toBe(noSystem);
			expect(injector.transform(noUser, "2026-08-14", "/cwd")).toBe(noUser);
		});

		it("keeps prior reminder bytes and moves a changed reminder to the next user turn", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const firstContext: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(firstContext, "2026-08-14", "/old");
			const firstInjected = first.messages[0]!;
			const secondUser: Message = { role: "user", content: "second", timestamp: 2 };
			const second = injector.transform(
				{
					systemPrompt: firstContext.systemPrompt,
					messages: [firstUser, createAssistantMessage("done"), secondUser],
				},
				"2026-08-15",
				"/new",
			);

			expect(second.messages[0]).toBe(firstInjected);
			expect(second.messages[0]?.content).toBe(firstInjected.content);
			expect(second.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/new")}\n\nsecond`);
			expect(firstUser.content).toBe("first");
			expect(secondUser.content).toBe("second");
		});

		it("reuses injected message objects on provider request replay", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(context, "2026-08-14", "/work/omp");
			const replay = injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work/omp");

			expect(replay.messages[0]).toBe(first.messages[0]);
		});

		it("keeps the reminders of turns a compaction retains when the first user turn changes", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const kept: Message = { role: "user", content: "kept", timestamp: 2 };
			const toolTurn = createAssistantMessage("calling a tool");
			// The cwd moves mid tool loop: the continuation carries the reminder as a control.
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/old");
			injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept, toolTurn] },
				"2026-08-14",
				"/old",
			);
			const live = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept, toolTurn] },
				"2026-08-14",
				"/new",
			);
			const control = live.messages.at(-1)!;
			expect(control.role).toBe("developer");

			// A compaction replaces everything before `kept` with a new summary turn.
			const summary: Message = { role: "user", content: "summary", timestamp: 3 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, kept, toolTurn] },
				"2026-08-14",
				"/new",
			);

			// The retained tail is sent exactly as before; only the new summary gets the current reminder.
			expect(after.messages.slice(1)).toEqual([kept, toolTurn, control]);
			expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/new")}\n\nsummary`);
		});

		it("appends a changed reminder when each request carries new copies of the earlier turns", () => {
			// Context hooks and secret obfuscation hand over equal but newly allocated messages per request.
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const first = injector.transform({ systemPrompt: ["system"], messages: [firstUser] }, "2026-08-14", "/work");

			const secondUser: Message = { role: "user", content: "second", timestamp: 2 };
			const second = injector.transform(
				{
					systemPrompt: ["system"],
					messages: [structuredClone(firstUser), createAssistantMessage("done"), secondUser],
				},
				"2026-08-15",
				"/work",
			);

			expect(second.messages[0]?.content).toBe(first.messages[0]!.content);
			expect(second.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nsecond`);
		});

		it("keeps a mid-loop reminder behind its anchor when the turns are copied again", () => {
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "first", timestamp: 1 };
			const toolResult = (id: string, timestamp: number): Message => ({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: id }],
				isError: false,
				timestamp,
			});
			const history: Message[] = [user, createAssistantMessage("call 1"), toolResult("call-1", 2)];
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			// The date rolls over between tool continuations: no new user turn exists, so a control follows the tail.
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: structuredClone(history) },
				"2026-08-15",
				"/work",
			);
			const next = injector.transform(
				{
					systemPrompt: ["system"],
					messages: structuredClone([...history, createAssistantMessage("call 2"), toolResult("call-2", 3)]),
				},
				"2026-08-15",
				"/work",
			);

			const wire = (messages: Message[]) => messages.map(message => JSON.stringify([message.role, message.content]));
			expect(wire(next.messages).slice(0, rolled.messages.length)).toEqual(wire(rolled.messages));
			expect(wire(rolled.messages).at(-1)).toBe(
				JSON.stringify(["developer", renderDateCwdReminder("2026-08-15", "/work")]),
			);
			expect(next.messages).toHaveLength(rolled.messages.length + 2);
		});

		it("gives the newest of two identical same-millisecond turns the changed reminder", () => {
			// Programmatic steering can append a user turn byte-identical to an earlier one
			// within the same millisecond; the two must not share one reminder.
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "ok", timestamp: 1 };
			const assistant = createAssistantMessage("a");
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: structuredClone([user, assistant, user]) },
				"2026-08-15",
				"/work",
			);

			expect(rolled.messages.map(message => message.content)).toEqual([
				`${renderDateCwdReminder("2026-08-14", "/work")}\n\nok`,
				assistant.content,
				`${renderDateCwdReminder("2026-08-15", "/work")}\n\nok`,
			]);
		});

		it("keeps the first reminder when the first turn's content is rewritten in place", () => {
			// Secret obfuscation re-renders an earlier turn once it learns a new secret.
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "token abc", timestamp: 1 };
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work");
			const redacted: Message = { role: "user", content: "token [redacted]", timestamp: 1 };
			const next: Message = { role: "user", content: "second", timestamp: 4 };
			const out = injector.transform(
				{ systemPrompt: ["system"], messages: [redacted, createAssistantMessage("a"), next] },
				"2026-08-15",
				"/work",
			);

			expect(out.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/work")}\n\ntoken [redacted]`);
			expect(out.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/work")}\n\nsecond`);
		});

		it("keeps a mid-loop reminder when its anchoring tool result is re-rendered", () => {
			// Image clamps and inline-snapshot transforms rewrite a tool result's content
			// between requests; the reminder already sent must stay where it was.
			const injector = new DateCwdReminderInjector();
			const user: Message = { role: "user", content: "first", timestamp: 1 };
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "FULL OUTPUT" }],
				isError: false,
				timestamp: 2,
			};
			injector.transform({ systemPrompt: ["system"], messages: [user] }, "2026-08-14", "/work");
			const rolled = injector.transform(
				{ systemPrompt: ["system"], messages: [user, createAssistantMessage("call"), toolResult] },
				"2026-08-15",
				"/work",
			);
			const truncated: Message = { ...toolResult, content: [{ type: "text", text: "TRUNCATED" }] };
			const next = injector.transform(
				{
					systemPrompt: ["system"],
					messages: [user, createAssistantMessage("call"), truncated, createAssistantMessage("call 2")],
				},
				"2026-08-15",
				"/work",
			);

			const control = rolled.messages.at(-1)!;
			expect(control.content).toBe(renderDateCwdReminder("2026-08-15", "/work"));
			expect(next.messages[3]).toBe(control);
		});
	});
});

describe("date-cwd reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		// Restore the clock here, not only in each test's `finally`: an aborted test would
		// otherwise leave every later test file running at the faked date.
		setSystemTime();
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("keeps the date/cwd out of the system prompt and pins the reminder to the first user turn across requests", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		const api = "test-date-cwd-reminder";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-reminder",
			name: "Date cwd reminder",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		try {
			await session.sendUserMessage("first");

			expect(contexts).toHaveLength(1);
			// The volatile line must no longer live in the system prompt: open-weight
			// chat templates render tool schemas after the system content, so any
			// per-request byte there invalidates the whole tool-schema cache (#7404).
			const systemPrompt = contexts[0]!.systemPrompt?.join("\n") ?? "";
			expect(systemPrompt).not.toContain("Today");
			expect(systemPrompt).not.toContain("current working directory");
			expect(systemPrompt).not.toContain(formatLocalCalendarDate());

			const firstUser = contexts[0]!.messages[0]!;
			expect(firstUser.role).toBe("user");
			const firstText =
				typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
			expect(firstText).toContain("<system-reminder>");
			expect(firstText).toContain(formatLocalCalendarDate());
			expect(firstText).toContain(normalizePromptPath(tempDir.path()));

			// A second request must re-emit byte-identical reminder bytes so the
			// conversation prefix (system + tools + first turn) stays cached.
			await session.sendUserMessage("second");
			expect(contexts).toHaveLength(2);
			const secondFirst = contexts[1]!.messages[0]!;
			expect(secondFirst.role).toBe("user");
			expect(typeof secondFirst.content).toBe(typeof firstUser.content);
			expect(secondFirst.content).toEqual(firstUser.content);
		} finally {
			authStorage.close();
		}
	});

	it("keeps an earlier steering message byte-identical when the date rolls over mid-turn", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		await Bun.write(tempDir.join("notes.txt"), "notes");
		const api = "test-date-cwd-reminder-steer";
		const contexts: Context[] = [];
		const pushReadCall = (stream: AssistantMessageEventStream, id: string) => {
			const toolCall = { type: "toolCall" as const, id, name: "read", arguments: { path: "notes.txt" } };
			const message: AssistantMessage = {
				...createAssistantMessage(""),
				content: [toolCall],
				stopReason: "toolUse",
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		};
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			const request = contexts.length;
			queueMicrotask(() => {
				if (request === 1) {
					void session.steer("steered");
					pushReadCall(stream, "read-1");
				} else if (request === 2) {
					// The next requests are tool continuations with no new user turn.
					setSystemTime(new Date(2026, 7, 15, 0, 1));
					pushReadCall(stream, "read-2");
				} else if (request < 5) {
					pushReadCall(stream, `read-${request}`);
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-reminder-steer",
			name: "Date cwd reminder steer",
			api,
			provider: "managed-primary",
			// Remote endpoint: a loopback URL would turn on append-only context, which pins message identity.
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		setSystemTime(new Date(2026, 7, 14, 23, 59));
		try {
			await session.sendUserMessage("first");
			await session.waitForIdle();

			expect(contexts).toHaveLength(5);
			const wire = contexts.map(context =>
				context.messages.map(message => JSON.stringify([message.role, message.content])),
			);
			const steerIndex = contexts[1]!.messages.findLastIndex(message => message.role === "user");
			expect(wire[1]![steerIndex]).toContain("steered");
			// Bytes the provider already saw stay put on every later request; the new date is appended once.
			for (let request = 2; request < wire.length; request++) {
				expect(wire[request]!.slice(0, wire[request - 1]!.length)).toEqual(wire[request - 1]!);
			}
			const reminder = JSON.stringify([
				"developer",
				renderDateCwdReminder("2026-08-15", normalizePromptPath(tempDir.path())),
			]);
			expect(wire[2]!.at(-1)).toBe(reminder);
			expect(wire[4]!.filter(message => message === reminder)).toHaveLength(1);
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});

	// Both producers hand the reminder injector new copies of every earlier turn on each request.
	for (const { producer, change } of [
		{ producer: "a context hook", change: "date" },
		{ producer: "a context hook", change: "cwd" },
		{ producer: "secret obfuscation", change: "date" },
	] as const) {
		it(`keeps the first user turn byte-identical when the ${change} changes under ${producer}`, async () => {
			using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
			const secret = "s3cret-rollover-token";
			await Bun.write(
				tempDir.join("secrets.yml"),
				`- type: plain\n  content: ${secret}\n  mode: replace\n  replacement: "[redacted]"\n`,
			);
			const api = "test-date-cwd-reminder-copies";
			const contexts: Context[] = [];
			registerCustomApi(api, (_model, context) => {
				contexts.push(context);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			});
			const model = buildModel({
				id: "date-cwd-reminder-copies",
				name: "Date cwd reminder copies",
				api,
				provider: "managed-primary",
				// Remote endpoint: a loopback URL would turn on append-only context, which pins message identity.
				baseUrl: "https://api.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
			} as ModelSpec<Api>) as Model<Api>;
			const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			authStorage.keys.setRuntime(model.provider, "test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const contextHook: ExtensionFactory = pi => {
				pi.on("context", () => undefined);
			};
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"secrets.enabled": producer === "secret obfuscation",
				}),
				model,
				disableExtensionDiscovery: true,
				extensions: producer === "a context hook" ? [contextHook] : [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			sessions.push(session);

			setSystemTime(new Date(2026, 7, 14, 23, 59));
			try {
				await session.sendUserMessage(`first ${secret}`);
				let cwd = tempDir.path();
				if (change === "date") {
					setSystemTime(new Date(2026, 7, 15, 0, 1));
				} else {
					cwd = tempDir.join("moved");
					sessionManager.setCwdWithoutRelocation(cwd);
				}
				await session.sendUserMessage("second");

				expect(contexts).toHaveLength(2);
				const wire = contexts.map(context =>
					context.messages.map(message => JSON.stringify([message.role, message.content])),
				);
				if (producer === "secret obfuscation") expect(wire[0]![0]).not.toContain(secret);
				// The turns the provider already saw are resent byte-for-byte; the new value rides on the new turn.
				expect(wire[1]!.slice(0, wire[0]!.length)).toEqual(wire[0]!);
				const date = change === "date" ? "2026-08-15" : "2026-08-14";
				expect(contexts[1]!.messages.at(-1)?.content).toEqual([
					{ type: "text", text: renderDateCwdReminder(date, normalizePromptPath(cwd)) },
					{ type: "text", text: "second" },
				]);
			} finally {
				setSystemTime();
				authStorage.close();
			}
		});
	}
});
