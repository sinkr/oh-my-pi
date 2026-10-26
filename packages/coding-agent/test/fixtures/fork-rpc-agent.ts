import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch over a session persisted under the test's temp root; only model replies are scripted.
// The root arrives as argv so storage can never land in an inherited cwd such as the repo checkout.
const root = process.argv[2];
if (!root || root.startsWith("-")) throw new Error("fork-rpc-agent: expected the temp root as the first argument");
process.chdir(root);
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const mock = createMockModel({
	// A prompt mentioning "slow" stays in flight long enough for the test to act mid-stream.
	handler: context => ({
		content: ["Done"],
		delayMs: JSON.stringify(context.messages.at(-1)?.content).includes("slow") ? 1500 : 0,
	}),
});
// The first goal continuation waits here until a branch summary starts, so it is decided but not yet started.
const summaryStarted = Promise.withResolvers<void>();
// Branch summaries: one whose instructions say "hang-summary" announces itself with a notice and runs
// until aborted; any other releases the held continuation and answers shortly after.
const side = createMockModel({
	handler: context => {
		summaryStarted.resolve();
		if (!JSON.stringify(context.messages).includes("hang-summary"))
			return { content: ["Branch summary"], delayMs: 200 };
		session.emitNotice("info", "summary started", "fork-rpc-agent");
		return { content: ["unreachable"], delayMs: 600_000 };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false, "goal.continuationModes": ["rpc"] }),
	modelRegistry,
	sideStreamFn: side.stream,
});
const waitForIdle = session.waitForIdle.bind(session);
let heldGoalIdle = false;
session.waitForIdle = async () => {
	await waitForIdle();
	if (heldGoalIdle || !session.getGoalModeState()?.enabled) return;
	heldGoalIdle = true;
	await summaryStarted.promise;
};
await runRpcMode(session);
