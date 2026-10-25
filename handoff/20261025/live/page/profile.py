"""Build byte-stable instructions. Call once at session creation, never per message."""
import json
from pathlib import Path
from .adapter import Profile
from .plugin import UI_SCHEMA,PROGRESS_SCHEMA,VERSION


def build_profile(*,persona:bytes,policy:bytes,tools:bytes,library:bytes):
    for value in [persona,policy,tools,library]:
        if not isinstance(value,bytes) or not value:raise ValueError('frozen_profile_section_missing')
    module=(Path(__file__).parent/'plugin/prompt.txt').read_bytes()
    schema=json.dumps([UI_SCHEMA,PROGRESS_SCHEMA],sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
    sections=[('persona',persona),('page_presentation_version',VERSION.encode()),('page_presentation',module),('policy',policy),('harness_tools',tools),('page_tools',schema),('display_library',library)]
    prefix=b''.join(b'\n<'+name.encode()+b'>\n'+value+b'\n</'+name.encode()+b'>\n' for name,value in sections)
    return Profile(prefix,VERSION)
