"""Release manifest checks must catch README edits before a release is published."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from verify_release_manifest import REPO_ROOT, read_manifest, mismatches, current_hashes


class ManifestIntegrityTests(unittest.TestCase):
    def test_real_release_manifest_is_current(self):
        release = read_manifest(ROOT / "RELEASE.json")
        self.assertEqual(release["version"], "0.3.12")
        self.assertGreaterEqual(len(release["files"]), 49)
        self.assertEqual(mismatches(ROOT, release), [])

    def test_readme_edit_is_detected_without_disabling_checks(self):
        with tempfile.TemporaryDirectory() as dirname:
            directory = Path(dirname)
            readme = directory / "README.md"
            readme.write_bytes(b"original\n")
            manifest = {
                "version": "test",
                "files": {"README.md": hashlib.sha256(readme.read_bytes()).hexdigest()},
            }
            (directory / "RELEASE.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(mismatches(directory, manifest), [])
            readme.write_bytes(b"new README text\n")
            self.assertEqual(mismatches(directory, manifest), ["README.md"])
            manifest["files"] = current_hashes(directory, manifest)
            self.assertEqual(mismatches(directory, manifest), [])

    def test_manifest_rejects_path_traversal_and_symlink(self):
        with tempfile.TemporaryDirectory() as dirname:
            directory = Path(dirname)
            outside = directory.parent / "not-in-project.txt"
            invalid = {"version": "test", "files": {"../not-in-project.txt": "a" * 64}}
            with self.assertRaises(ValueError):
                current_hashes(directory, invalid)
            (directory / "README.md").symlink_to(outside)
            invalid["files"] = {"README.md": "a" * 64}
            with self.assertRaises(ValueError):
                current_hashes(directory, invalid)

    def test_manifest_bad_digest_is_rejected(self):
        with tempfile.TemporaryDirectory() as dirname:
            target = Path(dirname) / "RELEASE.json"
            target.write_text('{"version":"test","files":{"README.md":"0"}}', encoding="utf-8")
            with self.assertRaises(ValueError):
                read_manifest(target)


if __name__ == "__main__":
    unittest.main()
