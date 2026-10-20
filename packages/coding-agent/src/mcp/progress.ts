import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { MCPNotificationMethods } from "./types";

/** Add request-scoped progress metadata without changing caller-owned objects. */
export function withProgressToken(
	params: Record<string, unknown> | undefined,
	token: string | number,
): Record<string, unknown> {
	return { ...params, _meta: { ...(isRecord(params?._meta) ? params._meta : {}), progressToken: token } };
}

/** Parse progress without coercing correlation tokens or retaining invalid fields. */
function parseProgressNotification(params: unknown): { token: string | number; progress: MCPProgress } | undefined {
	if (!isRecord(params)) return undefined;
	const token = params.progressToken;
	if (typeof token !== "string" && !(typeof token === "number" && Number.isFinite(token))) return undefined;
	if (typeof params.progress !== "number" || !Number.isFinite(params.progress)) return undefined;
	const progress: MCPProgress = { progress: params.progress };
	if (typeof params.total === "number" && Number.isFinite(params.total)) progress.total = params.total;
	if (typeof params.message === "string") progress.message = params.message;
	return { token, progress };
}

/**
 * Deliver a server notification to the request callback its progress token
 * selects. Other methods, malformed payloads, and unmatched tokens are ignored;
 * a throwing callback is logged and never reaches the transport or other requests.
 */
export function routeProgressNotification(
	method: string,
	params: unknown,
	callbackFor: (token: string | number) => ((progress: MCPProgress) => void) | undefined,
): void {
	if (method !== MCPNotificationMethods.PROGRESS) return;
	const parsed = parseProgressNotification(params);
	const onProgress = parsed && callbackFor(parsed.token);
	if (!parsed || !onProgress) return;
	try {
		onProgress(parsed.progress);
	} catch (error) {
		logger.debug("MCP progress callback failed", { error });
	}
}
