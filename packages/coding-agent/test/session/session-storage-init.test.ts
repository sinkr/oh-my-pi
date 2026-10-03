import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const initModule = new URL("../../src/session/session-storage-init.ts", import.meta.url).pathname;
const temporaryHomes: string[] = [];

async function runOffline(home: string, password: string, body: string): Promise<string> {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { initSessionStorage } from ${JSON.stringify(initModule)};
		const storage = await initSessionStorage();
		if (!storage) throw new Error("PostgreSQL storage was not selected");
		${body}
	`,
		],
		{
			env: {
				...process.env,
				HOME: home,
				PI_CONFIG_DIR: ".omp",
				OMP_PROFILE: "",
				PI_PROFILE: "",
				PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
				OMP_PG_SESSIONS: "true",
				OMP_SESSION_STORAGE: "postgres",
				DATABASE_URL: `postgres://cache_test:${password}@127.0.0.1:1/cache_test`,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Offline child exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

afterEach(async () => {
	await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("PostgreSQL session storage startup", () => {
	it("retains an offline append across abrupt process exit and credential rotation", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "omp-session-init-"));
		temporaryHomes.push(home);
		await runOffline(
			home,
			"before_rotation",
			`
			storage.writeTextSync("/sessions/offline.jsonl", "header\\n", { expectedSize: null });
			storage.openWriter("/sessions/offline.jsonl").appendSync("durable turn\\n");
			process.exit(0);
		`,
		);
		const restored = await runOffline(
			home,
			"after_rotation",
			`
			console.log(JSON.stringify(await storage.readText("/sessions/offline.jsonl")));
			process.exit(0);
		`,
		);
		expect(JSON.parse(restored)).toBe("header\ndurable turn\n");
	}, 15_000);
});
