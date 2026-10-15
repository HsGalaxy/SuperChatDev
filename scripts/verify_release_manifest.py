#!/usr/bin/env python3
"""Validate the exact files installed by the SuperChatDev release manifest.

Default is strictly read-only, for CI and before preparing releases.
Use --update when changing a manifest-listed file (including README.md).
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath


REPO_ROOT = Path(__file__).resolve().parents[1]
ALLOWED_ROOT_FILES = {"README.md", "CHANGELOG.md", "package.json"}


def check_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError(f"Unsafe manifest path: {name!r}")
    parts = PurePosixPath(name).parts
    if (
        PurePosixPath(name).is_absolute()
        or "." in parts
        or ".." in parts
        or not (name.startswith(("src/", "web/")) or name in ALLOWED_ROOT_FILES)
    ):
        raise ValueError(f"Unsafe manifest path: {name!r}")
    target = root.joinpath(*parts)
    if any(root.joinpath(*parts[:index]).is_symlink() for index in range(1, len(parts) + 1)):
        raise ValueError(f"Symlink in manifest path: {name}")
    if not target.is_file():
        raise ValueError(f"Manifest file missing or not regular: {name}")
    return target


def read_manifest(manifest_path: Path) -> dict:
    release = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(release, dict) or not isinstance(release.get("files"), dict) or not release["files"]:
        raise ValueError("Invalid or empty RELEASE.json file map")
    for name, digest in release["files"].items():
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError(f"Invalid SHA-256 digest in RELEASE.json for {name!r}")
    return release


def current_hashes(root: Path, release: dict) -> dict[str, str]:
    return {
        name: hashlib.sha256(check_path(root, name).read_bytes()).hexdigest()
        for name in release["files"]
    }


def mismatches(root: Path, release: dict) -> list[str]:
    actual = current_hashes(root, release)
    return [name for name, recorded in release["files"].items() if recorded != actual[name]]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true",
                        help="Recompute listed file hashes after intentional source changes")
    args = parser.parse_args()
    manifest_path = REPO_ROOT / "RELEASE.json"
    try:
        release = read_manifest(manifest_path)
        actual = current_hashes(REPO_ROOT, release)
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        if package.get("version") != release.get("version"):
            raise ValueError("RELEASE.json version differs from package.json")
        stale = [name for name, recorded in release["files"].items() if actual[name] != recorded]
        if args.update:
            release["files"] = {name: actual[name] for name in release["files"]}
            manifest_path.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"Updated RELEASE.json: {len(actual)} SHA-256 hashes"
                  + (f" ({', '.join(stale)})" if stale else " (no changes)"))
        elif stale:
            print(f"ERROR: {len(stale)} stale release checksums: {', '.join(stale)}", file=sys.stderr)
            print("Fix after reviewing the changed files: python3 scripts/verify_release_manifest.py --update",
                  file=sys.stderr)
            return 1
        else:
            print(f"Release verified: v{release['version']}, {len(actual)} SHA-256 hashes")
        return 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"Invalid release: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
