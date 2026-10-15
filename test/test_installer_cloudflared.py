"""Regression: Cloudflare's official binary .gpg key must not be text-encoded."""
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "superchatdev_installer_cloudflared",
    ROOT / "scripts" / "interactive_installer.py",
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class CloudflaredInstallerTests(unittest.TestCase):
    def test_atomic_write_supports_binary_gpg_without_corruption(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "keyrings" / "cloudflare-main.gpg"
            data = bytes(range(256)) + b"\x00\xff\x80binary-gpg-key"
            installer.atomic_write(output, data, 0o644)
            self.assertEqual(output.read_bytes(), data)
            self.assertEqual(output.stat().st_mode & 0o777, 0o644)
            installer.atomic_write(output, "UTF-8: 中文\n", 0o600)
            self.assertEqual(output.read_bytes(), "UTF-8: 中文\n".encode("utf-8"))
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_cloudflared_optional_apt_flow_writes_unmodified_binary_key_and_repo(self):
        with tempfile.TemporaryDirectory() as root:
            keyring = Path(root) / "keyrings" / "cloudflare-main.gpg"
            apt_source = Path(root) / "sources.list.d" / "cloudflared.list"
            # Simulate a binary PGP public key, including invalid UTF-8.
            key = b"\x99\x02\x00\x01\xff\x80" + bytes(range(128))
            installed = False
            commands = []

            def find_executable(name):
                if name == "apt-get":
                    return "/usr/bin/apt-get"
                if name == "cloudflared":
                    return "/usr/bin/cloudflared" if installed else None
                raise AssertionError("Unexpected dependency")

            def fake_run(*args, **kwargs):
                nonlocal installed
                commands.append(args)
                if args[:3] == ("apt-get", "install", "-y"):
                    self.assertEqual(args[3], "cloudflared")
                    installed = True

            with (
                patch.object(installer, "CLOUDFLARED_KEYRING", keyring),
                patch.object(installer, "CLOUDFLARED_APT_SOURCE", apt_source),
                patch.object(installer.shutil, "which", side_effect=find_executable),
                patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(key)) as get,
                patch.object(installer, "run", side_effect=fake_run),
            ):
                installer.ensure_cloudflared()

            self.assertEqual(keyring.read_bytes(), key)
            self.assertEqual(keyring.stat().st_mode & 0o777, 0o644)
            self.assertEqual(apt_source.read_text(encoding="utf-8"), (
                f"deb [signed-by={keyring}] "
                "https://pkg.cloudflare.com/cloudflared any main\n"
            ))
            self.assertEqual(apt_source.stat().st_mode & 0o777, 0o644)
            self.assertEqual(commands, [
                ("apt-get", "update"),
                ("apt-get", "install", "-y", "cloudflared"),
            ])
            self.assertEqual(get.call_count, 1)
            self.assertEqual(get.call_args.args[0].full_url,
                             "https://pkg.cloudflare.com/cloudflare-main.gpg")
            self.assertEqual(get.call_args.kwargs["timeout"], 12)

    def test_already_installed_cloudflared_skips_apt_and_download(self):
        with (
            patch.object(installer.shutil, "which", return_value="/usr/bin/cloudflared"),
            patch.object(installer.urllib.request, "urlopen") as network,
            patch.object(installer, "run") as run,
        ):
            installer.ensure_cloudflared()
        network.assert_not_called()
        run.assert_not_called()

    def test_key_download_larger_than_limit_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as root:
            keyring = Path(root) / "cloudflare-main.gpg"
            with (
                patch.object(installer, "CLOUDFLARED_KEYRING", keyring),
                patch.object(installer.shutil, "which", side_effect=lambda name:
                             None if name == "cloudflared" else "/usr/bin/apt-get"),
                patch.object(installer.urllib.request, "urlopen",
                             return_value=io.BytesIO(b"x" * (512 * 1024 + 1))),
                patch.object(installer, "run") as run,
            ):
                with self.assertRaises(installer.InstallError):
                    installer.ensure_cloudflared()
            self.assertFalse(keyring.exists())
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
