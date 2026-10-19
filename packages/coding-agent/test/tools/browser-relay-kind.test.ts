import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createBrowserPrelude,
	DEFAULT_RELAY_URL,
	resolveBrowserKind,
	resolveRelayKind,
} from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

describe("resolveRelayKind", () => {
	it("is disabled by default", () => {
		expect(resolveRelayKind(null, {})).toBeNull();
		expect(resolveRelayKind({}, {})).toBeNull();
	});

	it("resolves the default endpoint when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, {})).toEqual({ kind: "relay", cdpUrl: DEFAULT_RELAY_URL });
	});

	it("uses the configured URL and trims trailing slashes", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "http://127.0.0.1:9333///" }, {})).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:9333",
		});
	});

	it("falls back to the default endpoint for a blank URL", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "   " }, {})).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
		});
	});

	it("PI_BROWSER_RELAY=0 disables the relay even when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, { PI_BROWSER_RELAY: "0" })).toBeNull();
	});

	it("PI_BROWSER_RELAY=1 enables the relay when the setting is off", () => {
		expect(resolveRelayKind({ settingEnabled: false }, { PI_BROWSER_RELAY: "1" })).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
		});
	});
});

describe("browser prelude relay guidance", () => {
	const savedRelayEnv = process.env.PI_BROWSER_RELAY;
	beforeEach(() => {
		delete process.env.PI_BROWSER_RELAY;
	});
	afterEach(() => {
		if (savedRelayEnv === undefined) delete process.env.PI_BROWSER_RELAY;
		else process.env.PI_BROWSER_RELAY = savedRelayEnv;
	});

	const sessionWith = (settings: Record<string, unknown>): ToolSession =>
		({
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "browser.tern": false, "browser.cmux": false, ...settings }),
		}) as ToolSession;

	it("tells the model an open without app drives the user's Chrome only while that is what it does", () => {
		for (const [settings, env] of [
			[{ "browser.relay": true }, undefined],
			[{ "browser.relay": false }, undefined],
			[{ "browser.relay": true }, "0"],
			[{ "browser.relay": false }, "1"],
		] as const) {
			if (env === undefined) delete process.env.PI_BROWSER_RELAY;
			else process.env.PI_BROWSER_RELAY = env;
			const session = sessionWith(settings);
			const onRelay = resolveBrowserKind({ action: "open" }, session).kind === "relay";
			const guidance = createBrowserPrelude(session).guidance;
			expect(guidance !== undefined).toBe(onRelay);
			if (onRelay) expect(guidance).toContain("`app: { relay: false }` for a throwaway managed browser");
		}
	});

	it("names browser.cdpUrl as where app.relay:false goes when it is configured", () => {
		const session = sessionWith({ "browser.relay": true, "browser.cdpUrl": "http://127.0.0.1:9333" });
		expect(resolveBrowserKind({ action: "open", app: { relay: false } }, session)).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9333",
		});
		const guidance = createBrowserPrelude(session).guidance;
		expect(guidance).toContain("open in the browser at `browser.cdpUrl` (http://127.0.0.1:9333)");
		expect(guidance).not.toContain("throwaway");
	});
});
