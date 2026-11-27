"""Keyless boot tests for the production exe and development node carrier.

Each carrier skips independently when absent. Initialize and shutdown never
call a model, so the routes below need neither a key nor a reachable endpoint.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from neo_sdk import Neo, NeoClient, NeoClientConfig
from neo_sdk.errors import TransportClosedError
from neo_runtime import resolve_bundled_launch_args

_MODES = ("exe", "node")
_REPO_ROOT = Path(__file__).parents[3]
_MINIMAL_CONFIG = _REPO_ROOT / "examples" / "jsonrpc-agent" / "minimal.cordis.yml"

# The config must include the JSON-RPC serving plugin and an adapter for the
# provider `initialize` names; the server mounts none of its own.
_CORDIS_YML = """\
- id: sdk-jsonrpc-server
  name: '@neo/sdk-jsonrpc-server'
- id: llm-pi-ai
  name: '@neo/llm-pi-ai'
  config:
    providers:
      neo-default-route:
        api: openai-completions
        baseURL: 'http://127.0.0.1:9/v1'
        apiKeyEnv: LLM_API_KEY
        models:
          - id: neo-large-model
- id: agent-core
  name: '@neo/agent-spine-demo'
  config:
    workspaceContext: false
- id: sessions
  name: '@neo/session-persistence-jsonl'
  config:
    root: './sessions'
- id: session-checkpoints
  name: '@neo/session-checkpoint-policy'
- id: subprocess
  name: '@neo/subprocess-local'
- id: bash
  name: '@neo/bash-local'
  config:
    cwd: '.'
- id: todo
  name: '@neo/tool-todo'
  config:
    allowParallelInProgress: true
"""


def _launch_args(mode: str) -> tuple[str, ...]:
    try:
        return resolve_bundled_launch_args(mode)
    except FileNotFoundError as exc:
        pytest.skip(f"bundled {mode}-mode runtime unavailable on this machine: {exc}")


def _client(tmp_path: Path, launch_args: tuple[str, ...]) -> NeoClient:
    return NeoClient(
        NeoClientConfig(
            launch_args_override=launch_args,
            cwd=str(tmp_path),
            env={
                "NEO_CORDIS_CONFIG": "./cordis.yml",
                "NEO_SESSION_ROOT": str(tmp_path / "sessions"),
                "NEO_CWD": str(tmp_path),
            },
            request_timeout_seconds=120,
        )
    )


@pytest.mark.parametrize("mode", _MODES)
def test_bundled_runtime_boots_a_cordis_config(tmp_path: Path, mode: str) -> None:
    launch_args = _launch_args(mode)
    (tmp_path / "cordis.yml").write_text(_CORDIS_YML)

    with _client(tmp_path, launch_args) as client:
        init = client.initialize(provider="neo-default-route", cwd=str(tmp_path), model="neo-large-model")

    assert init.serverInfo is not None
    assert init.serverInfo.name == "neo-sdk-runtime"


@pytest.mark.parametrize("mode", _MODES)
def test_python_sdk_boots_minimal_jsonrpc_config(tmp_path: Path, mode: str) -> None:
    launch_args = _launch_args(mode)
    model = "minimal-environment-model"
    harness = Neo(
        model=model,
        cwd=str(tmp_path),
        session_root=str(tmp_path / "sessions"),
        cordis=str(_MINIMAL_CONFIG),
        env={
            "NEO_CONTEXT_WINDOW": "1000000",
            "NEO_SYSTEM_PROMPT": "You are the Python SDK minimal boot test agent.",
        },
        api_key="sk-dummy-for-boot",
        base_url="http://127.0.0.1:9",
        launch_args_override=launch_args,
        request_timeout_seconds=120,
    )

    with harness:
        pass


@pytest.mark.parametrize("mode", _MODES)
def test_bundled_runtime_surfaces_unbundled_plugin_failure(tmp_path: Path, mode: str) -> None:
    launch_args = _launch_args(mode)
    (tmp_path / "cordis.yml").write_text(
        "- id: missing\n  name: '@neo/does-not-exist'\n"
    )

    client = _client(tmp_path, launch_args)
    client.start()
    try:
        with pytest.raises((TransportClosedError, TimeoutError)) as excinfo:
            client.initialize(provider="neo-default-route", cwd=str(tmp_path), model="neo-large-model")
    finally:
        client.close()

    assert "@neo/does-not-exist" in str(excinfo.value)


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.parametrize("ambient_config", [None, ""], ids=["unset", "empty-counts-as-absent"])
def test_zero_config_run_injects_bundled_default_cordis_config(
    tmp_path: Path, mode: str, ambient_config: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _launch_args(mode)  # skip early when this carrier is unavailable
    monkeypatch.setenv("NEO_RUNTIME_MODE", mode)
    if ambient_config is None:
        monkeypatch.delenv("NEO_CORDIS_CONFIG", raising=False)
    else:
        monkeypatch.setenv("NEO_CORDIS_CONFIG", ambient_config)

    harness = Neo(
        model="neo-large-model",
        cwd=str(tmp_path),
        session_root=str(tmp_path / "sessions"),
        api_key="sk-dummy-for-boot",
        base_url="http://127.0.0.1:9",
        request_timeout_seconds=120,
    )
    with harness:
        pass
