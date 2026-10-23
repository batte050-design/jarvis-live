"""Declarative response assets and response-only preferences; no turn/session machinery."""
import base64
import functools
import hashlib
import json
import os
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


@functools.lru_cache(maxsize=1)
def assets():
    manifest = json.loads((ROOT / "response-capabilities.json").read_text())
    if manifest.get("version") != 1 or manifest.get("classes") != ["LOCAL", "DATA", "AGENT"]:
        raise ValueError("unsupported response manifest")
    source = canonical(manifest)
    core = (ROOT / "static/response-core.js").read_text()
    runtime = (ROOT / "static/response-runtime.js").read_text()
    style = (ROOT / "static/response-runtime.css").read_text()
    digest = hashlib.sha256(source.encode()).hexdigest()
    stamp = hashlib.sha256(canonical([source, core, runtime, style]).encode()).hexdigest()
    return manifest, digest, stamp, core, runtime, style


def config_script():
    manifest, digest, stamp, *_ = assets()
    return "window.JarvisResponseConfig=" + canonical({"manifest": manifest, "hash": digest, "runtime": stamp}) + ";\n"


def document(parent_origin):
    manifest, digest, _, core, runtime, style = assets()
    bootstrap = "window.JarvisResponseBootstrap=" + canonical({"manifest": manifest, "hash": digest, "parentOrigin": parent_origin}) + ";\n"
    script = bootstrap + core + "\n" + runtime
    # All three sources are repository-owned. No model content is interpolated here.
    if "</script" in script.lower() or "</style" in style.lower():
        raise ValueError("response asset closes its element")
    html = ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Interactive response</title><style>' + style + '</style></head>'
            '<body><main id="response-root"></main><script>' + script + '</script></body></html>')
    def sha(content):
        return base64.b64encode(hashlib.sha256(content.encode()).digest()).decode()
    policy = "; ".join(["default-src 'none'", "script-src 'sha256-" + sha(script) + "'",
                        "style-src 'sha256-" + sha(style) + "'", "connect-src 'none'",
                        "form-action 'none'", "base-uri 'none'", "object-src 'none'",
                        "frame-ancestors " + parent_origin, "sandbox allow-scripts"])
    return html, {"Content-Security-Policy": policy, "X-Content-Type-Options": "nosniff",
                  "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
                  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"}


def preferences(path, conv):
    defaults = dict(assets()[0]["defaults"])
    try:
        data = json.loads(pathlib.Path(path).read_text())
    except FileNotFoundError:
        return defaults
    except (OSError, ValueError):
        return dict.fromkeys(defaults, False)
    entry = data.get(conv, {}) if isinstance(data, dict) else {}
    value = entry.get("response", {}) if isinstance(entry, dict) else {}
    if not isinstance(value, dict):
        return dict.fromkeys(defaults, False)
    return {key: value.get(key, default) if isinstance(value.get(key, default), bool) else False
            for key, default in defaults.items()}


def save_preferences(path, conv, patch, lock):
    defaults = assets()[0]["defaults"]
    if not isinstance(patch, dict) or not patch or any(k not in defaults or not isinstance(v, bool) for k, v in patch.items()):
        raise ValueError("invalid response preferences")
    # The same lock as the existing settings writer, preserving web/memory and other fields.
    with lock:
        try:
            data = json.loads(pathlib.Path(path).read_text())
        except FileNotFoundError:
            data = {}
        if not isinstance(data, dict) or not isinstance(data.get(conv, {}), dict):
            raise ValueError("invalid settings store")
        value = preferences(path, conv)
        value.update(patch)
        data.setdefault(conv, {})["response"] = value
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path), delete=False) as f:
                temp = f.name
                json.dump(data, f, indent=1)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, path)
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)
        return value


def prompt_note():
    """Added only to existing text prompts; never calls a model or reads recall."""
    try:
        manifest = assets()[0]
        contract = {
            "type": "widget", "version": manifest["contractVersion"], "id": "quote",
            "component": "quote-estimator", "props": {"title": "Quote", "currency": "UGX"},
            "initial": {"quantity": 1, "price": 10000, "discount": 0},
            "actions": [{"id": "discuss", "class": "AGENT", "label": "Discuss this quote",
                         "question": "Help me review this quote."}],
            "fallback": "Quote: one item at UGX 10,000; total UGX 10,000."
        }
        return ("\n[Interactive text responses: optional, only when useful. One complete fenced ui JSON object. "
                "No HTML, JavaScript, CSS, URLs or tool calls to build it. LOCAL controls recompute locally; "
                "AGENT actions only propose a reviewed question. DATA is unavailable. "
                "Templates quote-estimator, bill-splitter and budget-planner take initial input overrides; "
                "do not supply inputs/graph/outputs on templates. Example: " + canonical(contract) +
                ". Custom applications use component application (or table/chart/map/quiz/diagram), declared inputs, "
                "a forward-only typed graph and fixed outputs. The exact schema follows: " +
                canonical({"schema": manifest["schema"], "operations": manifest["operations"],
                           "components": manifest["components"], "budgets": manifest["budgets"]}) + "]")
    except (OSError, ValueError):
        return ""
