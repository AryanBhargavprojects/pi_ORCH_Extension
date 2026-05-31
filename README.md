# Orch Pi Extension

Orch is a multi-agent orchestration extension for Pi.

It adds:

- interactive orchestrator behavior during normal chat
- a Claude Code-like `TodoWrite` checklist for the main Pi orchestrator
- Orch sub-agents via `orch_delegate` (validator runs are always fresh; other roles may reuse cached context)
- orchestrator-only advisor guidance via `orch_smart_friend`
- autonomous goal mode via `/orch goal`
- an Orch control surface via `/orch` and `/orch-model`
- custom footer, goal widgets, and compact tool rendering

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
- `interactive.ts` - default interactive orchestrator behavior plus `TodoWrite`, `orch_delegate`, and `orch_smart_friend`
- Goal engine modules - autonomous `/orch goal` execution, deterministic planning/steering, milestones, conditional validation, live goal block UI, and goal state snapshots
- `tool-renderers.ts` - compact built-in tool rendering for subtler chat activity
- `messages.ts` - Orch event message renderer/helpers
- `prompt-loader.ts` - loads role prompts from the extension-local prompt folder
- `prompts/orchestrator.md` - orchestrator system prompt
- `prompts/worker.md` - worker system prompt
- `prompts/validator.md` - validator system prompt
- `prompts/smart-friend.md` - smart friend advisor system prompt
- `role-runner.ts` - Orch subagent spawner plus worker/validator wrappers and non-validator session reuse
- `runtime.ts` - runtime state plus footer/goal status helpers
- `constants.ts` - shared metadata and command names
- `utils.ts` - shared helpers for slug generation and error formatting
- `package.json` - Pi package metadata for npm/git distribution

## Registered commands

Primary entrypoints:

- `/orch` - Orch control center
- `/orch status` - runtime and config summary, including live goal state from `state.json` when a goal is active
- `/orch goal status` - report whether an autonomous goal is running and show its current phase/state paths
- `/orch goal cancel` - cancel an active autonomous goal without entering takeover mode
- `/orch config` - show merged config plus user/project overrides
- `/orch config paths` - show config file paths and resolved Orch storage paths
- `/orch config init user|project [force]` - write a scaffold config file
- `/orch config set user|project <key> <value>` - persist a specific setting
- `/orch takeover [prompt]` - interrupt an active goal and return to interactive control
- `/orch reload` - reload Pi so Orch changes are picked up immediately
- `/orch-model [user|project] [role] [provider/model]` - select a Pi-available model for Orch sub-agents
- `/orch goal <goal>` - start explicit autonomous goal mode

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
- `orchestrator` when the main Pi agent is coordinating Orch work
- `worker` during feature execution phases
- `validator` during validation phases
- `success`, `error`, and `interrupted` as short transient reactions

Additional custom tools:

- `TodoWrite` - maintain a short live checklist for multi-step work in the main Pi orchestrator session
- `orch_delegate` - run an Orch role session with:
  - `worker`
  - `validator`
  - `plan_codebase`
  - `research`
- `orch_smart_friend` - ask a read-only advisor for a second opinion when the orchestrator is stuck
- `tinyfish` - run the TinyFish web automation/search agent for current web search, source lookup, live website extraction, and scraping

cmux integration:

- When Pi runs inside cmux, Orch mirrors task/goal/todo progress to the cmux workspace sidebar using `cmux set-status`, `cmux set-progress`, and `cmux log`.
- Orch sends native cmux notifications with `cmux notify` when interactive turns, goals, or tracked todo lists complete.
- cmux calls are best-effort no-ops outside cmux and never block Orch work.

This gives the main conversational agent a way to orchestrate directly, keep visible progress with todos, delegate focused sub-tasks using the role-specific models from Orch config, consult a stronger read-only advisor when needed, use cmux workspace status/notifications, and use TinyFish/Parallel/Context7-enabled research for web and docs lookup.

Validation is conditional during normal orchestration unless a stricter goal-stage validation step is triggered.

### TinyFish web search agent

Orch registers a `tinyfish` custom tool for the main orchestrator and enables it for `research` sub-agents. Use it with either:

- `query` for broad web search (defaults to DuckDuckGo HTML search results)
- `url` + `goal` for a specific website extraction/automation task

TinyFish authentication is read from `TINYFISH_API_KEY`; if that is not set, Orch falls back to `~/.pi/agent/orch/tinyfish-api-key`. Keep this file outside git and mode `0600`.

## Sub-agent model configuration

`/orch-model` is the Orch-side model selector for sub-agents.

It is intended to mirror Pi's normal `/model` flow, but for Orch roles instead of the active main session.

Behavior:

- reads the same Pi model registry used by `/model`
- only shows models that are currently available/authenticated in Pi
- lets the user choose which Orch sub-agent role to configure:
  - `worker`
  - `validator`
  - `smart_friend`
  - `research`
  - `plan_codebase`
- lets the user choose which config scope to write to:
  - project scope
  - user scope
- persists the selected provider/model pair into Orch config
- the selected worker/validator/smart-friend/research/plan_codebase role models are used by Orch sub-agents during delegation and `/orch goal` runs

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
/orch-model user research anthropic/claude-sonnet-4-5
```

## Sub-agent architecture

Orch validator sub-agents always run as fresh Pi SDK sessions with isolated context. Other Orch roles may reuse cached Pi SDK session context when the cwd/role/model/tool setup matches.

Implemented pieces:

- **Subagent spawner** - `spawnOrchSubagent()` in `role-runner.ts`
- **Worker sub-agent wrapper** - `runOrchWorkerSubagent()`
  - receives a feature spec plus goal shared-state context
  - implements the feature and any generated fix tasks
  - returns a structured handoff for the main Pi orchestrator and validator consumption
- **Validator sub-agent wrapper** - `runOrchValidatorSubagent()`
  - receives the worker handoff plus goal shared-state context
  - reviews the repository state
  - flags issues with severity and action items
- **Shared goal state access**
  - every role receives the goal state directory + file paths in its task prompt
  - roles can read the shared state files directly during execution
  - workers receive guidelines + knowledge base + feature status summary
  - validators receive knowledge base + feature status summary
  - failed validation is converted into deterministic fix tasks without spawning an orchestrator sub-agent

## Autonomous goal mode

`/orch goal <goal>` runs an isolated Orch loop:

1. The main Pi agent orchestrates the goal
2. Orch creates a simple goal execution plan from the goal
3. Orch creates a live goal state directory under the configured goal runs directory
4. Worker sub-agent executes each feature, usually reusing its cached role session context when the configuration matches
5. Validator sub-agent reviews a feature only when conditional policy says validation is needed; validator runs are always fresh
6. If validation fails, Orch generates deterministic fix tasks and optional follow-up instructions
7. Worker executes the fix tasks on the next attempt
8. After each milestone, validator performs milestone-level validation
9. Validator performs final goal validation
10. Final goal record is written to the configured goal runs directory

Phase 4 behavior now implemented:

- **Live goal block UI**
  - the main Pi pane shows a single goal-control block above the editor during active goals
  - the block is styled as a distinct dark status panel instead of footer-like text
  - it combines the goal objective, current task, live checklist from `features.json`, and the latest orchestrator update
  - orchestrator visibility stays in the main Pi pane instead of a separate cmux pane
  - planned features and generated fix tasks both appear in the checklist
  - routine goal progress chatter is suppressed from the main transcript so the goal block becomes the primary UI
  - the block clears automatically when the goal completes or is interrupted
- **Interrupt and take-over**
  - use `/orch takeover` or `/orch-takeover`
  - or simply type a normal prompt while a goal is running
  - Orch aborts the active goal and hands control back safely
  - if you typed a prompt during goal execution, Orch delivers it after the goal has stopped
- **cmux split-pane streaming**
  - when Orch is running inside cmux, a goal creates persistent role panes for:
    - `worker`
    - `validator`
  - the orchestrator stays in the main Pi goal block on the left
  - pane creation is anchored to the current caller pane/workspace only, so Orch splits the active workspace instead of creating or drifting into a separate workspace view
  - if cmux cannot resolve the caller pane/workspace reliably, Orch skips split-pane streaming instead of guessing
  - panes are created once per goal, not once per feature
  - worker runs stream sequentially into the same worker pane across the goal
  - validator runs stream sequentially into the same validator pane across the goal
  - raw thinking/text deltas are appended to role-specific goal logs and tailed live in the cmux panes
  - pane management is cmux-only for v1 and uses cmux's programmable API
- **Externalized goal state**
  - every goal now creates a live state directory:
    - `plan.json`
    - `features.json`
    - `validation-contract.md`
    - `knowledge-base.md`
    - `guidelines.md`
    - `state.json`
  - `features.json` tracks feature status with `pending`, `in-progress`, `done`, and `failed`
  - generated fix tasks are externalized into the feature state as goal-visible fix entries
  - `knowledge-base.md` accumulates validator findings and deterministic fix-plan notes
  - `guidelines.md` stores planning-time guidance plus steering-time updates
  - `state.json` is updated at phase transitions and powers live `/orch status` goal progress
- **Milestones and milestone validation**
  - goal plans now include milestone groups
  - Orch validates each milestone as an integrated unit before proceeding
  - milestone results are persisted in the final goal record
- **Fix-task loop**
  - validator failures now flow through an explicit loop:
    - validator flags issues
    - Orch creates deterministic fix tasks without an orchestrator sub-agent
    - worker executes those fix tasks on the next attempt
- **Minimal reactive footer**
  - the built-in footer is replaced by a single-line custom Orch footer
  - it shows only model name, current thinking level, current context usage, and an animated mascot
  - thinking-level display mirrors Pi's model-capability behavior exactly
  - the mascot reacts to normal chat work and Orch goal phases
- **Compact tool activity rendering**
  - built-in `read`, `bash`, `edit`, `write`, `find`, `grep`, and `ls` tool output is rendered in a subtler two-line activity style
  - collapsed tool rows show concise summaries instead of dumping raw output by default
  - `ctrl+o` still expands the row to show the underlying detailed output or diff

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
    "research": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
    "plan_codebase": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  },
  "tokenThresholds": {
    "learningExtraction": 100000,
    "contextWarning": 80000
  },
  "paths": {
    "userProfileFile": "orch/user-profile.json",
    "projectContextFile": ".pi/orch/project-context.json",
    "knowledgeBaseFile": ".pi/orch/knowledge-base.json",
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
- `prompts/research.md`
- `prompts/plan_codebase.md`

The interactive orchestrator prompt and Orch sub-agent session behavior load from these files.

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
- Validator sessions are created with the Pi SDK in fresh in-memory sessions; other Orch roles may reuse cached in-memory sub-agent sessions until Orch shuts down.
- Goal runs write a JSON goal record under the configured goal runs directory.
- While a goal is running, Orch also maintains a human-readable/live goal state directory under that directory.
