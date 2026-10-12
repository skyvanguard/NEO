# AGENTS.md — GitHub Actions

- **`ci.yml`** (Linux, `ubuntu-latest`) is the authoritative gate: `pnpm install --frozen-lockfile`, `build:lib` (tsc + tsdown), `verify-built-package-invariants`, `typecheck`, `lint`, and the full `test` suite.

A native-Windows workflow is possible but not kept here: `build:lib` currently fails on Windows (tsdown's workspace globbing does not match, so it tries to build `@neo/root`), so `typecheck`/`lint` cannot run through their package scripts there. To add Windows coverage later, fix the tsdown workspace globbing first, then run host `tsc` + `lint:contracts-ready` + `test` (the suite self-excludes unsupported suites on win32 via `windowsUnsupportedTests` in `vitest.config.ts`).
