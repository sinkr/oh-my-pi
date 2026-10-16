import type { FetchImpl } from "../../src/types";

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

/** Wrap a fetch handler as a {@link FetchImpl}, normalizing sync `Response` returns. */
export function mockFetch(fn: FetchHandler): FetchImpl {
	return async (input, init) => fn(input, init);
}

/**
 * Decode a captured request body to text, undoing the transport gzip the
 * Anthropic provider applies to large bodies sent to the official API.
 */
export function requestBodyText(init: RequestInit | undefined): string {
	const raw = init?.body;
	if (raw == null) return "{}";
	if (typeof raw === "string") return raw;
	if (!(raw instanceof Uint8Array)) return String(raw);
	const gzipped = new Headers(init?.headers).get("content-encoding") === "gzip";
	return new TextDecoder().decode(gzipped ? Bun.gunzipSync(raw as Uint8Array<ArrayBuffer>) : raw);
}
