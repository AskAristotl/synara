# Cross-Model Sub-Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a running provider session spawn sub-agents of other providers (Claude↔Codex↔Cursor↔…) to delegate bounded tasks and collect structured results, via a Synara-owned MCP server over the existing event-sourced orchestration spine.

**Architecture:** A new `SubAgentOrchestrator` server service maps MCP tool calls (`spawn_agent`/`wait`/`send_message`/`stop_agent`) onto existing orchestration commands (`thread.create` with `parentThreadId`, `thread.turn.start`, interrupt/stop) and reads results from the projection. The MCP tools are served over one local HTTP endpoint with a per-session bearer token resolving to the caller's `threadId`. Sub-agents are real child `OrchestrationThread`s; the parent stays parked on a blocking `wait`, so no mid-turn injection is needed.

**Tech Stack:** TypeScript, Effect (`Effect`, `Layer`, `Schema`, `Stream`, RPC), `@modelcontextprotocol/sdk` (server), `@anthropic-ai/claude-agent-sdk`, Codex app-server, Cursor `cursor-agent acp`, Vitest. Monorepo packages: `apps/server`, `apps/web`, `packages/contracts`, `packages/shared`.

## Global Constraints

- `bun fmt`, `bun lint`, `bun typecheck` must all pass before a task is "done"; bundle them into ONE final verification pass per task. NEVER run `bun test` — always `bun run test` (Vitest).
- `packages/contracts` is schema-only — no runtime logic.
- Reuse the shared disclosure motion (`apps/web/src/lib/disclosureMotion.ts`) for any open/close UI; never bespoke transitions.
- Extract shared logic to modules; no duplicated logic across files.
- Default concurrency cap `SUBAGENT_MAX_LIVE_PER_ROOT = 6`; default `wait` max `SUBAGENT_WAIT_MAX_SECONDS = 600`. Define both as named constants in `packages/shared`.
- Sub-agents reuse existing fields verbatim: `parentThreadId`, `subagentAgentId`, `subagentNickname`, `subagentRole` on `ThreadCreateCommand`/`OrchestrationThread`. Do NOT add parallel fields.
- Design source of truth: `docs/superpowers/specs/2026-06-30-cross-model-agents-design.md`.

---

## Phase 0 — Contracts

### Task 0.1: Sub-agent MCP I/O + result-envelope schemas

**Files:**

- Create: `packages/contracts/src/subagent.ts`
- Modify: `packages/contracts/src/index.ts` (re-export; match existing barrel style)
- Test: `packages/contracts/src/subagent.test.ts`

**Interfaces:**

- Produces: `SubAgentSpawnInput`, `SubAgentWaitInput`, `SubAgentSendMessageInput`, `SubAgentStopInput`, `SubAgentResult`, `SubAgentStatus`, `SubAgentWorkspaceMode` (`"share"|"worktree"`), `SubAgentApprovalMode` (`"auto"|"ask-human"|"read-only"`). Field shapes exactly per spec §3.4–3.5.

- [ ] **Step 1: Write failing decode/encode tests** for each schema (valid sample round-trips; `workspace` defaults to `"share"`, `approval` defaults to `"auto"`, `attachParentContext`/`includeWip` default `false`, `wait.mode` defaults `"all"`). Mirror the `Schema.withDecodingDefault` pattern used in `orchestration.ts`.
- [ ] **Step 2: Run** `bun run test packages/contracts/src/subagent.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `subagent.ts` with effect `Schema.Struct`s reusing `ProviderKind` and `TrimmedNonEmptyString` from existing contracts; add the barrel re-export.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(contracts): add sub-agent MCP I/O + result envelope schemas`.

### Task 0.2: Shared constants + handle helpers

**Files:**

- Create: `packages/shared/src/subagent/index.ts` (subpath export `@t3tools/shared/subagent`)
- Modify: `packages/shared/package.json` exports map (follow existing subpath-export style)
- Test: `packages/shared/src/subagent/index.test.ts`

**Interfaces:**

- Produces: `SUBAGENT_MAX_LIVE_PER_ROOT = 6`, `SUBAGENT_WAIT_MAX_SECONDS = 600`, `clampWaitSeconds(n: number): number`, `isTerminalStatus(s: SubAgentStatus): boolean`.

- [ ] **Step 1: Write failing tests** — `clampWaitSeconds(99999) === 600`, `clampWaitSeconds(0) === 600` (fallback to default), `isTerminalStatus("running") === false`, `isTerminalStatus("completed") === true`.
- [ ] **Step 2: Run** `bun run test packages/shared/src/subagent/index.test.ts` — FAIL.
- [ ] **Step 3: Implement** constants + helpers.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(shared): add sub-agent constants and handle helpers`.

---

## Phase 1 — SubAgentOrchestrator service (tested against the engine, no MCP transport yet)

This phase proves the command-mapping vertical slice using the in-process engine directly. MCP transport arrives in Phase 2.

### Task 1.1: SubAgentOrchestrator — spawn (share-cwd)

**Files:**

- Create: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts`
- Create: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.ts`
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`

**Interfaces:**

- Consumes: `OrchestrationEngineService` (`.dispatch`, `.streamDomainEvents`), `ProjectionSnapshotQuery` (read child state), `ProviderDiscovery` (validate provider). Mirror the service/layer split used by existing `orchestration/Layers/*`.
- Produces: `SubAgentOrchestratorShape` with:
  - `spawn(caller: { threadId; projectId; cwd; canSpawn }, input: SubAgentSpawnInput): Effect<{ agentId: ThreadId }, SubAgentError>`
  - (later tasks add `wait`, `sendMessage`, `stop`)

- [ ] **Step 1: Write failing test** — given a fake engine that records dispatched commands, `spawn({…canSpawn:true}, { provider:"codex", task:"validate", workspace:"share" })` dispatches a `thread.create` whose `parentThreadId` equals the caller threadId, `subagentRole` equals input.role (or null), `envMode === "local"`, `worktreePath === null`, followed by a `thread.turn.start` carrying `task` for the new child threadId; returns `{ agentId }` equal to the minted child id.
- [ ] **Step 2: Run** `bun run test apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts` — FAIL.
- [ ] **Step 3: Implement** `spawn` for the `workspace:"share"` path: mint child `ThreadId`, derive child cwd = caller cwd, dispatch `ThreadCreateCommand` then `ThreadTurnStartCommand`. Provider validation via `ProviderDiscovery`; unavailable → typed `SubAgentError` (`provider-unavailable`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(server): SubAgentOrchestrator.spawn for shared-cwd children`.

### Task 1.2: SubAgentOrchestrator — wait (terminal collection)

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts`
- Modify: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.ts`
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`

**Interfaces:**

- Produces: `wait(caller, input: SubAgentWaitInput): Effect<readonly SubAgentResult[], SubAgentError>`.
- Consumes: `OrchestrationEngineService.streamDomainEvents` to await each child reaching a terminal session status; `ProjectionSnapshotQuery.getThreadShellById` / snapshot to read `finalMessage`, provider, model.

- [ ] **Step 1: Write failing tests** — (a) `wait({ agentIds:[child], mode:"all" })` returns one envelope with `status:"completed"` and `finalMessage` equal to the child's last assistant message after the engine emits the child's turn-complete + idle session; (b) a child that errors yields `status:"failed"` + `error`; (c) `timeoutSeconds: small` with a never-finishing child yields `status:"running"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `wait`: subscribe to domain events filtered to the target child threadIds, resolve when each reaches terminal (`stopped`/`error`/idle-after-turn) or the clamped timeout elapses; build `SubAgentResult` from projection. `mode:"any"` resolves on first terminal.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(server): SubAgentOrchestrator.wait collects child results`.

### Task 1.3: Register the orchestrator layer in the server composition

**Files:**

- Modify: `apps/server/src/wsRpc.ts` (or the server layer root that provides orchestration services — follow where `OrchestrationEngineService`/`ProviderService` are provided)
- Test: extend `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts` with a layer-provision smoke test.

**Interfaces:**

- Produces: `SubAgentOrchestrator` available in the server's Effect context.

- [ ] **Step 1: Write failing test** that builds the server layer and `yield* SubAgentOrchestrator` resolves.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Wire** the layer into the composition next to existing orchestration layers.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `chore(server): provide SubAgentOrchestrator layer`.

---

## Phase 2 — MCP endpoint + per-session identity

### Task 2.1: Session token registry

**Files:**

- Create: `apps/server/src/subagentMcp/SessionTokenRegistry.ts`
- Test: `apps/server/src/subagentMcp/SessionTokenRegistry.test.ts`

**Interfaces:**

- Produces: `issueToken(threadId, { canSpawn: boolean }): string`, `resolve(token): { threadId; canSpawn } | null`, `revoke(threadId): void`. Random opaque tokens; never derivable from threadId.

- [ ] **Step 1: Write failing tests** — issued token resolves to the right threadId + `canSpawn`; revoked token resolves to `null`; two threads get distinct tokens.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement (in-memory map; crypto-random token). **Step 4:** PASS. **Step 5:** Commit `feat(server): sub-agent MCP session token registry`.

### Task 2.2: MCP server exposing the four tools over HTTP

**Files:**

- Create: `apps/server/src/subagentMcp/SubAgentMcpServer.ts` (MCP server: tool defs + handlers calling `SubAgentOrchestrator`)
- Create: `apps/server/src/subagentMcp/httpTransport.ts` (mount streamable-HTTP MCP on the existing HTTP server; auth via `Authorization: Bearer <token>` → `SessionTokenRegistry.resolve`)
- Test: `apps/server/src/subagentMcp/SubAgentMcpServer.test.ts`

**Interfaces:**

- Consumes: `SubAgentOrchestrator`, `SessionTokenRegistry`.
- Produces: tools `spawn_agent`, `wait`, `send_message`, `stop_agent` whose input schemas equal the Phase-0 contracts; handlers resolve the caller from the bearer token and call the orchestrator; tool errors returned as MCP `isError` content, not thrown.

- [ ] **Step 1: Write failing tests** (in-process MCP client ↔ server): unauthenticated request rejected; `spawn_agent` with a valid token invokes `SubAgentOrchestrator.spawn` with caller derived from the token and returns `{ agentId }`; a sub-agent token (`canSpawn:false`) calling `spawn_agent` returns a tool error `depth-limit`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement server + HTTP transport. **Step 4:** PASS. **Step 5:** Commit `feat(server): sub-agent MCP server over HTTP with bearer auth`.

---

## Phase 3 — Inject the MCP server into provider sessions

### Task 3.1: Carry MCP config through session start

**Files:**

- Modify: `packages/contracts/src/provider.ts` (`ProviderSessionStartInput`: add optional `subagentMcp?: { url: string; token: string }`)
- Modify: `apps/server/src/provider/Services/ProviderService.ts` (issue a token via `SessionTokenRegistry` at session start when the thread is human-initiated → `canSpawn:true`, else `canSpawn:false`; pass `subagentMcp` to the adapter)
- Test: `apps/server/src/provider/Services/ProviderService.test.ts` (or nearest existing)

**Interfaces:**

- Produces: every `startSession` receives `subagentMcp` with a token whose `canSpawn` reflects depth-1.

- [ ] **Step 1: Write failing test** — starting a session for a root thread issues a `canSpawn:true` token and forwards `subagentMcp`; starting a session for a thread with `parentThreadId` issues `canSpawn:false`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(server): plumb sub-agent MCP config through session start`.

### Task 3.2: Claude adapter — register the MCP server

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (add `subagentMcp` to `options.mcpServers` as an HTTP MCP server when present)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

- [ ] **Step 1: Write failing test** asserting the `query()` options include an `mcpServers` entry pointing at `subagentMcp.url` with the bearer token when `subagentMcp` is provided, and none when absent.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(claude): expose sub-agent MCP tools to Claude sessions`.

### Task 3.3: Codex adapter — register the MCP server

**Files:**

- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts` (inject MCP server into app-server session config)
- Test: `apps/server/src/provider/Layers/CodexAdapter.test.ts`

- [ ] **Step 1: Write failing test** asserting the Codex app-server session config carries the sub-agent MCP server (url + token) when provided.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement per Codex app-server MCP config shape. **Step 4:** PASS. **Step 5:** Commit `feat(codex): expose sub-agent MCP tools to Codex sessions`.

### Task 3.4: Cursor adapter — register the MCP server

**Files:**

- Modify: `apps/server/src/provider/Layers/CursorAdapter.ts` (ACP MCP config)
- Test: `apps/server/src/provider/Layers/CursorAdapter.test.ts`

- [ ] **Step 1: Write failing test** asserting the ACP session passes the sub-agent MCP server config when provided.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(cursor): expose sub-agent MCP tools to Cursor sessions`.

> Gemini/Grok/Kilo/OpenCode/Pi adapters follow the same one-line config shim in a follow-up; not required for v1 acceptance.

---

## Phase 4 — Isolated-worktree writers

### Task 4.1: Worktree provisioning on spawn (`workspace:"worktree"`)

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts`
- Modify: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.ts`
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`

**Interfaces:**

- Consumes: `GitManager.createWorktree` (verified to exist at `apps/server/src/git/Layers/GitManager.ts`).

- [ ] **Step 1: Write failing test** — `spawn(..., { workspace:"worktree" })` calls `GitManager.createWorktree` branching from the parent repo HEAD, and the dispatched `thread.create` has `envMode:"worktree"` + the returned `worktreePath` + `branch`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement worktree branch (from HEAD). **Step 4:** PASS. **Step 5:** Commit `feat(server): provision isolated worktree for writer sub-agents`.

### Task 4.2: `includeWip` — snapshot parent dirty tree onto the child branch

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts`
- Possibly Modify: `apps/server/src/git/Services/GitCore.ts` + `Layers/GitCore.ts` (add a `snapshotWorkingTreeToBranch` primitive if not already expressible)
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`, `apps/server/src/git/Layers/GitCore.test.ts`

- [ ] **Step 1: Write failing tests** — with `includeWip:true` and a dirty parent tree, the child worktree's branch tip contains the parent's uncommitted changes, and the parent working tree is left unchanged (no staged/committed mutation in the parent).
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement via a temporary commit/tree object on the new branch (e.g. `git stash create` → commit on branch, or `write-tree` of the parent index/worktree applied to the child branch) without disturbing the parent worktree. **Step 4:** PASS. **Step 5:** Commit `feat(server): includeWip snapshots parent WIP onto child branch`.

### Task 4.3: Populate `diff` in the result envelope

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts` (`wait` builder)
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`

- [ ] **Step 1: Write failing test** — a worktree child that completes a turn producing a `thread.turn.diff.complete` yields `diff:{ branch, filesChanged, summary }` in the envelope; a share-cwd child yields `diff:null`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement by reading the child's latest checkpoint/diff projection. **Step 4:** PASS. **Step 5:** Commit `feat(server): include branch/diff metadata in sub-agent results`.

---

## Phase 5 — Approvals, governance, lifecycle

### Task 5.1: Approval policy resolution (`auto` / `read-only` / `ask-human`)

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts` (set child `runtimeMode`/approval policy from `input.approval`)
- Create: `apps/server/src/orchestration/Services/SubAgentApprovalResolver.ts` (auto-responder)
- Modify: the approval-request reactor (where `thread.approval-response-requested` is handled) to auto-emit `ThreadApprovalRespondCommand` for sub-agent threads whose policy is `auto`/`read-only`
- Test: `apps/server/src/orchestration/Services/SubAgentApprovalResolver.test.ts`

- [ ] **Step 1: Write failing tests** — `auto`: an approval request on a sub-agent thread is auto-approved server-side; `read-only`: write/exec approvals auto-denied, reads approved; `ask-human`: request is left for the human (not auto-resolved).
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement resolver keyed off the child thread's recorded approval mode. **Step 4:** PASS. **Step 5:** Commit `feat(server): auto-resolve sub-agent approvals per policy`.

### Task 5.2: Depth-1 + concurrency cap enforcement

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts`
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`

- [ ] **Step 1: Write failing tests** — `spawn` with `caller.canSpawn:false` → `SubAgentError("depth-limit")`; spawning a 7th live child under one root → `SubAgentError("concurrency-limit")`; a child reaching terminal frees a slot.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement live-child accounting per root (count non-terminal children via projection). **Step 4:** PASS. **Step 5:** Commit `feat(server): enforce depth-1 and per-root concurrency cap`.

### Task 5.3: Cascade-stop children on parent stop

**Files:**

- Modify: the handler for `thread.session.stop` / `thread.turn.interrupt` (parent path) to enumerate + stop live children
- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts` (`stop(agentId)` helper, reused)
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`

- [ ] **Step 1: Write failing test** — stopping a parent thread with two live children dispatches interrupt+stop for both; already-terminal children are untouched.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement cascade. **Step 4:** PASS. **Step 5:** Commit `feat(server): cascade-stop live sub-agents when parent stops`.

---

## Phase 6 — Multi-turn + stop tools + provider validation + timeout polish

### Task 6.1: `send_message` (follow-up turn to a child) + `stop_agent`

**Files:**

- Modify: `apps/server/src/orchestration/Services/SubAgentOrchestrator.ts` (`sendMessage`, `stop`)
- Modify: `apps/server/src/subagentMcp/SubAgentMcpServer.ts` (already-registered tools call through)
- Test: `apps/server/src/orchestration/Layers/SubAgentOrchestrator.test.ts`, `apps/server/src/subagentMcp/SubAgentMcpServer.test.ts`

**Interfaces:**

- Produces: `sendMessage(caller, { agentId, task })` dispatches `ThreadTurnStartCommand` on the idle child (authorizing the child belongs to caller); `stop(caller, { agentId })` interrupts+stops.

- [ ] **Step 1: Write failing tests** — `send_message` to a child the caller spawned starts a new turn on that child; `send_message` to a non-child → `SubAgentError("not-owner")`; `stop_agent` interrupts+stops a running child.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement with ownership checks (handle must be a child of caller). **Step 4:** PASS. **Step 5:** Commit `feat(server): multi-turn send_message and stop_agent for sub-agents`.

### Task 6.2: Provider availability errors + `wait` timeout semantics surfaced as tool results

**Files:**

- Modify: `apps/server/src/subagentMcp/SubAgentMcpServer.ts` (map `SubAgentError` variants → structured MCP tool errors; `status:"running"` returned, not an error)
- Test: `apps/server/src/subagentMcp/SubAgentMcpServer.test.ts`

- [ ] **Step 1: Write failing tests** — `spawn_agent` with an uninstalled provider returns a tool error `provider-unavailable` with a human-readable message; `wait` that times out returns envelopes with `status:"running"` (tool success, not error) so the caller can re-`wait`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement the error mapping. **Step 4:** PASS. **Step 5:** Commit `feat(server): structured sub-agent tool errors and re-waitable timeouts`.

---

## Phase 7 — Web UI surfacing

### Task 7.1: Sub-agent block in the parent conversation

**Files:**

- Create: `apps/web/src/components/conversation/SubAgentBlock.tsx`
- Modify: the parent conversation renderer to show a block per child (status chip + provider/model + nickname/role + link to the child thread), driven by existing `parentThreadId`/`subagentAgentId` projection data
- Test: `apps/web/src/components/conversation/SubAgentBlock.test.tsx`

**Interfaces:**

- Consumes: child thread shells (already in the read model) filtered by `parentThreadId === currentThreadId`.

- [ ] **Step 1: Write failing test** — renders one block per child with the child's status and a link to its thread; updates status on prop change.
- [ ] **Step 2: Run** `bun run test apps/web/src/components/conversation/SubAgentBlock.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the block; any expand/collapse uses `disclosureMotion.ts` helpers.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): show sub-agent blocks in the parent conversation`.

### Task 7.2: Child thread surfacing in the sidebar

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx` (nest children under their parent, or tag them with their role/provider)
- Test: `apps/web/src/components/Sidebar.test.tsx` (or nearest existing)

- [ ] **Step 1: Write failing test** — a thread with `parentThreadId` renders nested/tagged under its parent.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Implement (reuse existing sidebar disclosure). **Step 4:** PASS. **Step 5:** Commit `feat(web): nest sub-agent threads under their parent in the sidebar`.

---

## Phase 8 — End-to-end acceptance

### Task 8.1: Cross-model delegation integration test

**Files:**

- Create: `apps/server/src/subagentMcp/crossModel.integration.test.ts`

- [ ] **Step 1: Write a failing integration test** that, with stubbed provider adapters, drives: a root (Claude-stub) session calls `spawn_agent({provider:"codex", task, workspace:"share"})` over the MCP HTTP endpoint → child thread created + turn started → child-stub completes → root calls `wait` → receives a `completed` envelope with `finalMessage`. Then a second spawn with `workspace:"worktree"` returns a `diff` envelope.
- [ ] **Step 2: Run** — FAIL. **Step 3:** Fill any wiring gaps surfaced. **Step 4:** Run — PASS.
- [ ] **Step 5:** Final full verification pass: `bun fmt && bun lint && bun typecheck && bun run test`. Commit `test(server): end-to-end cross-model delegation`.

---

## Self-review notes (spec coverage)

- Decisions 1–14 map to phases: primitive/delegation (P1/P6), MCP invocation (P2/P3), spawn+wait (P1), real child thread (P1), workspace knob (P1 share / P4 worktree), free-form roles (P0 schema, label only), approvals (P5.1), result envelope (P0/P1.2/P4.3), pull+push context (P1 task string is the turn; `attachParentContext` push is a follow-up enhancement — see Open Items), HEAD/includeWip (P4.1/P4.2), v1 tools (P2/P6), governance depth-1+cap (P5.2), lifecycle cascade-stop + persistence (P5.3), feasibility/validation (P6.2).
- **Open items deferred (not v1-blocking, tracked here):** `attachParentContext` push path (wire the existing `handoff.ts` context builder into `spawn` when the flag is set); worktree cleanup tool/GC; Gemini/Grok/Kilo/OpenCode/Pi MCP config shims. Add as Phase 9 tasks when prioritized.
