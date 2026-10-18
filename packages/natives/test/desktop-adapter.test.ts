import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

describe("desktop native ABI requirements", () => {
	it.each([
		["missing desktop export", undefined],
		[
			"legacy execute ABI",
			class {
				execute() {}
			},
		],
		[
			"pre-zoom ABI",
			class {
				click() {}
				cancel() {}
			},
		],
		[
			"uncancellable ABI",
			class {
				click() {}
				captureRegion() {}
			},
		],
	])("defers rejection of %s until desktop use without constructing the addon", (_label, NativeSession) => {
		// Importing the shared native module must remain safe for non-desktop tools.
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});

	it("rejects an addon built before the turn-scoped display hold", () => {
		const Stale = adaptDesktopSession(class {});
		expect(() => new Stale({ display: "active" })).toThrow(/holdDisplayUntilReleased, releaseDisplayAwake/);
	});

	it("rejects an addon built before the Escape stop count", () => {
		// Every method present, so only the getter can decide; without it the worker reads each run as stopped.
		const prototype = (escapeStops: boolean) =>
			new Proxy(
				{},
				{
					get: () => () => {},
					has: (_target, key) => escapeStops || key !== "escapeStops",
				},
			);
		const Current = { prototype: prototype(true) };
		expect<unknown>(adaptDesktopSession(Current)).toBe(Current);
		const Stale = adaptDesktopSession({ prototype: prototype(false) });
		expect(() => new Stale({ display: "active" })).toThrow(/^Unsupported: .*\(missing escapeStops\)/);
	});
});

describe("lazy desktop exports", () => {
	it("report a stale addon's missing Escape exports with the stale-addon stub", async () => {
		// A child process, since `mock.module` leaks across test files: it stands in a pre-change addon.
		const native = path.join(import.meta.dir, "../native");
		const script = `
			import { mock } from "bun:test";
			mock.module(${JSON.stringify(`${native}/loader-state.js`)}, () => ({
				loadNative: () => ({}),
				missingNativeExport: name => () => { throw new Error("stale addon lacks " + name); },
			}));
			const desktop = await import(${JSON.stringify(`${native}/desktop.js`)});
			for (const call of [() => desktop.desktopEscapeStops("k"), () => desktop.forgetDesktopEscapeStops("k")]) {
				try { call(); console.log("returned"); } catch (error) { console.log(error.message); }
			}`;
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(exitCode).toBe(0);
		expect(stdout.trim().split("\n")).toEqual([
			"stale addon lacks desktopEscapeStops",
			"stale addon lacks forgetDesktopEscapeStops",
		]);
	});
});
