import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";
import type { ForgeCliResult } from "@oh-my-pi/pi-coding-agent/utils/forge-cli";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { githubToolRenderer } from "@oh-my-pi/pi-tui/tools/github";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function createSession(): Promise<ToolSession> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gh-output-"));
	tempDirs.push(cwd);
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "github.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => cwd,
		allocateOutputArtifact: async () => ({ id: "captured", path: path.join(cwd, "captured.github.log") }),
	};
}

const capturedLog: ForgeCliResult = { exitCode: 0, stdout: "first log line\nCAPTURED_LOG", stderr: "" };
const unavailableLog: ForgeCliResult = {
	exitCode: 7,
	stdout: "NOT_A_CAPTURED_LOG",
	stderr: `gh: HTTP 403: log access denied ${"界".repeat(10_000)} OMITTED_ERROR_SUFFIX`,
};
const watchCases = [
	{
		name: "labels all-unavailable logs as diagnostics and keeps a bounded fetch failure",
		logs: [unavailableLog],
		label: "Failed-job log diagnostics",
		reason: "exit code 7",
	},
	{
		name: "labels captured logs as full only when every failed job has log content",
		logs: [capturedLog, { ...capturedLog, stdout: "other first line\nSECOND_CAPTURED_LOG" }],
		label: "Full failed-job logs",
	},
	{
		name: "labels partial logs and names the failed job whose log fetch failed",
		logs: [capturedLog, unavailableLog],
		label: "Partial failed-job logs",
		reason: "exit code 7",
	},
	{
		name: "does not claim full logs for a successful fetch with empty output",
		logs: [{ exitCode: 0, stdout: "\n\t\n", stderr: "" }],
		label: "Failed-job log diagnostics",
		reason: "empty",
	},
	{
		name: "keeps the failed fetch exit status even when stderr is empty",
		logs: [{ exitCode: 5, stdout: "", stderr: "" }],
		label: "Failed-job log diagnostics",
		reason: "exit code 5",
	},
];

for (const mode of ["run", "commit"] as const) {
	describe(`run_watch ${mode} log artifacts`, () => {
		for (const fixture of watchCases) {
			it(fixture.name, async () => {
				mockSchedulerWaitWithClock();
				const session = await createSession();
				const run = {
					id: 77,
					name: "CI",
					status: "completed",
					conclusion: "failure",
					head_branch: "main",
					head_sha: "0123456789abcdef",
					html_url: "https://github.com/owner/repo/actions/runs/77",
				};
				const jobs = fixture.logs.map((_log, index) => ({
					id: 201 + index,
					name: `failed-job-${201 + index}`,
					status: "completed",
					conclusion: "failure",
				}));
				const runSpy = vi.spyOn(github, "run").mockImplementation(async (_cwd, args) => {
					const endpoint = args.find(arg => arg.startsWith("/repos/"));
					const jobMatch = endpoint?.match(/\/actions\/jobs\/(\d+)\/logs$/);
					if (jobMatch) return fixture.logs[Number(jobMatch[1]) - 201];
					let data: unknown;
					switch (endpoint) {
						case "/repos/owner/repo/branches/main":
							data = { commit: { sha: run.head_sha } };
							break;
						case "/repos/owner/repo/actions/runs":
							data = { workflow_runs: [run] };
							break;
						case "/repos/owner/repo/actions/runs/77":
							data = run;
							break;
						case "/repos/owner/repo/actions/runs/77/jobs":
							data = { total_count: jobs.length, jobs };
							break;
						default:
							throw new Error(`Unexpected gh command: ${args.join(" ")}`);
					}
					return { exitCode: 0, stdout: JSON.stringify(data), stderr: "" };
				});

				const result = await new GithubTool(session).execute("watch-output", {
					op: "run_watch",
					repo: "owner/repo",
					...(mode === "run" ? { run: "77" } : { branch: "main" }),
					tail: 1,
				});
				const text = result.content.find(block => block.type === "text")?.text ?? "";
				const artifact = await Bun.file(path.join(session.cwd, "captured.github.log")).text();
				expect(text).toContain(`${fixture.label}: artifact://captured`);
				if (fixture.label !== "Full failed-job logs") expect(text).not.toContain("Full failed-job logs:");
				expect(result.details?.watch?.mode).toBe(mode);
				expect(result.details?.watch?.state).toBe("completed");
				for (const [index, log] of fixture.logs.entries()) {
					const failedLog = result.details?.watch?.failedLogs?.[index];
					const available = log.exitCode === 0 && log.stdout.trim().length > 0;
					expect(failedLog?.available).toBe(available);
					expect(text).toContain(jobs[index].name);
					expect(artifact).toContain(jobs[index].name);
					if (available) {
						expect(artifact).toContain(log.stdout);
						expect(artifact).toContain("Full log:");
						expect(text).not.toContain(log.stdout.split("\n")[0]);
					} else {
						expect(text).toContain(fixture.reason!);
						expect(artifact).toContain(fixture.reason!);
						expect(JSON.stringify(failedLog)).toContain(fixture.reason!);
						if (log.stderr) {
							expect(text).toContain("HTTP 403: log access denied");
							expect(Buffer.byteLength(JSON.stringify(failedLog))).toBeLessThan(1024);
						}
					}
				}
				if (fixture.label === "Failed-job log diagnostics") expect(artifact).not.toContain("Full log:");
				for (const output of [text, artifact, JSON.stringify(result.details)]) {
					expect(output).not.toContain("NOT_A_CAPTURED_LOG");
					expect(output).not.toContain("OMITTED_ERROR_SUFFIX");
				}
				if (fixture.logs[0] === unavailableLog) {
					await themeModule.initTheme();
					const theme = await themeModule.getThemeByName("dark");
					if (!theme) throw new Error("expected an initialized theme");
					const options = { expanded: true, isPartial: false };
					const component = githubToolRenderer.renderResult(result, options, theme);
					expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("exit code 7");
					expect(JSON.stringify(githubToolRenderer.describeResult(result, options))).toContain("exit code 7");
				}
				expect(
					runSpy.mock.calls.filter(([, args]) => args.some(arg => /\/actions\/jobs\/\d+\/logs$/.test(arg))),
				).toHaveLength(fixture.logs.length);
			});
		}
	});
}
