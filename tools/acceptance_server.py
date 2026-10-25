"""Only started by the dedicated-state harness, never installed as the live service."""
import os
from pathlib import Path
import sys
from acceptance_isolation import confine_writes

root=Path(os.environ['JARVIS_ACCEPTANCE_ROOT']).resolve()
app=Path(os.environ['JARVIS_ACCEPTANCE_APP']).resolve()
if root not in app.parents:raise SystemExit('app is outside acceptance root')
confine_writes(root)                         # inherited by every agent child, before app import
sys.path.insert(0,str(app))
import server
# Test-process binding only. No production file is rewritten, no route/auth/turn function replaced.
server.WORKDIR=str(app)
import uvicorn
uvicorn.run(server.app,host='127.0.0.1',port=int(os.environ['JARVIS_LIVE_PORT']),log_level='warning',timeout_graceful_shutdown=3)
