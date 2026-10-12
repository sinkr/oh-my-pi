import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	getTab,
	listTabs,
	releaseAllTabs,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const session: ToolSession = {
	cwd: process.cwd(),
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
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-worker-exit-test" };

async function open(name: string, body: string): Promise<void> {
	await prelude.invoke({ action: "open", name, url: `data:text/html,<body>${body}</body>` }, context);
	expect(getTab(name)?.backend).toBe("worker");
}

async function run(name: string, code: string): Promise<unknown> {
	const result = (await prelude.invoke({ action: "run", name, code, timeout: 20 }, context)) as {
		details?: Record<string, unknown>;
	};
	return result.details?.value;
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
	const error = await rejectionOf(promise);
	return error instanceof Error ? error.message : String(error);
}

// A rejection whose stack never touches the run's source, as a Puppeteer event handler's would: the
// worker's run guard leaves it alone, so it ends the worker.
const UNOWNED_REJECTION = `
	const err = new Error("library-internal");
	err.stack = "Error: library-internal\\n    at #onFileChooser (puppeteer/Page.js:1:1)";
	Promise.reject(err);
	await Promise.withResolvers().promise;
`;

/** Crash `name`'s worker and hold its reattachment until the returned `release` is called. */
async function crashAndHoldRecovery(name: string): Promise<{ crash: string; release: () => void }> {
	const tab = getTab(name);
	if (tab?.backend !== "worker") throw new Error("expected a worker tab");
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const worker = tab.worker;
	const terminate = worker.terminate.bind(worker);
	// The reattach starts by terminating the exited worker; parking it there keeps the recovery in flight.
	let calls = 0;
	worker.terminate = async () => {
		if (calls++ === 0) {
			entered.resolve();
			await gate.promise;
		}
		await terminate();
	};
	const crash = await messageOf(run(name, UNOWNED_REJECTION));
	await entered.promise;
	return { crash, release: () => gate.resolve() };
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab worker exit", () => {
	it("fails the call at once and continues on the same page with a new worker", async () => {
		const name = "worker-exit-reattach";
		await open(name, "alive");
		await run(name, `await tab.evaluate(() => { document.body.dataset.mark = "kept"; });`);

		const started = Date.now();
		const crash = await messageOf(run(name, UNOWNED_REJECTION));
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(crash).toMatch(/Browser tab worker exited unexpectedly \(exit code \d+, library-internal\)/);
		expect(crash).toContain("the tab is being reattached");

		expect(listTabs().some(tab => tab.name === name)).toBe(true);
		expect(await run(name, "return await tab.evaluate(() => document.body.dataset.mark);")).toBe("kept");
	}, 30_000);

	it("closes the tab when the new worker exits again right away", async () => {
		const name = "worker-exit-loop";
		await open(name, "alive");
		expect(await messageOf(run(name, UNOWNED_REJECTION))).toContain("the tab is being reattached");

		const again = await messageOf(run(name, UNOWNED_REJECTION));
		expect(again).toContain("library-internal");
		expect(again).toContain("again right after being replaced");
		expect(listTabs().some(tab => tab.name === name)).toBe(false);
		expect(await messageOf(run(name, "return 1;"))).toContain(`Tab "${name}" was killed`);

		await open(name, "again");
		expect(await run(name, "return 3;")).toBe(3);
	}, 30_000);

	it("runs a call that arrives during the reattach on the reattached page", async () => {
		const name = "worker-exit-queued";
		await open(name, "original");
		const { crash, release } = await crashAndHoldRecovery(name);
		expect(crash).toContain("the tab is being reattached");

		const queued = run(name, "return await tab.evaluate(() => document.body.textContent);");
		release();
		expect(await queued).toBe("original");
	}, 30_000);

	it("settles a call waiting on the reattach when it is aborted or runs out of time", async () => {
		const name = "worker-exit-cancel";
		await open(name, "original");
		const { release } = await crashAndHoldRecovery(name);
		try {
			const ac = new AbortController();
			const aborted = messageOf(
				runInTab(name, { code: "return 1;", timeoutMs: 20_000, signal: ac.signal, session }),
			);
			const timedOut = messageOf(runInTab(name, { code: "return 1;", timeoutMs: 200, session }));
			ac.abort();
			expect(await aborted).toMatch(/abort/i);
			expect(await timedOut).toContain("was still being reattached after 200ms");
		} finally {
			release();
		}
		expect(await run(name, "return 2;")).toBe(2);
	}, 30_000);

	it("does not run a call waiting on the reattach on a tab reopened under the same name", async () => {
		const name = "worker-exit-reopened";
		await open(name, "original");
		const { release } = await crashAndHoldRecovery(name);

		const queued = messageOf(run(name, `await tab.evaluate(() => { document.body.dataset.queued = "ran"; });`));
		await releaseTab(name);
		await open(name, "replacement");
		release();

		expect(await queued).toContain("was closed while its worker was being reattached");
		expect(await run(name, "return await tab.evaluate(() => document.body.dataset.queued ?? null);")).toBeNull();
	}, 30_000);
});
