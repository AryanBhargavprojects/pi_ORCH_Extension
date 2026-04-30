# Orch Pi Extension

Orch is a multi-agent orchestration extension for Pi.

It adds:

- interactive orchestrator behavior during normal chat
- fresh-context sub-agents via `orch_delegate`
- orchestrator-only advisor guidance via `orch_smart_friend`
- autonomous mission mode via `/mission`
- an Orch control surface via `/orch` and `/orch-model`
- custom footer, mission widgets, and compact tool rendering

## Install

### Global install

Install Orch once and use it from any directory:

```bash
pi install npm:pi-orch-extension
```

Or install directly from GitHub:

```bash
pi install git:github.com/AryanBhargavprojects/pi_ORCH_Extension
```

Pi writes global installs to `~/.pi/agent/settings.json`, so Orch loads in every project on this machine.

Verify the package is installed:

```bash
pi list
```

If Pi is already running, reload it:

```bash
/reload
```

### One-off try without installing globally

```bash
pi -e npm:pi-orch-extension
```

## Local development

For local development you can keep the extension in an auto-discovered Pi extension directory such as:

```text
.pi/extensions/orch/index.ts
```

That lets you iterate in-place and reload with `/reload`.

## Current contents

- `index.ts` - extension entrypoint
- `commands.ts` - `/orch` command router and aliases
- `footer.ts` - minimal custom footer with model/context stats and reactive mascot
- `model-command.ts` - `/orch-model` sub-agent model selector and persistence
- `config.ts` - Orch config schema, defaults, validation, load/save helpers
- `cmux-streaming.ts` - caller-anchored cmux worker/validator split-pane setup and raw role stream tailing
- `interactive.ts` - default interactive orchestrator behavior plus `orch_delegate` and `orch_smart_friend`
- `mission.ts` - autonomous `/mission` loop, planning, milestones, validation, fix-task steering, and the live mission block UI
- `mission-state.ts` - live mission state directory I/O, state snapshots, feature status tracking
- `mission-types.ts` - shared mission, milestone, fix-task, and state types
- `plan.ts` - Plan Mode workflow, `/plan` command, Ctrl+\` shortcut, plan progress UI
- `plan-state.ts` - Plan Mode state directory I/O and artifact persistence
- `plan-types.ts` - shared Plan Mode types
- `tool-renderers.ts` - compact built-in tool rendering for subtler chat activity
- `messages.ts` - Orch event message renderer/helpers
- `prompt-loader.ts` - loads role prompts from the extension-local prompt folder
- `prompts/orchestrator.md` - orchestrator system prompt
- `prompts/worker.md` - worker system prompt
- `prompts/validator.md` - validator system prompt
- `prompts/smart-friend.md` - smart friend advisor system prompt
- `role-runner.ts` - fresh-session Orch subagent spawner plus worker/validator wrappers
- `runtime.ts` - runtime state plus footer/mission status helpers
- `constants.ts` - shared metadata and command names
- `utils.ts` - shared helpers for slug generation and error formatting
- `package.json` - Pi package metadata for npm/git distribution

## Registered commands

Primary entrypoints:

- `/orch` - Orch control center
- `/orch status` - runtime and config summary, including live mission state from `state.json` when a mission is active
- `/orch config` - show merged config plus user/project overrides
- `/orch config paths` - show config file paths and resolved Orch storage paths
- `/orch config init user|project [force]` - write a scaffold config file
- `/orch config set user|project <key> <value>` - persist a specific setting
- `/orch takeover [prompt]` - interrupt an active mission and return to interactive control
- `/orch reload` - reload Pi so Orch changes are picked up immediately
- `/orch-model [user|project] [role] [provider/model]` - select a Pi-available model for Orch sub-agents
- `/mission <goal>` - start explicit autonomous mission mode
- `/plan <goal>` - start Plan Mode (read-only analysis, no project edits)
- `/plan status` - report active plan status
- `/plan cancel` - abort active plan
- Ctrl+\` - enter Plan Mode using editor text or prompt for goal

Compatibility aliases:

- `/orch-status`
- `/orch-reload`
- `/orch-takeover [prompt]`

Pi's built-in `/reload` command also works.

## Interactive mode

Normal conversation runs with Orch interactive orchestration guidance injected into the system prompt.

### Footer

Orch now installs a custom minimal footer in the Pi TUI.

Footer contents only:

- current model name
- current thinking level for reasoning-capable models
  - mirrors Pi's live Shift+Tab thinking-cycle behavior
  - models with xhigh support show `off|minimal|low|medium|high|xhigh`
  - reasoning-capable models without xhigh show `off|minimal|low|medium|high`
  - non-reasoning models hide the thinking-level indicator
- current context usage as `used/total`
- a small animated cyber/geek mascot

Mascot behavior:

- `idle` when nothing is running
- `thinking` during normal chat turns
- `tool` while tools are executing
- `orchestrator` during Orch planning/steering phases
- `worker` during feature execution phases
- `validator` during validation phases
- `success`, `error`, and `interrupted` as short transient reactions

Additional custom tools:

- `orch_delegate` - run a fresh Orch role session with:
  - `orchestrator`
  - `worker`
  - `validator`
- `orch_smart_friend` - ask a fresh read-only advisor for a second opinion when the orchestrator is stuck

This gives the main conversational agent a way to delegate focused sub-tasks using the role-specific models from Orch config, and to consult a stronger read-only advisor when needed.

## Sub-agent model configuration

`/orch-model` is the Orch-side model selector for sub-agents.

It is intended to mirror Pi's normal `/model` flow, but for Orch roles instead of the active main session.

Behavior:

- reads the same Pi model registry used by `/model`
- only shows models that are currently available/authenticated in Pi
- lets the user choose which Orch role to configure:
  - `orchestrator`
  - `worker`
  - `validator`
  - `smart_friend`
  - `plan_clarifier`
  - `plan_codebase`
  - `plan_researcher`
  - `plan_feasibility`
  - `plan_synthesizer`
- lets the user choose which config scope to write to:
  - project scope
  - user scope
- persists the selected provider/model pair into Orch config
- the selected role models are then used by Orch sub-agents during delegation, `/mission`, and `/plan` runs

Interactive flow:

- `/orch-model`
  - prompts for scope
  - prompts for role
  - prompts for model from Pi's available model list
- `/orch-model worker`
  - prompts only for scope and model
- `/orch-model project validator`
  - prompts only for model

Examples:

```text
/orch-model
/orch-model worker
/orch-model project validator
/orch-model worker anthropic/claude-sonnet-4-5
/orch-model user orchestrator openai/gpt-5
```

## Sub-agent architecture

Orch sub-agents run as fresh Pi SDK sessions with isolated context.

Implemented pieces:

- **Subagent spawner** - `spawnOrchSubagent()` in `role-runner.ts`
- **Worker sub-agent wrapper** - `runOrchWorkerSubagent()`
  - receives a feature spec plus mission shared-state context
  - implements the feature and any generated fix tasks
  - returns a structured handoff for validator/orchestrator consumption
- **Validator sub-agent wrapper** - `runOrchValidatorSubagent()`
  - receives the worker handoff plus mission shared-state context
  - reviews the repository state
  - flags issues with severity and action items
- **Shared mission state access**
  - every role receives the mission state directory + file paths in its task prompt
  - roles can read the shared state files directly during execution
  - workers receive guidelines + knowledge base + feature status summary
  - validators receive knowledge base + feature status summary
  - orchestrator steering receives the shared state snapshot for fix planning

## Autonomous mission mode

`/mission <goal>` runs an isolated Orch loop:

1. Orchestrator plans the mission
2. Orchestrator decomposes the goal into features and milestone groups
3. Orchestrator generates mission guidelines and a validation contract
4. Orch creates a live mission state directory under `paths.missionsDir/<mission-id>/`
5. Worker sub-agent executes each feature in fresh context
6. Validator sub-agent reviews each feature in fresh context
7. If validation fails, orchestrator generates explicit fix tasks and optional guideline updates
8. Worker executes the fix tasks on the next attempt
9. After each milestone, validator performs milestone-level validation
10. Validator performs final mission validation
11. Final mission record is written to `paths.missionsDir`

Phase 4 behavior now implemented:

- **Live mission block UI**
  - the main Pi pane shows a single mission-control block above the editor during active missions
  - the block is styled as a distinct dark status panel instead of footer-like text
  - it combines the mission goal, current task, live checklist from `features.json`, and the latest orchestrator update
  - orchestrator visibility stays in the main Pi pane instead of a separate cmux pane
  - planned features and generated fix tasks both appear in the checklist
  - routine mission progress chatter is suppressed from the main transcript so the mission block becomes the primary UI
  - the block clears automatically when the mission completes or is interrupted
- **Interrupt and take-over**
  - use `/orch takeover` or `/orch-takeover`
  - or simply type a normal prompt while a mission is running
  - Orch aborts the active mission and hands control back safely
  - if you typed a prompt during mission execution, Orch delivers it after the mission has stopped
- **cmux split-pane streaming**
  - when Orch is running inside cmux, a mission creates persistent role panes for:
    - `worker`
    - `validator`
  - the orchestrator stays in the main Pi mission block on the left
  - pane creation is anchored to the current caller pane/workspace only, so Orch splits the active workspace instead of creating or drifting into a separate workspace view
  - if cmux cannot resolve the caller pane/workspace reliably, Orch skips split-pane streaming instead of guessing
  - panes are created once per mission, not once per feature
  - worker runs stream sequentially into the same worker pane across the mission
  - validator runs stream sequentially into the same validator pane across the mission
  - raw thinking/text deltas are appended to role-specific mission logs and tailed live in the cmux panes
  - pane management is cmux-only for v1 and uses cmux's programmable API
- **Externalized mission state**
  - every mission now creates a live state directory:
    - `plan.json`
    - `features.json`
    - `validation-contract.md`
    - `knowledge-base.md`
    - `guidelines.md`
    - `state.json`
  - `features.json` tracks feature status with `pending`, `in-progress`, `done`, and `failed`
  - generated fix tasks are externalized into the feature state as mission-visible fix entries
  - `knowledge-base.md` accumulates validator findings and orchestrator fix-plan notes
  - `guidelines.md` stores planning-time guidance plus steering-time updates
  - `state.json` is updated at phase transitions and powers live `/orch status` mission progress
- **Milestones and milestone validation**
  - mission plans now include milestone groups
  - Orch validates each milestone as an integrated unit before proceeding
  - milestone results are persisted in the final mission record
- **Fix-task loop**
  - validator failures now flow through an explicit loop:
    - validator flags issues
    - orchestrator generates fix tasks
    - worker executes those fix tasks on the next attempt
- **Minimal reactive footer**
  - the built-in footer is replaced by a single-line custom Orch footer
  - it shows only model name, current thinking level, current context usage, and an animated mascot
  - thinking-level display mirrors Pi's model-capability behavior exactly
  - the mascot reacts to normal chat work and Orch mission phases
- **Compact tool activity rendering**
  - built-in `read`, `bash`, `edit`, `write`, `find`, `grep`, and `ls` tool output is rendered in a subtler two-line activity style
  - collapsed tool rows show concise summaries instead of dumping raw output by default
  - `ctrl+o` still expands the row to show the underlying detailed output or diff

## Plan Mode

`/plan <goal>` runs a read-only planning workflow that produces a structured plan without modifying the project. Plan sub-agents use read-only tools plus a bash allowlist for safe inspection commands. A live Plan Control block appears above the editor with phase, active sub-agent, elapsed time, latest activity, checklist, and artifact path.

Workflow phases:

1. **Clarifier** - refines the goal and asks clarification questions if needed
2. **Codebase analysis** - inspects the repository with read-only tools
3. **Docs/web research** - reviews repo docs and performs best-effort external docs/web lookup when available
4. **Feasibility assessment** - evaluates technical risks and approach
5. **Synthesis** - produces final `plan.md` and `validation-contract.md`

Plan artifacts are written to `.pi/orch/plans/<plan-id>/`:

- `brief.md` - original and refined goal with assumptions
- `questions.json` - clarification questions and answers
- `research/codebase-analysis.md` - codebase analysis report
- `research/docs-web-research.md` - documentation research report
- `feasibility.md` - feasibility assessment
- `plan.md` - final implementation plan
- `validation-contract.md` - acceptance criteria for validation
- `state.json` - runtime plan state

Shortcuts:

- Ctrl+\` enters Plan Mode using editor text (or prompts for a goal if editor is empty)
- `/plan status` shows active plan phase and state directory
- `/plan cancel` aborts an active plan

If an agent turn or mission is already running, the shortcut notifies instead of starting a second plan.

After completion, Orch suggests running `/mission <refined goal>` to execute the plan autonomously.

Plan Mode role models are configurable through `/orch-model` using `plan_clarifier`, `plan_codebase`, `plan_researcher`, `plan_feasibility`, and `plan_synthesizer`. If a plan role is not explicitly configured, it inherits the current merged `orchestrator` model so existing project configs keep working.

## Config files

Orch merges config from two scopes:

- user-level: `~/.pi/agent/orch/config.json`
- project-level: `<project>/.pi/orch/config.json`

Merge order:

1. Orch defaults
2. user config
3. project config

Project config overrides user config.

## Config schema

```json
{
  "roles": {
    "orchestrator": { "provider": "anthropic", "model": "claude-opus-4-5" },
    "worker": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
    "validator": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
    "smart_friend": { "provider": "anthropic", "model": "claude-opus-4-7" },
    "plan_clarifier": { "provider": "anthropic", "model": "claude-opus-4-5" },
    "plan_codebase": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
    "plan_researcher": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
    "plan_feasibility": { "provider": "anthropic", "model": "claude-opus-4-5" },
    "plan_synthesizer": { "provider": "anthropic", "model": "claude-opus-4-5" }
  },
  "tokenThresholds": {
    "learningExtraction": 100000,
    "contextWarning": 80000
  },
  "paths": {
    "userProfileFile": "orch/user-profile.json",
    "projectContextFile": ".pi/orch/project-context.json",
    "knowledgeBaseFile": ".pi/orch/knowledge-base.json",
    "missionsDir": ".pi/orch/missions",
    "adaptationLogFile": ".pi/orch/adaptation-log.jsonl",
    "plansDir": ".pi/orch/plans"
  }
}
```

Relative path resolution:

- `paths.userProfileFile` resolves relative to `~/.pi/agent/`
- project paths resolve relative to the project root
- absolute paths are preserved as-is

## Prompt folder

Role prompts live in the package-local `prompts/` directory.

Files:

- `prompts/orchestrator.md`
- `prompts/worker.md`
- `prompts/validator.md`
- `prompts/smart-friend.md`
- `prompts/plan_clarifier.md`
- `prompts/plan_codebase.md`
- `prompts/plan_researcher.md`
- `prompts/plan_feasibility.md`
- `prompts/plan_synthesizer.md`

The interactive orchestrator prompt and fresh sub-agent sessions load from these files.

## Hot-reload dev workflow

1. Start Pi from the project that has Orch installed locally.
2. Edit the Orch package files.
3. Inside Pi, run either:
   - `/orch reload`
   - `/orch-reload`
   - `/reload`
4. Run `/orch status` to confirm the new runtime `loadedAt` timestamp and active config

## Notes

- No build step is required for now; Pi loads the TypeScript directly via its extension loader.
- Autonomous role sessions are created with the Pi SDK in fresh in-memory sessions.
- Mission runs write a JSON mission record under the configured `missionsDir`.
- While a mission is running, Orch also maintains a human-readable/live mission state directory under `paths.missionsDir/<mission-id>/`.
