import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveSeanceSource } from "@oh-my-pi/pi-coding-agent/task/seance";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string, cwd: string) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-10-01T00:00:00.000Z",
		cwd,
	};
}

function modelChange(id: string, parentId: string | null, model: string, role: string) {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-10-01T00:00:01.000Z",
		model,
		role,
	};
}

function modelUsage(id: string, parentId: string, activeLeafId: string | null) {
	return {
		type: "model_usage",
		id,
		parentId,
		timestamp: "2026-10-01T00:00:02.000Z",
		purpose: "task-completion-probe",
		role: "smol",
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
		usage: {
			input: 11,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0.0011, output: 0.0004, cacheRead: 0.00003, cacheWrite: 0, total: 0.00153 },
		},
		stopReason: "stop",
		activeLeafId,
	};
}

async function writeSession(file: string, id: string, cwd: string, entries: unknown[] = []): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${[sessionHeader(id, cwd), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("seance source resolution", () => {
	it("resolves paths and stored IDs to read-only source metadata with the active model and default fallback", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const file = path.join(sessionDir, "saved.jsonl");
		await writeSession(file, "saved-source-id", cwd, [
			modelChange("default-model", null, "anthropic/claude-sonnet-4-5", "default"),
			modelChange("active-model", "default-model", "anthropic/claude-sonnet-4-6", "fast"),
		]);
		const original = await fs.readFile(file);
		const options = { cwd, sessionDirHint: sessionDir };

		await expect(resolveSeanceSource(file, options)).resolves.toEqual({
			file,
			id: "saved-source-id",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});
		await expect(resolveSeanceSource("saved-source-id", options)).resolves.toEqual({
			file,
			id: "saved-source-id",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});
		expect(await fs.readFile(file)).toEqual(original);
	});

	it("restores the model from the active branch after late usage and returns no models for a null active leaf", async () => {
		using tempDir = TempDir.createSync("@omp-seance-active-model-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const file = path.join(sessionDir, "late-usage.jsonl");
		const entries = [
			modelChange("default-model", null, "anthropic/claude-sonnet-4-5", "default"),
			modelChange("probe-owner", "default-model", "openai/gpt-4o", "fast"),
			modelChange("active-model", "default-model", "anthropic/claude-sonnet-4-6", "fast"),
			modelUsage("late-usage", "probe-owner", "active-model"),
		];
		await writeSession(file, "active-model-source", cwd, entries);
		await expect(resolveSeanceSource(file, { cwd, sessionDirHint: sessionDir })).resolves.toMatchObject({
			id: "active-model-source",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});

		const clearedFile = path.join(sessionDir, "cleared-usage.jsonl");
		await writeSession(clearedFile, "cleared-model-source", cwd, [
			...entries.slice(0, 3),
			modelUsage("cleared-usage", "probe-owner", null),
		]);
		await expect(resolveSeanceSource(clearedFile, { cwd, sessionDirHint: sessionDir })).resolves.toMatchObject({
			id: "cleared-model-source",
			modelSelectors: [],
		});
	});

	it("fails closed for missing paths and IDs, ambiguous prefixes, and files without a session header", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-invalid-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const options = { cwd, sessionDirHint: sessionDir };
		await writeSession(path.join(sessionDir, "first.jsonl"), "ambiguous-first", cwd);
		await writeSession(path.join(sessionDir, "second.jsonl"), "ambiguous-second", cwd);
		const malformedFile = path.join(sessionDir, "malformed.jsonl");
		await Bun.write(malformedFile, `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION })}\n`);

		await expect(resolveSeanceSource(path.join(sessionDir, "missing.jsonl"), options)).rejects.toThrow(
			"The selected session file was not found or could not be accessed.",
		);
		await expect(resolveSeanceSource("not-present", options)).rejects.toThrow('Session "not-present" was not found.');
		await expect(resolveSeanceSource("ambiguous", options)).rejects.toThrow(
			'Session selector "ambiguous" is ambiguous.',
		);
		await expect(resolveSeanceSource(malformedFile, options)).rejects.toThrow(
			"The selected file does not contain a valid session header.",
		);
	});
});
