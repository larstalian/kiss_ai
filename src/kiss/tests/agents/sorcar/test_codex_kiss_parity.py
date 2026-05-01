"""Parity tests for the Codex-to-KISS session bridge."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import kiss.agents.sorcar.persistence as th
from kiss.agents.vscode.server import VSCodeServer


def _redirect(tmpdir: str) -> tuple[Any, ...]:
    """Redirect persistence to a temp history.db."""
    old = (th._DB_PATH, th._db_conn, th._KISS_DIR)
    kiss_dir = Path(tmpdir) / ".kiss"
    kiss_dir.mkdir(parents=True, exist_ok=True)
    th._KISS_DIR = kiss_dir
    th._DB_PATH = kiss_dir / "history.db"
    th._db_conn = None
    return old


def _restore(saved: tuple[Any, ...]) -> None:
    (th._DB_PATH, th._db_conn, th._KISS_DIR) = saved


class TestCodexKissParity:
    def setup_method(self) -> None:
        self.tmpdir = tempfile.mkdtemp()
        self.saved = _redirect(self.tmpdir)
        self.server = VSCodeServer()
        self.events: list[dict[str, Any]] = []
        self._orig_broadcast = self.server.printer.broadcast

        def capture(event: dict[str, Any]) -> None:
            self.events.append(event)
            self._orig_broadcast(event)

        self.server.printer.broadcast = capture  # type: ignore[assignment]

    def teardown_method(self) -> None:
        if th._db_conn is not None:
            th._db_conn.close()
            th._db_conn = None
        _restore(self.saved)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _latest(self, event_type: str) -> dict[str, Any]:
        for event in reversed(self.events):
            if event.get("type") == event_type:
                return event
        raise AssertionError(f"Missing event: {event_type}")

    def _init_repo(self) -> Path:
        repo = Path(self.tmpdir) / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, check=True, stdout=subprocess.PIPE)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=repo,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=repo,
            check=True,
        )
        (repo / "app.txt").write_text("base\n")
        subprocess.run(["git", "add", "app.txt"], cwd=repo, check=True)
        subprocess.run(
            ["git", "commit", "-m", "initial"],
            cwd=repo,
            check=True,
            stdout=subprocess.PIPE,
        )
        return repo

    def test_prepare_codex_task_uses_kiss_chat_context_and_new_chat_boundary(self) -> None:
        self.server._handle_command({
            "type": "prepareCodexTask",
            "prompt": "first task",
            "workDir": self.tmpdir,
            "tabId": "tab-a",
        })
        first = self._latest("codexTaskPrepared")

        self.server._handle_command({
            "type": "persistCodexTask",
            "taskId": first["taskId"],
            "prompt": "first task",
            "result": "first result",
            "events": [{"type": "prompt", "text": "# Task\nfirst task"}],
            "model": "gpt-5.4",
            "tabId": "tab-a",
        })

        self.server._handle_command({
            "type": "prepareCodexTask",
            "prompt": "second task",
            "workDir": self.tmpdir,
            "tabId": "tab-a",
        })
        second = self._latest("codexTaskPrepared")
        assert "### Task 1\nfirst task" in second["prompt"]
        assert "### Result 1\nfirst result" in second["prompt"]
        assert second["task"] == "second task"

        self.server._handle_command({
            "type": "prepareCodexTask",
            "prompt": "third task",
            "workDir": self.tmpdir,
            "tabId": "tab-b",
        })
        third = self._latest("codexTaskPrepared")
        assert third["prompt"] == "# Task\nthird task"
        assert "first task" not in third["prompt"]

    def test_persist_codex_task_updates_history_resume_and_model_usage(self) -> None:
        self.server._handle_command({
            "type": "prepareCodexTask",
            "prompt": "ship feature",
            "workDir": self.tmpdir,
            "tabId": "tab-ship",
        })
        prepared = self._latest("codexTaskPrepared")
        persisted_events = [
            {"type": "prompt", "text": prepared["prompt"]},
            {"type": "result", "text": "done"},
        ]

        self.server._handle_command({
            "type": "persistCodexTask",
            "taskId": prepared["taskId"],
            "prompt": "ship feature",
            "result": "done",
            "events": persisted_events,
            "model": "gpt-5.4-mini",
            "tabId": "tab-ship",
        })

        self.server._handle_command({"type": "getModelUsage", "tabId": "tab-ship"})
        usage = self._latest("modelUsage")
        assert usage["usage"]["gpt-5.4-mini"] == 1
        assert usage["lastModel"] == "gpt-5.4-mini"
        assert usage["tabId"] == "tab-ship"

        self.server._handle_command({"type": "getHistory", "offset": 0, "generation": 4})
        history = self._latest("history")
        assert history["sessions"][0]["id"] == "tab-ship"
        assert history["generation"] == 4

        self.server._handle_command({
            "type": "resumeSession",
            "chatId": "tab-ship",
            "tabId": "tab-resume",
        })
        replay = self._latest("task_events")
        stripped = [
            {k: v for k, v in event.items() if k != "_timestamp"}
            for event in replay["events"]
        ]
        assert stripped[:2] == persisted_events
        assert stripped[-1]["type"] == "task_done"
        assert replay["chat_id"] == "tab-ship"
        assert replay["tabId"] == "tab-resume"

        self.server._handle_command({"type": "getInputHistory"})
        input_history = self._latest("inputHistory")
        assert input_history["tasks"][0] == "ship feature"

    def test_codex_worktree_prepare_redirects_cwd_and_persists_flags(self) -> None:
        repo = self._init_repo()
        self.server._handle_command({
            "type": "prepareCodexTask",
            "prompt": "edit in worktree",
            "workDir": str(repo),
            "tabId": "tab-wt",
            "useWorktree": True,
            "useParallel": True,
        })
        prepared = self._latest("codexTaskPrepared")
        worktree_created = self._latest("worktree_created")

        assert prepared["useWorktree"] is True
        assert prepared["useParallel"] is True
        assert prepared["workDir"] != str(repo)
        assert str(repo / ".kiss-worktrees") in prepared["workDir"]
        assert worktree_created["tabId"] == "tab-wt"

        self.server._handle_command({
            "type": "persistCodexTask",
            "taskId": prepared["taskId"],
            "prompt": "edit in worktree",
            "result": "done",
            "events": [{"type": "prompt", "text": prepared["prompt"]}],
            "model": "gpt-5.4",
            "tabId": "tab-wt",
        })

        latest = th._load_history()[0]
        extra = json.loads(latest["extra"])
        assert extra["backend"] == "codex"
        assert extra["work_dir"] == str(repo)
        assert extra["is_worktree"] is True
        assert extra["is_parallel"] is True
