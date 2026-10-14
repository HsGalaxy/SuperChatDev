"""Safe upgrade from the certified, pre-manifest 0.3.0 release.

Tests use small synthetic fixtures, not privileged production files.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "scripts" / "deploy_files.py"

def digest(value: str):
    return hashlib.sha256(value.encode()).hexdigest()

class LegacyUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="superchatdev-legacy-test-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.source = root / "source"
        self.target = root / "production"
        self.source.mkdir()
        self.target.mkdir()
        self.backup = root / "backup"
        self.old = {
            "src/server.mjs": "old server\n",
            "web/admin.js": "old admin\n",
            "README.md": "old readme\n",
        }
        new = {
            "src/server.mjs": "new server\n",
            "web/admin.js": "new admin\n",
            "README.md": "new readme\n",
        }
        for name, content in self.old.items():
            p = self.target / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        for name, content in new.items():
            p = self.source / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        self.public = self.source / "legacy-baselines" / "v0.3.0.json"
        self.public.parent.mkdir()
        self.public.write_text(json.dumps({
            "version": "0.3.0",
            "files": {name: digest(content) for name, content in self.old.items()}
        }))
        (self.source / "RELEASE.json").write_text(json.dumps({
            "version": "0.3.2",
            "files": {name: digest(content) for name, content in new.items()}
        }))

    def execute(self, mode, backup=None):
        backup = backup or self.backup
        return subprocess.run([
            sys.executable, str(DEPLOY), "apply",
            str(self.source), str(self.target), str(backup), mode
        ], capture_output=True, text=True, timeout=20)

    def test_certified_legacy_release_upgrades_and_creates_future_manifest(self):
        self.assertFalse((self.target / ".superchatdev-release.json").exists())
        (self.target / "custom-project.txt").write_text("user data")
        done = self.execute("upgrade")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.target / "src/server.mjs").read_text(), "new server\n")
        self.assertEqual((self.target / "custom-project.txt").read_text(), "user data")
        installed = json.loads((self.target / ".superchatdev-release.json").read_text())
        self.assertEqual(installed["version"], "0.3.2")
        self.assertEqual(len(installed["files"]), 3)
        undo = subprocess.run([
            sys.executable, str(DEPLOY), "rollback",
            str(self.target), str(self.backup)
        ], capture_output=True, text=True, timeout=20)
        self.assertEqual(undo.returncode, 0, undo.stderr)
        self.assertEqual((self.target / "src/server.mjs").read_text(), "old server\n")
        self.assertEqual((self.target / "web/admin.js").read_text(), "old admin\n")
        self.assertEqual((self.target / "custom-project.txt").read_text(), "user data")
        self.assertFalse((self.target / ".superchatdev-release.json").exists())

    def test_modified_production_refuses_before_any_write(self):
        (self.target / "web/admin.js").write_text("my patch")
        done = self.execute("upgrade")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("differs from the certified baseline", done.stderr)
        self.assertIn("web/admin.js", done.stderr)
        self.assertEqual((self.target / "src/server.mjs").read_text(), "old server\n")
        self.assertEqual((self.target / "web/admin.js").read_text(), "my patch")
        self.assertFalse(self.backup.exists())

    def test_missing_production_file_refuses_and_preserves_others(self):
        (self.target / "README.md").unlink()
        done = self.execute("upgrade")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("README.md", done.stderr)
        self.assertFalse(self.backup.exists())

    def test_unrecognized_legacy_install_refuses_without_guessing(self):
        self.public.unlink()
        done = self.execute("upgrade")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("certified legacy baseline", done.stderr)
        self.assertEqual((self.target / "src/server.mjs").read_text(), "old server\n")

    def test_legacy_snapshot_must_cover_every_runtime_file(self):
        item = json.loads(self.public.read_text())
        item["files"].pop("README.md")
        self.public.write_text(json.dumps(item))
        done = self.execute("upgrade")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("certified legacy baseline", done.stderr)



class WizardUpgradeTests(LegacyUpgradeTests):
    """Exercise the installer-level upgrade/health/rollback orchestration."""

    def setUp(self):
        super().setUp()
        import importlib.util
        from unittest.mock import patch
        script = ROOT / "scripts" / "interactive_installer.py"
        spec = importlib.util.spec_from_file_location("legacy_installer_wizard", script)
        self.wizard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.wizard)
        self.env = self.source.parent / "etc" / "service.env"
        self.env.parent.mkdir(parents=True, exist_ok=True)
        self.env.write_text('PORT="18787"\nPUBLIC_BASE_URL="https://example.org"\n')
        self.unit = self.source.parent / "systemd" / "chatgpt-dev-mcp.service"
        self.unit.parent.mkdir()
        self.unit.write_text("protected unit")
        self.restarts = []
        self.health_fail = False
        self.monkey = [
            patch.object(self.wizard, "SOURCE", self.source),
            patch.object(self.wizard, "APP", self.target),
            patch.object(self.wizard, "ENV_FILE", self.env),
            patch.object(self.wizard, "UNIT", self.unit),
            patch.object(self.wizard, "node_version", return_value=22),
            patch.object(self.wizard, "make_backup", side_effect=self.make_backup),
            patch.object(self.wizard, "backup_state", return_value=None),
            patch.object(self.wizard, "run", side_effect=self.fake_run),
            patch.object(self.wizard, "check_backend", side_effect=self.fake_health)
        ]
        for manager in self.monkey:
            manager.start()
            self.addCleanup(manager.stop)
        # The wizard dispatches the migration helper from its source tree.
        # Our tiny source release must include that executable too.
        dest = self.source / "scripts" / "deploy_files.py"
        dest.parent.mkdir()
        dest.write_bytes(DEPLOY.read_bytes())

    def make_backup(self):
        self.backup.mkdir(exist_ok=False)
        return self.backup

    def fake_run(self, *argv):
        if argv[:2] == ("systemctl", "restart"):
            self.restarts.append(argv)
            return
        if argv[0] == sys.executable:
            completed = subprocess.run(argv, capture_output=True, text=True, timeout=20)
            if completed.returncode:
                raise self.wizard.InstallError(completed.stderr)
            return
        raise AssertionError("Unexpected root command in mock: " + repr(argv))

    def fake_health(self, port):
        self.assertEqual(port,18787)
        if self.health_fail:
            raise self.wizard.InstallError("simulated health check failure")

    def test_upgrade_keeps_service_and_environment(self):
        old_unit = self.unit.read_bytes()
        old_env = self.env.read_bytes()
        self.wizard.upgrade()
        self.assertEqual((self.target / "src/server.mjs").read_text(),"new server\n")
        self.assertEqual(self.unit.read_bytes(),old_unit)
        self.assertEqual(self.env.read_bytes(),old_env)
        self.assertEqual(len(self.restarts),1)

    def test_health_failure_rolls_back_and_restarts_old_release(self):
        self.health_fail=True
        with self.assertRaisesRegex(self.wizard.InstallError,"health check"):
            self.wizard.upgrade()
        self.assertEqual((self.target / "src/server.mjs").read_text(),"old server\n")
        self.assertFalse((self.target / ".superchatdev-release.json").exists())
        self.assertEqual(len(self.restarts),2)
if __name__ == "__main__":
    unittest.main()
