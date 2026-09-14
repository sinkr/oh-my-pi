import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ADVISOR_ALLOWED_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionAdvisors from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(() => {
	tempDir = path.join(os.tmpdir(), `pi-advisor-tool-availability-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	authStorage = createInMemoryAuthStorage();
});

afterEach(() => {
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function requireTool(tools: readonly AgentTool[], name: string): AgentTool {
	const tool = tools.find(entry => entry.name === name);
	if (!tool) throw new Error(`expected ${name} in [${tools.map(entry => entry.name).join(", ")}]`);
	return tool;
}

// Advisors are hard read-only: a slate holds only allowlisted tools however
// much its grant asks for, and never advertises a tool only the primary has.
test("advisor slates hold only allowlisted tools, whatever the grant or the primary has", async () => {
	const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
	let factory: sessionAdvisors.AdvisorToolFactory | undefined;
	const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
		host: sessionAdvisors.SessionAdvisorsHost,
		options: sessionAdvisors.SessionAdvisorsOptions,
	) {
		factory = options.tools;
		return new RealSessionAdvisors(host, options);
	} as never);
	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated({ "find.enabled": "on" }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read", "bash", "grep", "find"],
		}));
	} finally {
		advisorsSpy.mockRestore();
	}
	try {
		// The primary holds and advertises tools no advisor may have.
		await session.setActiveToolsByName(["read", "bash", "grep", "find"]);
		const primaryActive = session.getActiveToolNames();
		expect(primaryActive).toContain("bash");
		expect(primaryActive).toContain("find");
		const primaryGrep = session.getToolByName("grep");
		expect(primaryGrep).toBeDefined();
		expect(primaryGrep!.description).toContain("Behavior/unknown symbol → `find`");

		// Every name a slate can hold is on the allowlist.
		const available = factory!.names();
		expect(available).toContain("grep");
		expect(available.filter(name => !ADVISOR_ALLOWED_TOOL_NAMES.has(name))).toEqual([]);

		// Mutating, delegating, and primary-only grants build nothing.
		const rich = factory!.create(new Set(["bash", "task", "wait", "grep", "find", "lsp"]));
		const narrow = factory!.create(new Set(["bash", "task", "grep"]));
		expect(rich.tools.map(tool => tool.name)).toEqual(["grep"]);
		expect(narrow.tools.map(tool => tool.name)).toEqual(["grep"]);
		// `find` was requested but never built, so neither slate advertises it.
		const richGrep = requireTool(rich.tools, "grep");
		const narrowGrep = requireTool(narrow.tools, "grep");
		expect(richGrep.description).not.toContain("`find`");
		expect(narrowGrep.description).not.toContain("`find`");

		// The Cursor bridge's per-call grep follows the same slate.
		const bridgeGrep = narrow.createGrepTool?.({});
		const richBridgeGrep = rich.createGrepTool?.({});
		expect(bridgeGrep).toBeDefined();
		expect(richBridgeGrep).toBeDefined();
		expect(bridgeGrep!.description).not.toContain("`find`");
		expect(richBridgeGrep!.description).not.toContain("`find`");
	} finally {
		await session!.dispose();
	}
}, 60_000);
