"""Small stdlib-only ACP client for a warm, reusable Hermes agent process."""

from __future__ import annotations

import collections
import json
import logging
import os
import queue
import subprocess
import threading
import time
from typing import Any, Callable


LOG = logging.getLogger(__name__)


class WarmAgent:
    def __init__(self, hermes_bin, workdir, session_name, model=None,
                 idle_seconds=900, timeout=1800, ctx_path=None):
        self.hermes_bin = hermes_bin
        self.workdir = workdir
        self.session_name = session_name
        self.model = model
        self.idle_seconds = idle_seconds
        self.timeout = timeout
        self._proc = None
        self._events = None
        self._reader = None
        self._rpc_id = 0
        self._session_id = None
        self._last_used = 0.0
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._closed = False
        self._reasoning_level = None      # what the session's thinking depth is currently set to
        self.ctx_path = ctx_path          # the file the web guard reads for the turn in flight
        self.last_usage: dict[str, Any] = {}
        self.last_build_error = ""        # why the last build failed, kept for the caller's log
        self.stderr_tail: list[str] = []  # the child's last words, kept for diagnosis

    def alive(self) -> bool:
        """Lock-free on purpose: a build can hold the lock for minutes, and a liveness check that
        queues behind it blocks the caller. It did exactly that on every live turn once."""
        proc = self._proc
        return bool(proc and proc.poll() is None)

    def ready(self) -> bool:
        """True when the process AND its session exist, so a turn can be served right now.

        A caller serving a person checks this first: building the session can take minutes (the
        engine loads every configured MCP server), and that build must never hold up a live turn -
        the caller falls back to its own cold path and lets the build finish behind it. Lock-free,
        because it runs on every turn and the build holds the lock while it runs.
        """
        proc, session = self._proc, self._session_id
        return bool(session and proc and proc.poll() is None)

    def hard_close(self) -> None:
        """Kill the child without waiting for the lock. Used by a watchdog when a build hangs."""
        proc = self._proc
        self._proc = None
        self._session_id = None
        self._reasoning_level = None
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass

    def close(self) -> None:
        with self._lock:
            self._closed = True
            proc = self._proc
            self._proc = None
            self._session_id = None
            if proc is None:
                return
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def ask(self, prompt, on_event=None, stop=None, reasoning="none") -> tuple[str, str]:
        """Ask the current ACP session, retrying once if its process dies."""
        with self._lock:
            if self._closed:
                return "failed", ""
            for attempt in range(2):
                if self._last_used and time.monotonic() - self._last_used >= self.idle_seconds:
                    self._drop_process()
                try:
                    self._ensure_process()
                    self._last_used = time.monotonic()
                    return self._prompt(prompt, on_event, stop, reasoning)
                except _ProcessDied:
                    LOG.debug("warm Hermes process died (attempt %d)", attempt + 1, exc_info=True)
                    self._drop_process()
                    if attempt == 1:
                        return "failed", ""
                except Exception:
                    LOG.debug("warm Hermes ACP turn failed", exc_info=True)
                    self._drop_process()
                    return "failed", ""
            return "failed", ""

    def _ensure_process(self) -> None:
        if self._proc is not None and self._proc.poll() is None and self._session_id:
            return
        self._rpc_id = 0
        self._events = queue.Queue()
        self._proc = subprocess.Popen(
            [self.hermes_bin, "acp"], cwd=self.workdir,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
            # The gate lives in this child, exactly as it does in a cold one. It is told where the
            # current turn is written instead of being handed new environment each time, which is
            # the only way one process can serve many turns and still be gated.
            env=({**os.environ,
                  "JARVIS_WEB_TURN": "1",
                  "JARVIS_WEB_CTX": self.ctx_path,
                  "JARVIS_WEB_GUARD": os.environ.get("JARVIS_WEB_GUARD") or "deny",
                  "JARVIS_GUARD_LOG": os.environ.get("JARVIS_GUARD_LOG") or "",
                  "JARVIS_APPROVAL_URL": os.environ.get("JARVIS_APPROVAL_URL") or "http://127.0.0.1:8150/agent/ask",
                  } if self.ctx_path else None),
        )
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()
        self._errreader = threading.Thread(target=self._read_stderr, daemon=True)
        self._errreader.start()
        self._request("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}},
            "clientInfo": {"name": "jarvis-live", "version": "1.0"},
        })
        result = self._request("session/new", {"cwd": self.workdir, "mcpServers": []})
        self._session_id = result.get("sessionId") or result.get("session_id")
        if not self._session_id:
            raise _ProcessDied("session/new returned no session id")
        if self.model:
            # ACP model ids are accepted by the server's session/set_model handler.
            self._request("session/set_model", {
                "sessionId": self._session_id, "modelId": self.model,
            })

    def _read_stdout(self) -> None:
        proc = self._proc
        try:
            for line in proc.stdout:
                LOG.debug("ACP stdout: %s", line.rstrip()[:200])
                try:
                    message = json.loads(line)
                except (TypeError, ValueError):
                    LOG.debug("discarding non-JSON ACP output: %r", line[:200])
                    continue
                self._events.put(message)
        except Exception:
            LOG.debug("ACP stdout reader stopped", exc_info=True)
        finally:
            # The child's own stderr is the only place its reason for dying is written, and a
            # pipe nobody reads also BLOCKS the child once it fills. Both are answered here.
            if self.stderr_tail:
                LOG.warning("ACP child stopped; stderr tail: %s", " | ".join(self.stderr_tail[-6:]))
            self._events.put(None)

    def _read_stderr(self) -> None:
        """Drain the child's stderr, keeping the tail for the post-mortem."""
        proc = self._proc
        tail: collections.deque[str] = collections.deque(maxlen=40)
        try:
            for line in proc.stderr:
                tail.append(line.rstrip()[:400])
                self.stderr_tail = list(tail)
        except Exception:
            LOG.debug("ACP stderr reader stopped", exc_info=True)

    def _send(self, method: str, params: dict[str, Any]) -> int:
        if not self._proc or self._proc.poll() is not None:
            raise _ProcessDied("ACP process is not running")
        self._rpc_id += 1
        request_id = self._rpc_id
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        with self._write_lock:
            self._proc.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
            self._proc.stdin.flush()
        return request_id

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._send(method, params)
        while True:
            message = self._events.get()
            if message is None:
                raise _ProcessDied("ACP process closed stdout")
            if self._answer_inbound(message):
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError("ACP %s failed: %s" % (method, message["error"]))
            return message.get("result") or {}

    def _prompt(self, prompt, on_event, stop, reasoning) -> tuple[str, str]:
        self._apply_reasoning(reasoning)
        request_id = self._send("session/prompt", {
            "sessionId": self._session_id,
            "prompt": [{"type": "text", "text": str(prompt)}],
        })
        text_parts = []
        deadline = time.monotonic() + self.timeout
        cancelled = False
        while True:
            if stop and stop() and not cancelled:
                cancelled = True
                try:
                    self._send("session/cancel", {"sessionId": self._session_id})
                except _ProcessDied:
                    raise
                return "stopped", ""
            remaining = min(0.2, max(0.0, deadline - time.monotonic()))
            if remaining == 0:
                try:
                    self._send("session/cancel", {"sessionId": self._session_id})
                except _ProcessDied:
                    pass
                return "timeout", ""
            try:
                message = self._events.get(timeout=remaining)
            except queue.Empty:
                continue
            if message is None:
                raise _ProcessDied("ACP process closed during prompt")
            if self._answer_inbound(message):
                continue
            if "id" in message and message.get("id") == request_id:
                result = message.get("result") or {}
                self.last_usage = result.get("usage") or {}
                reason = result.get("stopReason") or result.get("stop_reason")
                if reason == "cancelled":
                    return "stopped", ""
                if reason not in (None, "end_turn"):
                    return "failed", ""
                text = "".join(text_parts)
                return ("ok", text) if text.strip() else ("empty", "")
            if message.get("method") == "session/update":
                self._translate_update(message.get("params") or {}, text_parts, on_event)

    @staticmethod
    def _translate_update(params, text_parts, on_event) -> None:
        update = params.get("update") or params.get("sessionUpdate") or params
        kind = update.get("sessionUpdate") or update.get("type")
        if kind in ("agent_message_chunk", "text"):
            content = update.get("content") or {}
            delta = content.get("text", "") if isinstance(content, dict) else str(content)
            if delta:
                text_parts.append(delta)
                if on_event:
                    on_event("text", {"type": "text", "text": delta})
        elif kind in ("tool_call", "tool_use"):
            name = update.get("name") or update.get("title") or "tool"
            raw = update.get("rawInput", update.get("input", {}))
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except ValueError:
                    raw = {"raw": raw}
            if on_event:
                on_event("tool_use", {"type": "tool_use", "name": name, "input": raw or {}})
        elif kind in ("tool_call_update", "tool_result"):
            name = update.get("name") or update.get("title") or "tool"
            status = str(update.get("status") or "").lower()
            output = update.get("rawOutput", update.get("output", ""))
            if isinstance(output, dict) and "text" in output:
                output = output["text"]
            event = {
                "type": "tool_result", "name": name,
                "is_error": status in ("failed", "error") or bool(update.get("isError")),
                "output": output,
                "duration_ms": update.get("durationMs", update.get("duration_ms")),
            }
            if on_event:
                on_event("tool_result", event)

    def ensure_ready(self) -> bool:
        """Build the process and its session now, so the first real turn does not pay for it."""
        with self._lock:
            if self._closed:
                self.last_build_error = "agent was already closed"
                return False
            try:
                self._ensure_process()
            except Exception as exc:
                # Visible at WARNING: a swallowed build failure is undiagnosable in production.
                self.last_build_error = repr(exc)
                LOG.warning("warm agent build failed: %r", exc, exc_info=True)
                self._drop_process()
                return False
            self.last_build_error = ""
            return True

    def idle_for(self) -> float:
        """Seconds since this agent was last used."""
        return time.monotonic() - self._last_used

    def _apply_reasoning(self, level) -> None:
        """Set the session's thinking depth, the way --reasoning does on the cold path.

        Sent only when it changes: the value lives on the session, so a turn at the same depth
        as the last one costs no extra round trip.
        """
        wanted = str(level or "none").strip().lower()
        if wanted == self._reasoning_level:
            return
        try:
            self._request("session/set_config_option", {
                "sessionId": self._session_id, "configId": "reasoning_effort", "value": wanted,
            })
            self._reasoning_level = wanted
        except Exception:
            LOG.debug("could not set the session reasoning to %r", wanted, exc_info=True)

    # Permission option ids the ACP server offers, most-to-least persistent.
    _ALLOW_OPTION_IDS = ("allow_once", "allow_session", "allow_always")

    def _answer_inbound(self, message: dict[str, Any]) -> bool:
        """Answer a server->client request; True when the message was consumed.

        The ACP server asks the client to approve tool calls and edits and then BLOCKS
        until it answers (approvals.timeout, 300s by default). A client that stays silent
        stalls the whole turn - which is exactly what the first integration run did. The
        app has already vetted the prompt with its own danger gate and the agent runs
        unattended, so "allow once" is chosen: every tool call stays gated and no
        permanent grant is written. Unknown methods are refused rather than ignored, so
        the server never ends up waiting on us.
        """
        if not isinstance(message, dict) or "method" not in message or "id" not in message:
            return False
        method = message.get("method")
        result: dict[str, Any] | None = None
        error: dict[str, Any] | None = None
        if method == "session/request_permission":
            options = (message.get("params") or {}).get("options") or []
            chosen = self._choose_permission(options)
            if chosen:
                result = {"outcome": {"outcome": "selected", "optionId": chosen, "option_id": chosen}}
            else:
                result = {"outcome": {"outcome": "cancelled"}}
        else:
            error = {"code": -32601, "message": "warm client does not support %s" % method}
        reply: dict[str, Any] = {"jsonrpc": "2.0", "id": message["id"]}
        reply["error" if error else "result"] = error or result
        try:
            with self._write_lock:
                self._proc.stdin.write(json.dumps(reply, separators=(",", ":")) + "\n")
                self._proc.stdin.flush()
        except Exception as exc:
            raise _ProcessDied("could not answer ACP %s: %s" % (method, exc))
        LOG.info("answered ACP %s -> %s", method, result or error)
        return True

    @classmethod
    def _choose_permission(cls, options: Any) -> str | None:
        ids = [str(o.get("optionId") or o.get("option_id") or "")
               for o in options if isinstance(o, dict)]
        for wanted in cls._ALLOW_OPTION_IDS:
            if wanted in ids:
                return wanted
        for option_id in ids:
            if option_id and "deny" not in option_id:
                return option_id
        return None

    def _drop_process(self) -> None:
        proc, self._proc = self._proc, None
        self._session_id = None
        self._reasoning_level = None
        if proc is None:
            return
        try:
            proc.kill()
        except Exception:
            pass


class _ProcessDied(RuntimeError):
    pass
