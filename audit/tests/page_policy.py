"""Production page and enforced CSP for offline browser fixtures."""
import ast,json,sys
from pathlib import Path
from types import SimpleNamespace
from authoring_agent_support import symbols,Response
root=Path(__file__).resolve().parents[1]
tree=ast.parse((root/'server.py').read_text())
node=next(n for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='PAGE_CSP' for t in n.targets))
env={'WIDGETS':SimpleNamespace(host=lambda:'widgets.jarvis.invalid')}
exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-page-policy','exec'),env)
page=symbols(root,['page_response'],{'PAGE_CSP':env['PAGE_CSP'],'HTMLResponse':Response})['page_response']((root/'index_v1.html').read_text(),report_only=False)
print(json.dumps({'html':page.content,'headers':page.headers}))
