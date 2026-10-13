"""Unprivileged build client: package context, receive archive in workspace."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tarfile
import tempfile
import uuid

MAX_CONTEXT = 128 * 1024 * 1024
SKIP_DIRS = {'.git', 'node_modules', 'target', '__pycache__', '.rust-cargo', '.rust-home'}
SKIP_FILES = {'.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'owner-password', 'service.env'}


def scoped(root, relative, existing=True):
    target = root / relative
    if not target.resolve().is_relative_to(root):
        raise ValueError('Build path escapes workspace')
    current = root
    for part in target.relative_to(root).parts:
        current /= part
        if current.is_symlink():
            raise ValueError('Build paths cannot traverse symlinks')
    if existing and not target.exists():
        raise ValueError('Build path does not exist')
    return target


def build(payload):
    root = Path(payload['workspace']).resolve()
    step = payload['step']
    project = scoped(root, payload['cwd'])
    context = scoped(root, str(Path(payload['cwd']) / step['context']))
    if not context.is_dir():
        raise ValueError('Build context must be a directory')
    output = scoped(root, str(Path(payload['cwd']) / step['output']), existing=False)
    if output.exists():
        raise ValueError('Build output already exists; select a new output path')
    count = total = 0
    with tempfile.TemporaryDirectory(prefix='mcp-context-') as temporary:
        archive = Path(temporary) / 'context.tar'
        with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
            for directory, dirs, files in os.walk(context, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
                for name in dirs + sorted(files):
                    file = Path(directory) / name
                    if file.is_symlink():
                        raise ValueError('Build context symlinks are unsupported')
                    if file == output or file == archive or name in SKIP_FILES or name.startswith('.env.'):
                        continue
                    if not file.is_dir() and not file.is_file():
                        raise ValueError('Build context contains a special file')
                    count += 1
                    total += file.stat().st_size if file.is_file() else 0
                    if count > 10000 or total > MAX_CONTEXT:
                        raise ValueError('Build context exceeds 10000 entries or 128 MiB')
                    tar.add(file, arcname=str(file.relative_to(context)), recursive=False)
        size = archive.stat().st_size
        if size > MAX_CONTEXT:
            raise ValueError('Build archive exceeds 128 MiB')
        header = {'context_bytes': size, 'dockerfile': step['dockerfile'], 'network': step['network'], 'timeout_seconds': step['timeout_seconds']}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(step['timeout_seconds'] + 60)
            connection.connect(payload['build_socket'])
            connection.sendall(json.dumps(header).encode() + b'\n')
            with archive.open('rb') as source:
                while chunk := source.read(65536):
                    connection.sendall(chunk)
            with connection.makefile('rb') as response:
                raw = response.readline(512 * 1024)
                result = json.loads(raw)
                if not result.get('ok'):
                    return result
                remaining = result['image_bytes']
                if type(remaining) is not int or not 0 < remaining <= 512 * 1024 * 1024:
                    raise ValueError('Invalid image length')
                output.parent.mkdir(parents=True, exist_ok=True)
                scoped(root, str(output.relative_to(root)), existing=False)
                temporary_output = output.parent / ('.image-' + uuid.uuid4().hex + '.tmp')
                digest = hashlib.sha256()
                try:
                    with temporary_output.open('xb') as destination:
                        while remaining:
                            chunk = response.read(min(65536, remaining))
                            if not chunk:
                                raise ValueError('Truncated image archive')
                            destination.write(chunk)
                            digest.update(chunk)
                            remaining -= len(chunk)
                    # Hard-link publication refuses to overwrite concurrent work.
                    os.link(temporary_output, output)
                finally:
                    temporary_output.unlink(missing_ok=True)
                return {**result, 'path': str(output.relative_to(root)), 'sha256': digest.hexdigest(),
                        'next_step': 'Image archive is in the workspace. file_export provides a download link. This build did not deploy or start a production container.'}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('Build request too large')
        result = build(json.loads(raw))
    except Exception as error:
        result = {'ok': False, 'error': str(error)}
    print(json.dumps(result))
    sys.exit(0 if result.get('ok') else 1)
