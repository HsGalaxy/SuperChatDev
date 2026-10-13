"""Extract an untrusted ZIP into a NEW private directory, with bounded expansion."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile

archive, target, max_bytes = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3])
try:
    target.mkdir(mode=0o770)
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > 10000:
            raise ValueError("ZIP contains too many entries")
        seen = set()
        planned = []
        declared_bytes = 0
        for entry in entries:
            name = entry.filename
            parts = PurePosixPath(name).parts
            mode = entry.external_attr >> 16
            if (not parts or name.startswith("/") or "\\" in name or "\x00" in name
                    or any(p in (".", "..") or ":" in p for p in name.rstrip("/").split("/"))
                    or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise ValueError("ZIP contains an unsafe path or non-regular entry")
            normalized = "/".join(parts)
            if normalized in seen:
                raise ValueError("ZIP contains duplicate paths")
            seen.add(normalized)
            if entry.flag_bits & 1:
                raise ValueError("Encrypted ZIPs are not supported")
            declared_bytes += entry.file_size
            if declared_bytes > max_bytes or entry.file_size > max(1024 * 1024, entry.compress_size * 200):
                raise ValueError("ZIP expansion exceeds limits")
            planned.append((entry, target.joinpath(*parts)))
        actual_bytes = 0
        files = 0
        for entry, destination in planned:
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o770)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
            with package.open(entry) as source, destination.open("xb") as output:
                os.chmod(destination, 0o660)
                while chunk := source.read(65536):
                    actual_bytes += len(chunk)
                    if actual_bytes > max_bytes:
                        raise ValueError("ZIP expansion exceeds limits")
                    output.write(chunk)
            files += 1
    print(json.dumps({"files": files, "bytes": actual_bytes}))
except Exception as error:
    shutil.rmtree(target, ignore_errors=True)
    print(json.dumps({"error": str(error)}))
    sys.exit(1)
