import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { $ } from "bun";
import { getDefaultPasteImageKeys } from "@oh-my-pi/pi-tui/app-keybindings";
import {
	chipLabel,
	COMPOSER_TOKEN_REGEX,
	modelMentionChipLabel,
	skillChipLabel,
} from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import {
	CustomEditor,
	extractBracketedPastePaths,
	extractImagePathFromText,
	extractPastePathsFromText,
} from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { SPACE_HOLD_MECHANICAL_RUN, SPACE_HOLD_RELEASE_MS, SPACE_REPEAT_MAX_GAP_MS } from "@oh-my-pi/pi-tui/space-hold";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";

function makeEditor(holdEnabled = true) {
	const editor = new CustomEditor(getEditorTheme());
	const events: string[] = [];
	editor.spaceHold.handler = {
		enabled: () => holdEnabled,
		onStart: () => events.push("start"),
		onEnd: () => events.push("end"),
	};
	return { editor, events };
}

/** A gap below SPACE_REPEAT_MAX_GAP_MS — looks like OS key auto-repeat (a held bar). */
const REPEAT_GAP_MS = 30;
/** A gap above the threshold — looks like a deliberate keypress. */
const TAP_GAP_MS = SPACE_REPEAT_MAX_GAP_MS + 80;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function bracketedPaste(text: string): string {
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Feed `count` spaces `gapMs` apart on the fake clock. The first space of a run has no prior
 *  space, so its gap is effectively infinite and it always reads as a deliberate tap. */
function feedSpaces(editor: CustomEditor, count: number, gapMs: number): void {
	for (let i = 0; i < count; i++) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

/** Feed spaces at explicit per-press gaps (ms) on the fake clock — for simulating an irregular cadence. */
function feedGaps(editor: CustomEditor, gaps: number[]): void {
	for (const gapMs of gaps) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

async function decorateInFreshProcess(text: string, imageLinks?: readonly string[]): Promise<string> {
	const customEditorUrl = import.meta.resolve("@oh-my-pi/pi-tui/prompt/custom-editor");
	const script = `
import { CustomEditor } from ${JSON.stringify(customEditorUrl)};
const editor = new CustomEditor({});
editor.imageLinks = ${JSON.stringify(imageLinks)};
process.stdout.write(editor.decorateText(${JSON.stringify(text)}));
`;
	const child = await $`bun -e ${script}`.quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0) throw new Error(stderr || stdout || `decorate subprocess exited with ${child.exitCode}`);
	return stdout;
}

describe("CustomEditor placeholder decoration", () => {
	it("renders paste placeholders before theme initialization", async () => {
		const output = await decorateInFreshProcess("[Paste #1, +30 lines]");
		expect(output).toBe("[Paste #1, +30 lines]");
	});

	it("renders linked image placeholders before theme and settings initialization", async () => {
		const output = await decorateInFreshProcess("[Image #1]", ["/tmp/example.png"]);
		expect(output).toBe("[Image #1]");
	});
});

describe("CustomEditor restored image drafts", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("submits restored images with their historical prompt", () => {
		const editor = new CustomEditor(getEditorTheme());
		const image: ImageContent = {
			type: "image",
			data: "aW1hZ2U=",
			mimeType: "image/png",
		};
		let submitted: { text: string; images: ImageContent[] } | undefined;
		editor.onSubmit = text => {
			submitted = { text, images: [...editor.pendingImages] };
		};

		editor.setDraft("Inspect [Image #1, 1x1]", [image]);
		editor.submit();

		expect(submitted).toEqual({
			text: "Inspect [Image #1, 1x1]",
			images: [image],
		});
	});
});

describe("CustomEditor queue shorthand decoration", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reserves the first line as soon as either queue prefix is completed", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.handleInput(prefix[0] ?? "");
			expect(editor.getText()).toBe(prefix[0]);

			editor.handleInput(prefix[1] ?? "");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			editor.handleInput("\x7f");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
		}
	});

	it("renders the reserved line as a dim Queueing header", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(`${prefix}\nqueue this`);

			expect(editor.decorateText(prefix, { line: 0, startCol: 0, endCol: prefix.length })).toBe(
				theme.fg("dim", `Queueing ${theme.nav.selected}`),
			);
			editor.focused = true;
			const rendered = editor.render(40).map(line => Bun.stripANSI(line.replace(CURSOR_MARKER, "")));
			expect(rendered.some(line => line.includes(`Queueing ${theme.nav.selected}`))).toBe(true);
			expect(rendered.every(line => Bun.stringWidth(line) === 40)).toBe(true);
			expect(rendered.some(line => line.includes("queue this"))).toBe(true);
		}
	});

	it("highlights dot and parenthesis markers only for detected queue lists", () => {
		for (const [input, marker] of [
			["=>\n1. first\n2. second", "1."],
			["=>\n1) first\n2) second", "1)"],
		]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(input);
			const text = `${marker} first`;
			expect(
				editor
					.decorateText(text, { line: 1, startCol: 0, endCol: text.length })
					.startsWith(theme.fg("accent", marker)),
			).toBe(true);
		}

		const unfinished = new CustomEditor(getEditorTheme());
		unfinished.setText("=>\n1. first\n2. second\n3. third\n4.");
		expect(
			unfinished.decorateText("1. first", { line: 1, startCol: 0, endCol: 8 }).startsWith(theme.fg("accent", "1.")),
		).toBe(true);
		expect(
			unfinished.decorateText("4.", { line: 4, startCol: 0, endCol: 2 }).startsWith(theme.fg("accent", "4.")),
		).toBe(true);

		const editor = new CustomEditor(getEditorTheme());
		editor.setText("=>\n1. first\n3. third");
		expect(editor.decorateText("1. first", { line: 1, startCol: 0, endCol: 8 })).toBe("1. first");
	});
});

describe("CustomEditor bracketed path paste", () => {
	// Paste contract: bracketed-paste payloads are TEXT the terminal
	// delivered, so they always land in the buffer verbatim — never promoted
	// to an image attachment merely because they look like an image file
	// path. Image attachment requires real provenance (clipboard image bytes
	// or the macOS `public.file-url` pasteboard flavor), both handled by
	// `InputController.handleImagePaste`.
	it("inserts a single explicit image path as literal text", () => {
		const { editor } = makeEditor();
		editor.handleInput(bracketedPaste("/tmp/icon-photo-default.png"));
		expect(editor.getText()).toBe("/tmp/icon-photo-default.png");
	});

	it("inserts a pasted video path as literal text", () => {
		const { editor } = makeEditor();
		const video = "/Users/me/Movies/launch cut.mp4";
		editor.handleInput(bracketedPaste(video));
		expect(editor.getText()).toBe(video);
	});

	it("keeps video previews distinct from image chips", () => {
		const { editor } = makeEditor();
		editor.pendingImages = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
		editor.pendingImageLinks = ["/tmp/launch.mp4"];
		editor.setCollapsedText("[Video #1, 960x480]");

		expect(editor.getText()).toBe(chipLabel("video", 1));
		expect(editor.composerChips()).toMatchObject([{ kind: "video", n: 1 }]);
	});

	describe("skill chips", () => {
		function makeSkillEditor() {
			const { editor } = makeEditor();
			editor.skillFilePath = name => (name === "reviewer" ? "/skills/reviewer/SKILL.md" : undefined);
			return editor;
		}

		it("snaps a typed `/skill:<name>` into a chip once whitespace terminates it, keeping the cursor", () => {
			const editor = makeSkillEditor();
			for (const ch of "use /skill:reviewer") editor.handleInput(ch);
			// Still typing: no snap while the name could grow.
			expect(editor.getText()).toBe("use /skill:reviewer");
			editor.handleInput(" ");
			const chip = skillChipLabel("reviewer");
			expect(editor.getText()).toBe(`use ${chip} `);
			expect(editor.getCursor()).toEqual({ line: 0, col: `use ${chip} `.length });
			for (const ch of "now") editor.handleInput(ch);
			expect(editor.getText()).toBe(`use ${chip} now`);
		});

		it("leaves an unknown skill literal", () => {
			const editor = makeSkillEditor();
			for (const ch of "use /skill:nope ") editor.handleInput(ch);
			expect(editor.getText()).toBe("use /skill:nope ");
		});

		it("deletes the chip as one unit and expands it back to the token on submit", () => {
			const editor = makeSkillEditor();
			for (const ch of "/skill:reviewer then") editor.handleInput(ch);
			const chip = skillChipLabel("reviewer");
			expect(editor.getText()).toBe(`${chip} then`);

			let submitted: string | undefined;
			editor.onSubmit = text => {
				submitted = text;
			};
			editor.handleInput("\r");
			expect(submitted).toBe("/skill:reviewer then");

			for (const ch of "a /skill:reviewer ") editor.handleInput(ch);
			expect(editor.getText()).toBe(`a ${chip} `);
			editor.handleInput("\x7f"); // trailing space
			editor.handleInput("\x7f"); // whole chip
			expect(editor.getText()).toBe("a ");
		});

		it("re-collapses a restored draft so the chip survives a failed submit", () => {
			const editor = makeSkillEditor();
			editor.setCollapsedText("fix it /skill:reviewer please");
			expect(editor.getText()).toBe(`fix it ${skillChipLabel("reviewer")} please`);
			expect(editor.getExpandedText()).toBe("fix it /skill:reviewer please");
		});
	});

	describe("model mention chips", () => {
		function makeModelEditor() {
			const { editor } = makeEditor();
			editor.modelMentionLabel = selector => {
				if (selector === "a/x" || selector === "b/y") return modelMentionChipLabel("X One");
				if (selector === "c/z") return modelMentionChipLabel("Zed");
				return undefined;
			};
			editor.modelMentionSelector = agent => (agent === "m1" ? "a/x" : undefined);
			return editor;
		}

		it("collapses a completed selector, expands it exactly, and deletes the chip atomically", () => {
			const editor = makeModelEditor();
			for (const ch of "use ^a/x") editor.handleInput(ch);
			expect(editor.getText()).toBe("use ^a/x");

			editor.handleInput(" ");
			const chip = modelMentionChipLabel("X One");
			expect(editor.getText()).toBe(`use ${chip} `);
			expect(editor.getExpandedText()).toBe("use ^a/x ");

			editor.handleInput("\x7f");
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("use ");
		});

		it("leaves unknown selectors literal", () => {
			const editor = makeModelEditor();
			for (const ch of "use ^nope/z ") editor.handleInput(ch);
			expect(editor.getText()).toBe("use ^nope/z ");
			expect(editor.getExpandedText()).toBe("use ^nope/z ");
		});

		it("restores known persisted tags and leaves dropped pseudonyms literal", () => {
			const editor = makeModelEditor();
			const dropped = '<model agent="m2" name="Gone"/>';
			editor.setCollapsedText(`<model agent="m1" name="X One"/> ask ${dropped}`);

			const chip = modelMentionChipLabel("X One");
			expect(editor.getText()).toBe(`${chip} ask ${dropped}`);
			expect(editor.getExpandedText()).toBe(`^a/x ask ${dropped}`);
		});

		it("keeps a colliding display name literal so it cannot expand to the wrong selector", () => {
			const editor = makeModelEditor();
			for (const ch of "^a/x then ^b/y ") editor.handleInput(ch);

			const chip = modelMentionChipLabel("X One");
			expect(editor.getText()).toBe(`${chip} then ^b/y `);
			expect(editor.getExpandedText()).toBe("^a/x then ^b/y ");

			let submitted: string | undefined;
			editor.onSubmit = text => {
				submitted = text;
			};
			editor.handleInput("\r");
			expect(submitted).toBe("^a/x then ^b/y");
		});

		it("keeps local execution literal while allowing mentions in slash prompts and shell interpolation text", () => {
			for (const local of ["!echo ^a/x ", "  !echo ^a/x ", "$ ^a/x ", "$$ ^a/x "]) {
				const editor = makeModelEditor();
				for (const ch of local) editor.handleInput(ch);
				expect(editor.getText()).toBe(local);
				expect(editor.getExpandedText()).toBe(local);
			}

			const chip = modelMentionChipLabel("X One");
			for (const [input, collapsed] of [
				["/plan ask ^a/x ", `/plan ask ${chip} `],
				[`\${HOME} ask ^a/x `, `\${HOME} ask ${chip} `],
			]) {
				const editor = makeModelEditor();
				for (const ch of input) editor.handleInput(ch);
				expect(editor.getText()).toBe(collapsed);
				expect(editor.getExpandedText()).toBe(input);
			}
		});

		it("collapses completed selectors after bracketed paste", () => {
			const editor = makeModelEditor();
			editor.handleInput(bracketedPaste("paste ^c/z "));

			const chip = modelMentionChipLabel("Zed");
			expect(editor.getText()).toBe(`paste ${chip} `);
			expect(editor.getExpandedText()).toBe("paste ^c/z ");
		});

		it("self-heals the atomic token pattern after history restores mention atoms", () => {
			const editor = makeModelEditor();
			for (const ch of "use ^a/x ") editor.handleInput(ch);
			const chip = modelMentionChipLabel("X One");
			editor.rememberDraft();
			editor.clearPasteState();
			editor.setText("");
			editor.atomicTokenPattern = COMPOSER_TOKEN_REGEX;

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe(`use ${chip} `);
			editor.decorateText(editor.getText(), { line: 0, startCol: 0, endCol: editor.getText().length });
			expect(editor.atomicTokenPattern.source).not.toBe(COMPOSER_TOKEN_REGEX.source);

			editor.handleInput("\x05");
			editor.handleInput("\x7f");
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("use ");
		});
	});

	it("inserts a Windows drive image path as literal text", () => {
		const { editor } = makeEditor();
		editor.handleInput(bracketedPaste("C:\\Users\\me\\icon-photo-default.png"));
		expect(editor.getText()).toBe("C:\\Users\\me\\icon-photo-default.png");
	});

	it("inserts a `file://` image URL as literal text", () => {
		const { editor } = makeEditor();
		editor.handleInput(bracketedPaste("file:///Users/me/Pictures/photo.png"));
		expect(editor.getText()).toBe("file:///Users/me/Pictures/photo.png");
	});

	it("inserts a spaced macOS screenshot path as literal text", () => {
		// #6578 previously promoted this shape to an attachment via a
		// whole-text fallback; under the revised contract it stays text.
		const { editor } = makeEditor();
		const screenshot = "/Users/me/Desktop/Screenshot 2026-07-24 at 1.55.12 PM.png";
		editor.handleInput(bracketedPaste(screenshot));
		expect(editor.getText()).toBe(screenshot);
	});

	it("inserts multiple dragged image paths as literal text", () => {
		const { editor } = makeEditor();
		editor.handleInput(bracketedPaste("/tmp/a.png /tmp/b.png"));
		expect(editor.getText()).toBe("/tmp/a.png /tmp/b.png");
	});

	it("inserts non-image path pastes as literal text", () => {
		const { editor } = makeEditor();
		editor.handleInput(bracketedPaste("/tmp/report.csv"));
		expect(editor.getText()).toBe("/tmp/report.csv");
	});

	it("keeps a two-file drag with unescaped spaces as text", () => {
		const { editor } = makeEditor();
		const dropped =
			"/Users/me/Desktop/Screenshot 2026-07-24 at 1.55.12 PM.png /Users/me/Desktop/Screenshot 2026-07-24 at 1.56.00 PM.png";
		editor.handleInput(bracketedPaste(dropped));
		expect(editor.getText()).toBe(dropped);
	});

	it("still extracts explicit paths for the non-image path helper", () => {
		expect(extractBracketedPastePaths(bracketedPaste("/tmp/report.csv"))).toEqual(["/tmp/report.csv"]);
	});
});
describe("CustomEditor configured paste image keys", () => {
	it("routes Ghostty Cmd+V kitty key events through the macOS image-paste default", () => {
		const { editor } = makeEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;
		editor.setActionKeys("app.clipboard.pasteImage", getDefaultPasteImageKeys("darwin"));
		setKittyProtocolActive(true);

		try {
			editor.handleInput("\x1b[118;9u");
		} finally {
			setKittyProtocolActive(false);
		}

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});
});

describe("extractImagePathFromText (issue #3506)", () => {
	it("returns the path when the text is a single image or video file path", () => {
		expect(extractImagePathFromText("/tmp/screenshot.png")).toBe("/tmp/screenshot.png");
		expect(extractImagePathFromText("/Users/me/Pictures/photo.jpeg")).toBe("/Users/me/Pictures/photo.jpeg");
		expect(extractImagePathFromText("C:\\Users\\me\\img.gif")).toBe("C:\\Users\\me\\img.gif");
		expect(extractImagePathFromText("/Users/me/Movies/launch.mp4")).toBe("/Users/me/Movies/launch.mp4");
	});

	it("ignores surrounding whitespace from a clipboard read", () => {
		expect(extractImagePathFromText("  /tmp/photo.webp\n")).toBe("/tmp/photo.webp");
	});

	it("returns undefined for a bare filename (no explicit directory)", () => {
		// Mirrors the bracketed-paste contract: a bare `.png` filename is
		// almost always a project-relative reference the user wants as text,
		// not a clipboard-anchored attachment.
		expect(extractImagePathFromText("icon.png")).toBeUndefined();
	});

	it("returns undefined for non-image extensions", () => {
		expect(extractImagePathFromText("/tmp/report.csv")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/notes.txt")).toBeUndefined();
	});

	it("returns undefined when the text contains anything beyond a single path", () => {
		expect(extractImagePathFromText("see /tmp/screenshot.png")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/a.png /tmp/b.png")).toBeUndefined();
	});

	it("returns undefined for empty/whitespace-only input", () => {
		expect(extractImagePathFromText("")).toBeUndefined();
		expect(extractImagePathFromText("   ")).toBeUndefined();
	});

	it("decodes a `file://` URL to its filesystem path", () => {
		expect(extractImagePathFromText("file:///Users/me/Pictures/photo.png")).toBe("/Users/me/Pictures/photo.png");
	});

	it("recovers a single anchored image path containing unescaped spaces (macOS screenshot name)", () => {
		const macScreenshot = "/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45 PM.png";
		expect(extractImagePathFromText(macScreenshot)).toBe(macScreenshot);
		expect(extractImagePathFromText("~/Pictures/Cleanshot 2026-06-25 at 12.00.png")).toBe(
			"~/Pictures/Cleanshot 2026-06-25 at 12.00.png",
		);
		expect(extractImagePathFromText("C:\\Users\\me\\My Pictures\\img with space.jpg")).toBe(
			"C:\\Users\\me\\My Pictures\\img with space.jpg",
		);
	});

	it("resolves escaped and quoted spaced paths through the splitter (readMacFileUrls entries)", () => {
		expect(extractImagePathFromText("/tmp/My\\ Photos/shot\\ 1.png")).toBe("/tmp/My Photos/shot 1.png");
		expect(extractImagePathFromText('"/tmp/My Photos/shot 1.png"')).toBe("/tmp/My Photos/shot 1.png");
		expect(extractImagePathFromText("/Users/me/My Photos/shot 1.png")).toBe("/Users/me/My Photos/shot 1.png");
	});

	it("returns undefined for two spaced paths the splitter could not separate", () => {
		// Only the whole-text pass survives the splitter here, and it must not
		// fuse the pair into one path the loader can never resolve.
		expect(extractImagePathFromText("/tmp/a.png /tmp/b shot.png")).toBeUndefined();
	});

	it("does not hijack prose that happens to contain a path-shaped fragment", () => {
		// The whole-text branch is gated on ABSOLUTE_PATH_PREFIX_REGEX, so a
		// non-anchored prefix ("see ...") never triggers it.
		expect(extractImagePathFromText("see /Users/me/Desktop/Screenshot 1.png")).toBeUndefined();
	});
});

describe("extractPastePathsFromText", () => {
	it("delegates to the same logic the bracketed variant uses for path detection", () => {
		expect(extractPastePathsFromText("/tmp/a.png /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
		expect(extractPastePathsFromText("just text")).toBeUndefined();
	});
});

describe("CustomEditor space-hold push-to-talk", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("types deliberate space taps without triggering, even several in a row", () => {
		const { editor, events } = makeEditor();
		feedSpaces(editor, 3, TAP_GAP_MS);
		expect(editor.getText()).toBe("   ");
		expect(events).toEqual([]);
	});

	it("recognizes a held bar from a steady fast cadence and tracks back the burst", () => {
		const { editor, events } = makeEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		// Metronomic auto-repeat: the few pre-burst spaces typed are tracked back out when the hold is
		// recognized, leaving only the pre-burst text.
		feedSpaces(editor, SPACE_HOLD_MECHANICAL_RUN + 2, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// Continued auto-repeat while the bar is held is swallowed: no spam, no re-trigger.
		feedSpaces(editor, 5, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// An idle gap with no further repeats means the bar was released -> stop + transcribe.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});

	it("does not trigger when the space bar is smashed at an irregular cadence", () => {
		const { editor, events } = makeEditor();
		// Fast but jittery, the way a human mashes — not the metronomic delta of OS auto-repeat.
		const gaps = [40, 95, 45, 100, 35, 90, 50, 105];
		feedGaps(editor, gaps);
		expect(events).toEqual([]);
		// Nothing is eaten: every smashed space still types a real space.
		expect(editor.getText()).toBe(" ".repeat(gaps.length));
	});

	it("does not trigger on steady but slow spacing", () => {
		const { editor, events } = makeEditor();
		// Even cadence, but slower than auto-repeat: consistent deltas alone must not start recording.
		feedSpaces(editor, 6, TAP_GAP_MS);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(6));
	});

	it("does not trigger when a non-space breaks the run", () => {
		const { editor, events } = makeEditor();
		// Each partial run climbs the mechanical counter one short of the threshold; the non-space
		// resets it so they never combine into a hold.
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		editor.handleInput("x");
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		expect(events).toEqual([]);
	});

	it("leaves the space bar typing normally when the gesture is disabled", () => {
		const { editor, events } = makeEditor(false);
		feedSpaces(editor, 8, REPEAT_GAP_MS);
		expect(editor.getText()).toBe(" ".repeat(8));
		expect(events).toEqual([]);
	});
});
