/**
 * Contracts for the post-reauth reconnect path. `/mcp reauth` writes a fresh
 * url-keyed credential row, and the host's next auth resolution must be able
 * to pick it up: while a client-supplied `Authorization` header is present,
 * `lookupMcpOAuthCredential` disables the url-keyed fallback, and a stale
 * `auth` block answers first. The host reconnect hooks therefore clear that
 * surface (`clearMcpClientAuthSurface`) and install the cleaned definition
 * (`MCPManager.updateServerConfig`) before reconnecting.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { clearMcpClientAuthSurface } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPAuthConfig, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const staleAuth: MCPAuthConfig = {
	type: "oauth",
	credentialId: "mcp_oauth:profile:old",
	tokenUrl: "https://auth.example.com/token",
};

function asHttpServerConfig(
	config: MCPServerConfig,
): MCPServerConfig & { url: string; headers?: Record<string, string> } {
	if (config.type !== "http" && config.type !== "sse") {
		throw new Error(`expected an http/sse config, got ${config.type ?? "stdio"}`);
	}
	return config;
}

function asStdioServerConfig(config: MCPServerConfig): MCPServerConfig & { command: string; args?: string[] } {
	if (config.type !== "stdio") {
		throw new Error(`expected a stdio config, got config.type=${config.type}`);
	}
	return config;
}

describe("clearMcpClientAuthSurface", () => {
	test("strips every Authorization header spelling and the auth block, keeping the rest", () => {
		const config: MCPServerConfig = {
			type: "http",
			url: "https://mcp.example.com/mcp",
			headers: {
				Authorization: "Bearer stale-token",
				authorization: "Bearer also-stale",
				"X-Custom": "keep",
			},
			auth: staleAuth,
		};
		const cleaned = asHttpServerConfig(clearMcpClientAuthSurface(config));
		// Every casing of the bearer header is gone; unrelated headers survive.
		expect(Object.keys(cleaned.headers ?? {})).toEqual(["X-Custom"]);
		expect(cleaned.auth).toBeUndefined();
		expect(cleaned.url).toBe("https://mcp.example.com/mcp");
		// The input definition is not mutated in place.
		const original = asHttpServerConfig(config);
		expect(original.auth).toBe(staleAuth);
		expect(Object.keys(original.headers ?? {})).toContain("Authorization");
	});

	test("drops the auth block from stdio definitions without touching the rest", () => {
		const config: MCPServerConfig = {
			type: "stdio",
			command: "some-server",
			args: ["--stdio"],
			auth: staleAuth,
		};
		const cleaned = asStdioServerConfig(clearMcpClientAuthSurface(config));
		expect(cleaned.auth).toBeUndefined();
		expect(cleaned.command).toBe("some-server");
		expect(cleaned.args).toEqual(["--stdio"]);
	});
});

describe("MCPManager.updateServerConfig", () => {
	test("replaces the definition the next auth resolution reads", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manager-update-"));
		try {
			const manager = new MCPManager(cwd);
			expect(manager.getServerConfig("envserver")).toBeUndefined();

			const stale: MCPServerConfig = {
				type: "http",
				url: "https://mcp.example.com/mcp",
				headers: { Authorization: "Bearer stale-token" },
				auth: staleAuth,
			};
			manager.updateServerConfig("envserver", stale);
			expect(manager.getServerConfig("envserver")).toBe(stale);

			// A reauth installs the cleaned definition in the same slot; the
			// fresh one must win over the stored one, and updating a name the
			// manager never connected must not throw (no lost-server schedule,
			// no live connection to retire).
			const fresh = clearMcpClientAuthSurface(stale);
			manager.updateServerConfig("envserver", fresh);
			expect(manager.getServerConfig("envserver")).toBe(fresh);
			expect(Object.keys(asHttpServerConfig(fresh).headers ?? {})).toEqual([]);
			expect(manager.updateServerConfig("never-configured", fresh)).toBeUndefined();
		} finally {
			await removeWithRetries(cwd);
		}
	});
});
