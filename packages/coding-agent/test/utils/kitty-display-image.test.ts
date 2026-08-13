import { beforeAll, describe, expect, it } from "bun:test";
import {
	imageNeedsKittyDisplayPreparation,
	MAX_KITTY_IMAGE_BYTES,
	MAX_KITTY_IMAGE_DIMENSION,
	prepareImageForKittyDisplay,
} from "@oh-my-pi/pi-coding-agent/utils/image-loading";

// Regression coverage for the oversized-inline-image incident: a 6048x8064
// photo transmitted verbatim became a ~34.8 MB kitty APC, blowing herdr's
// 32 MiB per-frame budget — the frame dropped the payload but still shipped
// Unicode placeholder cells, so both native kitty and web sixel clients
// rendered placeholder glyph soup. The display path must downscale to the
// budget BEFORE the kitty payload is built.

// 1x1 red PNG (69 bytes) — Bun.Image seed to synthesize fixtures without
// checking binary blobs into the repo (same convention as image-resize.test.ts).
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedImage(width: number, height: number, format: "png" | "jpeg"): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const image = new Bun.Image(seed).resize(width, height, { filter: "nearest" });
	const bytes = format === "png" ? await image.png().bytes() : await image.jpeg({ quality: 90 }).bytes();
	return Buffer.from(bytes).toBase64();
}

// Fixtures synthesized once, shared read-only:
//   - oversizedPng: long edge over the 2048 display cap (2600x3466 mimics a
//     portrait photo shape without paying for full 6048x8064 encode time).
//   - smallPng: comfortably inside every budget — must pass through untouched.
//   - tinyJpeg: below the model-facing 200px floor — proves display prep
//     converts format without upscaling.
let oversizedPng: string;
let smallPng: string;
let tinyJpeg: string;

beforeAll(async () => {
	[oversizedPng, smallPng, tinyJpeg] = await Promise.all([
		makeRedImage(2600, 3466, "png"),
		makeRedImage(300, 300, "png"),
		makeRedImage(120, 80, "jpeg"),
	]);
});

describe("imageNeedsKittyDisplayPreparation", () => {
	it("flags PNGs whose long edge exceeds the display dimension budget", () => {
		expect(imageNeedsKittyDisplayPreparation({ data: oversizedPng, mimeType: "image/png" })).toBe(true);
	});

	it("flags PNG payloads over the byte budget without decoding them", () => {
		// Valid PNG header (so the dimension probe succeeds) padded past the byte
		// budget — the length check must trip before any header parsing matters.
		const hugeLength = Math.ceil(((MAX_KITTY_IMAGE_BYTES + 1024) * 4) / 3 / 4) * 4;
		const huge = smallPng + "A".repeat(hugeLength - smallPng.length);
		expect(imageNeedsKittyDisplayPreparation({ data: huge, mimeType: "image/png" })).toBe(true);
	});

	it("flags non-PNG formats regardless of size (kitty transmits f=100 PNG)", () => {
		expect(imageNeedsKittyDisplayPreparation({ data: tinyJpeg, mimeType: "image/jpeg" })).toBe(true);
	});

	it("passes small PNGs through with no preparation", () => {
		expect(imageNeedsKittyDisplayPreparation({ data: smallPng, mimeType: "image/png" })).toBe(false);
	});
});

describe("prepareImageForKittyDisplay", () => {
	it("downscales an oversized PNG under both budgets before transmit", async () => {
		const prepared = await prepareImageForKittyDisplay({
			type: "image",
			data: oversizedPng,
			mimeType: "image/png",
		});

		expect(prepared.mimeType).toBe("image/png");
		const bytes = Buffer.from(prepared.data, "base64");
		expect(bytes.length).toBeLessThanOrEqual(MAX_KITTY_IMAGE_BYTES);
		const { width, height } = await new Bun.Image(bytes).metadata();
		expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_KITTY_IMAGE_DIMENSION);
		// Aspect ratio preserved (2600:3466 = 3:4) within rounding.
		expect(Math.abs(width / height - 2600 / 3466)).toBeLessThan(0.01);
	});

	it("returns a small PNG byte-identical (same base64, no re-encode churn)", async () => {
		const prepared = await prepareImageForKittyDisplay({
			type: "image",
			data: smallPng,
			mimeType: "image/png",
		});

		expect(prepared.mimeType).toBe("image/png");
		expect(prepared.data).toBe(smallPng);
	});

	it("converts a tiny JPEG to PNG without upscaling it", async () => {
		const prepared = await prepareImageForKittyDisplay({
			type: "image",
			data: tinyJpeg,
			mimeType: "image/jpeg",
		});

		expect(prepared.mimeType).toBe("image/png");
		const { width, height } = await new Bun.Image(Buffer.from(prepared.data, "base64")).metadata();
		// The display path never upscales — the model-facing 200px floor must not apply.
		expect(width).toBe(120);
		expect(height).toBe(80);
	});

	it("rejects undecodable payloads so callers keep them off the wire", async () => {
		const junk = Buffer.from("this is not an image at all, not even close").toBase64();
		await expect(prepareImageForKittyDisplay({ type: "image", data: junk, mimeType: "image/png" })).rejects.toThrow();
	});
});
