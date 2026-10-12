# AGENTS.md — GitHub Actions

Two workflows gate the fork; both run on GitHub-hosted runners (no self-hosted or Wine pools).

- **`ci.yml`** (Linux, `ubuntu-latest`) is the authoritative gate: `pnpm install --frozen-lockfile`, `build:lib` (tsc + tsdown), `verify-built-package-invariants`, `typecheck`, `lint`, and the full `test` suite (Linux runs the bash/hooks/subprocess suites that Windows excludes).
- **`windows.yml`** (`windows-latest`) gives native Windows coverage without tsdown, which currently fails on Windows (its workspace globbing does not match, so it tries to build `@neo/root`). It runs `install`, `typecheck` (host + client via `tsc` directly), and `lint` (`lint:contracts-ready`) as blocking steps; the `test` step is observational (`continue-on-error`) until the genuinely-unsupported suites observed on the first real run are added to `windowsUnsupportedTests` in `vitest.config.ts` (that list is `process.platform === 'win32'`-gated, so it never affects Linux), after which it becomes blocking.

If native Windows `build:lib`/`verify-built-package-invariants` coverage is wanted later, fix the tsdown workspace globbing on Windows first.
