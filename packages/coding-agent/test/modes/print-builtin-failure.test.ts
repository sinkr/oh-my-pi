/**
 * Contract: print mode is automation surface — a builtin that consumes an
 * input but fails (unknown server, usage error, refused operation) must not
 * exit 0, or `omp -p '/mcp reauth foo'` scripts treat a failed
 * reauthorization as success. Conversely a consumed builtin that succeeded
 * exits 0 without prompting the model or reprinting the persisted previous
 * turn.
 */
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("print mode builtin exit codes", () => {
	test("exits 1 when the builtin fails, 0 when it succeeds, without prompting the model", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-builtin-"));
		const stderrLines: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const prompts: string[] = [];
		const session = {
			extensionRunner: undefined,
			subscribe: () => () => {},
			settings: Settings.isolated(),
			sessionManager: {
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getCwd: () => cwd,
				onPersistenceError: () => () => {},
				onPersistenceNotice: () => () => {},
			},
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async (text: string) => {
				prompts.push(text);
			},
			getLastAssistantMessage: () => undefined,
			dispose: async () => {},
		} as unknown as AgentSession;

		try {
			// A failed builtin (unknown server) consumes the input and reports
			// the failure; the run must surface it as a nonzero exit code.
			const failure = await runPrintMode(session as never, {
				mode: "text",
				messages: ["/mcp reauth no-such-server-9f3a"],
			});
			expect(failure).toBe(1);
			expect(stderrLines.join("")).toContain("not found");
			expect(prompts).toEqual([]);

			stderrLines.length = 0;
			// A non-slash input still prompts the model and is not a failure.
			const success = await runPrintMode(session as never, { mode: "text", messages: ["/mcp help"] });
			expect(success).toBe(0);
			expect(prompts).toEqual([]);
			expect(stderrLines.join("")).toContain("/mcp list");
		} finally {
			stderrSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});

	test("counts a builtin-started turn (/retry) as admitted and prints its answer", async () => {
		// Regression: `promptTextFor` ignored `agentInvoked`, so a consumed
		// `/retry` left `admittedAgentTurn` false and the retried turn's
		// assistant answer was suppressed (with its stop reason dropped from
		// the exit status).
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-retry-"));
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: unknown,
			callback?: (err?: Error | null) => void,
		) => {
			stdoutLines.push(String(chunk));
			// `writeStdoutLine` serializes on this callback; the mock must
			// fire it or `await stdoutTail` hangs forever.
			callback?.(null);
			return true;
		}) as never);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const retriedAnswer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Recovered answer." }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {} as AssistantMessage["usage"],
			stopReason: "stop",
			timestamp: 1,
		};
		const session = {
			extensionRunner: undefined,
			subscribe: () => () => {},
			settings: Settings.isolated(),
			sessionManager: {
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getCwd: () => cwd,
				onPersistenceError: () => () => {},
				onPersistenceNotice: () => () => {},
			},
			isStreaming: false,
			retry: async () => true,
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => {},
			getLastAssistantMessage: () => retriedAnswer,
			dispose: async () => {},
		} as unknown as AgentSession;

		try {
			const exitCode = await runPrintMode(session as never, { mode: "text", messages: ["/retry"] });
			expect(exitCode).toBe(0);
			// The retried turn's answer is this run's outcome: it must print.
			expect(stdoutLines.join("")).toContain("Recovered answer.");
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});
});
