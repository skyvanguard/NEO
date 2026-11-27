# @neo/anonymous-user-id

English | [中文](README.zh.md)

Anonymous identity for DeepSeek provider requests. `getOrCreateAnonymousUserId()` returns a random UUID v4 scoped to one harness home, persisted as the bare line `$NEO_HOME/.anonymous-user-id` (`~/.neo/.anonymous-user-id` when `NEO_HOME` is unset). `dsh-llm-deepseek` sends it as `x-deepseek-harness-user-id`, so one harness home presents one stable identity across requests.

The identity is never derived from the hostname, network address, git remote, or another identifying source. Deleting `.anonymous-user-id` resets the identity on the next process launch. Separate harness homes have separate identities.

## Storage contract

Reads and writes are synchronous so boot-time and request-time consumers share one API. The result is memoized per resolved file path for the process lifetime. A first writer uses exclusive creation and a concurrent loser adopts the persisted winner; a corrupt file is replaced. Persistence is best-effort, so an unwritable home still receives a process-local UUID rather than blocking a provider request.

## Composition

This package is a shared library, not a Cordis plugin. Consumers import `getOrCreateAnonymousUserId()` directly. Its invariant companion is intentionally empty because the package owns no event stream or public mutable relation that can be checked without creating the identity as a side effect.

## Model Experience

None, as the identifier reaches DeepSeek only as model-hidden HTTP transport metadata and never enters the request body, prompt, or model-visible content.

#### KV Cache effect

None; the transport header changes neither tokens nor the model-visible prefix.

## Known Limitations and Deferred Work

- **No recovery after deletion** — loss mints a new anonymous identity by design; recovery would require stable derivation material that weakens anonymity.
- **Best-effort concurrency** — a reader landing in the narrow interval between a concurrent process's exclusive create and completed write can use a different in-memory UUID for that run; later launches converge on the persisted value.
- **No cross-home identity** — different `$NEO_HOME` values cannot be correlated.
- **Configured DeepSeek gateways receive the id** — `dsh-llm-deepseek` sends the stable header to its resolved `baseURL`, including deployment overrides.
