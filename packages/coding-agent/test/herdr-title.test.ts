import { describe, expect, it } from "bun:test";
import { syncHerdrTitles } from "@oh-my-pi/pi-coding-agent/utils/herdr-title";

const HERDR_ENV = {
	HERDR_ENV: "1",
	HERDR_TAB_ID: "w1:t2",
	HERDR_WORKSPACE_ID: "w1",
} as const;

describe("syncHerdrTitles", () => {
	it("renames both the current HerdR tab and workspace", async () => {
		const calls: string[][] = [];
		const result = await syncHerdrTitles("Fix login flow", HERDR_ENV, async command => {
			calls.push([...command]);
			return 0;
		});

		expect(result).toBe("renamed");
		expect(calls).toContainEqual(["herdr", "tab", "rename", "w1:t2", "Fix login flow"]);
		expect(calls).toContainEqual(["herdr", "workspace", "rename", "w1", "Fix login flow"]);
		expect(calls).toHaveLength(2);
	});

	it("renames only the surfaces whose ids are present", async () => {
		const calls: string[][] = [];
		const result = await syncHerdrTitles("Tab only", { HERDR_ENV: "1", HERDR_TAB_ID: "w9:t1" }, async command => {
			calls.push([...command]);
			return 0;
		});

		expect(result).toBe("renamed");
		expect(calls).toEqual([["herdr", "tab", "rename", "w9:t1", "Tab only"]]);
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

	it("reports a failure when any surface rename fails", async () => {
		const exitOneForWorkspace = await syncHerdrTitles("Half", HERDR_ENV, async command =>
			command[1] === "workspace" ? 1 : 0,
		);
		const thrown = await syncHerdrTitles("Boom", HERDR_ENV, async () => {
			throw new Error("spawn failed");
		});

		expect(exitOneForWorkspace).toBe("failed");
		expect(thrown).toBe("failed");
	});
});
