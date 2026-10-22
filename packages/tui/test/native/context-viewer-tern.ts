/**
 * Opt-in physical-layout regression; deliberately not a bun:test suite.
 * Run from any directory: bun packages/tui/test/native/context-viewer-tern.ts --tern /path/to/tern
 * Prerequisites: Bun, installed Tern with `serve`, `ctl dump/tree`, `move` and `wheel`.
 * Use tern.com on Windows. No display, user account, recordings or configuration required.
 * --keep retains synthetic captures/logs for inspecting selection bars and full-width footer decoration.
 * This checks renderer geometry, not NativeNode props or the ANSI fallback.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log(
		"Usage: bun packages/tui/test/native/context-viewer-tern.ts [--tern PATH] [--keep]\nRequires Bun and Tern serve/ctl with dump, tree, move, wheel. Uses isolated synthetic state and an unused local port. --keep retains PNG/layout captures and logs for visual inspection.",
	);
	process.exit(0);
}
let tern = Bun.which(process.platform === "win32" ? "tern.com" : "tern");
let keep = false;
for (let index = 0; index < args.length; index++) {
	if (args[index] === "--keep") keep = true;
	else if (args[index] === "--tern" && args[index + 1]) tern = path.resolve(args[++index]!);
	else throw new Error(`Unknown or incomplete option: ${args[index]}`);
}
assert(tern, "Tern CLI not found; pass --tern PATH (tern.com on Windows)");

interface Element {
	path: string;
	nth: string;
	rect: [number, number, number, number];
	visible: boolean;
}
interface Layout {
	elements: Element[];
	footer?: Element;
}
interface TreeResponse {
	ok: boolean;
	count: number;
	nodes: { text: string; rect: [number, number, number, number] }[];
}
const tolerance = 0.75;
function one(layout: Layout, suffix: string): Element {
	const matches = layout.elements.filter(element => element.path.endsWith(suffix) && element.visible);
	assert.equal(matches.length, 1, `Expected one visible ${suffix}, got ${matches.length}`);
	return matches[0]!;
}
function contains(outer: Element, inner: Element): boolean {
	const [x, y, w, h] = outer.rect;
	const [ix, iy, iw, ih] = inner.rect;
	return (
		iw > 0 &&
		ih > 0 &&
		ix >= x - tolerance &&
		iy >= y - tolerance &&
		ix + iw <= x + w + tolerance &&
		iy + ih <= y + h + tolerance
	);
}
function fixed(before: Element, after: Element, label: string): void {
	assert(
		before.rect.every((value, index) => Math.abs(value - after.rect[index]!) <= tolerance),
		`${label} moved: ${before.rect} -> ${after.rect}`,
	);
}
function footerGeometry(layout: Layout): { viewport: Element; footer: Element } {
	const card = one(layout, "div.sf-ov-card");
	// Tern renderer classes, not ContextViewer's keys or child hierarchy.
	const viewport = one(layout, "div.sf-list-scroll.max");
	const footer = layout.footer;
	assert(footer, "Missing semantic footer geometry");
	assert(contains(card, footer), `Footer clipped by overlay: ${footer.rect}; overlay ${card.rect}`);
	assert(contains(card, viewport), `Scroller escapes overlay: ${viewport.rect}`);
	assert(
		viewport.rect[1] + viewport.rect[3] <= footer.rect[1] + tolerance,
		`Scroller overlaps footer: ${viewport.rect}; footer ${footer.rect}`,
	);
	assert(!footer.path.startsWith(`${viewport.path}>`), "Footer is inside the scrolling/clipping region");
	return { viewport, footer };
}

// Bind first to choose a free port, then release it immediately before starting our server.
const listener = net.createServer();
const listening = Promise.withResolvers<void>();
listener.once("error", listening.reject);
listener.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = listener.address();
assert(address && typeof address !== "string");
const port = String(address.port);
const closed = Promise.withResolvers<void>();
listener.close(error => (error ? closed.reject(error) : closed.resolve()));
await closed.promise;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-context-viewer-tern-"));
if (keep) console.log(`Synthetic regression artifacts: ${root}`);
const env = {
	...process.env,
	TERN_CONFIG_DIR: path.join(root, "config"),
	TERN_DAEMON_SOCKET: path.join(root, "daemon.sock"),
	STENCIL_LOG_DIR: path.join(root, "logs"),
	PI_TUI_TSP_RECORD: path.join(root, "native.jsonl"),
};
let child: Bun.Subprocess;
try {
	child = Bun.spawn([tern, "serve", "--control", port, "--out", path.join(root, "shots")], {
		env,
		stdout: "ignore",
		stderr: Bun.file(path.join(root, "serve.log")),
	});
} catch (error) {
	await fs.rm(root, { recursive: true, force: true });
	throw error;
}
let interrupted = false;
const interrupt = () => {
	interrupted = true;
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function ctl(...command: string[]): Promise<string> {
	assert(!interrupted || command[0] === "key" || command[0] === "quit", "Interrupted");
	const request = Bun.spawn([tern!, "ctl", "--control", port, ...command], { env, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => request.kill(), 15000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(request.stdout).text(),
			new Response(request.stderr).text(),
			request.exited,
		]);
		assert.equal(code, 0, `ctl ${command.join(" ")} failed: ${stderr}\n${stdout}`);
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}
async function capture(name: string): Promise<Layout> {
	const footerDump: Layout = JSON.parse(await ctl("dump", '[data-role="omp.actions"]'));
	assert.equal(footerDump.elements.length, 1, "Expected one action footer");
	await ctl("shot", name);
	const layout: Layout = await Bun.file(path.join(root, "shots", "serve", `${name}.layout.json`)).json();
	// Resolve the public role to the matching captured box, without depending on app hierarchy.
	layout.footer = layout.elements.find(element => element.nth === footerDump.elements[0]!.nth);
	return layout;
}
async function selected(): Promise<Element> {
	const dump: Layout = JSON.parse(await ctl("dump", "[data-mark=pick]"));
	assert.equal(dump.elements.length, 1, "Expected one selected entry");
	return dump.elements[0]!;
}
async function until(label: string, check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10000;
	let lastError: unknown;
	while (Date.now() < deadline && !interrupted) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

try {
	// Probe only readiness, never reuse a pre-existing endpoint or touch another session.
	// Native GPU/font initialization precedes endpoint startup; keep one bounded attempt.
	const deadline = Date.now() + 60000;
	while (true) {
		assert(child.exitCode === null && !interrupted, `Tern exited before readiness; see ${root}`);
		const connection = Promise.withResolvers<boolean>();
		const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
		socket.setTimeout(250);
		socket.once("connect", () => {
			socket.destroy();
			connection.resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			connection.resolve(false);
		});
		socket.once("timeout", () => {
			socket.destroy();
			connection.resolve(false);
		});
		const connected = await connection.promise;
		if (connected) break;
		assert(
			Date.now() < deadline,
			`Tern control endpoint did not become ready within 60s; see ${path.join(root, "logs", "tern-serve.log")}`,
		);
		await Bun.sleep(100);
	}
	const fixture = path.join(import.meta.dir, "fixtures", "context-viewer-tern.ts");
	// Match the verified bootstrap for shell-safe paths; quote only when necessary.
	const quote = (value: string) => {
		const normalized = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
		if (/^[A-Za-z0-9_./:\\-]+$/.test(normalized)) return normalized;
		return process.platform === "win32" ? `"${normalized}"` : `'${normalized.replaceAll("'", `'"'"'`)}'`;
	};
	const command = `${quote(process.execPath)} ${quote(fixture)}`;
	const bootstrap = path.join(root, "bootstrap.txt");
	await Bun.write(
		bootstrap,
		`account signed-in ContextViewerRegression\nagent-command ${JSON.stringify(command)}\nblock agent\n`,
	);
	await ctl("--file", bootstrap);
	await ctl("resize", "900", "620");
	const css = path.join(root, "still.css");
	await Bun.write(
		css,
		".sf-ov-card, .sf-ov-dim { opacity: 1 !important; animation: none !important; transform: none !important; }",
	);
	await ctl("css", "context-viewer-regression", css);
	await until("initial selected entry inside the Native viewport", async () => {
		const tree: TreeResponse = JSON.parse(await ctl("tree", "[data-mark=pick]"));
		const viewport: Layout = JSON.parse(await ctl("dump", ".sf-list-scroll.max"));
		return (
			tree.count === 1 &&
			tree.nodes[0]!.text.includes("[ENTRY-0]") &&
			viewport.elements.length === 1 &&
			contains(viewport.elements[0]!, await selected())
		);
	});
	const before = await capture("before");
	const initial = footerGeometry(before);
	const initialPick = await selected();
	assert(contains(initial.viewport, initialPick), "Initial selection is not fully visible");

	const [x, y, width, height] = initial.viewport.rect;
	await ctl("move", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
	await ctl("wheel", "0", "450");
	await until("real wheel displacement", async () => {
		const slot: Layout = JSON.parse(await ctl("dump", ".sf-list-slot"));
		return (
			slot.elements.length === 1 &&
			one(before, "div.sf-list-slot").rect[1] - slot.elements[0]!.rect[1] > 100 &&
			!contains(initial.viewport, await selected())
		);
	});
	const wheeled = await capture("wheel");
	const afterWheel = footerGeometry(wheeled);
	const movement = one(before, "div.sf-list-slot").rect[1] - one(wheeled, "div.sf-list-slot").rect[1];
	assert(movement > 100, `Real wheel did not displace content enough to hide selection: ${movement}px`);
	fixed(initial.viewport, afterWheel.viewport, "Scroller");
	fixed(initial.footer, afterWheel.footer, "Footer");
	assert(!contains(afterWheel.viewport, await selected()), "Wheel did not move selected entry outside viewport");

	await ctl("key", "down");
	await until("keyboard selection and reveal after wheel", async () => {
		const tree: TreeResponse = JSON.parse(await ctl("tree", "[data-mark=pick]"));
		return (
			tree.count === 1 && tree.nodes[0]!.text.includes("[ENTRY-1]") && contains(initial.viewport, await selected())
		);
	});
	const keyboard = await capture("keyboard-after-wheel");
	const afterKey = footerGeometry(keyboard);
	const selectedTree: TreeResponse = JSON.parse(await ctl("tree", "[data-mark=pick]"));
	assert(selectedTree.count === 1 && selectedTree.nodes[0]!.text.includes("[ENTRY-1]"), "Down did not select ENTRY-1");
	assert(contains(afterKey.viewport, await selected()), "Keyboard after wheel did not reveal the selected entry");
	fixed(initial.footer, afterKey.footer, "Footer after keyboard reveal");
	console.log(
		`PASS Native ContextViewer: footer outside viewport, real wheel moved content ${movement}px, fixed footer, keyboard reveal`,
	);
	if (keep)
		console.log(
			`Inspect PNGs for selection bars and full-width footer decoration: ${path.join(root, "shots", "serve")}`,
		);
} finally {
	// Closing the owned fixture and server also releases the isolated daemon's pane.
	if (child.exitCode === null) {
		try {
			await ctl("key", "escape");
			await ctl("key", "escape");
			await ctl("quit");
		} catch {
			child.kill();
		}
	}
	const timer = setTimeout(() => child.kill(), 5000);
	try {
		await child.exited;
	} finally {
		clearTimeout(timer);
	}
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", interrupt);
	if (keep) {
		for (const name of ["config", "daemon.sock"]) {
			await fs.rm(path.join(root, name), { recursive: true, force: true });
		}
	} else await fs.rm(root, { recursive: true, force: true });
}
