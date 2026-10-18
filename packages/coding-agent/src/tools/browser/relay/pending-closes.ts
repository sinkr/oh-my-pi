import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import type { RelayPendingClose, RelayPendingCloseStore } from "./bridge";

/** Where the relay on `port` keeps tab closes waiting for an offline browser. */
export function relayPendingClosesFile(port: number): string {
	return path.join(getBrowserRelayDir(), `pending-closes-${port}.json`);
}

/**
 * Pending closes kept in `file` as JSON; an unreadable or malformed file holds none. Loading is synchronous so
 * the relay has them before the first extension hello. Saves run in order, each written beside the file and
 * renamed over it, so a failed or interrupted save leaves the last saved list in place. `save` settles once that
 * save has run.
 */
export function fileCloseStore(
	file: string,
): RelayPendingCloseStore & { save(closes: RelayPendingClose[]): Promise<void> } {
	let saving = Promise.resolve();
	return {
		load() {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
				if (!Array.isArray(parsed)) return [];
				return parsed.filter(
					(entry): entry is RelayPendingClose =>
						typeof entry?.key === "string" &&
						typeof entry?.instanceId === "string" &&
						typeof entry?.url === "string",
				);
			} catch {
				return [];
			}
		},
		save(closes) {
			const json = JSON.stringify(closes);
			saving = saving
				.then(async () => {
					if (closes.length === 0) {
						await fs.promises.rm(file, { force: true });
						return;
					}
					const staged = `${file}.${process.pid}.tmp`;
					await Bun.write(staged, json);
					await fs.promises.rename(staged, file);
				})
				.catch(() => {
					// The last saved list stays; a close that cannot be kept still waits in this relay's memory.
				});
			return saving;
		},
	};
}
