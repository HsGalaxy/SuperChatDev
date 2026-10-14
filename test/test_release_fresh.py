"""Real installer and checksum deployment regression tests; never modify the host.

The previous public installer failed on every fresh machine because its release
helper unconditionally loaded BASELINE.json, a private upgrade-only artifact.
All fixtures here explicitly omit BASELINE.json.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts' / 'deploy_files.py'
INSTALLER = ROOT / 'scripts' / 'interactive_installer.py'

spec = importlib.util.spec_from_file_location('release_helper', HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

imspec = importlib.util.spec_from_file_location('fresh_installer', INSTALLER)
installer = importlib.util.module_from_spec(imspec)
imspec.loader.exec_module(installer)


def fingerprint(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='superchatdev-release-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.target = self.root / 'target'
        self.source.mkdir()
        self.target.mkdir()
        self.release(1)

    def release(self, version):
        samples = {
            'src/server.mjs': 'server-version-' + str(version),
            'web/admin.js': 'admin-version-' + str(version),
            'README.md': 'readme-version-' + str(version),
        }
        for name, data in samples.items():
            p = self.source / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(data)
        (self.source / 'RELEASE.json').write_text(json.dumps({
            'version': str(version),
            'files': {name: fingerprint(data) for name, data in samples.items()}
        }))
        return samples

    def execute(self, operation, backup, mode=None):
        args = [sys.executable, str(HELPER), operation, str(self.source), str(self.target), str(backup)]
        if operation == 'rollback':
            args = [sys.executable, str(HELPER), 'rollback', str(self.target), str(backup)]
        elif mode is not None:
            args.append(mode)
        return subprocess.run(args, capture_output=True, text=True, timeout=15)

    def test_fresh_requires_no_private_baseline_and_persists_manifest(self):
        self.assertFalse((self.source / 'BASELINE.json').exists())
        backup = self.root / 'backup'
        result = self.execute('apply', backup, 'fresh')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.target / helper.INSTALLED_MANIFEST).read_text())
        self.assertEqual(data['version'], '1')
        self.assertEqual(data['files'], json.loads((self.source / 'RELEASE.json').read_text())['files'])
        self.assertEqual((self.target / 'src/server.mjs').read_text(), 'server-version-1')
        self.assertTrue((backup / 'rollback.json').is_file())

    def test_fresh_rollback_removes_new_files_not_unrelated(self):
        unrelated = self.target / 'owner-data.txt'
        unrelated.write_text('preserve')
        backup = self.root / 'backup'
        self.assertEqual(self.execute('apply', backup, 'fresh').returncode, 0)
        result = self.execute('rollback', backup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(unrelated.read_text(), 'preserve')
        self.assertFalse((self.target / helper.INSTALLED_MANIFEST).exists())
        self.assertFalse((self.target / 'src/server.mjs').exists())
        self.assertFalse((self.target / 'web/admin.js').exists())

    def test_fresh_refuses_preexisting_code_without_overwriting(self):
        p = self.target / 'src/server.mjs'
        p.parent.mkdir()
        p.write_text('important modification')
        result = self.execute('apply', self.root / 'backup', 'fresh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('refused to overwrite', result.stderr)
        self.assertEqual(p.read_text(), 'important modification')
        self.assertFalse((self.target / helper.INSTALLED_MANIFEST).exists())

    def test_upgrade_uses_installed_local_manifest_and_rolls_back(self):
        first = self.root / 'initial-backup'
        self.assertEqual(self.execute('apply', first, 'fresh').returncode, 0)
        self.release(2)
        second = self.root / 'upgrade-backup'
        result = self.execute('apply', second, 'upgrade')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.target / 'src/server.mjs').read_text(), 'server-version-2')
        self.assertEqual(json.loads((self.target / helper.INSTALLED_MANIFEST).read_text())['version'], '2')
        self.assertEqual(self.execute('rollback', second).returncode, 0)
        self.assertEqual((self.target / 'src/server.mjs').read_text(), 'server-version-1')
        self.assertEqual(json.loads((self.target / helper.INSTALLED_MANIFEST).read_text())['version'], '1')

    def test_upgrade_rejects_edited_production_without_changing_other_files(self):
        self.assertEqual(self.execute('apply', self.root / 'original-backup', 'fresh').returncode, 0)
        (self.target / 'src/server.mjs').write_text('hand-edited')
        self.release(2)
        result = self.execute('apply', self.root / 'next-backup', 'upgrade')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Production file changed', result.stderr)
        self.assertEqual((self.target / 'src/server.mjs').read_text(), 'hand-edited')
        self.assertEqual((self.target / 'web/admin.js').read_text(), 'admin-version-1')

    def test_upgrade_refuses_unmanaged_install_no_guessing(self):
        p = self.target / 'src/server.mjs'
        p.parent.mkdir()
        p.write_text('unmanaged')
        result = self.execute('apply', self.root / 'backup', 'upgrade')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('installed release manifest is missing', result.stderr)
        self.assertEqual(p.read_text(), 'unmanaged')

    def test_fresh_failure_midwrite_rolls_back_without_baseline(self):
        original = helper.atomic
        backup = self.root / 'backup'
        def fail_on_admin(path, content, mode):
            if Path(path) == self.target / 'web/admin.js':
                raise OSError('simulated disk write failure')
            return original(path, content, mode)
        with patch.object(helper, 'atomic', side_effect=fail_on_admin):
            with self.assertRaisesRegex(OSError, 'simulated disk write failure'):
                helper.apply(self.source, self.target, backup, mode='fresh')
        self.assertFalse((self.target / 'src/server.mjs').exists())
        self.assertFalse((self.target / helper.INSTALLED_MANIFEST).exists())


class FreshInstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='superchatdev-fresh-installer-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.target = root / 'installed-app'
        self.target.mkdir()
        self.backups = root / 'backups'
        self.backups.mkdir()
        self.envdir = root / 'private-config'
        self.envdir.mkdir()
        self.unitdir = root / 'systemd'
        self.unitdir.mkdir()
        self.state = root / 'state'
        self.state.mkdir()
        self.workspace = root / 'workspace'
        self.workspace.mkdir()
        self.cred = self.envdir
        # GitHub Actions/setup-node puts node under /opt/hostedtoolcache.
        # The production wizard requires a system Node path; the isolated
        # unit test must not depend on the CI runner's installation layout.
        original_which = installer.shutil.which
        self.patchers = [
            patch.object(installer.shutil, 'which',
                         lambda program: '/usr/bin/node' if program == 'node'
                         else original_which(program)),
            patch.object(installer, 'SOURCE', ROOT),
            patch.object(installer, 'APP', self.target),
            patch.object(installer, 'ETC', self.envdir),
            patch.object(installer, 'ENV_FILE', self.envdir / 'service.env'),
            patch.object(installer, 'UNIT', self.unitdir / 'superchatdev.service'),
            patch.object(installer, 'BACKUPS', self.backups),
            patch.object(installer, 'VAR', root / 'var'),
            patch.object(installer, 'port_available', lambda x: None),
            patch.object(installer, 'ensure_prerequisites', lambda x: None),
            patch.object(installer, 'backup_state', lambda b: None),
            patch.object(installer, 'create_users_and_paths', self.fake_users),
            patch.object(installer, 'make_backup', self.fake_backup),
            patch.object(installer, 'run', self.fake_run),
            patch.object(installer, 'start_service', self.fake_start_service),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)
        self.fail_start = False
        self.args = types.SimpleNamespace(domain='mcp.real-domain.org', port=18787,
                                          auto_node=False, with_dc=False, proxy='external')

    def fake_users(self):
        return types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()), None

    def fake_backup(self):
        self.index = getattr(self, 'index', 0) + 1
        p = self.backups / str(self.index)
        p.mkdir()
        return p

    def fake_run(self, *argv, env=None):
        if argv[0] == sys.executable:
            subprocess.run(argv, check=True, capture_output=True, text=True, timeout=20)
        elif argv[0] == 'systemctl':
            return
        else:
            raise AssertionError('Attempted forbidden privileged action in test: ' + repr(argv))

    def fake_start_service(self, port):
        if self.fail_start:
            raise installer.InstallError('simulated systemd health failure')
        self.assertTrue((self.target / 'src/server.mjs').is_file())
        self.assertTrue((self.target / helper.INSTALLED_MANIFEST).is_file())
        self.assertTrue((self.envdir / 'service.env').is_file())

    def test_end_to_end_fresh_install_no_baseline_no_root_or_systemd(self):
        self.assertFalse((ROOT / 'BASELINE.json').exists())
        installer.fresh(self.args)
        self.assertTrue((self.target / helper.INSTALLED_MANIFEST).exists())
        self.assertTrue((self.envdir / 'service.env').exists())
        self.assertTrue((self.cred / 'owner-password').exists())
        self.assertTrue((self.unitdir / 'superchatdev.service').exists())
        self.assertTrue((self.target / 'src/server.mjs').is_file())

    def test_failed_install_cleans_runtime_unit_env_and_credentials_then_retries(self):
        self.fail_start = True
        with self.assertRaisesRegex(installer.InstallError, 'simulated systemd'):
            installer.fresh(self.args)
        for f in [self.target / helper.INSTALLED_MANIFEST,
                  self.target / 'src/server.mjs',
                  self.envdir / 'service.env',
                  self.cred / 'owner-password',
                  self.cred / 'admin-password',
                  self.unitdir / 'superchatdev.service']:
            self.assertFalse(f.exists(), str(f))
        self.fail_start = False
        installer.fresh(self.args)
        self.assertTrue((self.target / 'src/server.mjs').is_file())


if __name__ == '__main__':
    unittest.main()
