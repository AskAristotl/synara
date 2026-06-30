# Cross-Model Sub-Agent Orchestration — Design Spec

> Status: approved design (grilled 2026-06-30). Implementation plan:
> `docs/superpowers/plans/2026-06-30-cross-model-agents.md`.

## 1. Goal

Let a running provider session in Synara (Claude, Codex, Cursor, …) **delegate
bounded tasks to sub-agents of _other_ providers** and collect structured
results — e.g. Claude spins up a Codex sub-agent to validate its work, or a
Cursor (Composer) sub-agent for fast implementation, and vice-versa. Modeled on
Traycer's cross-model agent orchestration, but built on Synara's existing
event-sourced orchestration spine rather than a new runtime.

## 2. Design decisions (decision record)

These were resolved during the grilling session and are binding for v1.

1. **Core primitive = message-passing; delegation is the first workflow on top.**
   We build the agent→agent message primitive (a message becomes a turn on a
   target thread) and ship _delegation_ (spawn + task + collect result) as the
   first consumer. Free-form peer messaging is an explicit v2 layer that reuses
   the same primitive.
2. **Invocation surface = MCP.** A Synara-owned MCP server exposes tools
   (`spawn_agent`, `wait`, `send_message`, `stop_agent`) to each provider
   session. Tool calls translate into existing orchestration commands. Tool
   results are structured (ideal for delegation).
3. **Result delivery = non-blocking `spawn_agent` + blocking `wait`.**
   `spawn_agent` returns a handle immediately; `wait([handles])` blocks until
   results arrive. Enables parallel fan-out. The parent stays _parked on `wait`_,
   so **no mid-turn inbound injection is needed in v1**.
4. **A sub-agent is a real child `OrchestrationThread`** reusing the full
   provider/session/turn/event machinery, linked via the _already-present_
   `parentThreadId` / `subagentAgentId` / `subagentRole` / `subagentNickname`
   fields on `ThreadCreateCommand` / `OrchestrationThread`. A compact subagent
   block in the parent conversation is the at-a-glance view.
5. **Workspace = explicit per-spawn knob** (`share` parent cwd | `worktree`).
   No role-based inference.
6. **Roles = free-form, explicit knobs only.** Nothing is inferred from a role
   name; the caller specifies provider, model, workspace, approval, and task.
   `subagentRole` is stored as the existing free-form string (label only).
7. **Approvals = explicit knob, default `auto` (full-access, server-resolved).**
   Sub-agent approval requests are resolved server-side by the spawn's policy
   (no human prompt by default) and remain visible in the child thread.
   `ask-human` and `read-only` are also selectable.
8. **`wait()` returns a structured envelope:**
   `{ agentId, threadId, provider, model, status, finalMessage, diff?, error? }`.
   No enforced output-schema engine in v1 — desired content format is stated in
   the task prompt and read from `finalMessage`.
9. **Context = pull by default**, with explicit push knob. The child is a real
   session with full tools; it reads files / `git diff` itself. `attachParentContext`
   opt-in pushes parent messages/diff via the existing handoff machinery.
10. **Isolated writers branch from HEAD**, with `includeWip: true` to snapshot
    the parent's dirty tree onto the child branch (parent tree untouched).
11. **v1 tools:** `spawn_agent`, `wait`, `send_message` (to a child only),
    `stop_agent`. **No peer messaging** (child→child or unsolicited child→parent).
12. **Governance:** depth-1 (only human-initiated sessions may spawn; sub-agents
    cannot spawn grandchildren) + concurrency cap (default 6 live children/root).
13. **Lifecycle:** child threads + writer worktrees persist until explicit
    cleanup. Stopping a parent **cascade-stops** its running children.
14. **Feasibility (verified in code):** all 8 adapters drive headless sessions
    with `full-access`; Cursor runs `cursor-agent acp`; the server already
    dispatches via `OrchestrationEngineService.dispatch` and exposes
    `ProviderService`. `spawn_agent` validates the provider against the existing
    discovery layer and fails gracefully when not installed/authed.

## 3. Architecture

### 3.1 Component overview

```
 provider session (parent: Claude/Codex/…)
   │  MCP tool call: spawn_agent / wait / send_message / stop_agent
   ▼
 Synara MCP endpoint  (local HTTP, streamable; per-session bearer token)
   │  token → caller threadId (the "agentId")
   ▼
 SubAgentOrchestrator (new server service)
   ├─ dispatch ThreadCreateCommand { parentThreadId=caller, subagentRole, … }
   ├─ provision workspace (share cwd | git worktree) via GitManager
   ├─ dispatch ThreadTurnStartCommand (the task) → ProviderRuntimeIngestion
   ├─ wait(): await child terminal state via OrchestrationEngine event stream
   └─ build result envelope from projection (finalMessage + diff metadata)
   ▼
 existing spine: OrchestrationEngine → projection → WS push → web UI
```

### 3.2 Why one HTTP MCP transport (not in-process JS)

The Claude Agent SDK accepts an in-process MCP server object, but Codex
(app-server) and Cursor (ACP) are _separate processes_ that can only attach to
an MCP server over a transport (HTTP/stdio). To keep **one tool implementation**
and a uniform identity story, the MCP server is served over a **single local
HTTP endpoint** that every provider session is configured to connect to. Each
session is handed a unique bearer token at `startSession`; the endpoint maps
token → caller `threadId`. All adapters already support configuring an MCP
server (Claude via `options.mcpServers`, Codex via app-server MCP config, Cursor
via ACP MCP config).

### 3.3 Identity & addressing

- The **caller's** identity is its own `threadId`, resolved from the bearer token
  — the orchestrator never trusts a client-supplied agent id for the _caller_.
- `spawn_agent` mints the child `threadId` and returns it as the **handle**
  (also surfaced as `subagentAgentId`). `wait`, `send_message`, and `stop_agent`
  take handles. The orchestrator authorizes that the handle is a child of the
  caller (depth-1, parent-owns-child).
- `nickname` is an optional caller-supplied label stored in `subagentNickname`.

### 3.4 Result envelope

```ts
type SubAgentStatus = "completed" | "failed" | "interrupted" | "timeout" | "running";

interface SubAgentResult {
  agentId: string; // child threadId
  threadId: string; // same as agentId; explicit for clarity
  provider: ProviderKind;
  model: string | null;
  status: SubAgentStatus;
  finalMessage: string; // child's last assistant message (may be partial on failure)
  diff: {
    // present for isolated writers that produced a checkpoint
    branch: string;
    filesChanged: number;
    summary: string;
  } | null;
  error: string | null;
}
```

`status: "running"` is returned by `wait` when the server-side max-wait elapses
before the child finishes; the same handle can be passed to `wait` again.

### 3.5 MCP tool contracts (v1)

```ts
// spawn_agent — non-blocking; creates + starts a child sub-agent.
spawn_agent(input: {
  provider: ProviderKind;            // validated against discovery
  task: string;                      // becomes the child's first turn
  model?: string;                    // defaults to provider default
  role?: string;                     // free-form label only (subagentRole)
  nickname?: string;                 // subagentNickname
  workspace?: "share" | "worktree";  // default "share"
  includeWip?: boolean;              // worktree-only; snapshot parent dirty tree
  approval?: "auto" | "ask-human" | "read-only"; // default "auto"
  attachParentContext?: boolean;     // default false (pull model)
}): { agentId: string }

// wait — blocking; returns envelopes for the given handles.
wait(input: {
  agentIds: string[];
  mode?: "all" | "any";   // default "all"
  timeoutSeconds?: number; // clamped to server max (default 600)
}): SubAgentResult[]

// send_message — follow-up turn to a child the caller spawned; then wait again.
send_message(input: { agentId: string; task: string }): { ok: true }

// stop_agent — interrupt + stop a child the caller spawned.
stop_agent(input: { agentId: string }): { ok: true }
```

### 3.6 Mapping to existing commands

| Tool action                  | Existing mechanism                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| create child thread          | `ThreadCreateCommand` with `parentThreadId`, `subagentAgentId`, `subagentRole`, `subagentNickname`, `envMode`, `worktreePath` |
| start the task turn          | `ThreadTurnStartCommand` (→ `ProviderRuntimeIngestion` → `ProviderService.sendTurn`)                                          |
| follow-up (`send_message`)   | `ThreadTurnStartCommand` on the idle child thread                                                                             |
| stop (`stop_agent`, cascade) | `ThreadTurnInterruptCommand` + `ThreadSessionStopCommand`                                                                     |
| approvals (`auto`)           | server auto-emits `ThreadApprovalRespondCommand` per policy                                                                   |
| worktree provisioning        | `GitManager.createWorktree` (+ WIP snapshot for `includeWip`)                                                                 |
| result `finalMessage`        | last assistant message from projection                                                                                        |
| result `diff`                | `thread.turn.diff.complete` payload (`files`, `checkpointRef`, branch)                                                        |

### 3.7 Governance & safety

- **Depth-1:** the MCP endpoint marks a session's token as `canSpawn` only when
  the session is human-initiated (no `parentThreadId`). `spawn_agent` from a
  sub-agent token is rejected.
- **Concurrency cap:** the orchestrator tracks live (non-terminal) children per
  root and rejects `spawn_agent` beyond `SUBAGENT_MAX_LIVE_PER_ROOT` (default 6).
- **Cascade-stop:** stopping/interrupting a parent thread enumerates its live
  children and stops them.
- **Provider validation:** `spawn_agent` consults provider discovery; an
  unavailable provider yields a structured tool error (not a thrown crash).

## 4. Out of scope for v1

- Peer messaging (child↔child, unsolicited child→parent), inbox streams, and
  out-of-band notices (Traycer's `turn-ended` / `awaiting-input` / `errored`).
  These are the v2 layer over the same primitive and require mid-turn injection.
- Grandchildren (depth ≥ 2).
- Enforced JSON output schemas / automatic merge of writer branches.
- Cross-host orchestration (Traycer's `isLocal`/`hostId`).

## 5. Risks & mitigations

| Risk                                                       | Mitigation                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Parent provider tool-call timeout < child runtime          | `wait` returns `status:"running"` + handle before the parent's own timeout; caller re-`wait`s |
| Full-access child in a _shared_ cwd runs destructive shell | Document clearly; `read-only` knob; default writers to `worktree` in guidance                 |
| Worktree accumulation                                      | persist-until-explicit-cleanup + a `cleanup` path; out-of-scope auto-GC noted                 |
| MCP token leakage between sessions                         | per-session random bearer token, server-side map, never client-trusted for caller identity    |
| Codex/Cursor MCP config differences                        | single HTTP transport; per-adapter config shim verified by an integration test each           |
