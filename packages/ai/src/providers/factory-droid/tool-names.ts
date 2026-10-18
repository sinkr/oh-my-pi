import type { Tool } from "../../types";

/**
 * The CLI sanitizes tool names to `[a-zA-Z0-9_-]`; a name longer than 64
 * chars keeps its first 55 and ends `_` + an 8-char sha256, 64 in all, which
 * stays inside the route's tool-name bound. Applied to declarations and
 * replayed call/result names on every wire droid sanitizes.
 */
export function sanitizeFactoryDroidToolName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (sanitized.length <= 64) return sanitized;
	return `${sanitized.slice(0, 55)}_${Bun.SHA256.hash(sanitized, "hex").slice(0, 8)}`;
}

/**
 * Wire name -> caller tool name for the declared tools, so returned calls
 * dispatch to the tool that was advertised. Two tools sharing one wire name
 * could not be told apart, so that request is rejected.
 */
export function factoryDroidToolNamesByWire(tools: Tool[] | undefined): Map<string, string> {
	const names = new Map<string, string>();
	for (const tool of tools ?? []) {
		const wire = sanitizeFactoryDroidToolName(tool.name);
		const existing = names.get(wire);
		if (existing !== undefined && existing !== tool.name) {
			throw new Error(`Factory tool names "${existing}" and "${tool.name}" both encode as "${wire}"`);
		}
		names.set(wire, tool.name);
	}
	return names;
}
