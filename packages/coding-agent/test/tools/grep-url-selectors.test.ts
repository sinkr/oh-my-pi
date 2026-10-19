import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Minified JSON — the pretty-printed rendering of it does not contain `"needle":"x"`. */
const MINIFIED_JSON = '{"needle":"x"}';

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("GrepTool external URL selectors", () => {
	let tmpDir: string;
	let server: Bun.Server<undefined> | undefined;
	let url: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-url-"));
		server = Bun.serve({
			port: 0,
			fetch: () => new Response(MINIFIED_JSON, { headers: { "content-type": "application/json" } }),
		});
		url = `http://127.0.0.1:${server.port}/page`;
	});

	afterEach(async () => {
		server?.stop(true);
		server = undefined;
		await removeWithRetries(tmpDir);
	});

	function createSession(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => tmpDir,
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
	}

	it("searches the verbatim response body when the URL carries the :raw selector (issue #14092)", async () => {
		const tool = new GrepTool(createSession());

		// `:raw` must reach the fetch: the minified body matches, while the
		// rendered (pretty-printed) body does not contain the same bytes.
		const raw = await tool.execute("raw", { pattern: '"needle":"x"', path: `${url}:raw` });
		expect(getResultText(raw)).toContain(MINIFIED_JSON);

		const rendered = await tool.execute("rendered", { pattern: '"needle":"x"', path: url });
		expect(getResultText(rendered)).toContain("No matches found");
	});

	it("searches the whole fetched resource when the URL carries the :conflicts selector", async () => {
		const tool = new GrepTool(createSession());

		const result = await tool.execute("conflicts", { pattern: '"needle"', path: `${url}:conflicts` });
		expect(getResultText(result)).toContain("needle");
	});

	it("still rejects a URL tail selector that cannot filter matches by line number", async () => {
		const tool = new GrepTool(createSession());

		await expect(tool.execute("tail", { pattern: "needle", path: `${url}:-5` })).rejects.toThrow(/invalid selector/i);
	});
});
