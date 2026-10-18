import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { TempDir } from "@oh-my-pi/pi-utils";
import createTool, { type TuiParams } from "../tools/tui";

const tool = createTool({ cwd: path.resolve(import.meta.dir, "../.."), zod });

async function execute(params: TuiParams): Promise<string> {
	const result = await tool.execute("regression", params);
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

// The child and ConPTY advance on an external event loop that fake timers cannot
// drive. Poll the rendered condition rather than guessing a startup delay.
async function waitForScreen(name: string, expected: string): Promise<string> {
	const deadline = Date.now() + 5_000;
	let screen = "";
	do {
		screen = await execute({ op: "screen", name });
		if (screen.includes(expected)) return screen;
		await Bun.sleep(50);
	} while (Date.now() < deadline);
	throw new Error(`Missing ${expected} in screen:\n${screen}`);
}

async function sessionDirs(name: string): Promise<string[]> {
	return (await fs.readdir(os.tmpdir())).filter(entry => entry.startsWith(`omp-tui-${name}-`));
}

afterEach(() => {
	tool.onSession({ reason: "shutdown" });
});

describe("TUI debug tool PTY launcher", () => {
	it("gives file targets a real terminal, preserves argv, and resizes before delivering input", async () => {
		using dir = TempDir.createSync("@omp-tui-tool-fixture-");
		const file = dir.join("terminal.ts");
		await Bun.write(
			file,
			`
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("TTY=" + [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY].join(",") + "\\r\\n");
process.stdout.write("ARGS=" + JSON.stringify(process.argv.slice(2)) + "\\r\\n");
process.stdout.on("resize", () => process.stdout.write("\\r\\nRESIZED=" + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n"));
process.stdin.on("data", chunk => {
  if (chunk.toString() === "p") process.stdout.write("\\x1b[4;7H\\x1b[6n");
  if (chunk.toString().includes("\\x1b[")) process.stdout.write("\\r\\nREPLY=" + JSON.stringify(chunk.toString()) + "\\r\\n");
  if (chunk.toString().includes("x")) process.stdout.write("\\r\\nSIZE=" + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n");
});
`,
		);
		const name = `terminal-${crypto.randomUUID()}`;
		const args = ['space and "quote"', "中文", "trailing\\"];
		await execute({ op: "start", name, file, args, cols: 100, rows: 30, timeout: 0.2 });
		const screen = await waitForScreen(name, `ARGS=${JSON.stringify(args)}`);
		expect(screen).toContain("TTY=true,true,true");
		await execute({ op: "send", name, text: "p", quiet: true });
		await waitForScreen(name, 'REPLY="\\u001b[4;7R"');
		await execute({ op: "resize", name, cols: 48, rows: 18, quiet: true });
		await waitForScreen(name, "RESIZED=48x18");
		await execute({ op: "send", name, text: "x", quiet: true });
		expect(await waitForScreen(name, "SIZE=48x18")).toContain("screen 48x18");
		expect(await execute({ op: "stop", name })).toContain("exit -9");
		expect(await sessionDirs(name)).toEqual([]);
	}, 15_000);

	it("reports a fast bin target's exit code and output without leaving a session or temp directory", async () => {
		const name = `finite-${crypto.randomUUID()}`;
		await expect(
			execute({
				op: "start",
				name,
				bin: process.execPath,
				args: ["-e", 'process.stdout.write("FINITE-OUTPUT"); process.exit(7)'],
				timeout: 3,
			}),
		).rejects.toThrow(/code 7[\s\S]*FINITE-OUTPUT/);
		expect(await execute({ op: "list" })).not.toContain(name);
		expect(await sessionDirs(name)).toEqual([]);
	}, 15_000);

	it("cleans up a failed executable launch and permits reusing its session name", async () => {
		const name = `missing-${crypto.randomUUID()}`;
		await expect(
			execute({ op: "start", name, bin: path.join(os.tmpdir(), crypto.randomUUID(), "missing.exe") }),
		).rejects.toThrow(/missing\.exe/);
		expect(await sessionDirs(name)).toEqual([]);
		await expect(
			execute({
				op: "start",
				name,
				bin: process.execPath,
				args: ["-e", 'process.stdout.write("REUSED-NAME"); process.exit(3)'],
				timeout: 3,
			}),
		).rejects.toThrow(/code 3[\s\S]*REUSED-NAME/);
		expect(await execute({ op: "list" })).not.toContain(name);
		expect(await sessionDirs(name)).toEqual([]);
	}, 15_000);
});
