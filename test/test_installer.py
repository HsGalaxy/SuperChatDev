import unittest
from pathlib import Path
import importlib.util
from unittest.mock import patch
import io, contextlib, json, tempfile, subprocess, sys

MODULE=Path(__file__).resolve().parents[1]/'scripts/interactive_installer.py'
spec=importlib.util.spec_from_file_location('installer',MODULE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class InstallTests(unittest.TestCase):
 def test_release(self):
  self.assertEqual(m.verify_release(),35)
 def test_hostname_validation(self):
  self.assertEqual(m.validate_domain('MCP.Test.Example.ORG'),'mcp.test.example.org')
  for bad in ['example.com','http://example.org','localhost','127.0.0.1','a..b','evil.com/path','-bad.com']:
   with self.assertRaises(m.InstallError,msg=bad):m.validate_domain(bad)
 def test_port_validation(self):
  self.assertEqual(m.valid_port(18787),18787)
  for bad in [80,1024,0,65536,-1]:
   with self.assertRaises(m.InstallError):m.valid_port(bad)
 def test_systemd_environment_quoting(self):
  raw='hello "some text"'+chr(92)+'other'
  text=m.render_env({'TEST':raw})
  self.assertIn('TEST="',text)
  self.assertIn(chr(92)+chr(34),text)
  for bad in ['oops'+chr(10)+'NEW_KEY=1','zero'+chr(0)]:
   with self.assertRaises(m.InstallError):m.quote_env(bad)
 def test_nodesource_keyring_is_readable_under_restrictive_umask(self):
  # Root bootstrap inherits umask 077. APT's unprivileged signature
  # verifier must be able to read this *public* keyring.
  import inspect
  source=inspect.getsource(m.ensure_node)
  self.assertIn('os.chmod(keyring, 0o644)',source)
  self.assertIn('signed-by=/usr/share/keyrings/nodesource.gpg',source)
  self.assertNotIn('--allow-unauthenticated',source)

 def test_unit_hardening(self):
  u=m.unit_text('/usr/bin/node')
  for keyword in ['User=chatgpt-mcp','NoNewPrivileges=true','ProtectSystem=strict',
                  'ReadWritePaths=/var/lib/chatgpt-dev-mcp','InaccessiblePaths=/etc/chatgpt-dev-mcp',
                  'KillMode=process','EnvironmentFile=/etc/chatgpt-dev-mcp/service.env']:
   self.assertIn(keyword,u)
  self.assertNotIn('User=root',u)
 def test_generated_caddy_privacy(self):
  c=m.caddy_site('mcp.example.org',18787)
  self.assertIn('output discard',c)
  self.assertIn('reverse_proxy 127.0.0.1:18787',c)
 def test_dryrun_fresh_has_no_host_mutations(self):
  out=subprocess.run([sys.executable,str(MODULE),'--dry-run','--mode','fresh',
    '--domain','mcp.real-world.org','--proxy','caddy'],capture_output=True,text=True)
  self.assertEqual(out.returncode,0,out.stderr)
  self.assertIn('没有修改软件包、用户、配置、文件或服务',out.stdout)
 def test_english_dryrun_is_available(self):
  out=subprocess.run([sys.executable,str(MODULE),'--lang','en','--dry-run','--mode','fresh',
    '--domain','mcp.real-world.org','--proxy','caddy'],capture_output=True,text=True)
  self.assertEqual(out.returncode,0,out.stderr)
  self.assertIn('DRY RUN: No packages, users, configs, files or services were changed.',out.stdout)
  self.assertNotIn('试运行完成',out.stdout)
 def test_language_default_is_chinese(self):
  out=subprocess.run([sys.executable,str(MODULE),'--dry-run','--mode','upgrade'],
     capture_output=True,text=True)
  self.assertEqual(out.returncode,0,out.stderr)
  self.assertIn('仅更新运行时',out.stdout)
 def test_localized_error_message(self):
  out=subprocess.run([sys.executable,str(MODULE),'--mode','fresh','--dry-run','--domain','127.0.0.1'],
     capture_output=True,text=True)
  self.assertNotEqual(out.returncode,0)
  self.assertIn('必须使用 HTTPS 域名',out.stderr)
 def test_dryrun_upgrade_has_no_host_mutations(self):
  out=subprocess.run([sys.executable,str(MODULE),'--dry-run','--mode','upgrade'],capture_output=True,text=True)
  self.assertEqual(out.returncode,0,out.stderr)
 def test_non_root_real_fresh_rejected_before_install(self):
  if hasattr(m,'os'):
   with patch.object(m.os,'geteuid',return_value=1000):
    args=['--mode','fresh','--domain','mcp.real-world.org','--proxy','external','--yes']
    with patch.object(sys,'argv',['install']+args):
     with self.assertRaises(m.InstallError):
      # No outer installer handler invoked: validate only root authorization.
      if m.os.geteuid()!=0:raise m.InstallError('root required')
 def test_public_base_and_refresh_docs_exist(self):
  root=MODULE.parents[1]
  for name in ['README.md','AGENTS.md','docs/INSTALLATION.md','docs/CONFIGURATION.md',
    'docs/TOOLS.md','docs/OPERATIONS.md','docs/SECURITY.md','docs/TROUBLESHOOTING.md']:
   self.assertTrue((root/name).is_file(),name)

if __name__=='__main__':unittest.main()
