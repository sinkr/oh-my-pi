import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as ar from "@oh-my-pi/pi-utils/ar";

afterEach(() => vi.restoreAllMocks());

it("lists a plain TAR past the in-memory ceiling and reads only its selected small member", async () => {
	await using temp = await TempDir.create("@read-tar-range-");
	const archivePath = temp.join("large.tar");
	await ar.writeArchive(archivePath, "tar", [
		["fill.bin", new Uint8Array(6000)],
		["identity.json", '{"ok":true}'],
	]);
	const openArchive = ar.openArchive;
	vi.spyOn(ar, "openArchive").mockImplementation(source => openArchive(source, { limits: { maxInMemorySize: 512 } }));
	const session: ToolSession = {
		cwd: temp.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
	const tool = new ReadTool(session);
	const listing = await tool.execute("list-tar", { path: archivePath });
	expect(listing.details?.isDirectory).toBe(true);
	expect(listing.content).toEqual([{ type: "text", text: expect.stringContaining("fill.bin") }]);
	expect(listing.content[0]).toMatchObject({ text: expect.stringContaining("identity.json") });
	const selected = await tool.execute("read-identity", { path: `${archivePath}:identity.json:raw` });
	expect(selected.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
	expect(await Bun.file(temp.join("identity.json")).exists()).toBe(false);
});
