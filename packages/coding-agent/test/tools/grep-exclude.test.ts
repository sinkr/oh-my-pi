import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

describe("grep `!glob` exclusions", () => {
	let cwd: string;
	let tool: GrepTool;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-exclude-"));
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new GrepTool(session);
		for (const name of [
			"src/app.ts",
			"src/app.test.ts",
			"src/legacy/old.ts",
			"src/deep/legacy/kept.ts",
			"scripts/release.ts",
			"gen/schema.ts",
			"tools/gen/kept.ts",
			...Array.from({ length: 25 }, (_, index) => `vendor/pkg${index}/index.js`),
		]) {
			await Bun.write(path.join(cwd, name), "needle\n");
		}
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	const files = async (args: { path?: string }) =>
		(await tool.execute("exclude", { pattern: "needle", ...args })).details?.files ?? [];

	it("leaves out files and folders named by `!` entries", async () => {
		expect(await files({ path: "src;!*.test.ts" })).toEqual([
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
		]);
	});

	it("anchors an exclusion with a `/` to cwd instead of matching it at any depth", async () => {
		expect(await files({ path: "src;!src/legacy" })).toEqual([
			"src/app.test.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
		]);
		expect(await files({ path: "!./gen;!vendor" })).toEqual([
			"scripts/release.ts",
			"src/app.test.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
			"tools/gen/kept.ts",
		]);
	});

	it("searches cwd when every entry is an exclusion, without paging through excluded files", async () => {
		const result = await tool.execute("only-exclusions", { pattern: "needle", path: "!vendor;!gen;!*.test.ts" });
		expect(result.details?.files).toEqual([
			"scripts/release.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
		]);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).not.toContain("skip=");
	});

	it("still searches a real path whose name starts with `!`", async () => {
		await Bun.write(path.join(cwd, "!notes.txt"), "needle\n");
		expect(await files({ path: "!notes.txt" })).toEqual(["!notes.txt"]);
	});

	it("grants approval for searched roots only, keeping a real path whose name starts with `!`", async () => {
		await Bun.write(path.join(cwd, "!notes.txt"), "needle\n");
		const targets = (pathArg?: string) => tool.approvalCacheTargets(pathArg === undefined ? {} : { path: pathArg });
		expect(targets("src;!*.test.ts")).toEqual(targets("src"));
		expect(targets("!vendor;!gen")).toEqual(targets(undefined));
		expect(targets("src;!notes.txt")).toEqual([...(targets("src") ?? []), ...(targets("!notes.txt") ?? [])]);
		expect(targets("!notes.txt")).toHaveLength(1);
	});
});
