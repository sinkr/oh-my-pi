# Prewalk

Prewalk is a one-shot handoff from the active model to a faster or cheaper model after planning reaches implementation. It lets the starting model inspect the repository, create a todo list, and begin the change before the target model continues the session.

Prewalk is off by default. Its default target is the model assigned to the `@smol` role. To have OMP decide per task whether a prompt is worth it, see [Auto-prewalk](#auto-prewalk).

## Enable prewalk

Enable prewalk persistently in the global config:

```bash
omp config set prewalk.enabled true
```

The equivalent YAML in `~/.omp/agent/config.yml` or a project `.omp/config.yml` is:

```yaml
prewalk:
  enabled: true
```

The configured setting arms new sessions, not resumed/imported sessions. Explicit session flags can arm either:

| Flag | Effect |
| --- | --- |
| `--prewalk` | Arm prewalk for the new session. |
| `--no-prewalk` | Leave prewalk disabled for the startup session, even when `prewalk.enabled` is `true`, and keep [auto-prewalk](#auto-prewalk) out of it. `/new` still follows the settings. |
| `--prewalk-into <model-or-role>` | Arm prewalk and use the supplied model pattern or role instead of `@smol`. |

For example:

```bash
omp --prewalk
omp --prewalk-into @smol
omp --prewalk-into openai/gpt-5-mini
```

At startup, OMP resolves the target with the normal model-role and model-matching rules, trying configured role candidates in order for an authenticated, enabled provider. Extension-provided targets may resolve after extension registration. If no usable target remains, OMP prints a warning and starts with prewalk unarmed.

`--no-prewalk` cannot be combined with `--prewalk` or `--prewalk-into`. An explicit `--prewalk-into @default` resolves against the default role from before `--model` overrides it.

`/new` starts a fresh cycle using `prewalk.enabled` and the current `@smol` assignment, rather than inheriting a consumed handoff or the previous todo gate. Startup flags (`--prewalk`, `--no-prewalk`, `--prewalk-into`) apply only to the startup session; `/new` always uses the configured setting. When prewalk is enabled, the new session restores the previous planning model and thinking level after a handoff unless a later selection replaced them. If the planning model can no longer be used (for example, its credentials were removed), `/new` warns and stays on the current model. Resuming an existing session does not automatically re-arm prewalk.

Any model or thinking-level change made after the handoff counts as a replacement, including the switches plan mode makes on entry and exit. Automatic retry fallback, fallback restoration, and context promotion do not; if the session is back on the handoff model and thinking level when you run `/new`, it still restores the planning model.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. Without an active `todo` tool, the gate is already open.

OMP switches at the completed assistant-turn boundary containing the first eligible `edit` or `write` result, after persisting that turn's assistant message and tool results. Unlike the todo gate, the edit/write trigger does not require a successful result.

Calls to other tools do not trigger the handoff. A read-only `xd://` device request routed through `write`, such as LSP navigation, also does not count; only device operations classified as workspace writes or execution count.

The switch is one-shot: after the handoff, prewalk disarms itself, removes the planning nudge, and steers the target with an implementation checklist. It changes the session's active model and optional thinking level without rewriting model-role assignments. A same-model handoff can still change thinking; when the model and effective thinking configuration already match, prewalk disarms without switching.

## Arm from an active session

In a top-level session, changing `prewalk.enabled` live also takes effect:
turning it on arms the current `@smol` target when none is armed; turning it off
disarms a pending handoff. This does not control subagent prewalk.

Run these slash commands without restarting OMP:

```text
/prewalk
/prewalk restart
/prewalk off
```

`/prewalk` arms a one-shot handoff from the active model to the current `@smol` assignment.

`/prewalk off` cancels a pending handoff and clears its planning steering without changing the active model, saved configuration, or already-delivered continuation history. It is safe to run when already off or after a handoff; it does not switch back to the planning model. Cancellation applies only to the current session: `/new` re-arms prewalk when the configured setting is enabled. It also keeps [auto-prewalk](#auto-prewalk) from arming again until `/new`.

After a handoff, `/prewalk restart` immediately returns the session to the current `@default` assignment and re-arms the handoff to `@smol`. Both roles are resolved when the command runs, so the cycle is independent of concrete model names and does not alter either role's persisted configuration.

If prewalk is already armed, `/prewalk` leaves the existing target in place. `/prewalk restart` also preserves a matching arm; if its existing target differs from the current `@smol` resolution, restart is rejected before changing the active model. To choose a different target at startup, use `--prewalk-into`.

## Auto-prewalk

`prewalk.enabled` and `/prewalk` unconditionally arm a one-shot handoff. Auto-prewalk asks OMP's native judge, per task, whether prewalk is worthwhile. Classifying alone never switches models: only a qualifying task under `on` switches from the configured source to the configured target. It is a prewalk-suitability check, not a difficulty rating or a general model router.

```yaml
prewalk:
  enabled: false
  auto: on
  autoSource: "@slow"
  autoTarget: "@smol"
```

`prewalk.autoSource` (default `@slow`) and `prewalk.autoTarget` (default `@smol`) take a model pattern or role, resolved with the normal role and model-matching rules, including authentication.

| `prewalk.auto` | Behavior |
| --- | --- |
| `off` (default) | No classification; nothing changes. |
| `suggest` | Classifies each eligible prompt and reports the decision only. Never resolves or switches models, arms prewalk, or injects the plan or checklist. |
| `on` | Classifies each eligible prompt. When the judge is confident the task fits, and both source and target resolve with usable credentials, switches to the source and arms a handoff to the target; otherwise nothing changes. |

Run `suggest` for a while to see how it judges your prompts, then set `auto: on`.

`prewalk.enabled` keeps its meaning: unconditional prewalk, independent of `prewalk.auto`.

### Requirements

Auto-prewalk needs the `judge` model role to resolve first to a native judgment backend, the same condition as `find.enabled: auto`. It uses the existing judge-role provider support, including TypeSafe `jev`, OpenRouter, OpenAI Decisions, and Workers AI Clef. It relies on calibrated probabilities and never executes a prompted on-device or chat judge, even if the judge-role cache predates a login or discovery change. Without a native judge nothing is classified, and nothing is reported.

### What it decides

The judge sorts each task by where its expensive reasoning belongs, not by how hard or large it is:

| Route | Meaning | Typical tasks |
| --- | --- | --- |
| `prewalk` | The hard thinking comes first; once it settles the approach, the remaining implementation and verification are bounded. | Tracing an unfamiliar subsystem before a localized change; reading several interacting files before implementing a clear design; diagnosing a bug down to a concrete fix; a migration whose hard part is finding the transformation and everything it touches. |
| `primary` | Strong reasoning stays necessary while implementing, debugging, or validating, so the first edit is too early to hand off. | Unresolved races or invariants; subtle lifecycle changes; a bug whose cause will still be unclear after a first look; high-risk or algorithmically hard changes. |
| `direct` | There is no up-front phase worth handing off from. | Explanations and read-only questions; trivial, mechanical, or fully specified edits; tiny localized fixes. |

Volume of work alone and difficulty alone never make a task a prewalk candidate, and a wrong handoff costs more than a missed one: between `prewalk` and `primary` the judge is told to choose `primary`, and for a small task to choose `direct`. OMP arms only when `prewalk` wins **and** its probability is at least 0.70. That threshold is fixed, and a `prewalk` winner below it counts as a "no".

`suggest`, and negative decisions under `on`, report one line per prompt:

```text
Auto-prewalk: prewalk 0.84
Auto-prewalk: primary (prewalk 0.18)
Auto-prewalk: direct (prewalk 0.06)
Auto-prewalk: prewalk 0.55 (below threshold)
```

Under `on`, a confident decision shows the usual `Prewalk: armed for …` notice instead, after the session has switched to the source. Thinking effort is then chosen for the source model. The existing handoff does the switching to the target, with its todo gate and first `edit`/`write` trigger unchanged. Like a configured prewalk, an armed turn skips the `todo.eager` reminder, since the plan nudge owns todo creation.

### What is classified

Only real user-authored turns in the top-level session: typed prompts and user-invoked `/skill:` prompts. Synthetic continuation turns, hidden steering, agent-attributed messages, subagents, plan mode, and turns where prewalk is already armed are skipped. Classification runs after the prompt is expanded and before auto thinking and the model request, so thinking effort is judged for the model that will actually answer.

Queued follow-ups and visible user steering are classified when they are delivered, not when they are enqueued. If a steering batch needs auto-prewalk routing, it waits for the next model-call boundary instead of entering an already-streaming response on the old model. Hidden or otherwise ineligible steering keeps its existing live-delivery behavior. Withdrawing queued input cancels its preparation and rolls back only the model, thinking, and pending handoff it still owns.

A follow-up such as `do that` or `continue` cannot be judged alone, so the judge also sees the previous substantive user request and the agent's last reply, each truncated like other small-model input. The current request stays authoritative: the context only resolves what it points at.

### Manual controls win

A negative, direct, or sub-threshold decision, or a classifier error, leaves the model, thinking level, and prewalk exactly as they were. If either selector cannot be resolved or authenticated, or arming or the switch cannot proceed, OMP rolls back to the exact prior state and the turn runs as if auto-prewalk were off. Auto-prewalk does not restore the source model later; handoffs are not undone before the next task, and `/new` follows the usual rules above.

An explicit model or thinking-level selection made while prompt setup is waiting takes ownership of that turn, including during memory recall, classification, or credential checks. Auto-prewalk does not overwrite it when the awaited work finishes. Selections made before submitting the prompt do not disable automatic routing for the new task.

A pending prewalk, whether from `/prewalk`, `prewalk.enabled`, `--prewalk`, or an earlier auto arm that has not handed off yet, is never replaced, retargeted, or reclassified. `/prewalk off` and `--no-prewalk` keep auto-prewalk out of the session (for `--no-prewalk`, the startup session) until `/new`, and neither switches models. An explicit `/prewalk` or `/prewalk restart` still arms normally and takes over a pending auto arm.

### Failure behavior

Auto-prewalk is an optimization and fails open. A missing native judge, a judge error or malformed answer, the 4-second timeout, an abort, a prompt superseded while the judge ran, or an unusable source or target all leave the turn exactly as it would be without auto-prewalk. Answers with invalid probabilities, an inconsistent winning route, or invalid confidence are rejected. Judge failures are logged rather than shown; an unusable selector reports an `Auto-prewalk skipped: source/target …` warning. Judgments are journaled as model usage under the purpose `auto-prewalk`.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.
