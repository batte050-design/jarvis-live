"""Test-only Linux Landlock write confinement. No production route or authentication bypass."""
import ctypes
import errno
import os
import platform
from pathlib import Path


def confine_writes(root):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64','aarch64'):
        raise RuntimeError('write confinement requires Linux x86_64/aarch64; refusing unsafe run')
    libc=ctypes.CDLL(None,use_errno=True)
    create,add,restrict=444,445,446
    abi=libc.syscall(create,0,0,1)
    if abi<1:
        raise RuntimeError('Landlock unavailable: '+os.strerror(ctypes.get_errno()))
    rights=sum(1<<n for n in (1,4,5,6,7,8,9,10,11,12))
    if abi>=2:rights|=1<<13
    if abi>=3:rights|=1<<14
    class Ruleset(ctypes.Structure):_fields_=[('handled_access_fs',ctypes.c_uint64)]
    class Beneath(ctypes.Structure):
        _pack_=1
        _fields_=[('allowed_access',ctypes.c_uint64),('parent_fd',ctypes.c_int32)]
    attr=Ruleset(rights);fd=libc.syscall(create,ctypes.byref(attr),ctypes.sizeof(attr),0)
    if fd<0:raise OSError(ctypes.get_errno(),'Landlock create')
    parent=os.open(str(Path(root).resolve()),os.O_PATH|os.O_CLOEXEC)
    try:
        rule=Beneath(rights,parent)
        if libc.syscall(add,fd,1,ctypes.byref(rule),0)<0:raise OSError(ctypes.get_errno(),'Landlock rule')
        if libc.prctl(38,1,0,0,0)<0:raise OSError(ctypes.get_errno(),'no_new_privs')
        if libc.syscall(restrict,fd,0)<0:raise OSError(ctypes.get_errno(),'Landlock restrict')
    finally:os.close(parent);os.close(fd)
    return abi
