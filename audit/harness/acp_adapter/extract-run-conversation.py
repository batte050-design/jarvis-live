# extracted from acp_adapter/server.py lines 773-836, function _run_agent_turn

def _run_agent_turn(
        self, *, state: SessionState, session_id: str, user_text: str, user_content: Any, conn: Any,
        loop: asyncio.AbstractEventLoop, approval_cb: Any, edit_approval_requester: Any,
    ) -> dict:
        """Executor-thread body of one turn, run inside ``contextvars.copy_context()`` so
        ContextVar writes are isolated from concurrent sessions.

        Approval routing is thread-local, so it MUST be bound here, not on the loop thread.
        Interactive routing is a ``tools.approval`` contextvar, not ``HERMES_INTERACTIVE`` in
        os.environ, so concurrent workers can't race a global flag onto the non-interactive
        auto-approve path (GHSA-96vc-wcxf-jjff)."""
        agent = state.agent
        page_channel.begin(state)
        with contextlib.ExitStack() as stack:
            # HERMES_SESSION_KEY scopes per-session caches (interactive sudo password) to this
            # session, not the reused thread. ``cwd`` pins what the system prompt reports as the
            # working directory — otherwise it advertises the Hermes workspace while tools are
            # rooted at the client's project and edits land outside it. ``cron_session=""`` masks
            # any leaked process-global HERMES_CRON_SESSION.
            def _session_context() -> Callable[[], None]:
                from gateway.session_context import clear_session_vars, set_session_vars

                tokens = set_session_vars(
                    session_key=session_id, session_id=session_id, cwd=state.cwd, cron_session="",
                )
                return lambda: clear_session_vars(tokens)

            def _approval() -> Callable[[], None]:
                from tools import terminal_tool

                previous = terminal_tool._get_approval_callback()
                terminal_tool.set_approval_callback(approval_cb)
                return lambda: terminal_tool.set_approval_callback(previous)

            def _edit_approval() -> Callable[[], None]:
                from acp_adapter.edit_approval import reset_edit_approval_requester, set_edit_approval_requester

                token = set_edit_approval_requester(edit_approval_requester)
                return lambda: reset_edit_approval_requester(token)

            _bind_guarded(stack, "session context", _session_context)
            if approval_cb:
                _bind_guarded(stack, "approval callback", _approval)
            if edit_approval_requester:
                _bind_guarded(stack, "edit approval requester", _edit_approval)
            stack.callback(reset_hermes_interactive_context, set_hermes_interactive_context(True))
            # Tools tag side-effects with the ACP session (``kanban_create``); save/restore it.
            stack.callback(_restore_env, "HERMES_SESSION_ID", os.environ.get("HERMES_SESSION_ID"))
            os.environ["HERMES_SESSION_ID"] = session_id

            # Auto-titling fires in the turn prologue; push the title now as a session-info update.
            def _notify_title_update(_title: str, _source: str) -> None:
                if conn:
                    loop.call_soon_threadsafe(asyncio.create_task, self._send_session_info_update(session_id))

            agent._on_session_title = _notify_title_update
            try:
                return agent.run_conversation(
                    user_message=user_content, conversation_history=state.history, task_id=session_id,
                    persist_user_message=user_text or "[Image attachment]",
                )
            except Exception as e:
                logger.exception("Agent error in session %s", session_id)
                return {"final_response": f"Error: {e}", "messages": state.history}
