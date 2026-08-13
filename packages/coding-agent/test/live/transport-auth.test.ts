import { describe, expect, it } from "bun:test";
import { isAuthError, LiveSignalingError } from "@oh-my-pi/pi-coding-agent/live/transport";

describe("live signaling auth classification", () => {
	it("treats a 404 entitlement gate as rotation-worthy", () => {
		// OpenAI returns 404 {"detail":"Not Found"}, not 403, when the account's
		// plan lacks Codex live. Must rotate to sibling credentials.
		expect(isAuthError(new LiveSignalingError(404, "Codex live signaling failed (404)"))).toBe(true);
	});

	it("does not rotate on request validation errors", () => {
		expect(isAuthError(new LiveSignalingError(400, "bad session payload"))).toBe(false);
		expect(isAuthError(new LiveSignalingError(500, "server error"))).toBe(false);
	});

	it("does not rotate on non-signaling errors", () => {
		expect(isAuthError(new Error("network down"))).toBe(false);
	});
});
