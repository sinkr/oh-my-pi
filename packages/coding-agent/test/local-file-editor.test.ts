import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resolveLocalEditorTarget } from "@oh-my-pi/pi-coding-agent/modes/local-file-editor";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("resolveLocalEditorTarget", () => {
	beforeEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	it("accepts bare, local:// and local:/ names for the same file", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const planPath = path.join(tmp.path(), "local", "plan.md");
		await Bun.write(planPath, "# plan");
		const expected = await fs.realpath(planPath);

		for (const target of ["plan.md", "local://plan.md", "  local:/plan.md  "]) {
			expect((await resolveLocalEditorTarget(target, options)).path).toBe(expected);
		}
	});

	it("rejects missing files, directories, and paths escaping the local root", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		await Bun.write(path.join(tmp.path(), "local", "sub", "inner.md"), "x");
		await Bun.write(path.join(tmp.path(), "escape.md"), "outside");

		await expect(resolveLocalEditorTarget("nope.md", options)).rejects.toThrow(
			"Local file not found: local://nope.md",
		);
		await expect(resolveLocalEditorTarget("sub", options)).rejects.toThrow(
			"local://sub is a directory; name a file inside it.",
		);
		await expect(resolveLocalEditorTarget("../escape.md", options)).rejects.toThrow();
	});

	it("opens bare names containing %, #, and ? without double-decoding an encoded local:// URL", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const names = ["100%.md", "a#b.md", "a?b.md", "sub/a#b.md"];
		for (const name of names) {
			await Bun.write(path.join(tmp.path(), "local", name), name);
		}

		for (const name of names) {
			const resolved = await resolveLocalEditorTarget(name, options);
			expect(resolved.path).toBe(await fs.realpath(path.join(tmp.path(), "local", name)));
			expect(resolved.url).toBe(`local://${name}`);
		}
		expect((await resolveLocalEditorTarget("local://100%25.md", options)).path).toBe(
			await fs.realpath(path.join(tmp.path(), "local", "100%.md")),
		);
	});

	it("rejects a name whose file is a symlink to outside the local root", async () => {
		using tmp = TempDir.createSync("@omp-local-editor-");
		const options = { getArtifactsDir: () => tmp.path(), getSessionId: () => "s" };
		const outside = path.join(tmp.path(), "outside.md");
		await Bun.write(outside, "secret");
		await fs.mkdir(path.join(tmp.path(), "local"));
		await fs.symlink(outside, path.join(tmp.path(), "local", "normal.md"));

		await expect(resolveLocalEditorTarget("normal.md", options)).rejects.toThrow(/escapes/);
	});
});
