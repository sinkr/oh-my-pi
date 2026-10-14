import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger, pathIsWithin, toError } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";
import { SEANCE_AGENT_NAME } from "./seance-policy";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;

function artifactsDirectoryFor(sessionFile: string): string | null {
	if (!sessionFile.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH);
}

function neutralizeInheritedSessionInit(manager: SessionManager): void {
	// getEntries returns a shallow copy, so updating these entry objects changes the manager's transcript.
	for (const entry of manager.getEntries()) {
		if (entry.type !== "session_init") continue;
		const data = { ...entry };
		const mutable = entry as unknown as Record<string, unknown>;
		for (const key of Object.keys(mutable)) delete mutable[key];
		Object.assign(mutable, {
			type: "custom",
			customType: "source_session_init",
			id: data.id,
			parentId: data.parentId,
			timestamp: data.timestamp,
			data,
		});
	}
}

async function copySeanceArtifacts(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
	let realSource = sourceSessionFile;
	try {
		realSource = await fs.promises.realpath(sourceSessionFile);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const sourceArtifactsDir = artifactsDirectoryFor(realSource);
	const destinationArtifactsDir = artifactsDirectoryFor(destinationSessionFile);
	if (!sourceArtifactsDir || !destinationArtifactsDir) return;
	if (path.resolve(sourceArtifactsDir) === path.resolve(destinationArtifactsDir)) return;

	try {
		if (!(await fs.promises.stat(sourceArtifactsDir)).isDirectory()) {
			throw new Error(`Session artifacts path is not a directory: ${sourceArtifactsDir}`);
		}
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}

	let realSourceArtifactsDir: string;
	try {
		realSourceArtifactsDir = await fs.promises.realpath(sourceArtifactsDir);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	await fs.promises.mkdir(path.dirname(destinationArtifactsDir), { recursive: true });
	const realDestinationParent = await fs.promises.realpath(path.dirname(destinationArtifactsDir));
	const realDestinationSessionFile = path.join(realDestinationParent, path.basename(destinationSessionFile));
	let realDestinationArtifactsDir: string;
	try {
		realDestinationArtifactsDir = await fs.promises.realpath(destinationArtifactsDir);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		realDestinationArtifactsDir = path.join(realDestinationParent, path.basename(destinationArtifactsDir));
	}
	if (realSourceArtifactsDir === realDestinationArtifactsDir) return;

	let snapshotDir: string | undefined;
	let failure: unknown;
	try {
		let copySourceDir = realSourceArtifactsDir;
		if (pathIsWithin(realSourceArtifactsDir, realDestinationArtifactsDir)) {
			snapshotDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-seance-artifact-snapshot-"));
			await fs.promises.cp(realSourceArtifactsDir, snapshotDir, {
				recursive: true,
				force: false,
				errorOnExist: false,
				filter: source => {
					const candidate = path.resolve(source);
					return (
						candidate !== realDestinationSessionFile &&
						candidate !== realDestinationArtifactsDir &&
						!pathIsWithin(realDestinationArtifactsDir, candidate)
					);
				},
			});
			copySourceDir = snapshotDir;
		}
		await fs.promises.mkdir(destinationArtifactsDir, { recursive: true });
		await fs.promises.cp(copySourceDir, destinationArtifactsDir, {
			recursive: true,
			force: false,
			errorOnExist: false,
		});
	} catch (error) {
		failure = error;
	}

	if (snapshotDir) {
		try {
			await fs.promises.rm(snapshotDir, { recursive: true, force: true });
		} catch (error) {
			if (failure === undefined) failure = error;
			else {
				logger.warn("Failed to remove seance artifact snapshot", {
					snapshotDir,
					error: toError(error).message,
				});
			}
		}
	}
	if (failure !== undefined) throw failure;
}

export async function forkSeanceSession(args: {
	sourceFile: string;
	sessionFile: string;
	cwd: string;
	sessionDir?: string;
	storage?: SessionStorage;
}): Promise<SessionManager> {
	const { sourceFile, sessionFile, cwd, sessionDir } = args;
	const storage = args.storage ?? new FileSessionStorage();
	if (storage.existsSync(sessionFile)) throw new Error(`Fork destination already exists: ${sessionFile}`);
	const destinationArtifactsDir = artifactsDirectoryFor(sessionFile);
	if (destinationArtifactsDir) {
		try {
			await fs.promises.lstat(destinationArtifactsDir);
			throw new Error(`Fork artifact destination already exists: ${destinationArtifactsDir}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}

	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		if (manager.getSessionFile() !== sessionFile) {
			throw new Error("Fork destination changed while the session was being created.");
		}

		neutralizeInheritedSessionInit(manager);
		const header = manager.getHeader();
		if (!header) throw new Error("The new seance session has no session header.");
		header.historyScope = "session";
		header.sessionPolicy = SEANCE_AGENT_NAME;

		const inheritedDirectories = manager.getAdditionalDirectories();
		await manager.setAdditionalDirectories([]);
		if (inheritedDirectories.length === 0) await manager.rewriteEntries();
		if (manager.getSessionFile() !== sessionFile) {
			throw new Error("Fork destination changed while the session was being prepared.");
		}
		await copySeanceArtifacts(sourceFile, sessionFile);
		return manager;
	} catch (error) {
		if (manager) {
			try {
				await manager.dropSession(manager.getSessionFile() ?? sessionFile);
			} catch (cleanupError) {
				logger.warn("Failed to remove incomplete seance fork", {
					sessionFile: manager.getSessionFile() ?? sessionFile,
					error: toError(cleanupError).message,
				});
			}
		}
		throw error;
	}
}
