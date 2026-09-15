import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig, MCPServerConnection, MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp/types";

const FAST: MCPReconnectPolicy = { retryBaseMs: 30, retryMaxMs: 60 };
// Negative contract: wait out every possible retry timer. Fake clocks cannot
// drive the real Bun.serve + fetch round trips exercised by this integration.
const QUIET_MS = FAST.retryMaxMs * 4;

let manager: MCPManager;
let server: Bun.Server<undefined>;
let config: MCPHttpServerConfig;
let failures: number;
let failureStatus: number;
let initializeRequests: number;
let terminalRequest: PromiseWithResolvers<void>;

beforeEach(() => {
	failures = 0;
	failureStatus = 503;
	initializeRequests = 0;
	terminalRequest = Promise.withResolvers<void>();
	manager = new MCPManager(process.cwd(), undefined, undefined, undefined, FAST);
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
					if (failures-- > 0) {
						if (failureStatus === 400) terminalRequest.resolve();
						return new Response("Unavailable", { status: failureStatus });
					}
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
});

afterEach(async () => {
	await manager.disconnectAll();
	server.stop(true);
});

async function expectUsable(connection: MCPServerConnection): Promise<void> {
	expect(manager.getConnectionStatus("hub")).toBe("connected");
	expect(
		await connection.transport.request<MCPToolCallResult>("tools/call", { name: "health", arguments: {} }),
	).toMatchObject({
		content: [{ type: "text", text: "Hub is online" }],
	});
}

function nextConnection(): Promise<void> {
	const connected = Promise.withResolvers<void>();
	const stop = manager.addConnectionStatusListener(event => {
		if (event.type === "connected" && event.serverName === "hub") {
			stop();
			connected.resolve();
		}
	});
	return connected.promise;
}

// A server the host already knows stays linked through an outage and is reached again by the
// next request (mcp-lost-remote-retry.test.ts). A server that was still starting when the
// session connected has no link and no tools, so nothing would ever ask for it again.
describe("MCP remote startup recovery", () => {
	it("recovers from transient initial startup failures in the background", async () => {
		failures = Number.POSITIVE_INFINITY;
		const recovered = nextConnection();
		await manager.connectServers({ hub: config }, {});
		await expect(manager.waitForConnection("hub")).rejects.toThrow();
		failures = 0;
		await recovered;

		await expectUsable(await manager.waitForConnection("hub"));
		expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__hub_health"]);
	});

	it("stops pending remote retries when the server is disconnected", async () => {
		failures = Number.POSITIVE_INFINITY;
		await manager.connectServers({ hub: config }, {});
		await expect(manager.waitForConnection("hub")).rejects.toThrow();
		await manager.disconnectServer("hub");
		const requestsAtDisconnect = initializeRequests;
		failures = 0;
		await Bun.sleep(QUIET_MS);
		expect(manager.getConnectionStatus("hub")).toBe("disconnected");
		expect(initializeRequests).toBe(requestsAtDisconnect);
	});

	it("does not retry terminal initial startup errors", async () => {
		failures = Number.POSITIVE_INFINITY;
		failureStatus = 400;
		const result = await manager.connectServers({ hub: config }, {});
		expect(result.errors.has("hub")).toBe(true);
		expect(manager.getConnectionStatus("hub")).toBe("disconnected");

		failures = 0;
		await Bun.sleep(QUIET_MS);
		expect(initializeRequests).toBe(1);
		expect(manager.getConnectionStatus("hub")).toBe("disconnected");
	});

	it("stops the background schedule when a transient startup failure becomes terminal", async () => {
		failures = Number.POSITIVE_INFINITY;
		await manager.connectServers({ hub: config }, {});
		await expect(manager.waitForConnection("hub")).rejects.toThrow();
		const requestsAfterForeground = initializeRequests;
		failureStatus = 400;

		await terminalRequest.promise;
		await manager.waitForPendingConnections();
		await Bun.sleep(QUIET_MS);
		expect(initializeRequests).toBe(requestsAfterForeground + 1);
		expect(manager.getConnectionStatus("hub")).toBe("disconnected");
	});
});
