# `@neo/browser`

The Playwright browser-control surface as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts a single [`@neo/mcp-client`](../../mcp/mcp-client/README.md) row that spawns the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server over stdio, registering its browser-control tools on `ctx.tools` under the `mcp__browser__*` namespace. The model gains `navigate`, `click`, `type`, `snapshot`, and the rest of the Playwright tool set, driven through the page accessibility tree (no vision model, no extra LLM key). The package has no runtime API; the profile composer resolves the patch through the `dsh.bundle.patch` manifest field, never through code.

This bundle is an **additive layer**, not a standalone profile — it carries no model surface of its own, so it is applied on top of an existing profile (`web` or `headless`) rather than used alone:

```bash
neo plugin --profile web add @neo/browser
```

The server is spawned with `npx`, so the host must have the matching Playwright browser installed once. Install it through the MCP server's own bundled Playwright so the browser revision matches the server (a plain `npx playwright install chromium` can fetch a different revision than `@playwright/mcp` expects and fail at launch):

```bash
npx @playwright/mcp@latest install-browser chrome-for-testing
```

On a minimal host that is missing the shared libraries Chromium needs, also install the OS dependencies once (requires root): `npx playwright install-deps chromium`.

The row runs the browser `--headless` (suited to a server with no display) and `--isolated` (each session starts from an in-memory profile that is discarded on close, so no browser state leaks between sessions). `@playwright/mcp@latest` tracks the newest release on every cold start; pin a version in the patch `args` for a reproducible deployment. Override the row by id (`mcp-browser`) from a profile or home `cordis.patch.yml` to change the flags, pin a version, or point at a different browser.

## Model Experience

Indirectly, through the inserted `@neo/mcp-client` row: after the Playwright MCP server connects, each advertised tool appears as a native tool named `mcp__browser__<rawName>` with the server-provided description and input schema. This bundle contributes no model-visible text of its own; the tool surface and its token/cache behavior are owned by [`@neo/mcp-client`](../../mcp/mcp-client/README.md#model-experience).

#### KV Cache effect

None directly; the inserted MCP client row owns its effect (prefix-stable while the discovered tool set is unchanged).

## Known Limitations and Deferred Work

- **The browser must be installed out of band** — the patch spawns `npx @playwright/mcp@latest` but does not provision Chromium; a host that has not run `install-browser` produces an MCP server that fails to launch, surfaced through the MCP client's startup/reconnect logging.
- **`@playwright/mcp@latest` is unpinned** — a cold start resolves the newest published server, so a deployment that needs reproducibility must pin a version in the patch `args`; this bundle ships `latest` for first-run convenience.
- **One shared isolated browser per server** — the single mounted row serves every turn from one Playwright MCP process; per-agent or per-session browser isolation beyond `--isolated`'s in-memory profile is deferred to a future multi-instance patch.
