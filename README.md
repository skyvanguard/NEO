# NEO

> _"Free your mind."_

**NEO** is a private, local-first AI agent harness for offensive security. Everything is a plugin; the runtime is powered by [Cordis](https://github.com/cordiverse/cordis).

It runs entirely on your own infrastructure — a local, OpenAI-compatible model does the reasoning, a local toolchain does the work, and nothing leaves the box. Built to drive real engagements end to end: recon, enumeration, exploitation, and post-exploitation.

## What it is

- **Local-first** — points at a local model endpoint (e.g. a `llama.cpp` server). No cloud, no external API, no telemetry.
- **Everything is a plugin** — models, tools, skills, and providers compose through Cordis.
- **Web UI** — a browser cockpit for driving the agent, served on loopback (reach it over an SSH tunnel).
- **Vision + full toolkit** — the agent reads images natively and drives a complete offensive toolset in a controlled sandbox.

## Run

From a repository checkout:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

The Web UI serves at `http://127.0.0.1:3080` by default (loopback only). Point NEO at your local model from **Settings → Models** (any OpenAI-compatible endpoint).

## Development

- [AGENTS.md](AGENTS.md) — agent and codebase conventions.
- [docs/development.md](docs/development.md) — development guide.
- [docs/architecture.md](docs/architecture.md) — architecture.

## License

[MIT](LICENSE). Third-party dependencies and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
