#!/usr/bin/env python3
"""No-clobber, no-symlink directory rename on Linux, run as MCP's unprivileged user.

The parent-directory descriptors remain pinned throughout the check and rename.
Directory contents are checked for links/special files; a local owner with
concurrent write access can still change descendants between preflight and
rename. This is not a snapshot, transaction or hostile-multitenant sandbox.
"""
import ctypes
import errno
import json
import os
import stat
import sys

RENAME_NOREPLACE = 1
LIBC = ctypes.CDLL(None, use_errno=True)
AT_FDCWD = -100
SKIP = {'.git', 'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.chatgpt-mcp',
        'id_rsa', 'id_ed25519', 'credentials.json'}
MAX_ENTRIES = 10000
MAX_BYTES = 512 * 1024 * 1024

def safe_name(name):
    if not name or name in ('.', '..') or '/' in name or '\x00' in name or '\\' in name:
        raise ValueError('Invalid directory path component')
    if name in SKIP or name == '.env' or name.startswith('.env.') or name.endswith(('.pem', '.key', '.p12', '.pfx')):
        raise ValueError('Directory contains protected or dependency filename')
    return name

def open_parent(root_fd, relative):
    parts = relative.split('/')
    if not parts or any(part in ('', '.', '..') for part in parts):
        raise ValueError('Invalid relative directory path')
    leaf = safe_name(parts[-1])
    current = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            safe_name(part)
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            os.close(current)
            current = next_fd
        return current, leaf
    except BaseException:
        os.close(current)
        raise

def preflight(fd, expected_inode):
    info = os.fstat(fd)
    if info.st_ino != expected_inode:
        raise ValueError('Source inode changed since fs_list; refusing rename')
    total = 0
    size = 0
    pending = [os.dup(fd)]
    try:
        while pending:
            current = pending.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        safe_name(entry.name)
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                            raise ValueError('Directory contains symlink or special file')
                        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                            raise ValueError('Directory contains hard-linked file')
                        total += 1
                        size += info.st_size if stat.S_ISREG(info.st_mode) else 0
                        if total > MAX_ENTRIES or size > MAX_BYTES:
                            raise ValueError('Directory exceeds safe rename scan limits')
                        if stat.S_ISDIR(info.st_mode):
                            pending.append(os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current))
            finally:
                os.close(current)
    finally:
        for current in pending:
            os.close(current)
    return total, size

def run(root, src, dst, expected_inode):
    if not os.path.isabs(root):
        raise ValueError('Workspace root must be absolute')
    if src == dst or dst.startswith(src + '/'):
        raise ValueError('Cannot rename a directory onto itself or a descendant')
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        source_parent, source_name = open_parent(root_fd, src)
        destination_parent, destination_name = open_parent(root_fd, dst)
        try:
            source_fd = os.open(source_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=source_parent)
            try:
                count, bytes_ = preflight(source_fd, expected_inode)
                # The source parent descriptor is pinned. Do not trust a stale
                # filename after a concurrent move.
                if os.stat(source_name, dir_fd=source_parent, follow_symlinks=False).st_ino != expected_inode:
                    raise ValueError('Source directory changed before rename')
                # Linux renameat2 handles the must-not-replace check atomically.
                renameat2 = getattr(LIBC, 'renameat2', None)
                if renameat2 is None:
                    raise OSError(errno.ENOSYS, 'renameat2 is unavailable; refusing non-atomic fallback')
                renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                renameat2.restype = ctypes.c_int
                result = renameat2(source_parent, os.fsencode(source_name),
                                   destination_parent, os.fsencode(destination_name),
                                   RENAME_NOREPLACE)
                if result != 0:
                    code = ctypes.get_errno()
                    raise OSError(code, os.strerror(code))
                return {'ok': True, 'action': 'rename_directory', 'source': src, 'destination': dst,
                        'inode': expected_inode, 'entries': count, 'bytes': bytes_}
            finally:
                os.close(source_fd)
        finally:
            os.close(source_parent)
            os.close(destination_parent)
    finally:
        os.close(root_fd)

try:
    payload = json.loads(sys.stdin.read(32768))
    result = run(payload['workspace'], payload['source'], payload['destination'], payload['expected_inode'])
except Exception as error:
    result = {'ok': False, 'error': str(error)[:1024]}
print(json.dumps(result))
sys.exit(0 if result['ok'] else 1)
