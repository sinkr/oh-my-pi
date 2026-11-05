import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import {
	type Settings as SettingsCapabilityItem,
	settingsCapability,
} from "@oh-my-pi/pi-coding-agent/capability/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("codex/claude discovery when cwd is the home directory", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-home-cwd-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(home, ".codex"), { recursive: true });
		await fs.mkdir(path.join(home, ".claude"), { recursive: true });
		await fs.mkdir(path.join(project, ".codex"), { recursive: true });
		await fs.mkdir(path.join(project, ".claude"), { recursive: true });
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		const toml = (name: string) => `[mcp_servers.${name}]\ncommand = "echo"\n`;
		const json = (name: string) => JSON.stringify({ mcpServers: { [name]: { command: "echo" } } });
		await fs.writeFile(path.join(home, ".codex", "config.toml"), `model = "home"\n\n${toml("home-codex")}`);
		await fs.writeFile(path.join(home, ".claude", "mcp.json"), json("home-claude"));
		await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "home" }));
		await fs.writeFile(path.join(project, ".codex", "config.toml"), `model = "proj"\n\n${toml("proj-codex")}`);
		await fs.writeFile(path.join(project, ".claude", "mcp.json"), json("proj-claude"));
		await fs.writeFile(path.join(project, ".claude", "settings.json"), JSON.stringify({ model: "proj" }));
	});

	afterEach(async () => {
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	});

	for (const provider of ["codex", "claude"]) {
		test(`${provider}: home-level files are never re-read as project-scope MCP servers or settings`, async () => {
			const servers = await loadCapability<MCPServer>(mcpCapability.id, { cwd: home, providers: [provider] });
			expect(servers.items.filter(item => item._source.level === "project")).toEqual([]);

			const settings = await loadCapability<SettingsCapabilityItem>(settingsCapability.id, {
				cwd: home,
				providers: [provider],
			});
			expect(settings.items.filter(item => item.level === "project")).toEqual([]);
		});

		test(`${provider}: a real project directory still gets project-scope MCP servers and settings`, async () => {
			const servers = await loadCapability<MCPServer>(mcpCapability.id, { cwd: project, providers: [provider] });
			expect(servers.items.filter(item => item._source.level === "project").map(item => item.name)).toEqual([
				`proj-${provider}`,
			]);

			const settings = await loadCapability<SettingsCapabilityItem>(settingsCapability.id, {
				cwd: project,
				providers: [provider],
			});
			expect(settings.items.filter(item => item.level === "project")).toHaveLength(1);
		});
	}
});
