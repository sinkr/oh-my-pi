import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
export {
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
export type {
	SubagentProgressPayload,
	SubagentLifecyclePayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { type BaseType, type } from "@oh-my-pi/omptype";
import { $env } from "@oh-my-pi/pi-utils";

import type { AgentSessionEvent } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import type { CreateAgentSessionOptions } from "../sdk";
import type { PersistedSessionInit, SessionForkOptions } from "../session/session-manager";
import type { ToolSession } from "../tools";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;

export const taskItemSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"+": "delete",
});

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"+": "delete",
});
const taskSchemaBatch = type({
	context: "string",
	tasks: taskItemSchemaIsolated.array(),
	"+": "delete",
});
const taskSchemaBatchNoIsolation = type({
	context: "string",
	tasks: taskItemSchema.array(),
	"+": "delete",
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string;
	effortEnabled: boolean;
	evalToolsEnabled: boolean;
	structured: boolean;
	taskPolicyFields: Record<string, BaseType>;
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent);
	const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
	const schemaFields = options.structured
		? { "outputSchema?": outputSchemaInputSchema, "schemaMode?": '"permissive" | "strict"' }
		: {};
	const toolsField = options.evalToolsEnabled ? { "tools?": "string[]" } : {};
	const taskPolicyFields = options.taskPolicyFields;
	if (options.batchEnabled) {
		if (options.isolationEnabled) {
			const item = type.raw({
				"name?": "string",
				agent,
				task: "string",
				solutionSpace: "string",
				...effortField,
				...schemaFields,
				...toolsField,
				...taskPolicyFields,
				"isolated?": "boolean",
				"+": "delete",
			});
			return type.raw({
				context: "string",
				tasks: item.array(),
				"+": "delete",
			});
		}
		const item = type.raw({
			"name?": "string",
			agent,
			task: "string",
			solutionSpace: "string",
			...effortField,
			...schemaFields,
			...toolsField,
			...taskPolicyFields,
			"+": "delete",
		});
		return type.raw({
			context: "string",
			tasks: item.array(),
			"+": "delete",
		});
	}
	if (options.isolationEnabled) {
		return type.raw({
			"name?": "string",
			agent,
			task: "string",
			solutionSpace: "string",
			...effortField,
			...schemaFields,
			...toolsField,
			...taskPolicyFields,
			"isolated?": "boolean",
			"+": "delete",
		});
	}
	return type.raw({
		"name?": "string",
		agent,
		task: "string",
		solutionSpace: "string",
		...effortField,
		...schemaFields,
		...toolsField,
		...taskPolicyFields,
		"+": "delete",
	});
}

/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	/** Advertise the `tools` field for eval-defined tools (`eval.tools.enabled`, default on). */
	evalToolsEnabled?: boolean;
	/** Advertise `outputSchema`/`schemaMode` (`task.structured`); default on. */
	structured?: boolean;
	defaultAgent?: string;
	taskPolicySchemas?: readonly AgentTaskSchema[];
}): TaskToolSchemaInstance {
	const {
		taskPolicySchemas = [],
		defaultAgent: requestedDefaultAgent,
		effortEnabled: requestedEffortEnabled,
		evalToolsEnabled: requestedEvalToolsEnabled,
		structured: requestedStructured,
		...schemaOptions
	} = options;
	const defaultAgent = requestedDefaultAgent ?? "task";
	const effortEnabled = requestedEffortEnabled ?? false;
	const evalToolsEnabled = requestedEvalToolsEnabled ?? true;
	const structured = requestedStructured ?? true;
	const orderedTaskPolicySchemas = [...taskPolicySchemas].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const taskPolicyFields = Object.assign({}, ...orderedTaskPolicySchemas.map(schema => schema.fields));
	if (
		defaultAgent === "task" &&
		!effortEnabled &&
		evalToolsEnabled &&
		structured &&
		orderedTaskPolicySchemas.length === 0
	) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
	const policyKey = JSON.stringify(orderedTaskPolicySchemas.map(schema => schema.key));
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${effortEnabled ? "effort" : "default"}:${evalToolsEnabled ? "tools" : "notools"}:${structured ? "structured" : "prose"}:${policyKey}:${defaultAgent}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({
		...schemaOptions,
		effortEnabled,
		evalToolsEnabled,
		structured,
		defaultAgent,
		taskPolicyFields,
	});
	taskSchemaCache.set(key, schema);
	return schema;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

export interface AgentTaskSchema {
	/** Stable identity; change when fields or guidance change. */
	key: string;
	fields: Record<string, BaseType>;
	guidance?: string;
}

export interface AgentTaskPreparationContext {
	session: ToolSession;
	invocationKind: "task" | "eval";
	agent: AgentDefinition;
	params: TaskParams;
	planMode: boolean;
	isolationRequested: boolean;
	hasCustomTools: boolean;
}

/** Owned self-contained source fork: excludes parent workspace/extensions; core owns rollback and private artifacts. */
export interface PreparedAgentTaskSession {
	fork: {
		sourceFile: string;
		options: SessionForkOptions;
	};
	promptSuffix?: (resolvedModel?: string) => string;
}

export interface AgentTaskPreparation {
	modelPatterns?: string[];
	session?: PreparedAgentTaskSession;
}

export interface AgentTaskRestorePolicy {
	cwd: string;
	modelPattern: string;
	toolNames: string[];
}

export interface AgentTaskPolicy {
	available?: (context: { planMode: boolean }) => boolean;
	schema?: AgentTaskSchema;
	validate?: (context: { params: TaskParams; batchEnabled: boolean; defaultAgent: string }) => string | undefined;
	prepare?: (context: AgentTaskPreparationContext) => Promise<AgentTaskPreparation>;
	session?: {
		options: (cwd: string) => Partial<CreateAgentSessionOptions>;
		restore?: (context: {
			init: PersistedSessionInit;
			cwd: string;
			modelRegistry: ModelRegistry;
		}) => Promise<AgentTaskRestorePolicy | undefined>;
	};
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	/** `true` = task spawns keep the `yield` tool and this agent's `output` schema even when `task.structured` is off. */
	structured?: boolean;
	autoloadSkills?: string[];
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	/** Advisor for spawned sessions of this agent: `true` = advise with the default advisor-role model, string = advise with that model pattern (optional `:level` suffix). Absent/`false` = no advisor. */
	advisor?: boolean | string;
	/** Trusted built-in code only; never parsed from user or session agent frontmatter. */
	taskPolicy?: AgentTaskPolicy;
	source: AgentSource;
	filePath?: string;
}
