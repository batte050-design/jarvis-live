"""Validate and evaluate one OpenUI program outside the page, for emit_ui.

Prints one JSON line: {"ok": true, "components": [...]} or {"ok": false, "stage": ..., "error": ...}
Nothing is written and nothing is executed beyond the validator's own parse and binding evaluation.
"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import response_openui as R

def main():
    program = sys.stdin.read() if len(sys.argv) < 2 else sys.argv[1]
    try:
        value = R.validate(program, {})
    except Exception as exc:
        print(json.dumps({"ok": False, "stage": "validate", "error": str(exc)[:800]}))
        return 1
    comps = value.get("components") if isinstance(value, dict) else None
    print(json.dumps({"ok": True, "components": comps or []}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
