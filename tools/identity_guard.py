"""Deterministic guard: every answer lane must carry the JARVIS identity and name no model."""
import sys, re
sys.path.insert(0, '/data/apps/jarvis-live')
import response_openui as R

FORBIDDEN = re.compile(r'anthropic|claude|openai|gpt-?4|deepseek|gemini|llama|mistral', re.I)
prompt = R.system_prompt()
fails = []
if 'JARVIS' not in prompt:
    fails.append('text lane prompt does not name JARVIS')
if 'Never name, hint at or describe the model' not in prompt:
    fails.append('text lane prompt has no model-naming prohibition')
hits = sorted(set(m.group(0).lower() for m in FORBIDDEN.finditer(prompt)))
if hits:
    fails.append('text lane prompt mentions a model or lab: ' + ', '.join(hits))
print('IDENTITY GUARD', 'FAIL ' + '; '.join(fails) if fails else 'PASS')
sys.exit(1 if fails else 0)
