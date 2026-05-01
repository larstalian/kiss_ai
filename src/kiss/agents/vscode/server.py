"""VS Code extension backend server for Sorcar agent.

This module provides a JSON-based stdio interface between the VS Code
extension and the Sorcar agent. Commands are read from stdin as JSON
lines, and events are written to stdout as JSON lines.

The per-command handlers, task-runner, merge / worktree flow and
autocomplete logic live in sibling mixin modules.  This file keeps the
core dispatch loop, per-tab state accessors, the history / chat /
commit-message helpers, and the ``main`` CLI entry point.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import sys
import threading
from pathlib import Path
from typing import Any

from kiss.agents.sorcar.git_worktree import GitWorktreeOps
from kiss.agents.sorcar.persistence import (
    _append_chat_event,
    _allocate_chat_id,
    _get_adjacent_task_by_chat_id,
    _load_history,
    _load_last_model,
    _load_latest_chat_events_by_chat_id,
    _load_model_usage,
    _record_model_usage,
    _search_history,
    _save_task_extra,
    _save_task_result,
)
from kiss.agents.vscode.autocomplete import _AutocompleteMixin
from kiss.agents.vscode.commands import _CommandsMixin
from kiss.agents.vscode.diff_merge import (  # noqa: F401 (re-export for tests)
    _cleanup_merge_data,
    _git,
    _merge_data_dir,
)
from kiss.agents.vscode.helpers import (
    fast_model_for,
    generate_commit_message_from_diff,
    generate_followup_text,
    model_vendor,
)
from kiss.agents.vscode.merge_flow import _MergeFlowMixin
from kiss.agents.vscode.printer import VSCodePrinter
from kiss.agents.vscode.tab_state import _TabState, parse_task_tags
from kiss.agents.vscode.task_runner import _TaskRunnerMixin
from kiss.core.models.model_info import MODEL_INFO, get_available_models, get_default_model

__all__ = [
    "VSCodePrinter",
    "VSCodeServer",
    "_TabState",
    "main",
    "parse_task_tags",
]

logger = logging.getLogger(__name__)


class VSCodeServer(
    _CommandsMixin,
    _TaskRunnerMixin,
    _MergeFlowMixin,
    _AutocompleteMixin,
):
    """Backend server for VS Code extension."""

    def __init__(self) -> None:
        self.printer = VSCodePrinter()
        self._tab_states: dict[str, _TabState] = {}
        self.work_dir = os.environ.get("KISS_WORKDIR", os.getcwd())
        persisted = _load_last_model()
        self._default_model = (
            persisted
            or os.environ.get("KISS_MODEL", "")
            or get_default_model()
        )
        self._state_lock = threading.Lock()
        self._complete_seq: int = 0
        self._complete_seq_latest: int = -1
        self._complete_queue: queue.Queue[tuple[str, int, str, str]] | None = None
        self._complete_worker: threading.Thread | None = None
        self._file_cache: list[str] | None = None
        self._last_active_file: str = ""
        self._last_active_content: str = ""

    def _get_tab(self, tab_id: str) -> _TabState:
        """Get or create per-tab state for the given tab.

        Each tab gets its own agent instances so concurrent tabs never
        share mutable agent state (chat_id, task_id, worktree, etc.).
        The tab_id is a frontend string identifier; the agent's chat_id
        is a string assigned by the database on first task insertion.

        Thread-safe: acquires ``_state_lock`` to protect the
        get-or-create pattern against concurrent callers.

        Args:
            tab_id: The frontend tab identifier string.

        Returns:
            The per-tab state object.
        """
        with self._state_lock:
            tab = self._tab_states.get(tab_id)
            if tab is None:
                tab = _TabState(tab_id, self._default_model)
                self._tab_states[tab_id] = tab
            return tab

    def _any_non_wt_running(self) -> bool:
        """True if any tab is running a non-worktree task on the main tree.

        Must be called with ``_state_lock`` held.

        Returns:
            True if at least one tab has ``is_running_non_wt`` set.
        """
        return any(t.is_running_non_wt for t in self._tab_states.values())

    def run(self) -> None:
        """Main loop: read commands from stdin, execute them."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            cmd: dict[str, Any] = {}
            try:
                cmd = json.loads(line)
                self._handle_command(cmd)
            except json.JSONDecodeError as e:
                self.printer.broadcast({"type": "error", "text": f"Invalid JSON: {e}"})
            except Exception as e:  # pragma: no cover
                event: dict[str, Any] = {"type": "error", "text": str(e)}
                tab_id = cmd.get("tabId") if isinstance(cmd, dict) else None
                if tab_id is not None:
                    event["tabId"] = tab_id
                self.printer.broadcast(event)

    def _handle_command(self, cmd: dict[str, Any]) -> None:
        """Dispatch a command from VS Code to the appropriate handler."""
        cmd_type: str = cmd.get("type", "")
        handler = self._HANDLERS.get(cmd_type)
        if handler is not None:
            handler(self, cmd)
        else:
            event: dict[str, Any] = {"type": "error", "text": f"Unknown command: {cmd_type}"}
            tab_id = cmd.get("tabId")
            if tab_id is not None:
                event["tabId"] = tab_id
            self.printer.broadcast(event)


    def _get_models(self) -> None:
        """Send available models list with usage counts and pricing."""
        usage = _load_model_usage()
        models_list: list[dict[str, Any]] = []
        sort_keys: dict[str, tuple[int, float]] = {}
        for name in get_available_models():
            info = MODEL_INFO.get(name)
            if info and info.is_function_calling_supported:
                vendor_name, vendor_order = model_vendor(name)
                models_list.append({
                    "name": name,
                    "inp": info.input_price_per_1M,
                    "out": info.output_price_per_1M,
                    "uses": usage.get(name, 0),
                    "vendor": vendor_name,
                })
                price = float(info.input_price_per_1M) + float(info.output_price_per_1M)
                sort_keys[name] = (vendor_order, -price)
        models_list.sort(key=lambda m: sort_keys[m["name"]])

        # Add custom endpoint model if configured
        from kiss.agents.vscode.vscode_config import get_custom_model_entry, load_config

        cfg = load_config()
        custom = get_custom_model_entry(cfg)
        if custom:
            models_list.insert(0, custom)

        self.printer.broadcast({
            "type": "models",
            "models": models_list,
            "selected": self._default_model,
        })

    def _get_model_usage(self, tab_id: str = "") -> None:
        """Send persisted model usage and the last-selected model."""
        self.printer.broadcast({
            "type": "modelUsage",
            "usage": _load_model_usage(),
            "lastModel": _load_last_model(),
            "tabId": tab_id,
        })

    def _get_history(self, query: str | None, offset: int = 0, generation: int = 0) -> None:
        """Send conversation history with pagination support."""
        if query:
            entries = _search_history(query, limit=50, offset=offset)
        else:
            entries = _load_history(limit=50, offset=offset)

        sessions = []
        for entry in entries:
            task = str(entry.get("task", ""))
            has_events = bool(entry.get("has_events", False))
            chat_id = str(entry.get("chat_id", "") or "")
            sessions.append({
                "id": chat_id,
                "title": task[:50] + "..." if len(task) > 50 else task,
                "timestamp": entry.get("timestamp", 0),
                "preview": task,
                "has_events": has_events,
            })
        self.printer.broadcast({
            "type": "history", "sessions": sessions,
            "offset": offset, "generation": generation,
        })

    def _get_input_history(self) -> None:
        """Send deduplicated task texts for arrow-key cycling.

        Loads the full persisted history so ArrowUp can traverse every
        distinct task stored in ``sorcar.db``, not just an arbitrary
        recent subset.
        """
        entries = _load_history()
        seen: set[str] = set()
        tasks: list[str] = []
        for e in entries:
            task = str(e.get("task", "")).strip()
            if task and task not in seen:
                seen.add(task)
                tasks.append(task)
        self.printer.broadcast({"type": "inputHistory", "tasks": tasks})

    def _prepare_codex_task(
        self,
        prompt: str,
        tab_id: str = "",
        work_dir: str | None = None,
        use_worktree: bool = False,
        use_parallel: bool = False,
        skip_merge: bool = False,
    ) -> None:
        """Persist a Codex task and return the KISS-built prompt."""
        tab = self._get_tab(tab_id)
        if tab_id and tab.agent.chat_id == "":
            tab.agent._chat_id = tab_id
        resolved_work_dir = work_dir or self.work_dir
        effective_work_dir = resolved_work_dir
        actual_use_worktree = False
        with self._state_lock:
            tab.is_task_active = True
            tab.use_worktree = bool(use_worktree)
            tab.use_parallel = bool(use_parallel)
            tab.skip_merge = bool(skip_merge)
            tab.is_running_non_wt = not bool(use_worktree)
        try:
            if use_worktree:
                repo = GitWorktreeOps.discover_repo(Path(resolved_work_dir))
                if repo is not None:
                    if tab.agent.chat_id == "":
                        tab.agent._chat_id = _allocate_chat_id()
                    tab.agent._restore_from_git(repo)
                    wt_work_dir = tab.agent._try_setup_worktree(repo, resolved_work_dir)
                    tab.agent._flush_warnings(self.printer)
                    if wt_work_dir is not None:
                        actual_use_worktree = True
                        effective_work_dir = str(wt_work_dir)
                        with self._state_lock:
                            tab.use_worktree = True
                            tab.is_running_non_wt = False
                        self.printer.broadcast({
                            "type": "worktree_created",
                            "worktreeDir": str(tab.agent._wt_dir),
                            "branch": tab.agent._wt_branch,
                            "tabId": tab_id,
                        })
                        tab.codex_snapshot = {
                            "kind": "worktree",
                            "work_dir": resolved_work_dir,
                            "effective_work_dir": effective_work_dir,
                        }
                else:
                    logger.warning("Not a git repo, running Codex task directly")
                    tab.agent._flush_warnings(self.printer)

            if not actual_use_worktree:
                with self._state_lock:
                    tab.use_worktree = False
                    tab.is_running_non_wt = True
                    deferred = tab.deferred_snapshot
                if deferred is not None:
                    pre_head, pre_hunks, pre_untracked, pre_hashes = deferred
                else:
                    repo = GitWorktreeOps.discover_repo(Path(resolved_work_dir))
                    pre_head, pre_hunks, pre_untracked, pre_hashes = (
                        self._capture_pre_snapshot(resolved_work_dir, repo, tab_id)
                    )
                tab.codex_snapshot = {
                    "kind": "direct",
                    "work_dir": resolved_work_dir,
                    "pre_head": pre_head,
                    "pre_hunks": pre_hunks,
                    "pre_untracked": pre_untracked,
                    "pre_hashes": pre_hashes,
                }
        except BaseException:
            with self._state_lock:
                tab.is_task_active = False
                tab.is_running_non_wt = False
            tab.codex_snapshot = None
            raise
        task_id, prepared_prompt = tab.agent.prepare_task(prompt)
        self.printer.broadcast({
            "type": "codexTaskPrepared",
            "prompt": prepared_prompt,
            "task": prompt,
            "taskId": task_id,
            "workDir": effective_work_dir,
            "useWorktree": actual_use_worktree,
            "useParallel": bool(use_parallel),
            "chatId": tab.agent.chat_id,
            "tabId": tab_id,
        })

    def _persist_codex_task(
        self,
        task_id: Any,
        task: str,
        result: str,
        events: Any,
        model: str,
        status: str = "completed",
        error: str | None = None,
        tab_id: str = "",
    ) -> None:
        """Persist a completed Codex task through the standard KISS store."""
        resolved_task_id = int(task_id) if task_id is not None else None
        event_list = events if isinstance(events, list) else []
        tab = self._get_tab(tab_id)
        snapshot = tab.codex_snapshot
        direct_snapshot = None
        is_worktree = False
        if isinstance(snapshot, dict):
            work_dir = str(snapshot.get("work_dir") or self.work_dir)
            if snapshot.get("kind") == "worktree":
                is_worktree = bool(tab.use_worktree)
            elif snapshot.get("kind") == "direct":
                direct_snapshot = (
                    snapshot.get("pre_head"),
                    snapshot.get("pre_hunks", {}),
                    snapshot.get("pre_untracked", set()),
                    snapshot.get("pre_hashes"),
                )
        elif snapshot:
            work_dir = snapshot[0]
            direct_snapshot = snapshot[1:]
        else:
            work_dir = self.work_dir
        task_end_event: dict[str, Any]
        if status == "failed":
            task_end_event = {"type": "task_error", "text": error or "Codex turn failed"}
        elif status != "completed":
            task_end_event = {"type": "task_stopped"}
        else:
            task_end_event = {"type": "task_done"}
        if tab_id:
            task_end_event["tabId"] = tab_id
        try:
            for event in event_list:
                if isinstance(event, dict):
                    _append_chat_event(event, task_id=resolved_task_id, task=task)
            _save_task_result(result=result, task_id=resolved_task_id, task=task)
            if model:
                _record_model_usage(model)
            from kiss._version import __version__

            _save_task_extra(
                {
                    "backend": "codex",
                    "model": model,
                    "work_dir": work_dir,
                    "version": __version__,
                    "tokens": 0,
                    "cost": 0,
                    "is_parallel": bool(tab.use_parallel),
                    "is_worktree": is_worktree,
                },
                task_id=resolved_task_id,
                task=task,
            )
            with self._state_lock:
                tab.is_task_active = False
                if not is_worktree:
                    tab.is_running_non_wt = False
            if direct_snapshot:
                pre_head, pre_hunks, pre_untracked, pre_hashes = direct_snapshot
                if tab.skip_merge:
                    with self._state_lock:
                        tab.deferred_snapshot = direct_snapshot
                else:
                    with self._state_lock:
                        tab.deferred_snapshot = None
                    self._prepare_and_start_merge(
                        work_dir,
                        pre_hunks,
                        pre_untracked,
                        pre_hashes,
                        base_ref=pre_head or "HEAD",
                        tab_id=tab_id,
                    )
            elif is_worktree and tab.agent._wt_pending and not tab.skip_merge:
                try:
                    self._present_pending_worktree(tab_id, try_merge_review=True)
                except BaseException:
                    logger.debug("Worktree merge review error", exc_info=True)
            persisted_end_event = {
                k: v for k, v in task_end_event.items() if k != "tabId"
            }
            _append_chat_event(persisted_end_event, task_id=resolved_task_id, task=task)
            self.printer.broadcast({"type": "tasks_updated", "tabId": tab_id})
            self.printer.broadcast(task_end_event)
            if resolved_task_id is not None:
                self._generate_followup_async(task, result, resolved_task_id)
        finally:
            with self._state_lock:
                tab.is_task_active = False
                tab.is_running_non_wt = False
            tab.codex_snapshot = None
            self.printer.broadcast({
                "type": "codexTaskPersisted",
                "taskId": resolved_task_id,
                "tabId": tab_id,
            })

    def _close_tab(self, tab_id: str) -> None:
        """Clean up all backend state for a closed tab.

        Removes the tab from ``_tab_states``, cleans up per-tab printer
        state (bash buffers, recordings), and drops the persist-agent
        reference.  Does nothing if the tab is currently running a task
        or in a merge review — the frontend should stop/resolve those
        first.

        When the tab has a pending worktree, auto-merges it (just like
        starting a new task would) before removing the tab, so the
        worktree branch and directory are not orphaned.

        Args:
            tab_id: The frontend tab identifier to close.
        """
        with self._state_lock:
            tab = self._tab_states.get(tab_id)
            if tab is not None and (
                tab.is_task_active
                or tab.is_merging
                or (tab.task_thread is not None and tab.task_thread.is_alive())
            ):
                return
            self._tab_states.pop(tab_id, None)
        if tab is not None and tab.agent._wt_pending:
            try:
                tab.agent._release_worktree()
            except Exception:
                logger.debug("Worktree release on tab close failed", exc_info=True)
        self.printer.cleanup_tab(tab_id)
        self.printer._persist_agents.pop(tab_id, None)
        _cleanup_merge_data(str(_merge_data_dir(tab_id)))

    def _new_chat(self, tab_id: str) -> None:
        """Start a new chat session for the given tab.

        The ``newChat`` command is only issued by the frontend's
        ``createNewTab`` flow, which always allocates a fresh tab id
        that the backend has never seen before.  ``_get_tab`` creates a
        clean ``_TabState``, so there is no prior run state (no active
        task, no in-progress merge, no pending worktree, no carried-over
        warnings) to guard against here.

        Args:
            tab_id: The frontend tab identifier (a freshly-minted uuid).
        """
        tab = self._get_tab(tab_id)
        tab.agent.new_chat()
        self.printer.broadcast({"type": "showWelcome", "tabId": tab_id})

    def _replay_session(self, chat_id: str, tab_id: str = "") -> None:
        """Replay recorded chat events for a previous chat session.

        Sets the tab's agent chat_id to match the resumed session.
        The tab_id (frontend key in ``_tab_states``) does not change.

        When ``tab_id`` is empty the call is a no-op — the previous
        behavior of synthesizing a phantom tab keyed by ``chat_id`` and
        mutating its ``use_worktree`` flag violated per-tab state
        isolation (C2/C3 fix).

        Args:
            chat_id: The string chat session identifier to replay.
            tab_id: The frontend tab identifier.
        """
        if not tab_id:
            logger.debug("_replay_session called without tab_id; ignoring")
            return
        result = _load_latest_chat_events_by_chat_id(chat_id)
        if not result or not result.get("events"):
            return
        tab = self._get_tab(tab_id)
        tab.agent.resume_chat_by_id(chat_id)

        extra_str = str(result.get("extra", "") or "")
        if extra_str:
            try:
                extra = json.loads(extra_str)
                with self._state_lock:
                    tab.use_worktree = bool(extra.get("is_worktree"))
            except (json.JSONDecodeError, TypeError):
                pass

        self.printer.broadcast({
            "type": "task_events",
            "events": result["events"],
            "task": result["task"],
            "chat_id": chat_id,
            "extra": result.get("extra", ""),
            "tabId": tab_id,
        })
        self._emit_pending_worktree(tab_id)


    def _generate_followup_async(
        self,
        task: str,
        result: str,
        task_id: int | None,
    ) -> None:
        """Generate and broadcast a follow-up suggestion in a background thread.

        The suggestion is broadcast to the webview and also appended to
        the persisted chat events so it survives panel re-creation.

        Args:
            task: The completed task description.
            result: The task result summary.
            task_id: Stable history row id for the completed task.
        """
        owner_tab = getattr(self.printer._thread_local, "tab_id", None)

        def _run() -> None:
            if owner_tab is not None:
                self.printer._thread_local.tab_id = owner_tab
            try:
                suggestion = generate_followup_text(
                    task, result, fast_model_for()
                )
                if suggestion:  # pragma: no cover — requires LLM API call
                    event: dict[str, object] = {
                        "type": "followup_suggestion",
                        "text": suggestion,
                    }
                    self.printer.broadcast(event)
                    _append_chat_event(event, task_id=task_id, task=task)
            except Exception:  # pragma: no cover — LLM API error handler
                logger.debug("Async followup generation failed", exc_info=True)

        threading.Thread(target=_run, daemon=True).start()

    def _extract_result_summary(self) -> str:
        """Extract result summary from the current recording."""
        events = self.printer.peek_recording()
        for ev in reversed(events):
            if ev.get("type") == "result":
                summary = ev.get("summary") or ev.get("text") or ""
                return str(summary)
        return ""

    def _get_adjacent_task(
        self, chat_id: str, task: str, direction: str, tab_id: str = "",
    ) -> None:
        """Send events for the adjacent task in the same chat session.

        Args:
            chat_id: The string chat session identifier.
            task: Current task description string (used as timestamp reference).
            direction: ``"prev"`` or ``"next"``.
            tab_id: Frontend tab identifier used to route the event.
        """
        result = _get_adjacent_task_by_chat_id(chat_id, task, direction)
        event: dict[str, Any] = {
            "type": "adjacent_task_events",
            "direction": direction,
            "task": result["task"] if result else "",
            "events": result["events"] if result else [],
            "tabId": tab_id,
        }
        self.printer.broadcast(event)

    def _generate_commit_message(self) -> None:
        """Generate a git commit message from current changes."""
        try:
            cached_result = _git(self.work_dir, "diff", "--cached")
            diff_text = cached_result.stdout.strip()
            if not diff_text:  # pragma: no branch — LLM API required for else
                self.printer.broadcast({
                    "type": "commitMessage",
                    "message": "",
                    "error": "No staged changes found. Stage files with 'git add' first.",
                })
                return
            msg = generate_commit_message_from_diff(diff_text)  # pragma: no cover
            self.printer.broadcast({"type": "commitMessage", "message": msg})  # pragma: no cover
        except Exception:  # pragma: no cover — LLM API error handler
            logger.debug("Commit message generation failed", exc_info=True)
            self.printer.broadcast({
                "type": "commitMessage",
                "message": "",
                "error": "Failed to generate",
            })


def main() -> None:  # pragma: no cover — CLI entry point
    """Main entry point for VS Code backend server."""
    server = VSCodeServer()
    server.run()


if __name__ == "__main__":
    main()
