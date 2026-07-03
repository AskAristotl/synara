# Task API

A small first-class HTTP facade for dispatching coding tasks to Synara from
external services, without speaking the Effect-RPC WebSocket protocol.

A task is a **standalone automation run**: `POST /api/tasks` maps onto
`AutomationService.create` (schedule `manual`, mode `standalone`) +
`AutomationService.runNow`, so every task gets a fresh thread + turn, and
done-detection stays fully server-side (`AutomationRunReactor` →
`AutomationService.reconcileThread` derives
`succeeded`/`failed`/`interrupted`/`waiting-for-approval` from the thread
shell). This module reimplements **no orchestration** — it only translates HTTP
onto the existing automation/orchestration services.

## Auth

Same posture as the rest of the HTTP surface: `ServerAuth.authenticateHttpRequest`
(session cookie or bearer session token). The legacy `T3CODE_AUTH_TOKEN`
query-param credential is **not** accepted here.

Headless bearer recipe (works today):

1. Bind the server to a non-loopback host (e.g. `T3CODE_HOST=0.0.0.0`). Startup
   prints a pairing banner whose URL ends in `/pair#token=<credential>`.
2. `POST /api/auth/bootstrap/bearer {"credential": "<credential>"}` →
   `{"sessionToken": "..."}` (30-day TTL).
3. Send `Authorization: Bearer <sessionToken>` on every task API request.

Note: any paired session (including role `client`) can create tasks in any
project — Synara has no per-user identity; invoker attribution belongs in the
calling service.

## Routes

### `POST /api/tasks` → `201`

```jsonc
{
  "projectId": "<required, must exist — see Projects below>",
  "prompt": "<required>",
  "name": "<optional, defaults to the prompt's first line>",
  "modelSelection": { "provider": "cursor", "model": "auto" }, // optional; falls back to the project's default model (400 if neither exists)
  "providerOptions": { "cursor": { "binaryPath": "..." } },    // optional passthrough
  "worktreeMode": "auto" | "local" | "worktree",                // optional, default "auto"
  "runtimeMode": "approval-required" | ...,                     // optional, default "approval-required"
  "interactionMode": "...",                                     // optional passthrough
  "acknowledgedRisks": ["full-access" | "local-checkout" | "fast-interval"], // required in practice for full-access / non-repo local checkouts — create hard-fails without it
  "deliverPr": true                                             // optional; prompt-level: appends a "commit and open a pull request" instruction; the PR surfaces as lastKnownPr on the events endpoint
}
```

Response: `{"taskId": "<automation run id>", "threadId": "...", "status": "running"}`.

### `GET /api/tasks/:taskId/events?after=N` → `200`

Cursor over the durable orchestration event log, filtered to the task's thread,
plus per-poll snapshots. Poll with `after=<last nextCursor>`; start at `after=0`.

```jsonc
{
  "taskId": "...",
  "threadId": "...",
  "run": { "status": "pending|running|waiting-for-approval|succeeded|failed|interrupted|cancelled",
           "error": null, "result": { "outcome": "...", "summary": null, ... },
           "startedAt": "...", "finishedAt": "..." },           // snapshot per poll — there is no terminal domain event; derive terminality from run.status
  "lastKnownPr": null,                                           // thread-shell snapshot; populated when a PR is created/observed on the thread
  "pendingApprovals": [ { "approvalId": "...", "turnId": "...", "createdAt": "..." } ],
  "events": [                                                    // minimal external union, each with a monotonic "sequence"
    { "type": "assistant-message", "sequence": 14, "turnId": "...", "text": "..." }, // FINAL messages only; streaming deltas are filtered out
    { "type": "activity", "sequence": 15, "tone": "info|tool|approval|error", "kind": "...", "summary": "...", "approvalId": "..."? },
    { "type": "approval-resolved", ... }, { "type": "user-input-resolved", ... },
    { "type": "turn-diff", "files": [...] }, { "type": "pr-updated", ... }
  ],
  "nextCursor": 16                                               // max sequence scanned; the log is GLOBAL, so the cursor also advances past other threads' events
}
```

### `POST /api/tasks/:taskId/input` → `202`

One of:

```jsonc
{ "type": "approval",   "approvalId": "<requestId>", "decision": "accept|acceptForSession|decline|cancel" }
{ "type": "user-input", "approvalId": "<requestId>", "answers": { ... } }
{ "type": "message",    "text": "follow-up user turn" }
```

Maps onto `thread.approval.respond` / `thread.user-input.respond` /
`thread.turn.start` (reusing the run's permission snapshot — a follow-up cannot
escalate modes), queued behind startup reconciliation like the ws RPC. A fresh
`taskapi:<uuid>` commandId is minted per request, so HTTP retries are never
dropped by the engine's receipt dedupe. Response:
`{"taskId": ..., "threadId": ..., "commandId": ...}`.

## Projects

`projectId` must reference an existing project (else `404`). Projects are only
created via the `project.create` orchestration command (web UI / ws RPC) —
there is no HTTP create-project route. For tests/smoke, one in-process engine
dispatch seeds a project (see `taskApi.integration.test.ts`).

## Headless boot + spend-free smoke recipe

```sh
SYNARA_HOME=$(mktemp -d) T3CODE_PORT=4599 T3CODE_HOST=0.0.0.0 T3CODE_NO_BROWSER=1 \
  bun run --cwd apps/server dev
```

(The missing web bundle is a warning only — the API works standalone.)
Get a bearer via the pairing recipe above. For a no-model-spend end-to-end run,
point the cursor provider at the in-repo mock ACP agent:

```jsonc
"modelSelection": { "provider": "cursor", "model": "auto" },
"providerOptions": { "cursor": { "binaryPath": "<wrapper>" } }
```

where `<wrapper>` is a 2-line sh script asserting `$1 = acp` then
`exec bun apps/server/scripts/acp-mock-agent.ts` (see
`CursorTextGeneration.test.ts` `makeAcpAgentWrapper`). The mock answers every
prompt with a fixed text (`T3_ACP_PROMPT_RESPONSE_TEXT`) and `end_turn`, so the
run reaches `succeeded` in ~1s.

## Known limits (v0)

- **Approval handling is mandatory for headless dispatchers**: the default
  `runtimeMode` is `approval-required`; a run that hits an approval parks in
  `waiting-for-approval` forever unless the caller polls `pendingApprovals` and
  answers via `/input`. `runtimeMode: "full-access"` avoids this but requires
  `acknowledgedRisks: ["full-access"]`.
- **Input commands are accepted, not validated, synchronously**: `/input`
  returns `202` when the engine accepts the command; e.g. an unknown
  `approvalId` still yields `202` and the failure surfaces asynchronously in
  the event stream (`approval-resolved` + an `error`-tone
  `provider.approval.respond.failed` activity).
- **Follow-up `message` after a terminal run does not reopen the run**: the
  turn really runs on the thread and its events keep flowing, but `run.status`
  stays terminal (`AutomationRepository.getRunByThreadId` ignores terminal rows).
- **Final assistant text can appear more than once** (e.g. on
  `assistant.complete` and turn completion) — dedupe by `sequence`/`turnId` if
  it matters to the consumer.
- **Cursor scans the global log**: `nextCursor` advances past other threads'
  events; per-poll cost is O(all events since cursor) with a 1000-event page
  limit. Escape hatch if it bites: a by-aggregate SQL read (the store already
  has the columns).
- **One automation definition row per task**, never archived — harmless, but
  clutters the automations UI. Archive-on-terminal is the obvious follow-up.
- **No terminal event** exists in the union; treat `run.status` (snapshot) as
  the source of truth for terminality.
