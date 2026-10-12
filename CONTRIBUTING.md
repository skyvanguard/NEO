# Contributing to NEO

Thanks for your interest in NEO — a local-first, plugin-based AI agent harness for offensive security, maintained by SkyVanguard. NEO is a hardened fork of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

## Ways to help

- **Report bugs and ideas** in [GitHub Issues](https://github.com/skyvanguard/NEO/issues) — a clear repro or a focused proposal is the most useful thing you can send.
- **Open a pull request.** Small, focused PRs are welcome. For anything large, open an issue first so we can agree on the approach before you invest the work.
- **Build plugins.** Everything in NEO is a plugin; you can add or swap capabilities without forking the core. Share yours and tag the repo so others can find it.

## Development

See [AGENTS.md](AGENTS.md) for the architecture and codebase conventions, and the **Commands** section there for the full gate list. The essentials:

```sh
pnpm install          # Node ^22.19 || >=24
pnpm run build        # tsc emits lib/types, tsdown bundles the runtime
pnpm run test         # vitest unit tests
pnpm run typecheck
pnpm run lint
```

Before opening a PR:

- Run the checks relevant to your change (`test`, `typecheck`, `lint`), and the snapshot suite if you touched model- or user-visible output.
- Use conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Keep changes in their own commits so an upstream merge stays reviewable.

## Responsible use

NEO is offensive-security tooling. Contributions must assume **authorized use only** — see [Responsible use](README.md#responsible-use) in the README. Do not contribute content whose only purpose is to attack systems without authorization.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
