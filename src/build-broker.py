"""Narrow rootless image-build broker. Runs as a separate, unprivileged user.

One private Unix socket; fixed Podman flags; validated tar bytes only. No paths
to the caller's filesystem, Docker socket, privileged mode or host mounts.
"""
import json
import os
import re
from pathlib import Path, PurePosixPath
import select
import shutil
import signal
import socket
import struct
import subprocess
import tarfile
import tempfile
import time
import uuid

MAX_CONTEXT = 128 * 1024 * 1024
MAX_IMAGE = 512 * 1024 * 1024
PODMAN = ['/usr/bin/podman', '--storage-driver=vfs', '--cgroup-manager=cgroupfs']


def relative(value):
    if not isinstance(value, str) or not value or '\x00' in value or value.startswith('/') or '..' in value.split('/'):
        raise ValueError('Expected a relative context path without traversal')
    return str(PurePosixPath(value))


def extract_context(archive, destination):
    total = 0
    seen = set()
    with tarfile.open(archive, mode='r:') as tar:
        for item in tar:
            name = relative(item.name)
            if name in seen or len(seen) >= 10000 or not (item.isfile() or item.isdir()):
                raise ValueError('Context requires unique regular files/directories; links and devices are forbidden')
            seen.add(name)
            total += item.size
            if total > MAX_CONTEXT or item.size < 0:
                raise ValueError('Expanded context exceeds 128 MiB')
            target = destination / name
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tar.extractfile(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 65536)
                target.chmod(0o700 if item.mode & 0o111 else 0o600)


def disconnected(connection):
    if not select.select([connection], [], [], 0)[0]:
        return False
    return connection.recv(1, socket.MSG_PEEK) == b''


def run_command(argv, connection, deadline, log):
    with log.open('ab') as output:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        try:
            while process.poll() is None:
                if time.monotonic() >= deadline or disconnected(connection):
                    raise RuntimeError('Build deadline expired or client disconnected')
                if log.stat().st_size > 4 * 1024 * 1024:
                    raise RuntimeError('Build log exceeds 4 MiB')
                time.sleep(0.2)
            if process.returncode:
                raise RuntimeError(f'Builder command failed with exit code {process.returncode}')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def handle(connection):
    root = Path(os.environ['HOME'])
    image = 'localhost/mcp-build:' + uuid.uuid4().hex
    work = Path(tempfile.mkdtemp(prefix='request-', dir=root))
    log = work / 'build.log'
    response_started = False
    build_started = completed = False
    # Context/download operations are bounded independently from build time.
    connection.settimeout(30)
    try:
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != int(os.environ['BUILD_CLIENT_UID']):
            raise ValueError('Only the configured execution UID may build')
        with connection.makefile('rb', buffering=0) as request:
            header = request.readline(8193)
            if len(header) > 8192 or not header.endswith(b'\n'):
                raise ValueError('Invalid build header')
            spec = json.loads(header)
            if set(spec) != {'context_bytes', 'dockerfile', 'network', 'timeout_seconds'}:
                raise ValueError('Unexpected build options')
            size = spec['context_bytes']
            if type(size) is not int or not 0 < size <= MAX_CONTEXT:
                raise ValueError('Context archive must be at most 128 MiB')
            timeout = spec['timeout_seconds']
            if type(timeout) is not int or not 1 <= timeout <= 900:
                raise ValueError('Build deadline must be 1..900 seconds')
            dockerfile = relative(spec['dockerfile'])
            if spec['network'] not in ['none', 'private']:
                raise ValueError('Only none/private build networking is available')
            archive = work / 'context.tar'
            remaining = size
            with archive.open('xb') as output:
                while remaining:
                    chunk = request.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('Truncated context archive')
                    remaining -= len(chunk)
                    output.write(chunk)
            context = work / 'context'
            context.mkdir(mode=0o700)
            extract_context(archive, context)
            if not (context / dockerfile).is_file():
                raise ValueError('Dockerfile missing from context')
            log = work / 'build.log'
            deadline = time.monotonic() + timeout
            network = 'none' if spec['network'] == 'none' else 'slirp4netns:allow_host_loopback=false'
            build_started = True
            run_command(PODMAN + ['build', '--force-rm', '--isolation=oci', '--network=' + network, '--cap-drop=NET_RAW', '--cap-drop=MKNOD',
                '--security-opt=no-new-privileges', '--layers=false', '--format=docker', '--tag', image,
                '--file', str(context / dockerfile), str(context)], connection, deadline, log)
            output = work / 'image.tar'
            run_command(PODMAN + ['save', '--format=docker-archive', '--output', str(output), image], connection, deadline, log)
            if output.stat().st_size > MAX_IMAGE:
                raise ValueError('Image archive exceeds 512 MiB')
            result = {'ok': True, 'image_bytes': output.stat().st_size, 'image': image,
                      'rootless': True, 'network': spec['network'], 'log': log.read_bytes()[-16384:].decode(errors='replace')}
            connection.sendall(json.dumps(result).encode() + b'\n')
            response_started = True
            with output.open('rb') as source:
                while chunk := source.read(65536):
                    connection.sendall(chunk)
            completed = True
    except Exception as error:
        if not response_started:
            try:
                # Source/logs appear only in this user's tool result, never in gateway traces.
                result = {'ok': False, 'error': str(error), 'log': log.read_bytes()[-16384:].decode(errors='replace') if log and log.exists() else ''}
                connection.sendall(json.dumps(result).encode() + b'\n')
            except OSError:
                pass
    finally:
        # Only this request's image/container namespace is touched.
        try:
            if build_started:
                subprocess.run(PODMAN + ['rmi', '--force', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    # OCI runtimes can detach descendants or switch to subordinate UIDs. Only
    # systemd's control-group teardown guarantees that every RUN process stops.
    return build_started and not completed


def recover_storage():
    # This account/storage is dedicated to this serialized broker, never host
    # Docker or production workloads. Recover only stranded build containers.
    result = subprocess.run(PODMAN + ['ps', '--all', '--external', '--format', '{{.ID}}'], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Cannot inspect dedicated builder storage during recovery')
    ids = [value for value in result.stdout.splitlines() if re.fullmatch(r'[a-f0-9]{12,64}', value)]
    if ids:
        subprocess.run(PODMAN + ['rm', '--force', *ids], check=True, stdout=subprocess.DEVNULL, timeout=30)


if __name__ == '__main__':
    os.umask(0o077)
    runtime = Path(os.environ['XDG_RUNTIME_DIR'])
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    # systemd socket activation supplies the listening descriptor.
    listener = socket.socket(fileno=3)
    recover_storage()
    while True:
        connection, _ = listener.accept()
        with connection:
            if handle(connection):
                raise SystemExit(75)
