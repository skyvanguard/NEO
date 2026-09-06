# Agent Note: Session deletion (permanent removal of a session, its log, and its registry references)

Status: implemented

## Problem

The Web GUI could rename, fork, or archive a session, and archive only hid the row through the registry-global archive set — no restore, no removal. A session the user no longer wanted stayed durable forever: its event log kept occupying storage and its row stayed hidden behind an archive set that nothing could clear per-session.

## Decision

One `session.delete` RPC performs a permanent, ordered three-step removal on the Host:

1. **Dispose the attached agent first** through its owned `AgentHandle`: the drain commits the final events before the log disappears, and the paired `session/disposed` edge broadcasts `host/session-removed` to every connected client.
2. **`persistence.remove(id)`** — a new `SessionPersistence.remove` capability. The base class rejects it (readRaw-style default); the SQLite backend deletes the session and event rows in one transaction, and the JSONL backend removes the session's whole directory. The coordinator joins the per-id write chain and, like `readFrom`, first waits for a retirement in flight, so a late write-behind cannot re-materialize the id behind the removal. Unknown ids resolve without effect.
3. **`workspaceRegistry.forgetSession(id)`** — prunes the id from the registry-global archive set and detaches it from every workspace account; both steps are write-free no-ops for ids nothing holds.

The apiproxy previously dropped every `AgentHandle` after reading `.agent`, so it now tracks handles in a `sessionHandles` map fed by every creation path: `ensureSession` (resume and create), `sessions.fork`, and the resolver's cold resume through a new `onHandle` callback on `ApiRemoteAgentOptions`. A live session with no tracked handle fails with `internal` rather than orphaning the agent; subagent-owned sessions are fenced `agent-busy` like every other session verb.

The client adds `ISessions.deleteSession`: the service calls the RPC, throws on a wire error, and re-pulls the baseline either way — attached sessions converge through the disposal edge, unattached ones leave no edge behind. The session row menu gains a danger delete item and a browser-owned confirmation dialog that mirrors the workspace delete dialog: it blocks duplicate submission and stays open until the list projection has committed the removal.

## Alternatives considered

**Delete as archive plus a purge flag.** Rejected: archive is a display set whose rows can return; deletion must remove the durable log. One knob for "hide" and "erase" would make the archive set a second source of truth about what exists.

**Cascade from workspace deletion only.** Rejected: a session must be deletable when it is ungrouped or its workspace record is already gone, and the registry has to forget the id in every case.

**Let the client drop the row locally and skip the refresh.** Rejected: the Host is the authority for what exists; the response alone must never remove a row, and the re-pull keeps cold deletes of other clients' sessions converging too.

## Consequences

- `SessionPersistence` gains a concrete capability with a rejecting default: a backend without `remove` makes deletion fail `internal` instead of deleting the registry references without the log.
- New wire method `session.delete` (`{ sessionId }` → `{ deleted: true }`) reusing the existing `agent-busy` / `session-not-found` / `internal` error vocabulary; the fetch carrier, both client API faces, and the keyless fixture implement it.
- Deleting a live session is the only host path that disposes the agent without client participation; the `session/disposed` edge (and thus `host/session-removed`) is what attached clients observe.
- Coverage: the shared persistence contract now tests `remove` against every backend; the apiproxy delete spec covers cold, live, cold-resume handle tracking, subagent fencing, the orphaned-handle `internal`, and not-found; the registry spec covers `forgetSession` accounting; client service and browser dialog specs cover the client half.
