/**
 * `mr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache, router, and default-project singletons. `gitlab.json` / `gitlab.text`
 * are spied per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	GITLAB_DEFAULT_PROJECT_INFLIGHT,
	GITLAB_DEFAULT_PROJECT_RESOLVED,
} from "@oh-my-pi/pi-coding-agent/tools/glab-mr";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { gitlab } from "@oh-my-pi/pi-coding-agent/utils/gitlab";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const diffText = `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -1 +1 @@
-one
+uno
diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1 +1 @@
-two
+dos
`;
const secondSection = diffText.slice(diffText.indexOf("diff --git a/src/two.ts"));

let tempDir: string;
let originalCacheDb: string | undefined;
let originalToken: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mr-protocol-"));
	originalCacheDb = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	originalToken = process.env.GITLAB_TOKEN;
	process.env.GITLAB_TOKEN = "test-token";
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	GITLAB_DEFAULT_PROJECT_RESOLVED.clear();
	GITLAB_DEFAULT_PROJECT_INFLIGHT.clear();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	GITLAB_DEFAULT_PROJECT_RESOLVED.clear();
	GITLAB_DEFAULT_PROJECT_INFLIGHT.clear();
	if (originalCacheDb === undefined) delete process.env.OMP_GITHUB_CACHE_DB;
	else process.env.OMP_GITHUB_CACHE_DB = originalCacheDb;
	if (originalToken === undefined) delete process.env.GITLAB_TOKEN;
	else process.env.GITLAB_TOKEN = originalToken;
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

describe("mr:// diff family", () => {
	it("lists changed files of a nested-group project with per-file mr:// links", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.example.com/acme/platform/api/7/diff");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Merge Request Diff: gitlab.example.com/acme/platform/api!7 (2 files)");
		expect(resource.content).toContain("mr://gitlab.example.com/acme/platform/api/7/diff/1");
		expect(resource.content).toContain("mr://gitlab.example.com/acme/platform/api/7/diff/2");
		const args = textSpy.mock.calls[0]![1] as string[];
		expect(args.slice(0, 5)).toEqual(["mr", "diff", "7", "-R", "https://gitlab.example.com/acme/platform/api"]);
	});

	it("slices one file, returns the full diff, and rejects an out-of-range index", async () => {
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const slice = await router.resolve("mr://gitlab.com/g/p/7/diff/2");
		expect(slice.content).toBe(secondSection);
		const all = await router.resolve("mr://gitlab.com/g/p/7/diff/all");
		expect(all.content).toBe(diffText);
		await expect(router.resolve("mr://gitlab.com/g/p/7/diff/3")).rejects.toThrow(/MR has 2 files/);
	});

	it("serves a repeat read from the cache without re-running glab", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const first = await router.resolve("mr://gitlab.com/g/p/7/diff/1");
		const second = await router.resolve("mr://gitlab.com/g/p/7/diff/1");

		expect(first.notes?.[0]).toBe("Fetched live");
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("resolves the short form against the project glab reports for the session cwd", async () => {
		const jsonSpy = vi
			.spyOn(gitlab, "json")
			.mockResolvedValue({ web_url: "https://gitlab.example.com/acme/platform/api" });
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://7/diff", { cwd: tempDir });

		expect(resource.content).toContain("# Merge Request Diff: gitlab.example.com/acme/platform/api!7 (2 files)");
		expect(jsonSpy.mock.calls[0]![1]).toEqual(["repo", "view", "-F", "json"]);
	});

	it("rejects URLs without a diff suffix or a group/project pair", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mr://gitlab.com/g/p/7")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com/g/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("retries without --raw when the instance has no raw diff endpoint", async () => {
		const textSpy = vi
			.spyOn(gitlab, "text")
			.mockRejectedValueOnce(new Error("could not obtain raw diff: 404 Not Found"))
			.mockResolvedValueOnce(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.com/g/p/7/diff");

		expect(resource.content).toContain("(2 files)");
		expect(textSpy).toHaveBeenCalledTimes(2);
		expect(textSpy.mock.calls[0]![1]).toContain("--raw");
		expect(textSpy.mock.calls[1]![1]).not.toContain("--raw");
	});
});
