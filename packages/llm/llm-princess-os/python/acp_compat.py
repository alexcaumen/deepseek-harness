"""Launch Hermes ACP with narrow, process-local compatibility repairs.

The canonical Hermes/GianaOS source remains untouched. Repairs are installed
only when an older active release lacks a method that its extracted
conversation loop already calls.
"""

from __future__ import annotations

import getpass
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from inspect import signature
from typing import Any, Optional

from run_agent import AIAgent


def _install_windows_git_bash_guard() -> None:
    """Keep the local terminal on Git Bash instead of an incompatible WSL bash.

    The active Hermes release probes Git Bash once and caches the result. A
    transient probe failure can therefore select Windows' WSL launcher for the
    lifetime of the ACP process. That launcher cannot resolve MSYS paths such
    as ``/f/DS-Harness``. Retry the configured Git Bash locally and fail closed
    if the only remaining candidate is the WSL launcher.
    """
    if os.name != "nt":
        return

    from tools.environments import local as local_environment

    configured = os.environ.get("HERMES_GIT_BASH_PATH", "").strip()
    if not configured or not Path(configured).is_file():
        return

    # Probe exactly once during ACP startup. Re-probing on every environment
    # construction can serialize several 15-second subprocess probes and make
    # a simple read_file call appear hung. Once this exact executable passes,
    # keep the immutable path for the lifetime of this ACP child.
    local_environment._bash_starts_cache.pop(configured, None)
    local_environment._bash_probe_details_cache.pop(configured, None)
    if not local_environment._bash_starts(configured):
        raise RuntimeError(
            "configured Git Bash failed its startup probe; refusing shell "
            "fallback for this ACP process"
        )

    def _find_bash() -> str:
        return configured

    local_environment._find_bash = _find_bash


def _windows_binding_sha256() -> str:
    """Hash the signed-in Windows principal and host without exporting either."""
    domain = os.environ.get("USERDOMAIN", "")
    user = os.environ.get("USERNAME", "") or getpass.getuser()
    computer = os.environ.get("COMPUTERNAME", "")
    material = f"{domain}\\{user}|{computer}".lower().encode("utf-8")
    return hashlib.sha256(material).hexdigest().upper()


def _load_profile_config(home: Path) -> dict:
    """Read only the active profile config used by this ACP child."""
    try:
        import yaml

        document = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
        return document if isinstance(document, dict) else {}
    except (ImportError, OSError, ValueError, TypeError):
        return {}


def _resolve_owner_private_context() -> tuple[str, str] | None:
    """Return the canonical owner id and memory fragment after local auth proof.

    The expected binding is a no-export hash supplied by the Harness route.
    The canonical owner id and memory remain in the active Putri profile and
    are read only inside this process. Nothing is copied into Harness state.
    """
    required = os.environ.get("GIANA_OWNER_PRIVATE_BINDING_REQUIRED", "0") == "1"
    if not required:
        return None

    expected = os.environ.get("GIANA_OWNER_PRIVATE_WINDOWS_BINDING_SHA256", "").strip().upper()
    if len(expected) != 64 or not hmac.compare_digest(expected, _windows_binding_sha256()):
        raise RuntimeError("owner-private Windows binding validation failed")

    from hermes_constants import get_hermes_home
    from gateway.giana_core_memory_fragment import build_core_memory_fragment

    home = Path(get_hermes_home()).resolve()
    config = _load_profile_config(home)
    platforms = config.get("platforms")
    feishu = platforms.get("feishu") if isinstance(platforms, dict) else None
    extra = feishu.get("extra") if isinstance(feishu, dict) else None
    owners = extra.get("owner_private_users") if isinstance(extra, dict) else None
    canonical_owners = [str(value).strip() for value in owners] if isinstance(owners, list) else []
    canonical_owners = [value for value in canonical_owners if value]
    if len(canonical_owners) != 1:
        raise RuntimeError("canonical owner-private identity is not singular")

    fragment = build_core_memory_fragment(
        home=home,
        config=config,
        owner_private_surface=True,
    )
    if "## Owner-private continuity" not in fragment:
        raise RuntimeError("canonical owner-private memory fragment is unavailable")
    return canonical_owners[0], fragment


def _install_owner_private_acp_binding() -> None:
    """Patch only this ACP process; canonical GianaOS source stays unchanged."""
    from acp_adapter.session import SessionManager

    original = SessionManager._make_agent

    def _make_agent(self, **kwargs):
        agent = original(self, **kwargs)
        context = _resolve_owner_private_context()
        if context is None:
            return agent

        owner_id, fragment = context
        existing = str(getattr(agent, "ephemeral_system_prompt", "") or "").strip()
        binding_note = (
            "Authenticated owner-private ACP surface. The signed-in Windows principal "
            "is bound to the single canonical owner declared by this Putri profile. "
            "Preserve Putri's canonical identity, Soul, memory, tools, and approval policy; "
            "Giana Code is only the workbench projection."
        )
        agent.ephemeral_system_prompt = "\n\n".join(
            part for part in (existing, binding_note, fragment) if part
        )
        agent._user_id = owner_id
        agent._chat_type = "dm"
        agent._user_name = "Authenticated local owner"
        return agent

    SessionManager._make_agent = _make_agent


if not hasattr(AIAgent, "_conversation_root_id"):

    def _conversation_root_id(self: AIAgent) -> Optional[str]:
        """Resolve the stable root id without changing canonical session data."""
        session_id = getattr(self, "session_id", None)
        if not session_id:
            return None

        start = getattr(self, "_parent_session_id", None) or session_id
        session_db = getattr(self, "_session_db", None)
        if session_db is not None:
            try:
                root = session_db.get_conversation_root(start)
                if root:
                    return root
            except Exception:
                pass
        return start

    AIAgent._conversation_root_id = _conversation_root_id


_is_thinking_message = AIAgent._is_thinking_only_assistant
if "drop_codex_reasoning_items" not in signature(_is_thinking_message).parameters:

    def _is_thinking_only_assistant(
        msg: dict,
        *,
        drop_codex_reasoning_items: bool = True,
    ) -> bool:
        """Match the extracted loop's reasoning-item compatibility contract."""
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            return False
        if msg.get("tool_calls"):
            return False

        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                return False
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    if block:
                        return False
                    continue
                block_type = block.get("type")
                if block_type in {"thinking", "redacted_thinking"}:
                    continue
                if block_type == "text":
                    text = block.get("text", "")
                    if isinstance(text, str) and text.strip():
                        return False
                    continue
                return False
        elif content is not None and content != "":
            return False

        reasoning = msg.get("reasoning_content") or msg.get("reasoning")
        if isinstance(reasoning, str) and reasoning.strip():
            return True
        reasoning_details = msg.get("reasoning_details")
        if isinstance(reasoning_details, list) and reasoning_details:
            return True
        codex_items = msg.get("codex_reasoning_items")
        if drop_codex_reasoning_items and isinstance(codex_items, list):
            return any(
                isinstance(item, dict) and item.get("type") == "reasoning"
                for item in codex_items
            )
        return False

    AIAgent._is_thinking_only_assistant = staticmethod(
        _is_thinking_only_assistant
    )


_sanitize_tool_calls = AIAgent._sanitize_tool_calls_for_strict_api
if "model" not in signature(_sanitize_tool_calls).parameters:

    def _sanitize_tool_calls_for_strict_api(
        api_msg: dict, model: Optional[str] = None
    ) -> dict:
        """Accept the extracted loop's model argument for older active agents."""
        tool_calls = api_msg.get("tool_calls")
        if not isinstance(tool_calls, list):
            return api_msg

        strip_keys = {"call_id", "response_item_id"}
        try:
            from agent.transports.chat_completions import (
                _model_consumes_thought_signature,
            )

            if not _model_consumes_thought_signature(model):
                strip_keys.add("extra_content")
        except (ImportError, AttributeError):
            strip_keys.add("extra_content")

        api_msg["tool_calls"] = [
            {key: value for key, value in tool_call.items() if key not in strip_keys}
            if isinstance(tool_call, dict)
            else tool_call
            for tool_call in tool_calls
        ]
        return api_msg

    AIAgent._sanitize_tool_calls_for_strict_api = staticmethod(
        _sanitize_tool_calls_for_strict_api
    )


_drop_thinking_messages = AIAgent._drop_thinking_only_and_merge_users
if "drop_codex_reasoning_items" not in signature(_drop_thinking_messages).parameters:

    def _drop_thinking_only_and_merge_users(
        messages: list[dict],
        drop_codex_reasoning_items: bool = True,
    ) -> list[dict]:
        """Bridge the extracted loop to the matching stateless helper.

        The active release contains a newer conversation loop and helper but an
        older method bound on ``AIAgent``. Keep the repair process-local and
        preserve the loop's Codex reasoning policy instead of discarding the
        keyword argument.
        """
        from agent.agent_runtime_helpers import (
            drop_thinking_only_and_merge_users,
        )

        return drop_thinking_only_and_merge_users(
            messages,
            drop_codex_reasoning_items=drop_codex_reasoning_items,
        )

    AIAgent._drop_thinking_only_and_merge_users = staticmethod(
        _drop_thinking_only_and_merge_users
    )


_sync_external_memory = AIAgent._sync_external_memory_for_turn
if "messages" not in signature(_sync_external_memory).parameters:

    def _sync_external_memory_for_turn(
        self: AIAgent,
        *,
        original_user_message: Any,
        final_response: Any,
        interrupted: bool,
        messages: Optional[list[dict[str, Any]]] = None,
    ) -> None:
        """Accept the newer finalizer contract while preserving old semantics.

        The active method already mirrors the completed user/assistant pair and
        skips interrupted turns. The newer finalizer additionally supplies the
        full message list, which the older implementation does not consume.
        """
        del messages
        return _sync_external_memory(
            self,
            original_user_message=original_user_message,
            final_response=final_response,
            interrupted=interrupted,
        )

    AIAgent._sync_external_memory_for_turn = _sync_external_memory_for_turn


if not hasattr(AIAgent, "_emit_wait_notice"):

    def _emit_wait_notice(self: AIAgent, text: str) -> None:
        try:
            self._touch_activity(text)
            callback = getattr(self, "thinking_callback", None)
            if callback:
                callback(text)
        except Exception:
            return

    AIAgent._emit_wait_notice = _emit_wait_notice


if not hasattr(AIAgent, "_buffer_status"):

    def _buffer_status(self: AIAgent, message: str) -> None:
        try:
            buffer = getattr(self, "_retry_status_buffer", None)
            if buffer is None:
                buffer = []
                self._retry_status_buffer = buffer
            buffer.append(("status", message))
        except Exception:
            return

    AIAgent._buffer_status = _buffer_status


if not hasattr(AIAgent, "_buffer_vprint"):

    def _buffer_vprint(self: AIAgent, message: str) -> None:
        try:
            buffer = getattr(self, "_retry_status_buffer", None)
            if buffer is None:
                buffer = []
                self._retry_status_buffer = buffer
            buffer.append(("vprint", message))
        except Exception:
            return

    AIAgent._buffer_vprint = _buffer_vprint


if not hasattr(AIAgent, "_clear_status_buffer"):

    def _clear_status_buffer(self: AIAgent) -> None:
        try:
            buffer = getattr(self, "_retry_status_buffer", None)
            if buffer:
                buffer.clear()
        except Exception:
            return

    AIAgent._clear_status_buffer = _clear_status_buffer


if not hasattr(AIAgent, "_emit_pending_fallback_notice"):

    def _emit_pending_fallback_notice(self: AIAgent) -> None:
        try:
            notice = getattr(self, "_pending_fallback_notice", None)
            if notice:
                self._pending_fallback_notice = None
                self._emit_status(notice)
        except Exception:
            return

    AIAgent._emit_pending_fallback_notice = _emit_pending_fallback_notice


if not hasattr(AIAgent, "_flush_status_buffer"):

    def _flush_status_buffer(self: AIAgent) -> None:
        try:
            self._pending_fallback_notice = None
            buffer = getattr(self, "_retry_status_buffer", None)
            if not buffer:
                return
            messages = list(buffer)
            buffer.clear()
            for kind, message in messages:
                try:
                    if kind == "status":
                        self._emit_status(message)
                    elif kind == "warn":
                        self._emit_warning(message)
                    else:
                        self._vprint(
                            f"{getattr(self, 'log_prefix', '')}{message}",
                            force=True,
                        )
                except Exception:
                    continue
        except Exception:
            return

    AIAgent._flush_status_buffer = _flush_status_buffer


if not hasattr(AIAgent, "_disable_codex_reasoning_replay"):

    def _disable_codex_reasoning_replay(
        self: AIAgent,
        messages: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, int]:
        stripped_messages = 0
        stripped_items = 0
        for message in messages if isinstance(messages, list) else []:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            items = message.pop("codex_reasoning_items", None)
            if isinstance(items, list) and items:
                stripped_messages += 1
                stripped_items += len(items)
        self._codex_reasoning_replay_enabled = False
        return {"messages": stripped_messages, "items": stripped_items}

    AIAgent._disable_codex_reasoning_replay = _disable_codex_reasoning_replay


if not hasattr(AIAgent, "_is_copilot_url"):

    def _is_copilot_url(self: AIAgent) -> bool:
        base_url = str(
            getattr(self, "_base_url_lower", "")
            or getattr(self, "base_url", "")
        ).lower()
        return "api.githubcopilot.com" in base_url or "models.github.ai" in base_url

    AIAgent._is_copilot_url = _is_copilot_url


if not hasattr(AIAgent, "_requested_output_cap_from_api_kwargs"):

    def _requested_output_cap_from_api_kwargs(
        api_kwargs: Any,
    ) -> Optional[int]:
        if not isinstance(api_kwargs, dict):
            return None
        for key in ("max_output_tokens", "max_completion_tokens", "max_tokens"):
            try:
                value = int(api_kwargs.get(key))
            except (TypeError, ValueError):
                continue
            if value > 0:
                return value
        return None

    AIAgent._requested_output_cap_from_api_kwargs = staticmethod(
        _requested_output_cap_from_api_kwargs
    )


if not hasattr(AIAgent, "_api_request_payload_for_hook"):

    def _api_request_payload_for_hook(
        self: AIAgent,
        api_kwargs: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
        # Harness telemetry must never receive prompts, tools, or credentials.
        return {"method": "POST", "body": {"redacted": True}}

    AIAgent._api_request_payload_for_hook = _api_request_payload_for_hook


if not hasattr(AIAgent, "_api_response_payload_for_hook"):

    def _api_response_payload_for_hook(
        self: AIAgent,
        response: Any,
        assistant_message: Any,
        *,
        finish_reason: Optional[str],
    ) -> dict[str, Any]:
        usage = None
        try:
            usage = self._usage_summary_for_api_request_hook(response)
        except Exception:
            pass
        return {
            "model": getattr(response, "model", None),
            "finish_reason": finish_reason,
            "assistant_message": {"redacted": True},
            "usage": usage,
        }

    AIAgent._api_response_payload_for_hook = _api_response_payload_for_hook


if not hasattr(AIAgent, "_try_refresh_vertex_client_credentials"):

    def _try_refresh_vertex_client_credentials(self: AIAgent) -> bool:
        # This compatibility route is bound to the approved non-Vertex provider.
        return False

    AIAgent._try_refresh_vertex_client_credentials = (
        _try_refresh_vertex_client_credentials
    )


if not hasattr(AIAgent, "_interim_assistant_visible_text"):

    def _interim_assistant_visible_text(
        self: AIAgent,
        assistant_message: dict[str, Any],
    ) -> str:
        content = assistant_message.get("content")
        if isinstance(content, str):
            visible = content
        elif isinstance(content, list):
            visible = "\n".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") in {"text", "input_text"}
            )
        else:
            visible = ""
        try:
            return self._strip_think_blocks(visible).strip()
        except Exception:
            return visible.strip()

    AIAgent._interim_assistant_visible_text = _interim_assistant_visible_text


if not hasattr(AIAgent, "_try_strip_image_parts_from_tool_messages"):

    def _try_strip_image_parts_from_tool_messages(
        self: AIAgent,
        api_messages: list,
        *,
        remember_model: bool = True,
    ) -> bool:
        if not isinstance(api_messages, list):
            return False
        if remember_model:
            key = (
                str(getattr(self, "provider", "") or "").strip().lower(),
                str(getattr(self, "model", "") or "").strip(),
            )
            if not hasattr(self, "_no_list_tool_content_models"):
                self._no_list_tool_content_models = set()
            if key[1]:
                self._no_list_tool_content_models.add(key)
        changed = False
        for message in api_messages:
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            content = message.get("content")
            if not isinstance(content, list):
                continue
            text_parts = []
            had_image = False
            for part in content:
                if isinstance(part, str) and part.strip():
                    text_parts.append(part.strip())
                elif isinstance(part, dict):
                    if part.get("type") in {"image_url", "input_image"}:
                        had_image = True
                    elif part.get("type") in {"text", "input_text"}:
                        text = str(part.get("text") or "").strip()
                        if text:
                            text_parts.append(text)
            if had_image:
                message["content"] = "\n\n".join(text_parts) or (
                    "[image content removed for provider compatibility]"
                )
                changed = True
        return changed

    AIAgent._try_strip_image_parts_from_tool_messages = (
        _try_strip_image_parts_from_tool_messages
    )


if not hasattr(AIAgent, "_reapply_reasoning_echo_for_provider"):

    def _reapply_reasoning_echo_for_provider(
        self: AIAgent,
        api_messages: list,
    ) -> int:
        try:
            from agent.agent_runtime_helpers import (
                reapply_reasoning_echo_for_provider,
            )

            return reapply_reasoning_echo_for_provider(self, api_messages)
        except Exception:
            return 0

    AIAgent._reapply_reasoning_echo_for_provider = (
        _reapply_reasoning_echo_for_provider
    )


if not hasattr(AIAgent, "_invoke_api_request_error_hook"):

    def _invoke_api_request_error_hook(
        self: AIAgent,
        *,
        task_id: str,
        turn_id: str,
        api_request_id: str,
        api_call_count: int,
        api_start_time: float,
        api_kwargs: Optional[dict],
        error_type: str,
        error_message: str,
        status_code: Optional[int] = None,
        retry_count: Optional[int] = None,
        max_retries: Optional[int] = None,
        retryable: Optional[bool] = None,
        reason: Optional[str] = None,
    ) -> None:
        """Restore the extracted loop's optional error-hook contract.

        The active Putri release has the newer conversation loop but not the
        corresponding method on ``AIAgent``. Keep this process-local and send
        metadata only; never forward request bodies or private prompt data.
        """
        try:
            from hermes_cli import plugins as _plugins

            if not _plugins.has_hook("api_request_error"):
                return
            ended_at = time.time()
            _plugins.invoke_hook(
                "api_request_error",
                task_id=task_id,
                turn_id=turn_id,
                api_request_id=api_request_id,
                session_id=getattr(self, "session_id", "") or "",
                platform=getattr(self, "platform", "") or "",
                model=getattr(self, "model", ""),
                provider=getattr(self, "provider", ""),
                base_url="<redacted>",
                api_mode=getattr(self, "api_mode", ""),
                api_call_count=api_call_count,
                api_duration=ended_at - api_start_time,
                started_at=api_start_time,
                ended_at=ended_at,
                status_code=status_code,
                retry_count=retry_count,
                max_retries=max_retries,
                retryable=retryable,
                reason=reason,
                error={"type": error_type, "message": str(error_message)[:1000]},
                request={"redacted": True},
            )
        except Exception:
            return

    AIAgent._invoke_api_request_error_hook = _invoke_api_request_error_hook


from acp_adapter.entry import main


if __name__ == "__main__":
    _install_windows_git_bash_guard()
    _install_owner_private_acp_binding()
    main()
