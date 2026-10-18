import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import type { RelayPendingClose, RelayPendingCloseStore } from "./bridge";

/** Where the relay on `port` keeps tab closes waiting for an offline browser. */
export function relayPendingClosesFile(port: number): string {
	return path.join(getBrowserRelayDir(), `pending-closes-${port}.json`);
}

/** Pending closes kept in `file` as JSON; an unreadable or malformed file holds none. */
export function fileCloseStore(file: string): RelayPendingCloseStore {
	return {
		load() {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
				if (!Array.isArray(parsed)) return [];
				return parsed.filter(
					(entry): entry is RelayPendingClose =>
						typeof entry?.key === "string" && typeof entry?.browserSession === "string",
				);
			} catch {
				return [];
			}
		},
		save(closes) {
			try {
				if (closes.length === 0) {
					fs.rmSync(file, { force: true });
					return;
				}
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, JSON.stringify(closes));
			} catch {
				// A close that cannot be kept still waits in this relay's memory.
			}
		},
	};
}
