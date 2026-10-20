import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { loadPage } from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

function makeSession(): ToolSession {
	const cwd = process.cwd();
	const artifactsDir = path.join(cwd, ".fetch-user-agent-retry-artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => ({ id: "test", path: path.join(artifactsDir, `test.${toolType}.log`) }),
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

const ARTICLE = `<html><head><title>Filing</title></head><body><main><h1>Quarterly report</h1>
<p>${"Revenue grew in the quarter while operating costs held steady across every segment. ".repeat(4)}</p>
</main></body></html>`;

describe("read URL refused for one user agent", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	function serveRefusingCurl(refusal: () => Response): Bun.Server<undefined> {
		const server = Bun.serve({
			port: 0,
			fetch: request =>
				request.headers.get("user-agent")?.startsWith("curl/")
					? refusal()
					: new Response(ARTICLE, { headers: { "content-type": "text/html" } }),
		});
		servers.push(server);
		return server;
	}

	async function readText(server: Bun.Server<undefined>) {
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/filing.htm`,
		});
		return { method: result.details?.method, text: result.content.find(block => block.type === "text")?.text };
	}

	it("reads the page from the next user agent when a bare 403 page names no bot check", async () => {
		const server = serveRefusingCurl(
			() =>
				new Response("<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>", {
					status: 403,
					headers: { "content-type": "text/html" },
				}),
		);

		const { method, text } = await readText(server);

		expect(method).not.toBe("failed");
		expect(text).toContain("Revenue grew in the quarter");
	});

	it("reads the page from the next user agent before waiting out a 429's Retry-After", async () => {
		const server = serveRefusingCurl(() => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "10" } }));

		const started = performance.now();
		const { method, text } = await readText(server);

		expect(method).not.toBe("failed");
		expect(text).toContain("Revenue grew in the quarter");
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("sends a caller's own User-Agent once instead of repeating a refused request", async () => {
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				requests++;
				return new Response("Forbidden", { status: 403 });
			},
		});
		servers.push(server);

		const result = await loadPage(`http://127.0.0.1:${server.port}/api`, { headers: { "User-Agent": "omp/test" } });

		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
		expect(requests).toBe(1);
	});
});
