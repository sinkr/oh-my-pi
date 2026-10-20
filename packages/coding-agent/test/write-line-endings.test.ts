import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("write tool keeps the replaced file's line endings and BOM", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-line-endings-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("writes CRLF when replacing a CRLF file with LF content", async () => {
		const filePath = path.join(tmpDir, "build.bat");
		await fs.writeFile(filePath, "@echo off\r\necho old\r\n");

		const result = await new WriteTool(createSession(tmpDir)).execute("call-1", {
			path: filePath,
			content: "@echo off\necho new\n",
		});

		expect(await fs.readFile(filePath, "latin1")).toBe("@echo off\r\necho new\r\n");
		expect(resultText(result)).toContain(
			"Successfully wrote 21 bytes to build.bat\nNote: kept the replaced file's CRLF line endings.",
		);
	});

	it("keeps a UTF-8 BOM when replacing a BOM file", async () => {
		const filePath = path.join(tmpDir, "notes.txt");
		await fs.writeFile(filePath, "\uFEFFhello\nworld\n");

		await new WriteTool(createSession(tmpDir)).execute("call-1", { path: filePath, content: "hello\nthere\n" });

		expect([...(await fs.readFile(filePath)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFhello\nthere\n");
	});

	it("keeps both CRLF and the BOM, and the returned tag edits the file", async () => {
		const filePath = path.join(tmpDir, "Program.cs");
		await fs.writeFile(filePath, "\uFEFFclass A {}\r\n");
		const session = createSession(tmpDir);

		const writeResult = await new WriteTool(session).execute("call-1", {
			path: filePath,
			content: "class A {}\nclass B {}\n",
		});
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFclass A {}\r\nclass B {}\r\n");
		expect(resultText(writeResult)).toContain("Note: kept the replaced file's CRLF line endings and UTF-8 BOM.");

		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		await new EditTool(session, "hashline").execute("call-2", {
			input: `${headerLine}\nPUT 2.=2:\n+class C {}\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFclass A {}\r\nclass C {}\r\n");
	});

	it("writes content that already has carriage returns as given", async () => {
		const crlfPath = path.join(tmpDir, "crlf.txt");
		await fs.writeFile(crlfPath, "a\r\nb\r\n");
		const crlfResult = await new WriteTool(createSession(tmpDir)).execute("call-1", {
			path: crlfPath,
			content: "x\ny\r\n",
		});
		expect(await fs.readFile(crlfPath, "latin1")).toBe("x\ny\r\n");
		expect(resultText(crlfResult)).not.toContain("Note: kept");

		const lfPath = path.join(tmpDir, "lf.txt");
		await fs.writeFile(lfPath, "a\nb\n");
		await new WriteTool(createSession(tmpDir)).execute("call-2", { path: lfPath, content: "x\r\ny\r\n" });
		expect(await fs.readFile(lfPath, "latin1")).toBe("x\r\ny\r\n");
	});

	it("writes new files and replaced LF or binary files as given", async () => {
		const tool = new WriteTool(createSession(tmpDir));

		const newPath = path.join(tmpDir, "new.txt");
		await tool.execute("call-1", { path: newPath, content: "a\nb\n" });
		expect(await fs.readFile(newPath, "latin1")).toBe("a\nb\n");

		const lfPath = path.join(tmpDir, "lf.txt");
		await fs.writeFile(lfPath, "a\nb\n");
		const lfResult = await tool.execute("call-2", { path: lfPath, content: "c\nd\n" });
		expect(await fs.readFile(lfPath, "latin1")).toBe("c\nd\n");
		expect(resultText(lfResult)).not.toContain("Note: kept");

		// A PNG signature has a CRLF pair and NUL bytes: it says nothing about text line endings.
		const pngPath = path.join(tmpDir, "image.png");
		await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
		await tool.execute("call-3", { path: pngPath, content: "not an image\nanymore\n" });
		expect(await fs.readFile(pngPath, "latin1")).toBe("not an image\nanymore\n");
	});

	it("does not leave a lone BOM when emptying a BOM file", async () => {
		const filePath = path.join(tmpDir, "empty.txt");
		await fs.writeFile(filePath, "\uFEFFold\r\n");
		await new WriteTool(createSession(tmpDir)).execute("call-1", { path: filePath, content: "" });
		expect((await fs.readFile(filePath)).length).toBe(0);
	});
});
