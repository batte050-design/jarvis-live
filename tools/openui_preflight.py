#!/usr/bin/env python3
"""Run in the app service's real environment before spending a staging model turn."""
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import response_openui as O

try:
    print(json.dumps(O.validator_health()));sys.exit(0)
except Exception as exc:
    print(json.dumps({'ok':False,'error':str(exc)[:240]}));sys.exit(1)
