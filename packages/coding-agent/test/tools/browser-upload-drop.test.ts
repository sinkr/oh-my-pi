import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// A drop zone, and a plain element that neither opens a chooser nor takes a drop. Like react-dropzone, the page
// cancels dragover and drop everywhere so a file dropped outside the zone does not navigate away.
const html = `<!doctype html>
<style>div { display: block; margin: 8px; padding: 8px; }</style>
<div id="drop">Drop files here</div>
<div id="inert">Not a drop zone</div>
<script>
window.log = [];
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => {
  event.preventDefault();
  log.push({ id: "drop", names: [...event.dataTransfer.files].map(file => file.name) });
});
document.getElementById("inert").addEventListener("drop", event => log.push({ id: "inert", names: [] }));
document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => event.preventDefault());
</script>`;

let tempDir = "";
let site: Bun.Server<undefined> | undefined;
let url = "";

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
	site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
	});
	url = `http://127.0.0.1:${site.port}/`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	site?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile", () => {
	test("fails when the target neither opens a chooser nor accepts a drop", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-upload-inert" };
		const name = `upload-${crypto.randomUUID()}`;
		await prelude.invoke({ action: "open", name, url }, context);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					timeout: 15,
					code: `const errors = [];
for (const selector of ["#drop", "#inert"]) {
	try { await tab.uploadFile(selector, "alpha.txt"); errors.push(null); }
	catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return { errors, log: await tab.evaluate(() => window.log) };`,
				},
				context,
			);
			const details = result.details;
			if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
			// `run` details carry the cell's return value untyped.
			const { errors, log } = details.value as { errors: (string | null)[]; log: unknown[] };
			expect(errors[0]).toBeNull();
			expect(errors[1]).toContain("opened no file chooser and nothing on the page took the dropped files");
			// The inert element and the document saw the drop event but did not take its files.
			expect(log).toEqual([
				{ id: "drop", names: ["alpha.txt"] },
				{ id: "inert", names: [] },
			]);
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
		}
	}, 60_000);
});
