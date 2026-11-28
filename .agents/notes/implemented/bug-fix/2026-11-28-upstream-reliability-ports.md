# Agent Note: Upstream reliability fixes ported by hand after the history re-root

Status: implemented

## Problem

The public history no longer shares a commit with upstream deepseek-harness, so no upstream fix applies with `git apply`, even with fuzz. A triage of the upstream commits between 2026-10-17 and 2026-11-22 found five fixes whose defect exists in this fork and matters for a local OpenAI-compatible model on one slot:

- A compaction whose own summary request exceeded the context window failed outright. The region ceiling (`maxRegionTokens`) bounds the span from the token meter's estimate, and that estimate can undercount what the provider bills, so a session could keep growing until every request was refused.
- `classifyPiAiError` scanned the whole failure message. A gateway `500` whose body quotes its upstream's `401` matched `AUTH`, which the retry policy does not retry, and a `413` stayed the unclassified `PI_AI_ERROR`.
- `fs-local` joined `~/notes.md` onto the base directory, so home-relative reads and writes missed or landed in a literal `~` folder.
- The continuable-delegation prompt section never told the parent to end its turn while only waiting on background children, so it kept the turn open by sleeping or polling, spending model requests on the slot its children need.
- The persistent bash shell left history expansion on, so `!` handling depended on how a bash build's history expander reads the `$'…'` wrapper.

## Decision

Each fix is reimplemented against the fork's code, one commit per package, with the upstream commit named in the commit message.

### Summary overflow retries a smaller prefix

`compactSurfaceRegion` accepts `allowSmallerPrefix`. When the summarizer fails with code `CONTEXT_WINDOW_EXCEEDED`, the transaction rechecks stability and retries inside the same bracket over the first half of the span's tool-balanced units, rounding up, until a request fits or one unit remains. The code is read structurally because the fork's default summarizer rethrows the stream failure as a plain `Error` carrying `code`, not as an `LlmError` (upstream cf7229e72a reads `LlmError`). Pressure and overflow compaction run through a private `compactAutomaticRegion`, and `compactNow()` passes the option; an explicit `compactRegion()` range stays exact. Only the successful attempt is recorded on `compaction/summary`.

### pi-ai failures classify by their leading status

When a message leads with a `4xx`/`5xx` status, the numeric rules read only that status, and a leading `5xx` returns `SERVER` before the wording rules, so quoted rate-limit, invalid-request, or size text cannot turn a retryable server failure into a terminal one. Quota wording keeps its precedence. A `413` or oversized-body message is `INVALID_REQUEST`. Upstream d1711894c8 bounds only the numeric rules; the leading-`5xx` precedence is this fork's extension.

### fs-local expands a requested home prefix

`resolve` and `lstat` replace a leading `~` or `~/`, and `~\` on Windows only, with `os.homedir()`. `~user`, later `~` segments, and listed child names stay literal. This follows upstream 32004176bf, which superseded the shared `expandHomePath` of ae0dfd1003 because `~\` is a literal file name on POSIX. `tool-fs`'s `attach_file` keeps its own expansion because other filesystem backends may not expand `~`.

### The delegation prompt ends a waiting turn

The `tool:<toolName>` section adds that, once only the children's results remain, the model ends its turn instead of sleeping or polling. An idle parent's settlement notice arrives through `followup()` and starts the next turn, so the instruction is accurate for this fork (upstream bc540720ec).

### The persistent shell disables history expansion

Initialization runs `stty -echo; set +H`. On bash 5.2 the `$'…'` wrapper already keeps `!` out of history expansion, so the new loader-composition case passes there with or without the change; `set +H` removes the dependence on that quoting detail that upstream 967ba4c4b8 hit.

## Alternatives considered

**Rebase or cherry-pick from upstream.** Rejected: there is no merge base, and every tested patch failed to apply because intermediate upstream refactors are absent here.

**Keep `compactRegion()` as the automatic entry point and widen its signature.** Rejected: `compactRegion()` is the `@neo/compaction` Service Definition method with a fixed contract; adding a retry option there changes every backend. `summarize()` remains the subclass hook.

**Port the pi-ai fix verbatim.** Rejected: its wording rules still scan a leading-`5xx` body, so `502 … invalid request` became a non-retryable `INVALID_REQUEST`, the same cross-hop leak the fix targets.

**Reuse `@neo/home-paths` `expandHomePath` in `fs-local`.** Rejected: it expands `~\` on every platform, which rewrites a legal POSIX file name.

## Consequences

A session whose summary request overflows now compacts a smaller head span instead of failing, at the cost of up to log2(n) failed summary requests that the log does not record. A subclass that overrides `compactRegion()` no longer intercepts automatic compaction. A workspace folder literally named `~` is now reachable only as `./~`. Gateway `5xx` failures retry whatever their body quotes. The four failure cases are pinned by package tests; the bash change has no failing case on bash 5.2.
