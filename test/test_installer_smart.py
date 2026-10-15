"""Smart domain onboarding regression tests (offline; no system changes)."""
import contextlib
import importlib.util
import io
import ipaddress
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/interactive_installer.py'
spec = importlib.util.spec_from_file_location("superchatdev_installer_smart", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeHttpResponse:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, amount):
        return self.payload[:amount]


class SmartInstallerTests(unittest.TestCase):
    def setUp(self):
        m.set_language('zh')

    def test_public_ipv4_parsing_rejects_internal_and_invalid_addresses(self):
        self.assertEqual(m.parse_public_ipv4(' 8.8.4.4\n'), '8.8.4.4')
        for invalid in [
            "127.0.0.1", "10.0.0.1", "172.16.0.3", "192.168.1.8",
            "169.254.10.2", "100.64.12.3", "0.0.0.0", "224.0.0.1",
            "2001:4860:4860::8888", "not-ip", "8.8.8.8,10.0.0.2", "",
        ]:
            with self.subTest(invalid=invalid):
                self.assertIsNone(m.parse_public_ipv4(invalid))

    def test_external_ip_lookup_is_bounded_https_direct_and_falls_back(self):
        opener = Mock()
        opener.open.side_effect = [
            OSError('first endpoint unavailable'),
            FakeHttpResponse(b'10.1.2.3\n'),
            FakeHttpResponse(b'1.2.3.4\n'),
        ]
        with patch.object(m.urllib.request, 'build_opener', return_value=opener) as factory:
            result = m.detect_public_ipv4()
        self.assertEqual(result, "1.2.3.4")
        self.assertEqual(opener.open.call_count, 3)
        for call in opener.open.call_args_list:
            request = call.args[0]
            self.assertTrue(request.full_url.startswith('https://'))
            self.assertLessEqual(call.kwargs['timeout'], 3)
        handler = factory.call_args.args[0]
        self.assertIsInstance(handler, m.urllib.request.ProxyHandler)
        self.assertEqual(handler.proxies, {})

    def test_ip_lookup_does_not_trust_oversized_or_invalid_response(self):
        opener = Mock()
        opener.open.side_effect = [
            FakeHttpResponse(b'3.2.1.4' + b'x' * 200),
            FakeHttpResponse(b'192.168.5.2'),
            FakeHttpResponse(b'<html>not a valid IP</html>'),
        ]
        with patch.object(m.urllib.request, 'build_opener', return_value=opener):
            self.assertIsNone(m.detect_public_ipv4())
        self.assertEqual(opener.open.call_count, len(m.PUBLIC_IPV4_ENDPOINTS))

    def test_suggestion_is_option_two_and_default_enter_selects_it(self):
        out = io.StringIO()
        with (patch.object(m, 'detect_public_ipv4', return_value='1.2.3.4'),
              patch('builtins.input', return_value='') as ask,
              contextlib.redirect_stdout(out)):
            domain = m.choose_install_domain()
        self.assertEqual(domain, '1.2.3.4.sslip.io')
        display = out.getvalue()
        self.assertIn('1. 手动输入域名', display)
        self.assertIn('2. 自动推荐：1.2.3.4.sslip.io', display)
        self.assertIn('NAT', display)
        self.assertIn('已选择 MCP 域名', display)
        self.assertEqual(ask.call_count, 1)
        self.assertIn('[2]', ask.call_args.args[0])

    def test_user_can_choose_manual_domain_and_correct_invalid_input(self):
        out = io.StringIO()
        with (patch.object(m, 'detect_public_ipv4', return_value='1.2.3.4'),
              patch('builtins.input', side_effect=['1', 'not a domain', 'MCP.My-Domain.ORG']),
              contextlib.redirect_stdout(out)):
            domain = m.choose_install_domain()
        self.assertEqual(domain, 'mcp.my-domain.org')
        self.assertIn('域名无效，请重新输入', out.getvalue())

    def test_fallback_when_ip_lookup_is_unavailable(self):
        out = io.StringIO()
        with (patch.object(m, 'detect_public_ipv4', return_value=None),
              patch('builtins.input', side_effect=['', 'custom-domain.org']) as ask,
              contextlib.redirect_stdout(out)):
            domain = m.choose_install_domain()
        self.assertEqual(domain, 'custom-domain.org')
        self.assertIn('无法自动获取公网 IPv4', out.getvalue())
        self.assertNotIn('2. 自动推荐', out.getvalue())
        self.assertEqual(ask.call_count, 2)
        self.assertIn('[1]', ask.call_args_list[0].args[0])

    def test_english_option_labels(self):
        m.set_language('en')
        out = io.StringIO()
        with (patch.object(m, 'detect_public_ipv4', return_value='1.2.3.4'),
              patch('builtins.input', return_value=''),
              contextlib.redirect_stdout(out)):
            domain = m.choose_install_domain()
        self.assertEqual(domain, '1.2.3.4.sslip.io')
        self.assertIn('1. Enter my own domain', out.getvalue())
        self.assertIn('2. Use suggested sslip.io domain', out.getvalue())

    def test_final_default_confirmation_is_yes_but_n_cancels(self):
        with patch('builtins.input', return_value='') as ask:
            self.assertTrue(m.confirm(m.tr('Proceed with privileged changes?'), True))
        self.assertIn('[Y/n]', ask.call_args.args[0])
        with patch('builtins.input', return_value='n'):
            self.assertFalse(m.confirm(m.tr('Proceed with privileged changes?'), True))

    def test_end_to_end_interactive_selection_uses_third_ranked_sslip_option(self):
        out = io.StringIO()
        captured = []
        stdin = Mock()
        stdin.isatty.return_value = True
        with (patch.object(sys, 'argv', ['install', '--lang', 'zh', '--mode', 'fresh',
                                        '--proxy', 'external']),
              patch.object(sys, 'stdin', stdin),
              patch.object(m.os, 'geteuid', return_value=0),
              patch.object(m, 'node_version', return_value=22),
              patch.object(m, 'verify_release', return_value=31),
              patch.object(m, 'detect_public_ipv4', return_value='1.2.3.4'),
              patch.object(m, 'fresh', side_effect=lambda args: captured.append(args)),
              patch('builtins.input', side_effect=['3', 'n', '']) as ask,
              contextlib.redirect_stdout(out)):
            self.assertEqual(m.main(), 0)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0].domain, '1.2.3.4.sslip.io')
        self.assertEqual(captured[0].proxy, 'external')
        self.assertFalse(captured[0].with_dc)
        self.assertIn('[Y/n]', ask.call_args_list[-1].args[0])

    def test_noninteractive_explicit_domain_never_contacts_ip_service(self):
        out = io.StringIO()
        stdin = Mock()
        stdin.isatty.return_value = False
        captured = []
        with (patch.object(sys, 'argv', ['install', '--lang', 'en', '--mode', 'fresh',
                                        '--domain', 'MCP.EXAMPLE.NET', '--proxy', 'external', '--yes']),
              patch.object(sys, 'stdin', stdin),
              patch.object(m.os, 'geteuid', return_value=0),
              patch.object(m, 'verify_release', return_value=31),
              patch.object(m, 'detect_public_ipv4', side_effect=AssertionError('network lookup must be skipped')),
              patch.object(m, 'fresh', side_effect=lambda args: captured.append(args)),
              patch('builtins.input', side_effect=AssertionError('no prompt expected')),
              contextlib.redirect_stdout(out)):
            self.assertEqual(m.main(), 0)
        self.assertEqual(captured[0].domain, 'mcp.example.net')

    def test_dry_run_with_missing_domain_skips_network_lookup(self):
        stdin = Mock()
        stdin.isatty.return_value = False
        with (patch.object(sys, 'argv', ['install', '--lang', 'zh', '--mode', 'fresh', '--dry-run']),
              patch.object(sys, 'stdin', stdin),
              patch.object(m, 'verify_release', return_value=31),
              patch.object(m, 'detect_public_ipv4', side_effect=AssertionError('dry run must be offline')),
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(m.main(), 0)


if __name__ == '__main__':
    unittest.main()
