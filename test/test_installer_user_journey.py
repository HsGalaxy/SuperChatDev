"""Practical onboarding tests: no redundant dependency prompts, real login handoff."""
from pathlib import Path
from unittest.mock import patch, Mock
import contextlib
import importlib.util
import io
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("scd_ux_installer",ROOT/"scripts"/"interactive_installer.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class TTY(io.StringIO):
    def isatty(self):
        return True

class UserJourneyTests(unittest.TestCase):
    def setUp(self):
        installer.set_language("zh")

    def test_cloudflare_choice_automatically_sets_required_dependencies(self):
        entry=Mock()
        entry.isatty.return_value=True
        result=[]
        with (patch.object(sys,"argv",["installer","--lang","zh","--mode","fresh","--access-method","cloudflare"]),
              patch.object(sys,"stdin",entry),
              patch.object(installer.os,"geteuid",return_value=0),
              patch.object(installer,"node_version",return_value=0),
              patch.object(installer,"verify_release",return_value=49),
              patch.object(installer,"fresh",side_effect=lambda args:result.append(args)),
              patch("builtins.input",side_effect=["n",""]) as question,
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(installer.main(),0)
        self.assertEqual(len(result),1)
        args=result[0]
        self.assertEqual(args.proxy,"cloudflare")
        self.assertTrue(args.auto_cloudflared)
        self.assertTrue(args.auto_node)
        self.assertFalse(args.with_dc)
        self.assertEqual(question.call_count,2)
        prompts=" ".join(str(call.args[0]) for call in question.call_args_list)
        self.assertNotIn("NodeSource",prompts)
        self.assertNotIn("cloudflared",prompts)
        self.assertIn("Desktop Commander",prompts)

    def test_non_cloudflare_choice_skips_cloudflared_and_auto_installs_node(self):
        input_stream=Mock()
        input_stream.isatty.return_value=False
        result=[]
        with (patch.object(sys,"argv",["installer","--lang","en","--mode","fresh",
                                       "--domain","vps.example.org","--proxy","external","--yes"]),
              patch.object(sys,"stdin",input_stream),
              patch.object(installer.os,"geteuid",return_value=0),
              patch.object(installer,"node_version",return_value=0),
              patch.object(installer,"verify_release",return_value=49),
              patch.object(installer,"fresh",side_effect=lambda args:result.append(args)),
              patch("builtins.input",side_effect=AssertionError("Unexpected question")),
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(installer.main(),0)
        self.assertFalse(result[0].auto_cloudflared)
        self.assertTrue(result[0].auto_node)

    def test_custom_domain_defaults_to_managed_caddy_without_extra_question(self):
        input_stream=Mock()
        input_stream.isatty.return_value=True
        captured=[]
        with (patch.object(sys,"argv",["installer","--lang","en","--mode","fresh",
                                       "--domain","vps.example.org"]),
              patch.object(sys,"stdin",input_stream),
              patch.object(installer.os,"geteuid",return_value=0),
              patch.object(installer,"verify_release",return_value=49),
              patch.object(installer,"fresh",side_effect=lambda args:captured.append(args)),
              patch("builtins.input",side_effect=["n",""]) as question,
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(installer.main(),0)
        self.assertEqual(captured[0].proxy,"caddy")
        self.assertFalse(captured[0].auto_cloudflared)
        self.assertEqual(question.call_count,2)
        prompts=" ".join(str(call.args[0]) for call in question.call_args_list)
        self.assertNotIn("HTTPS proxy",prompts)

    def test_explicit_install_cloudflared_does_not_reconfirm(self):
        input_stream=Mock()
        input_stream.isatty.return_value=True
        with (patch.object(sys,"argv",["installer","--lang","en","--install-cloudflared"]),
              patch.object(sys,"stdin",input_stream),
              patch.object(installer.os,"geteuid",return_value=0),
              patch.object(installer,"ensure_cloudflared") as install,
              patch("builtins.input",side_effect=AssertionError("Redundant confirmation")),
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(installer.main(),0)
        install.assert_called_once_with()

    def test_interactive_root_sees_generated_credentials_once(self):
        output=TTY()
        input_stream=Mock()
        input_stream.isatty.return_value=True
        with (patch.object(installer.os,"geteuid",return_value=0),
              patch.object(sys,"stdin",input_stream),
              contextlib.redirect_stdout(output)):
            installer.print_install_credentials("owner-secret-123","admin-secret-456")
        s=output.getvalue()
        self.assertIn("owner-secret-123",s)
        self.assertIn("admin-secret-456",s)
        self.assertIn("OAuth",s)
        self.assertIn("管理员",s)

    def test_unattended_and_redirected_modes_never_print_credentials(self):
        for stdin_tty,stdout_tty,uid in [(False,False,0),(True,False,0),(True,True,1000)]:
            with self.subTest(stdin=stdin_tty,stdout=stdout_tty,uid=uid):
                output=TTY() if stdout_tty else io.StringIO()
                stdin=Mock()
                stdin.isatty.return_value=stdin_tty
                with (patch.object(installer.os,"geteuid",return_value=uid),
                      patch.object(sys,"stdin",stdin),
                      contextlib.redirect_stdout(output)):
                    installer.print_install_credentials("owner-private","admin-private")
                text=output.getvalue()
                self.assertNotIn("owner-private",text)
                self.assertNotIn("admin-private",text)
                self.assertIn("owner-password",text)
                self.assertIn("admin-password",text)

    def test_fresh_cloudflare_provisions_binary_and_outputs_real_quick_url(self):
        with tempfile.TemporaryDirectory() as home:
            root=Path(home)
            envdir=root/"etc"
            envdir.mkdir()
            state=root/"state"/"cloudflare-tunnel"
            state.mkdir(parents=True)
            backup=root/"backup"
            backup.mkdir()
            unit=root/"systemd.service"
            calls=[]
            runner=types.SimpleNamespace(pw_uid=1234,pw_gid=2345)
            args=types.SimpleNamespace(
                domain="pending.trycloudflare.com",port=18787,proxy="cloudflare",
                auto_node=True,auto_cloudflared=False,with_dc=False,cloudflare_mode="quick")
            def start(_):
                (state/"quick-url").write_text("https://test-working-address.trycloudflare.com\n")
            with (patch.object(installer,"ETC",envdir),
                  patch.object(installer,"ENV_FILE",envdir/"service.env"),
                  patch.object(installer,"UNIT",unit),
                  patch.object(installer,"VAR",root),
                  patch.object(installer,"port_available",return_value=None),
                  patch.object(installer,"ensure_prerequisites",side_effect=lambda enabled:calls.append(("node",enabled))),
                  patch.object(installer,"ensure_cloudflared",side_effect=lambda:calls.append(("cloudflared",))),
                  patch.object(installer,"create_users_and_paths",return_value=(runner,None)),
                  patch.object(installer,"make_backup",return_value=backup),
                  patch.object(installer,"backup_state",return_value=None),
                  patch.object(installer,"install_release",return_value=None),
                  patch.object(installer,"create_credentials",return_value=("one","two")),
                  patch.object(installer,"start_service",side_effect=start),
                  patch.object(installer.shutil,"which",return_value="/usr/bin/node"),
                  patch.object(installer,"print_install_credentials",return_value=None),
                  contextlib.redirect_stdout(io.StringIO()) as out):
                installer.fresh(args)
            self.assertIn(("node",True),calls)
            self.assertIn(("cloudflared",),calls)
            self.assertIn("https://test-working-address.trycloudflare.com/mcp",out.getvalue())
            self.assertNotIn("pending.trycloudflare.com/mcp",out.getvalue())

    def test_fresh_other_proxies_never_install_cloudflared(self):
        with tempfile.TemporaryDirectory() as home:
            root=Path(home)
            envdir=root/"etc"
            envdir.mkdir()
            backup=root/"backup"
            backup.mkdir()
            args=types.SimpleNamespace(domain="vps.example.org",port=18787,proxy="external",
                    auto_node=True,auto_cloudflared=True,with_dc=False,cloudflare_mode="quick")
            runner=types.SimpleNamespace(pw_uid=1234,pw_gid=2345)
            with (patch.object(installer,"ETC",envdir),patch.object(installer,"ENV_FILE",envdir/"service.env"),
                  patch.object(installer,"UNIT",root/"unit"),patch.object(installer,"VAR",root),
                  patch.object(installer,"port_available",return_value=None),
                  patch.object(installer,"ensure_prerequisites",return_value=None),
                  patch.object(installer,"ensure_cloudflared",side_effect=AssertionError("Cloudflare should not install")),
                  patch.object(installer,"create_users_and_paths",return_value=(runner,None)),
                  patch.object(installer,"make_backup",return_value=backup),
                  patch.object(installer,"backup_state",return_value=None),
                  patch.object(installer,"install_release",return_value=None),
                  patch.object(installer,"create_credentials",return_value=("one","two")),
                  patch.object(installer,"start_service",return_value=None),
                  patch.object(installer.shutil,"which",return_value="/usr/bin/node"),
                  patch.object(installer,"print_install_credentials",return_value=None),
                  contextlib.redirect_stdout(io.StringIO())):
                installer.fresh(args)

if __name__=="__main__":
    unittest.main()
