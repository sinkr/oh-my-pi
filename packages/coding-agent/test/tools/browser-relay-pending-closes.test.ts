import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileCloseStore } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/pending-closes";

const first = { key: "AAAA:7", instanceId: "chrome" };
const second = { key: "AAAA:8", instanceId: "chrome" };

describe("relay pending-close file", () => {
	let dir = "";
	afterEach(async () => {
		if (!dir) return;
		await fs.chmod(dir, 0o700).catch(() => undefined);
		await fs.rm(dir, { recursive: true, force: true });
		dir = "";
	});

	it("keeps the last saved list when a later save fails", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-closes-"));
		const file = path.join(dir, "pending-closes.json");
		const store = fileCloseStore(file);
		await store.save([first]);
		expect(fileCloseStore(file).load()).toEqual([first]);
		// Nothing new can be created in the directory, so the staged copy cannot be written.
		await fs.chmod(dir, 0o500);
		await store.save([first, second]);
		await fs.chmod(dir, 0o700);
		expect(fileCloseStore(file).load()).toEqual([first]);
		expect(await fs.readdir(dir)).toEqual(["pending-closes.json"]);
	});

	it("removes the file once nothing waits", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-closes-"));
		const file = path.join(dir, "pending-closes.json");
		const store = fileCloseStore(file);
		await store.save([first]);
		await store.save([]);
		expect(await fs.readdir(dir)).toEqual([]);
		expect(store.load()).toEqual([]);
	});
});
