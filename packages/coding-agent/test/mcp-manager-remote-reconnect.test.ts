import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig, MCPServerConnection, MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp/types";

let manager: MCPManager;
let server: Bun.Server<undefined>;
let config: MCPHttpServerConfig;
let failures: number;
let failureStatus: number;
let initializeRequests: number;

beforeEach(() => {
	failures = 0;
	failureStatus = 503;
	initializeRequests = 0;
	manager = new MCPManager(process.cwd());
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			const body = (await request.json()) as { id?: number; method: string };
			if (body.id === undefined) return new Response(null, { status: 202 });
			let result: unknown;
			switch (body.method) {
				case "initialize":
					initializeRequests++;
					if (failures-- > 0) return new Response("Unavailable", { status: failureStatus });
					result = {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "recovering-hub", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = { tools: [{ name: "health", inputSchema: { type: "object" } }] };
					break;
				case "tools/call":
					result = { content: [{ type: "text", text: "Hub is online" }] };
					break;
				default:
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32601, message: "Unknown method" },
					});
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	});
	config = { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 };
	// Exercise real HTTP handshakes while advancing only the reconnect backoff.
	const sleep = Bun.sleep;
	vi.spyOn(Bun, "sleep").mockImplementation(ms =>
		typeof ms === "number" && ms >= 500 ? Promise.resolve() : sleep(ms),
	);
});

afterEach(async () => {
	await manager.disconnectAll();
	server.stop(true);
	vi.restoreAllMocks();
});

async function expectUsable(connection: MCPServerConnection): Promise<void> {
	expect(manager.getConnectionStatus("hub")).toBe("connected");
	expect(
		await connection.transport.request<MCPToolCallResult>("tools/call", { name: "health", arguments: {} }),
	).toEqual({
		content: [{ type: "text", text: "Hub is online" }],
	});
}

describe("MCP remote restart recovery", () => {
	it("keeps reconnecting after the initial retry burst is exhausted", async () => {
		await manager.connectServers({ hub: config }, {});
		const original = await manager.waitForConnection("hub");
		failures = 7;
		await original.transport.close();
		await expectUsable(await manager.waitForConnection("hub"));
	});

	it("recovers when the hub is unavailable during initial startup", async () => {
		failures = 7;
		await manager.connectServers({ hub: config }, {});
		await expectUsable(await manager.waitForConnection("hub"));
	});

	it("stops pending remote retries when the server is disconnected", async () => {
		await manager.connectServers({ hub: config }, {});
		failures = 7;
		const sleeping = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		vi.spyOn(Bun, "sleep").mockImplementation(() => {
			sleeping.resolve();
			return resume.promise;
		});
		const reconnect = manager.reconnectServer("hub");
		await sleeping.promise;
		await manager.disconnectServer("hub");
		const requestsAtDisconnect = initializeRequests;
		failures = 0;
		resume.resolve();
		expect(await reconnect).toBeNull();
		expect(manager.getConnectionStatus("hub")).toBe("disconnected");
		expect(initializeRequests).toBe(requestsAtDisconnect);
	});

	it("does not keep retrying non-transient HTTP errors", async () => {
		await manager.connectServers({ hub: config }, {});
		failures = Number.POSITIVE_INFINITY;
		failureStatus = 400;
		expect(await manager.reconnectServer("hub")).toBeNull();
		expect(manager.getConnectionStatus("hub")).toBe("disconnected");
	});
});
