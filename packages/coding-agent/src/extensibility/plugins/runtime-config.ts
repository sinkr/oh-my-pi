import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { PluginRuntimeConfig } from "./types";

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}

/**
 * Write a plugin runtime lockfile readable only by its owner.
 *
 * The lockfile holds plugin settings, and a setting a plugin marks `secret` is
 * a credential the user asked to be masked. A group- or world-readable
 * lockfile hands that credential to every other local account, so the file is
 * written 0600 — and an existing lockfile keeps that mode, because
 * `writeFile`'s mode only applies to a file it creates.
 */
export async function writePluginRuntimeConfig(lockPath: string, config: PluginRuntimeConfig): Promise<void> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	await fs.writeFile(lockPath, JSON.stringify(config, null, 2), { mode: 0o600 });
	if (process.platform === "win32") return;
	try {
		await fs.chmod(lockPath, 0o600);
	} catch (error) {
		logger.warn("Could not restrict permissions on the plugin lockfile", { path: lockPath, error: String(error) });
	}
}
