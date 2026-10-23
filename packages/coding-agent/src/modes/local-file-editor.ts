import * as fs from "node:fs/promises";
import { InternalUrlRouter, type LocalFileEntry, type LocalProtocolOptions, listLocalFiles } from "../internal-urls";
import type { SessionManager } from "../session/session-manager";
import { getEditorCommand, openEditorOnPath } from "../utils/external-editor";
import { formatByteSize } from "../utils/video";
import type { InteractiveModeContext } from "./types";

const PICKER_TITLE = "Open local:// file in external editor";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sessionLocalProtocolOptions(
	sessionManager: Pick<SessionManager, "getArtifactsDir" | "getSessionId">,
): LocalProtocolOptions {
	return {
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getSessionId: () => sessionManager.getSessionId(),
	};
}

/** Encode a filesystem name as `local://` path segments. `/` stays a separator; `%`, `#`, `?` are encoded once. */
function encodeLocalPath(name: string): string {
	return name.split("/").map(segment => encodeURIComponent(segment)).join("/");
}

/** Resolve a user-typed local file target to its on-disk real path. Throws user-facing Errors. */
export async function resolveLocalEditorTarget(
	target: string,
	options: LocalProtocolOptions,
): Promise<{ url: string; path: string }> {
	const trimmed = target.trim();
	if (!trimmed) throw new Error("Enter a local:// file name.");
	// Explicit `local://` / `local:/` is already a URL: pass it through so an encoded
	// `local://100%25.md` is not encoded again. A bare filesystem name (what the completer
	// inserts) must be encoded or `%` / `#` / `?` never reach `locate()`.
	const explicitUrl = /^local:/i.test(trimmed);
	const displayUrl = explicitUrl ? trimmed : `local://${trimmed}`;
	const url = explicitUrl ? trimmed : `local://${encodeLocalPath(trimmed)}`;
	// Non-creating locate: realpath + root containment, so traversal and escaping symlinks throw.
	const located = await InternalUrlRouter.instance().locate(url, { localProtocolOptions: options });
	if (located === null) throw new Error(`Local file not found: ${displayUrl}`);
	const stat = await fs.stat(located);
	if (stat.isDirectory()) throw new Error(`${displayUrl} is a directory; name a file inside it.`);
	if (!stat.isFile()) throw new Error(`${displayUrl} is not a regular file.`);
	return { url: displayUrl, path: located };
}

async function pickLocalFile(
	ctx: InteractiveModeContext,
	options: LocalProtocolOptions,
): Promise<LocalFileEntry | undefined> {
	let files: LocalFileEntry[];
	try {
		files = await listLocalFiles(options);
	} catch (error) {
		ctx.showError(`Failed to list local:// files: ${errorMessage(error)}`);
		return undefined;
	}
	if (files.length === 0) {
		ctx.showStatus("No local:// files in this session yet.");
		return undefined;
	}
	const choice = await ctx.showHookSelector(
		PICKER_TITLE,
		files.map(file => ({ label: file.url, description: formatByteSize(file.size) })),
	);
	return files.find(file => file.url === choice);
}

/** `/local [target]` and the `app.local.open` key: picker when target is blank, else open target directly. */
export async function openLocalFileInEditor(ctx: InteractiveModeContext, target?: string): Promise<void> {
	const editorCmd = getEditorCommand();
	if (!editorCmd) {
		ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
		return;
	}
	const options = sessionLocalProtocolOptions(ctx.sessionManager);

	let chosen: { url: string; path: string } | undefined;
	if (target?.trim()) {
		try {
			chosen = await resolveLocalEditorTarget(target, options);
		} catch (error) {
			ctx.showError(errorMessage(error));
			return;
		}
	} else {
		const picked = await pickLocalFile(ctx, options);
		if (!picked) return;
		try {
			// The listing is stale once the picker returns. Re-resolve the filesystem name
			// (not the display URL, which would decode `%` twice) so a symlink swapped in
			// while the picker was open cannot escape the local root.
			chosen = await resolveLocalEditorTarget(picked.name, options);
		} catch (error) {
			ctx.showError(errorMessage(error));
			return;
		}
	}

	let exitCode: number;
	try {
		ctx.ui.stop();
		exitCode = await openEditorOnPath(editorCmd, chosen.path);
	} catch (error) {
		ctx.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		return;
	} finally {
		ctx.ui.start();
		ctx.ui.requestRender();
	}

	if (exitCode !== 0) {
		ctx.showWarning(`Editor exited with code ${exitCode}; ${chosen.url} keeps whatever it saved.`);
		return;
	}
	ctx.showStatus(`Closed ${chosen.url} in editor.`);
}
