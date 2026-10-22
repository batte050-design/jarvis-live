"""Pending approval questions, per-chat permission modes, and the audit trail.

Three small stores, all under the app's data directory, all written atomically:

    modes.json      chat id -> "ask" | "auto"      the per-chat Permissions control
    pending.json    question id -> the question    one per turn, cleared when answered
    audit.jsonl     one row per decision           chat, turn, action, class, mode, outcome, time

The rule this module exists to enforce: a question is answered by the signed-in owner, for one
chat, one turn and one question id, once. No answer, no viewer, a timeout or a restart means deny,
and that deny is written to the audit log like any other decision.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from typing import Any, Dict, List, Optional

LOCK = threading.RLock()
# Ten minutes, not two. He asked for the window to hold: a question that vanishes while he is
# walking back to his phone is a step silently skipped. The turn does not sit for ten minutes
# when nobody is looking - the ask route shortens the wait when no page is attached.
ASK_TTL_SECONDS = 600


class Store:
    def __init__(self, root: str):
        self.root = root
        self.modes_path = os.path.join(root, "modes.json")
        self.pending_path = os.path.join(root, "pending.json")
        self.audit_path = os.path.join(root, "audit.jsonl")

    # --- small atomic json helpers -------------------------------------------------
    def _read(self, path: str) -> Dict[str, Any]:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _write(self, path: str, data: Dict[str, Any]) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)

    # --- modes ---------------------------------------------------------------------
    def mode(self, chat: str) -> str:
        """Auto unless the chat says ask. Auto is the default mode."""
        with LOCK:
            m = str(self._read(self.modes_path).get(str(chat or "")) or "").strip().lower()
        return "ask" if m == "ask" else "auto"

    def set_mode(self, chat: str, mode: str) -> str:
        mode = "auto" if str(mode).strip().lower() == "auto" else "ask"
        with LOCK:
            data = self._read(self.modes_path)
            data[str(chat)] = mode
            self._write(self.modes_path, data)
        return mode

    # --- questions -----------------------------------------------------------------
    def ask(self, chat: str, turn: str, question: str, action: str, cls: str, tier: str = "high") -> Dict[str, Any]:
        qid = secrets.token_hex(8)
        item = {"id": qid, "chat": str(chat), "turn": str(turn), "question": question,
                "action": action, "class": cls, "tier": tier, "asked": time.time(), "state": "pending"}
        with LOCK:
            data = self._read(self.pending_path)
            data[qid] = item
            self._write(self.pending_path, data)
        return item

    def pending_for(self, chat: str) -> List[Dict[str, Any]]:
        with LOCK:
            items = list(self._read(self.pending_path).values())
        return [i for i in items if i.get("chat") == str(chat) and i.get("state") == "pending"]

    def answer(self, qid: str, chat: str, turn: str, allow: bool) -> Dict[str, Any]:
        """One answer, bound to its own chat and turn. A second answer is refused."""
        with LOCK:
            data = self._read(self.pending_path)
            item = data.get(str(qid))
            if not item:
                return {"ok": False, "error": "no such question"}
            if item.get("chat") != str(chat) or item.get("turn") != str(turn):
                return {"ok": False, "error": "question does not belong to this chat and turn"}
            if item.get("state") != "pending":
                return {"ok": False, "error": "already answered"}
            if time.time() - float(item.get("asked") or 0) > ASK_TTL_SECONDS:
                return {"ok": False, "error": "the question expired before the answer arrived"}
            item["state"] = "answered"
            item["outcome"] = "allow" if allow else "deny"
            item["answered"] = time.time()
            data[qid] = item
            self._write(self.pending_path, data)
        return {"ok": True, "outcome": item["outcome"], "item": item}

    def expire(self, reason: str, chat: str | None = None) -> List[Dict[str, Any]]:
        """Restart or timeout: everything still pending becomes a logged deny."""
        expired = []
        with LOCK:
            data = self._read(self.pending_path)
            now = time.time()
            for qid, item in list(data.items()):
                if chat is not None and item.get("chat") != str(chat):
                    continue
                if item.get("state") != "pending":
                    continue
                if reason == "timeout" and now - float(item.get("asked") or 0) < ASK_TTL_SECONDS:
                    continue
                item["state"] = "expired"
                item["outcome"] = "deny"
                item["expired_reason"] = reason
                data[qid] = item
                expired.append(item)
            if expired:
                self._write(self.pending_path, data)
        for item in expired:
            self.audit(item.get("chat"), item.get("turn"), item.get("action"), item.get("class"),
                       mode="ask", outcome="deny", reason=reason)
        return expired

    # --- audit ---------------------------------------------------------------------
    def audit(self, chat: str, turn: str, action: str, cls: str, mode: str, outcome: str,
              reason: str = "") -> None:
        row = {"at": time.time(), "chat": str(chat or ""), "turn": str(turn or ""),
               "action": str(action or "")[:500], "class": str(cls or ""), "mode": mode,
               "outcome": outcome, "reason": reason}
        with LOCK:
            try:
                with open(self.audit_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(row) + "\n")
            except Exception:
                pass

    def audit_rows(self, limit: int = 50) -> List[Dict[str, Any]]:
        try:
            with open(self.audit_path, encoding="utf-8") as f:
                rows = [json.loads(l) for l in f if l.strip()]
        except Exception:
            return []
        return rows[-limit:]
