import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import importlib.util
import sys
import socket

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('scd_res_installer',ROOT/'scripts/interactive_installer.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ResourcesInstallerTests(unittest.TestCase):
 def test_fresh_unit_has_1024_threads_and_4g_memory_default(self):
  unit=m.unit_text('/usr/bin/node')
  self.assertIn('TasksMax=1024',unit)
  self.assertIn('MemoryMax=4G',unit)
  self.assertIn('KillMode=process',unit)
  self.assertNotIn('job-runner.sock',unit)
  isolated=m.unit_text('/usr/bin/node',isolated=True)
  self.assertIn('TasksMax=512',isolated)
  self.assertIn('MemoryMax=2G',isolated)
  self.assertIn('TasksMax=768',m.runner_unit_text('/usr/bin/node'))
  self.assertIn('MemoryMax=4G',m.runner_unit_text('/usr/bin/node'))
  self.assertNotIn('MCP_ADMIN_PASSWORD',m.runner_unit_text('/usr/bin/node'))
 def test_managed_dropin_snapshot_and_exact_rollback_without_systemd_mutation(self):
  with tempfile.TemporaryDirectory() as tmp:
   base=Path(tmp);backup=base/'backup';backup.mkdir()
   unit=base/'service';unit.write_text('original unit\n')
   env=base/'service.env';env.write_text('SOME_SECRET="not printed"\n')
   dropin=base/'dropin'
   runner_unit=base/'runner.service';runner_env=base/'runner.env'
   with patch.multiple(m,UNIT=unit,ENV_FILE=env,RESOURCE_DROPIN=dropin,
       RUNNER_UNIT=runner_unit,RUNNER_ENV=runner_env),patch.object(m,'run') as run:
    m.snapshot_service_changes(backup)
    m.apply_resource_changes()
    self.assertIn('TasksMax=1024',dropin.read_text())
    m.apply_resource_changes(isolated=True)
    self.assertIn('TasksMax=512',dropin.read_text())
    self.assertEqual(env.read_text(),'SOME_SECRET="not printed"\n')
    m.restore_service_changes(backup)
    self.assertEqual(env.read_text(),'SOME_SECRET="not printed"\n')
    self.assertEqual(unit.read_text(),'original unit\n')
    self.assertFalse(dropin.exists())
    run.assert_called_with('systemctl','daemon-reload')
 def test_user_resource_dropin_is_never_overwritten(self):
  with tempfile.TemporaryDirectory() as tmp:
   target=Path(tmp)/'custom.conf';target.write_text('[Service]\nTasksMax=30\n')
   with patch.object(m,'RESOURCE_DROPIN',target):
    with self.assertRaises(m.InstallError):m.apply_resource_changes()
    self.assertEqual(target.read_text(),'[Service]\nTasksMax=30\n')
 def test_optin_runner_config_uses_private_env_and_no_oauth_credentials(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);conf=root/'etc';conf.mkdir()
   state=root/'var'/'state';state.mkdir(parents=True)
   unit=root/'runner.service';runner_env=conf/'runner.env'
   service_env=conf/'service.env'
   service_env.write_text(m.render_env({
    'EXECUTION_UID':'1001','EXECUTION_GID':'1002','EXECUTION_HOME':str(root/'runtime'),
    'EXECUTION_ENV':'{"PATH":"/usr/bin:/bin","HOME":"/test"}',
    'MCP_OWNER_PASSWORD':'private-secret-owner',
    'MCP_ADMIN_PASSWORD':'private-secret-admin'
   }))
   sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
   sock.bind(str(state/'job-runner.sock'))
   try:
    with patch.multiple(m,ETC=conf,VAR=root/'var',ENV_FILE=service_env,
         RUNNER_UNIT=unit,RUNNER_ENV=runner_env,RUNNER_SOCKET=state/'job-runner.sock'),\
         patch.object(m,'run') as mock_run:
     m.install_runner_service('/usr/bin/node')
     self.assertTrue(unit.exists())
     self.assertTrue(runner_env.exists())
     self.assertIn('JOB_RUNNER_EXEC_UID=',runner_env.read_text())
     self.assertNotIn('private-secret-owner',runner_env.read_text())
     self.assertNotIn('private-secret-admin',runner_env.read_text())
     self.assertIn('JOB_RUNNER_SOCKET=',service_env.read_text())
     self.assertEqual(service_env.stat().st_mode&0o777,0o600)
     mock_run.assert_any_call('systemctl','enable','--now',m.RUNNER_SERVICE)
   finally:sock.close()
 def test_installer_cli_requires_explicit_switch_for_resource_migration(self):
  import subprocess
  proc=subprocess.run([sys.executable,str(ROOT/'scripts/interactive_installer.py'),
   '--lang','en','--mode','upgrade','--dry-run','--apply-resource-limits',
   '--enable-isolated-runner'],capture_output=True,text=True,timeout=12)
  self.assertEqual(proc.returncode,0,proc.stderr)
  self.assertIn('TasksMax=1024',proc.stdout)
  self.assertIn('Isolated',proc.stdout) if 'Isolated' in proc.stdout else self.assertIn('Runner',proc.stdout)

if __name__=='__main__':unittest.main()
