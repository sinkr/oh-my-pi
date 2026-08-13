import { describe, expect, it } from "bun:test";
import { syncHerdrTitles } from "@oh-my-pi/pi-coding-agent/utils/herdr-title";

const HERDR_ENV = {
	HERDR_ENV: "1",
	HERDR_TAB_ID: "w1:t2",
	HERDR_WORKSPACE_ID: "w1",
} as const;

describe("syncHerdrTitles", () => {
	it("renames only the HerdR tab, never the workspace", async () => {
		const calls: string[][] = [];
		const result = await syncHerdrTitles("Fix login flow", HERDR_ENV, async command => {
			calls.push([...command]);
			return 0;
		});

		expect(result).toBe("renamed");
		expect(calls).toEqual([["herdr", "tab", "rename", "w1:t2", "Fix login flow"]]);
	});

	it("skips when only a workspace id is present", async () => {
		const calls: string[][] = [];
		const result = await syncHerdrTitles(
			"Workspace only",
			{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
			async command => {
				calls.push([...command]);
				return 0;
			},
		);

		expect(result).toBe("skipped");
		expect(calls).toEqual([]);
	});

	it("does nothing outside HerdR", async () => {
		let invoked = 0;
		const noEnv = await syncHerdrTitles("Anywhere", {}, async () => {
			invoked++;
			return 0;
		});
		const noIds = await syncHerdrTitles("No targets", { HERDR_ENV: "1" }, async () => {
			invoked++;
			return 0;
		});

		expect(noEnv).toBe("skipped");
		expect(noIds).toBe("skipped");
		expect(invoked).toBe(0);
	});

	it("reports a failure when the tab rename fails", async () => {
		const exitOne = await syncHerdrTitles("Half", HERDR_ENV, async () => 1);
		const thrown = await syncHerdrTitles("Boom", HERDR_ENV, async () => {
			throw new Error("spawn failed");
		});

		expect(exitOne).toBe("failed");
		expect(thrown).toBe("failed");
	});
});
