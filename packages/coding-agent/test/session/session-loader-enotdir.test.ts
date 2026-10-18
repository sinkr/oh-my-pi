import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

// Windows reports ENOENT (not ENOTDIR) when a path component is a regular
// file; loadSessionFile must keep the ENOTDIR rejection POSIX produces so a
// malformed session path is not masked as a missing session.
describe("loadSessionFile path errors", () => {
	it("rejects a session path with a regular-file component", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		fs.writeFileSync(file, "not a directory");
		await expect(loadSessionFile(path.join(file, "sub", "session.jsonl"))).rejects.toMatchObject({
			code: "ENOTDIR",
		});
	});
});
