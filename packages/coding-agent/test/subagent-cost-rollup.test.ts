import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// #7978 review: detached subagents deliver their result as an async-result
// message that never rolls usage into the parent's message stats, so the
// executor records the child's spend explicitly; the parent's cost total
// (read by the shared cost gate) must include it.

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	tempDir = TempDir.createSync("@omp-subagent-cost-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

function createSession(): AgentSession {
	const model = modelRegistry.getAll()[0];
	if (!model) throw new Error("expected a bundled model");
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
	});
}

describe("detached subagent cost rollup (issue #7978)", () => {
	it("includes recorded subagent spend in the parent session cost", async () => {
		const session = createSession();
		try {
			const baseline = session.getSessionStats().cost;
			session.sessionManager.recordSubagentCost(4.2);
			expect(session.getSessionStats().cost).toBeCloseTo(baseline + 4.2, 5);
		} finally {
			await session.dispose();
		}
	});

	it("ignores non-finite and negative spend", async () => {
		const session = createSession();
		try {
			const baseline = session.getSessionStats().cost;
			session.sessionManager.recordSubagentCost(Number.NaN);
			session.sessionManager.recordSubagentCost(Number.POSITIVE_INFINITY);
			session.sessionManager.recordSubagentCost(-3);
			expect(session.getSessionStats().cost).toBeCloseTo(baseline, 5);
		} finally {
			await session.dispose();
		}
	});
});
