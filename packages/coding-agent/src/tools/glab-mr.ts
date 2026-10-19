import * as path from "node:path";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Settings } from "../config/settings";
import { gitlab } from "../utils/gitlab";
import { type PrDiffPayload, parsePrUnifiedDiff } from "./gh-pr-diff";
import type { ViewLookupResult } from "./gh-view";
import { getOrFetchView, resolveGitlabCacheAuthKey } from "./github-cache";

/**
 * GitLab project refs are `<host>/<namespace…>/<project>` (host lowercased).
 * glab's `-R` accepts a full URL, which disambiguates nested groups and
 * self-managed hosts.
 */
export function formatGitlabProjectArg(project: string): string {
	return `https://${project}`;
}

const PROJECT_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Parse a GitLab project web URL into a `<host>/<namespace…>/<project>` ref. */
export function parseGitlabProjectWebUrl(webUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(webUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2 || !segments.every(segment => PROJECT_SEGMENT_PATTERN.test(segment))) return undefined;
	return `${url.host.toLowerCase()}/${segments.join("/")}`;
}

/**
 * Process-lifetime cache of `glab repo view` lookups keyed by absolute cwd.
 * Mirrors `resolveDefaultRepoMemoized`: the shared lookup is not bound to any
 * caller's signal; each caller's abort is honored at the wait point.
 */
export const GITLAB_DEFAULT_PROJECT_RESOLVED = new Map<string, string>();
export const GITLAB_DEFAULT_PROJECT_INFLIGHT = new Map<string, Promise<string>>();

async function resolveGitlabProjectFromCwd(cwd: string): Promise<string> {
	const view = await gitlab.json<{ web_url?: string; http_url_to_repo?: string }>(cwd, ["repo", "view", "-F", "json"]);
	const project =
		(view.web_url ? parseGitlabProjectWebUrl(view.web_url) : undefined) ??
		(view.http_url_to_repo ? parseGitlabProjectWebUrl(view.http_url_to_repo.replace(/\.git$/, "")) : undefined);
	if (!project) throw new ToolError(`GitLab CLI returned an unrecognized project URL: ${String(view.web_url)}`);
	return project;
}

export async function resolveDefaultGitlabProjectMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
	const key = path.resolve(cwd);
	const ready = GITLAB_DEFAULT_PROJECT_RESOLVED.get(key);
	if (ready) return ready;
	let pending = GITLAB_DEFAULT_PROJECT_INFLIGHT.get(key);
	if (!pending) {
		pending = (async () => {
			const value = await resolveGitlabProjectFromCwd(cwd);
			GITLAB_DEFAULT_PROJECT_RESOLVED.set(key, value);
			return value;
		})();
		void pending.then(
			() => GITLAB_DEFAULT_PROJECT_INFLIGHT.delete(key),
			() => GITLAB_DEFAULT_PROJECT_INFLIGHT.delete(key),
		);
		GITLAB_DEFAULT_PROJECT_INFLIGHT.set(key, pending);
	}
	return untilAborted(signal, pending);
}

/** Older glab lacks `--raw`; some GitLab instances lack the `raw_diffs` endpoint. */
function isRawDiffUnsupportedError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		message.includes("unknown flag: --raw") ||
		(message.includes("could not obtain raw diff") && message.includes("404"))
	);
}

export async function fetchMrDiffFresh(
	cwd: string,
	project: string,
	iid: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const baseArgs = ["mr", "diff", String(iid), "-R", formatGitlabProjectArg(project)];
	let text: string;
	try {
		text = await gitlab.text(cwd, [...baseArgs, "--raw", "--color", "never"], signal, { trimOutput: false });
	} catch (err) {
		if (!isRawDiffUnsupportedError(err)) throw err;
		logger.debug("glab mr diff --raw unavailable; retrying without --raw", { project, iid, err: String(err) });
		try {
			text = await gitlab.text(cwd, [...baseArgs, "--color", "never"], signal, { trimOutput: false });
		} catch {
			throw err;
		}
	}
	const payload = parsePrUnifiedDiff(text);
	// `rendered` carries the verbatim diff; blank the payload copy so the cache
	// row stores it once. `getOrFetchMrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

export interface MrDiffLookupOptions {
	cwd: string;
	/** `<host>/<namespace…>/<project>`. */
	project: string;
	iid: number;
	signal?: AbortSignal;
	settings?: Settings;
	/** `null` bypasses the cache; `undefined` derives the key from glab credentials. */
	cacheAuthKey?: string | null;
}

/**
 * Cache-aware MR diff fetcher; one `mr-diff` cache row backs the listing,
 * full-diff, and per-file slice variants of `mr://…/diff`.
 */
export async function getOrFetchMrDiff(options: MrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey =
		options.cacheAuthKey === undefined
			? (resolveGitlabCacheAuthKey(options.project.split("/")[0]!) ?? null)
			: options.cacheAuthKey;
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.project,
		kind: "mr-diff",
		number: options.iid,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: () => fetchMrDiffFresh(options.cwd, options.project, options.iid, options.signal),
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
