"""Construct the page coordinator with the installed-harness hooks, never a provider."""
import os
from pathlib import Path
from .adapter import Adapter
from .driver import ACPDriver
from .installed_hooks import display_profile,session_factory,permission_action


def build_adapter(*,app_dir,hermes_bin,state_dir,timeout=480):
    app=Path(app_dir).resolve();state=Path(state_dir).resolve()
    if not app.is_dir() or not state.is_absolute():raise ValueError('invalid_page_paths')
    existing=os.environ.setdefault('PRESENT_STORE',str(state))
    if Path(existing).resolve()!=state:raise ValueError('conflicting_page_state_directory')
    library=(app/'openui/system-prompt.txt').read_text()
    profile=display_profile(library)
    driver=ACPDriver(hermes_bin,str(app),session_factory,permission_action,timeout=timeout)
    return Adapter(driver,profile,timeout=timeout)
