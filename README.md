# pi-workflow

**A task-driven discipline extension for pi agents.**

`pi-workflow` enforces structured, task-by-task work on the [pi coding agent](https://github.com/earendil-works/pi). It registers a `workflow` MCP tool, a `/workflow` slash command, and a real-time terminal UI — together forming a lightweight project-management layer that keeps the agent focused and accountable.

---

## How It Works — Gate Principle

> *The agent may only use non-workflow tools if an active list exists, has at least one non-closed task, and **exactly one task is in progress**.*

Every tool call (except `workflow` itself and `ctx_*` context tools) is intercepted. If the gate conditions are not met, the call is blocked and the agent receives a nudge message explaining what to do next.

---

## Task Status Machine

```
idle ──start──► inprogress ──done──► done  (terminal)
  ▲                  │
  └──unblock──┐      ├──pause──► idle
              │      └──block──► blocked ⇄ unblock ──► idle
              │
              └── skip ──────────────────────────────► skipped  (terminal)
```

Any non-terminal task can also be `skip`ped at any time.

---

## Tool: `workflow`

### Actions

| Action | Required params | Optional params | Description |
|--------|----------------|-----------------|-------------|
| `new-list` | `text` (title) | `description` | Create a new task list (replaces current after confirmation) |
| `list` | — | — | Show all tasks with progress bar |
| `add` | `text` **or** `texts[]` | `importance`, `acceptance` | Add one or multiple tasks |
| `start` | `id` | — | Set a task to *inprogress* (auto-pauses any other active task) |
| `done` | `id` | `note`, `evidence[]` | Mark a task as completed |
| `pause` | `id` | — | Return an *inprogress* task to *idle* |
| `block` | `id`, `reason` | — | Block a task with a reason |
| `unblock` | `id` | — | Return a *blocked* task to *idle* |
| `skip` | `id`, `reason` | — | Permanently skip a task |
| `remove` | `id` | — | Remove a mistakenly added task (not for intentional exclusions) |
| `update` | `id` | `text`, `importance`, `acceptance` | Edit task metadata |
| `move` | `id` | `position`, `beforeId`, `afterId` | Reorder tasks |
| `clear` | — | — | Remove all tasks and reset the list |

### Task Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Auto-incrementing unique identifier |
| `text` | string | Task description |
| `status` | `idle` \| `inprogress` \| `blocked` \| `skipped` \| `done` | Current status |
| `importance` | `low` \| `normal` \| `high` \| `critical` | Priority level (default: `normal`) |
| `acceptance` | string[] | Acceptance criteria shown as a reminder on `done` |
| `blockedReason` | string | Why the task is blocked |
| `skippedReason` | string | Why the task was skipped |
| `doneNote` | string | Completion note |
| `evidence` | string[] | Evidence of completion (links, file paths, etc.) |
| `elapsedMs` | number | Active working time in milliseconds |
| `usage.inputTokens` | number | Input tokens consumed while working on this task |
| `usage.outputTokens` | number | Output tokens consumed while working on this task |
| `usage.toolCalls` | Record<string, number> | Per-tool call counts for this task |

---

## Mandatory Agent Rules

The tool description embeds these rules so the agent always follows them:

1. Always call `workflow list` first to check current state before working on an existing list.
2. If the user's new request does not fit the current list's theme, use `clear` then `new-list`.
3. Before any new work, call `workflow new-list`; `add` requires an existing list.
4. Only `idle` tasks can be started with `start`.
5. When finished, use `done` with `note` and/or `evidence` to document completion.
6. Never reopen a `done` task.
7. Use `block` for obstacles, `skip` for deliberate exclusions — not `remove`.
8. `remove` is only for mistakenly added tasks.
9. No cyclic toggle action exists or should be used.

---

## Slash Command: `/workflow`

Opens a full-screen overlay displaying the current task list. Requires interactive terminal mode.

```
/workflow
```

Press **Escape** to close the overlay.

---

## Terminal UI Surfaces

The extension renders three persistent UI surfaces:

| Surface | Content |
|---------|---------|
| **Current-task widget** | Shown above the editor when a task is *inprogress*. Displays task text, importance, and live elapsed time. |
| **Footer** | Model ID · context usage % · input/output token totals · estimated cost · cwd · git branch · per-tool call counters |
| **Status line** | Active list title and overall progress (`X/Y closed`) |

---

## Nudge & Summary Behaviour

**Nudge** — After each agent turn, if no task is in progress or an in-progress task is stale, the agent receives a `⚠️ workflow-nudge` message:
- No active task → start the next idle task.
- Active task still open → complete, block, or pause it.
- Third consecutive nudge → escalated warning requiring resolution.

**Final summary** — Once all tasks are closed, a `✅ workflow-summary` message is emitted once per list version:

```
✅ Workflow complete: <list title>

Tasks:
  ✓ #1 Implement feature — 12m 34s — note: shipped in v2.3
  ↷ #2 Write docs — skipped: deferred

Tools used:
  - Read: 14
  - Edit: 8
  - Bash: 3
```

---

## State & Session Handling

Workflow state is stored in tool-result `details` for proper branching support. State is reconstructed automatically on:
- `session_start`
- `session_switch`
- `session_fork`
- `session_tree`

This means the task list survives `/fork`, `/clone`, and session switches without data loss.

---

## Architecture

```
workflow.ts
├── Types          WorkflowTask, WorkflowSnapshot, WorkflowDetails
├── Schema         TypeBox schema for all action parameters
├── UI Components  WorkflowListComponent (overlay), refreshUI()
│                  Current-task widget, footer with token/cost stats
├── Events         session_start/switch/fork/tree → reconstructState()
│                  tool_execution_end → token & tool-count tracking
│                  tool_call → blocking gate
│                  agent_end → nudge / final summary
├── Tool           workflow (13 actions)
└── Command        /workflow → overlay
```

**Dependencies:**
- `@earendil-works/pi-ai` — `StringEnum`, `AssistantMessage`
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, `Theme`
- `@earendil-works/pi-tui` — `Text`, `truncateToWidth`, `visibleWidth`, `matchesKey`
- `@sinclair/typebox` — JSON schema / validation

---

## Example Workflow

```
# Start a new list
workflow new-list  text="Refactor auth module"

# Add tasks
workflow add  texts=["Audit existing code", "Extract token logic", "Write tests", "Update docs"]

# Work task by task
workflow start  id=1
... (do the work) ...
workflow done  id=1  note="Found 3 security issues, all fixed"

workflow start  id=2
... (unexpected dependency) ...
workflow block  id=2  reason="Waiting for crypto lib upgrade"

workflow start  id=3
workflow done  id=3  evidence=["tests/auth.test.ts"]

workflow unblock  id=2
workflow start   id=2
workflow done    id=2

workflow skip  id=4  reason="Docs PR opened separately"
# → Final summary emitted automatically
```

---

## License

Part of the [pi](https://github.com/earendil-works/pi) extension ecosystem by Earendil Works.
