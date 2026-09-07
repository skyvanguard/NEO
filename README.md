# NEO

> _"Free your mind."_

**NEO** is a private, local-first AI agent harness built for offensive security. Everything is a plugin; the runtime is powered by [Cordis](https://github.com/cordiverse/cordis). A local model does the reasoning, a local toolkit does the work, and **nothing leaves the box**.

It's a hardened fork wired end to end for real engagements — reconnaissance, enumeration, exploitation, and post-exploitation — with the agent reasoning locally and its tools running in a controlled sandbox.

---

## Why NEO

- **Local-first, zero cloud.** Points at a local, OpenAI-compatible model (e.g. a `llama.cpp` server). No external API, no telemetry, nothing leaving the host — the OPSEC posture offensive work needs.
- **Everything is a plugin.** Models, tools, skills, search and providers all compose through Cordis. Add or swap capabilities without forking the core.
- **Native vision.** The agent reads screenshots, diagrams and images directly — CTF artifacts, hardware/token photos, UI review, document understanding.
- **Full offensive toolkit.** Drives a complete toolset (nmap, ffuf/gobuster, sqlmap, netexec/impacket, john/hashcat, Metasploit, …) from a sandboxed shell.
- **Local search.** Reconnaissance search runs through a self-hosted SearXNG — no queries leave under your identity.
- **Subagent orchestration.** Delegates parallel work to subagents and workflows; the orchestrator reasons while workers fan out — optionally onto a smaller, dedicated model.
- **Skills.** Distilled, reusable playbooks (recon, password cracking, SUID privesc, exploiting known challenges) the agent loads on demand.
- **Web cockpit.** A browser UI to drive the agent, served on loopback and reached over an SSH tunnel.

---

## Architecture

```
   Browser (via SSH tunnel)
            │
            ▼
      NEO Web UI  ──►  Agent runtime (Cordis plugin tree)
                            │
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                         ▼
  Local LLM + vision   Sandboxed tools          Skills · Search
  OpenAI-compatible    shell · fs · web · docker  (SearXNG · catalog)
```

- **Model** — any local OpenAI-compatible endpoint. Reference setup: a dense reasoning model on `llama.cpp` with multi-token-prediction (MTP) speculative decoding and a vision projector.
- **Runtime** — the Cordis plugin tree: session state, tool registry, the approval/sandbox stack, and the model route.
- **Access** — loopback-only by design; the UI is reached through an SSH tunnel.

---

## Quick start

From a repository checkout:

```sh
pnpm install
pnpm run build
pnpm neo web
```

The Web UI serves at `http://127.0.0.1:3080` (loopback only). Reach it from another machine over an SSH tunnel:

```sh
ssh -N -L 3080:127.0.0.1:3080 <user>@<host>
# then open http://127.0.0.1:3080
```

Point NEO at your model from **Settings → Models** — any OpenAI-compatible base URL and model id.

---

## Security model

NEO's agent **executes code and commands** on the host. It binds to **loopback only** and deliberately refuses to expose itself to the network — reach it through an SSH tunnel, never a raw port on an untrusted LAN. The Web UI ships **no authentication of its own**: treat access to the loopback port as full control of the machine. Run it only on infrastructure you control.

---

## Development

- [AGENTS.md](AGENTS.md) — agent and codebase conventions.
- [docs/development.md](docs/development.md) — development guide.
- [docs/architecture.md](docs/architecture.md) — architecture reference.

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
