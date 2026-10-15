import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const COLUMNS = 120;
const REPLY_LINES = 150;

/** Turn chrome (status, loader, HUD) that outlives the turn, taller than the idle chrome at startup. */
class TurnChrome implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Turn chrome row ${i}`);
	}
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("transcript rows under chrome that outlives the turn", () => {
	for (const rows of [24, 45]) {
		it(`keeps every line of a long streamed answer at ${rows} rows`, async () => {
			const terminal = new VirtualTerminal(COLUMNS, rows);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const transcript = new TranscriptContainer();
			const chrome = new TurnChrome();
			const editor = new Container();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, chrome, editor]);
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);

			const message = new AssistantMessageComponent();
			transcript.addChild(message);
			chrome.rows = 7;
			const lines = Array.from(
				{ length: REPLY_LINES },
				(_, i) => `QZC${String(i + 1).padStart(3, "0")} alpha bravo`,
			);
			for (let n = 1; n <= lines.length; n++) {
				message.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
			}
			message.updateContent(reply(lines.join("\n\n")));
			message.markTranscriptBlockFinalized();
			composer.ui.requestRender();
			await scheduler.settle(terminal);

			const counts = new Map<number, number>();
			for (const row of terminal.getScrollBuffer()) {
				const token = /QZC(\d{3})/.exec(Bun.stripANSI(row))?.[1];
				if (token !== undefined) counts.set(Number(token), (counts.get(Number(token)) ?? 0) + 1);
			}
			const missing = Array.from({ length: REPLY_LINES }, (_, i) => i + 1).filter(n => !counts.has(n));
			const duplicated = [...counts].filter(([, count]) => count > 1).map(([n]) => n);
			expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
			composer.stop();
		});
	}
});
