import { ProcessTerminal, TUI } from "../../../src/index";
import { ContextViewer, type ContextViewData } from "../../../src/overlays/context-viewer";

// Only synthetic data: never read a user's session or configuration.
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const data: ContextViewData = {
	modelLabel: "Native regression fixture",
	window: 10000,
	usage: 100,
	buffer: 1000,
	free: 8900,
	breakdown: {
		model: undefined,
		contextWindow: 10000,
		categories: [],
		thresholdTokens: 9000,
		usedTokens: 100,
		freeTokens: 8900,
		autoCompactBufferTokens: 1000,
	},
	categories: [
		{
			id: "tool-output",
			label: "Tool Output",
			tokens: 100,
			entries: Array.from({ length: 40 }, (_, index) => ({
				id: `entry-${index}`,
				label: `ENTRY-${index}`,
				tokens: 10,
				info: index < 2 || index % 3 === 0 ? "short metadata" : "metadata detail\n".repeat(10),
				text: `${index % 3 === 0 ? "Short complete content" : "中文字 long output ".repeat(80)}\nTAIL-${index}`,
			})),
		},
	],
};
const viewer = new ContextViewer(data, {
	onClose() {
		viewer.dispose();
		tui.stop();
		process.exit(0);
	},
	requestRender: () => tui.requestRender(),
	getRows: () => terminal.rows,
});
// Enter the category through the component API; all regression input below is real Tern input.
viewer.handleNativeEvent({ type: "activate", key: "categories", item: "tool-output" });
tui.start();
tui.showOverlay(viewer, { fullscreen: true, mouseTracking: false });
