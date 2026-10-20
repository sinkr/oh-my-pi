import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { renderPdfPageScreenshot } from "@oh-my-pi/pi-coding-agent/tools/read-pdf";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
// Each page came back blank about half the time before the fix, so eight
// pages fail it on nearly every run.
const PAGE_COUNT = 8;
// Each render has its own 30 s deadline; they take about 3 s.
const TEST_TIMEOUT_MS = PAGE_COUNT * 30_000;

/**
 * A PDF whose pages are each one scan-sized embedded image and no text: a
 * black square on white filling the page. A small image painted in time
 * even before the fix.
 */
function imageOnlyPdf(pageCount: number): Buffer {
	const size = 1600;
	const pixels = Buffer.alloc(size * size, 0xff);
	for (let y = size / 4; y < (size * 3) / 4; y++) pixels.fill(0, y * size + size / 4, y * size + (size * 3) / 4);
	const image = deflateSync(pixels);

	const imageId = 3 + pageCount * 2;
	const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i * 2);
	const content = Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q");
	const objects: Buffer[] = [
		Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
		Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`),
	];
	for (const id of pageIds) {
		objects.push(
			Buffer.from(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${id + 1} 0 R >>`,
			),
			Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
		);
	}
	objects.push(
		Buffer.concat([
			Buffer.from(
				`<< /Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
			),
			image,
			Buffer.from("\nendstream"),
		]),
	);

	const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
	let offset = parts[0].length;
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		const object = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
		offsets.push(offset);
		offset += object.length;
		parts.push(object);
	});
	const xref = [
		"xref",
		`0 ${objects.length + 1}`,
		"0000000000 65535 f ",
		...offsets.map(o => `${String(o).padStart(10, "0")} 00000 n `),
		"trailer",
		`<< /Size ${objects.length + 1} /Root 1 0 R >>`,
		"startxref",
		String(offset),
		"%%EOF",
	].join("\n");
	parts.push(Buffer.from(xref));
	return Buffer.concat(parts);
}

/** Counts near-white and near-black pixels; `Bun.Image` leaves uncompressed PNG rows unfiltered. */
async function countPagePixels(file: string): Promise<{ light: number; dark: number }> {
	const png = await new Bun.Image(await Bun.file(file).bytes()).png({ compressionLevel: 0 }).bytes();
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	for (let offset = 8; offset + 12 <= png.length; offset += 12 + view.getUint32(offset)) {
		const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + view.getUint32(offset));
		if (type === "IHDR") {
			width = view.getUint32(offset + 8);
			height = view.getUint32(offset + 12);
			channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
		} else if (type === "IDAT") {
			idat.push(data);
		}
	}
	expect(channels).toBeGreaterThan(0);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	let light = 0;
	let dark = 0;
	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1);
		expect(raw[row]).toBe(0);
		for (let x = row + 1; x < row + 1 + stride; x += channels) {
			const min = Math.min(raw[x], raw[x + 1], raw[x + 2]);
			const max = Math.max(raw[x], raw[x + 1], raw[x + 2]);
			if (min >= 240) light++;
			else if (max <= 15) dark++;
		}
	}
	return { light, dark };
}

describe.skipIf(!CHROMIUM_AVAILABLE)("PDF page screenshots in Chromium", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-chromium-"));
	});

	afterEach(async () => {
		// Close the viewer before deleting the PDF it holds open.
		await releaseAllTabs({ kill: true });
		await removeWithRetries(testDir);
	});

	it(
		"paints image-only pages instead of the empty viewer",
		async () => {
			const pdfPath = path.join(testDir, "scan.pdf");
			await fs.writeFile(pdfPath, imageOnlyPdf(PAGE_COUNT));
			const session = {
				cwd: testDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "browser.headless": true, "browser.cmux": false, "browser.tern": false }),
			} as ToolSession;

			for (let page = 1; page <= PAGE_COUNT; page++) {
				const screenshot = await renderPdfPageScreenshot(session, pdfPath, page);
				const { light, dark } = await countPagePixels(screenshot.dest).finally(() =>
					fs.rm(screenshot.dest, { force: true }),
				);
				const total = screenshot.width * screenshot.height;
				// The white page and its black square both show; an unpainted
				// frame is only the viewer's grey background.
				expect({ page, light: light > total / 20, dark: dark > total / 100 }).toEqual({
					page,
					light: true,
					dark: true,
				});
			}
		},
		TEST_TIMEOUT_MS,
	);
});
