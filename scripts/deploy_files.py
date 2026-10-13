#!/usr/bin/env python3
"""Verify, install and roll back an explicit release file set. Does not manage services."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_name(name):
    parts = Path(name).parts
    if not parts or Path(name).is_absolute() or any(p in ('..', '.') for p in parts):
        raise ValueError('Unsafe manifest path')
    if parts[0] not in ('src', 'web') and name not in ('package.json', 'README.md'):
        raise ValueError('Manifest includes a non-runtime path: ' + name)


def reject_links(root, relative):
    current = root
    if current.is_symlink():
        raise ValueError('Symlink installation root refused')
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlink installation path refused: ' + relative)


def atomic(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.release-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def apply(source, target, backup):
    release = json.loads((source / 'RELEASE.json').read_text())
    baseline = json.loads((source / 'BASELINE.json').read_text())['hashes']
    originals = {}
    # Check every input and live conflict BEFORE replacing any runtime file.
    for name, digest in release['files'].items():
        validate_name(name)
        reject_links(source, name)
        reject_links(target, name)
        data = (source / name).read_bytes()
        if sha(data) != digest:
            raise ValueError('Release checksum mismatch: ' + name)
        live = target / name
        if live.exists():
            if not live.is_file():
                raise ValueError('Destination is not a file: ' + name)
            current = sha(live.read_bytes())
            if name != 'README.md' and current not in (baseline.get(name), digest):
                raise ValueError('Production file changed since baseline; reconcile before deploying: ' + name)
            info = live.stat()
            originals[name] = {'existed': True, 'mode': info.st_mode & 0o777, 'uid': info.st_uid, 'gid': info.st_gid}
        else:
            originals[name] = {'existed': False}
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    directory_modes = {}
    for d in ('src', 'web'):
        if (target / d).exists():
            directory_modes[d] = (target / d).stat().st_mode & 0o777
    for name, item in originals.items():
        if item['existed']:
            atomic(backup / name, (target / name).read_bytes(), 0o600)
    atomic(backup / 'rollback.json', json.dumps({'files': originals, 'directories': directory_modes}).encode(), 0o600)
    try:
        for name in originals:
            # Sources are public code/assets; credentials remain outside the release.
            atomic(target / name, (source / name).read_bytes(), 0o644)
        for d in ('src', 'web'):
            os.chmod(target / d, 0o755)
    except BaseException:
        rollback(target, backup)
        raise


def rollback(target, backup):
    journal = json.loads((backup / 'rollback.json').read_text())
    for name, item in journal['files'].items():
        validate_name(name)
        reject_links(target, name)
        if item['existed']:
            atomic(target / name, (backup / name).read_bytes(), item['mode'])
            if os.geteuid() == 0:
                os.chown(target / name, item['uid'], item['gid'])
        else:
            (target / name).unlink(missing_ok=True)
    for name, mode in journal['directories'].items():
        os.chmod(target / name, mode)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'apply':
            apply(*(Path(x).resolve() for x in sys.argv[2:5]))
        elif sys.argv[1] == 'rollback':
            rollback(*(Path(x).resolve() for x in sys.argv[2:4]))
        else:
            raise ValueError('Expected apply or rollback')
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
