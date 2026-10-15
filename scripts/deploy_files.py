#!/usr/bin/env python3
"""Checksum-verified release deployment with distinct fresh/upgrade modes.

Both operations use the same rollback journal. A fresh install needs NO
BASELINE.json; upgrades verify installed manifests or certified legacy hashes before changing
files. It never fabricates a baseline from files it is about to overwrite.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

INSTALLED_MANIFEST = '.superchatdev-release.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_name(name):
    if not isinstance(name, str):
        raise ValueError('Invalid manifest path')
    parts = Path(name).parts
    if (not parts or Path(name).is_absolute() or
            any(p in ('..', '.') for p in parts)):
        raise ValueError('Unsafe manifest path')
    if parts[0] not in ('src', 'web') and name not in ('package.json', 'README.md', 'CHANGELOG.md'):
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


def file_metadata(path):
    if not path.exists():
        return {'existed': False}
    if not path.is_file():
        raise ValueError('Expected a regular file: ' + str(path))
    info = path.stat()
    return {'existed': True, 'mode': info.st_mode & 0o777,
            'uid': info.st_uid, 'gid': info.st_gid}


def installed_baseline(source, target, release_files):
    path = target / INSTALLED_MANIFEST
    reject_links(target, INSTALLED_MANIFEST)
    if path.exists():
        manifest = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(manifest.get('files'), dict):
            raise ValueError('Installed release manifest is invalid')
        return manifest['files']

    # Public pre-manifest v0.3.0 installations had no installed manifest.
    # Migrate ONLY the exact historic release, not an unknown/custom build.
    # Crucially, this is a trusted release snapshot; never manufacture a
    # baseline from the machine we are about to overwrite.
    legacy = source / 'legacy-baselines' / 'v0.3.0.json'
    if legacy.is_file() and not legacy.is_symlink():
        snapshot = json.loads(legacy.read_text(encoding='utf-8'))
        expected = snapshot.get('files')
        if (snapshot.get('version') == '0.3.0'
                and isinstance(expected, dict)
                and set(expected).issubset(set(release_files))):
            problems = []
            for name, checksum in expected.items():
                validate_name(name)
                reject_links(target, name)
                current = target / name
                if not isinstance(checksum, str) or len(checksum) != 64:
                    raise ValueError('Invalid legacy checksum: ' + name)
                if not current.is_file() or sha(current.read_bytes()) != checksum:
                    problems.append(name)
            if not problems:
                return expected
            raise ValueError(
                'Known v0.3.0 installation differs from the certified baseline; '
                'refusing migration. Changed or missing: ' +
                ', '.join(problems[:10]))
    raise ValueError(
        'Cannot safely upgrade: installed release manifest is missing and '
        'installation does not match a certified legacy baseline. '
        'Do not use fresh mode to overwrite existing runtime files; '
        'reconcile the existing installation before upgrading.')


def apply(source, target, backup, mode='upgrade'):
    if mode not in ('fresh', 'upgrade'):
        raise ValueError('Mode must be fresh or upgrade')
    if not target.is_dir() or target.is_symlink():
        raise ValueError('Deployment target must be an existing real directory')
    release = json.loads((source / 'RELEASE.json').read_text(encoding='utf-8'))
    files = release.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError('Release manifest is empty or invalid')

    manifest_path = target / INSTALLED_MANIFEST
    reject_links(target, INSTALLED_MANIFEST)
    manifest_original = file_metadata(manifest_path)
    if mode == 'fresh':
        if manifest_original['existed']:
            raise ValueError('Runtime is already installed; choose upgrade mode')
        baseline = {}
    else:
        baseline = installed_baseline(source, target, files)

    originals = {}
    # Verify all input files, existing metadata and conflicts BEFORE writes.
    for name, digest in files.items():
        validate_name(name)
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('Invalid file digest: ' + name)
        reject_links(source, name)
        reject_links(target, name)
        data = (source / name).read_bytes()
        if sha(data) != digest:
            raise ValueError('Release checksum mismatch: ' + name)
        live = target / name
        original = file_metadata(live)
        if mode == 'fresh':
            if original['existed']:
                raise ValueError('Fresh installation refused to overwrite existing runtime file: ' + name)
        elif original['existed']:
            current = sha(live.read_bytes())
            if current not in (baseline.get(name), digest):
                raise ValueError('Production file changed since installation; reconcile before deploying: ' + name)
        elif name in baseline:
            raise ValueError('An installed runtime file is missing; inspect before upgrading: ' + name)
        originals[name] = original

    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    directory_modes = {}
    for name in ('src', 'web'):
        d = target / name
        if d.exists() and not d.is_dir():
            raise ValueError('Runtime directory is not a directory: ' + name)
        directory_modes[name] = {
            'existed': d.exists(),
            'mode': d.stat().st_mode & 0o777 if d.exists() else None,
        }
    for name, original in originals.items():
        if original['existed']:
            atomic(backup / name, (target / name).read_bytes(), 0o600)
    if manifest_original['existed']:
        atomic(backup / INSTALLED_MANIFEST, manifest_path.read_bytes(), 0o600)
    atomic(backup / 'rollback.json', json.dumps({
        'files': originals, 'directories': directory_modes,
        'installed_manifest': manifest_original,
        'mode': mode,
    }).encode(), 0o600)

    try:
        for name in files:
            atomic(target / name, (source / name).read_bytes(), 0o644)
        for d in ('src', 'web'):
            if (target / d).exists():
                os.chmod(target / d, 0o755)
        # Persist verified digests for the NEXT upgrade. Every upgrade saves a manifest;
        # legacy installations first pass a certified historical hash check.
        atomic(manifest_path, json.dumps({
            'schema': 1, 'version': release.get('version', 'unknown'),
            'files': files,
        }, indent=2).encode() + b'\n', 0o644)
    except BaseException:
        rollback(target, backup)
        raise


def restore_file(target, backup, name, original):
    reject_links(target, name)
    if original['existed']:
        atomic(target / name, (backup / name).read_bytes(), original['mode'])
        if os.geteuid() == 0:
            os.chown(target / name, original['uid'], original['gid'])
    else:
        (target / name).unlink(missing_ok=True)


def rollback(target, backup):
    journal = json.loads((backup / 'rollback.json').read_text(encoding='utf-8'))
    for name, original in journal['files'].items():
        validate_name(name)
        restore_file(target, backup, name, original)
    manifest_original = journal.get('installed_manifest', {'existed': False})
    restore_file(target, backup, INSTALLED_MANIFEST, manifest_original)
    for name, setting in journal['directories'].items():
        d = target / name
        if isinstance(setting, dict):
            if setting.get('existed') and d.exists():
                os.chmod(d, setting['mode'])
            elif not setting.get('existed') and d.exists():
                try:
                    d.rmdir()
                except OSError:
                    pass  # Don't remove unexpected data.
        elif d.exists():
            os.chmod(d, setting)


if __name__ == '__main__':
    try:
        if len(sys.argv) >= 5 and sys.argv[1] == 'apply' and len(sys.argv) <= 6:
            apply(*(Path(x).resolve() for x in sys.argv[2:5]),
                  mode=sys.argv[5] if len(sys.argv) == 6 else 'upgrade')
        elif len(sys.argv) == 4 and sys.argv[1] == 'rollback':
            rollback(*(Path(x).resolve() for x in sys.argv[2:4]))
        else:
            raise ValueError('Expected: apply SOURCE TARGET BACKUP [fresh|upgrade], or rollback TARGET BACKUP')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
