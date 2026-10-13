"""Offline integration tests for streamed, no-clone SuperChatDev installation."""
import os
import pty
import select
import signal
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "install.sh"


class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="scd-bootstrap-test-")
        cls.root = Path(cls.temp.name)
        cls.fakebin = cls.root / "fakebin"
        cls.fakebin.mkdir()
        cls.archive = cls.root / "source.tar.gz"
        with tarfile.open(cls.archive, "w:gz") as tar:
            for path in ROOT.rglob("*"):
                if not path.is_file() or any(s in path.parts for s in
                                              (".git", "node_modules", "__pycache__")):
                    continue
                if path.suffix in (".log", ".pyc", ".png", ".zip", ".tar"):
                    continue
                tar.add(path, arcname="SuperChatDev-main/" + str(path.relative_to(ROOT)))
        mock_curl = cls.fakebin / "curl"
        mock_curl.write_text("""#!/bin/sh
set -eu
output=''
previous=''
for item in "$@"; do
  if [ "$previous" = "--output" ]; then output="$item"; previous=''; continue; fi
  if [ "$item" = "--output" ]; then previous='--output'; fi
done
if [ "$(printenv SUPERCHATDEV_MOCK_CURL_FAIL || true)" = "yes" ]; then exit 22; fi
[ -n "$output" ] || exit 19
cp "$SUPERCHATDEV_TEST_ARCHIVE" "$output"
""")
        mock_curl.chmod(0o755)
        cls.env = dict(os.environ)
        cls.env.pop("SUPERCHATDEV_LANG", None)
        cls.env["PATH"] = str(cls.fakebin) + os.pathsep + os.environ["PATH"]
        cls.env["SUPERCHATDEV_TEST_ARCHIVE"] = str(cls.archive)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def piped(self, args, *, extra_env=None):
        env = dict(self.env)
        env.update(extra_env or {})
        return subprocess.run(["bash", "-s", "--", *args],
                              input=LAUNCHER.read_text(), text=True,
                              cwd=self.root, env=env, capture_output=True, timeout=35)

    def test_real_piped_chinese_one_liner_dry_run(self):
        run = self.piped(["--mode", "fresh", "--domain", "mcp.real-domain.org",
                          "--proxy", "caddy", "--dry-run"])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("一键安装", run.stdout)
        self.assertIn("试运行完成", run.stdout)
        self.assertIn("发行文件", run.stdout)

    def test_real_piped_english_one_liner_dry_run(self):
        run = self.piped(["--lang", "en", "--mode", "fresh",
                          "--domain", "mcp.real-domain.org",
                          "--proxy", "caddy", "--dry-run"])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("downloading source from GitHub", run.stdout)
        self.assertIn("DRY RUN", run.stdout)
        self.assertNotIn("试运行完成", run.stdout)

    def test_download_failure_stops_without_install(self):
        run = self.piped(["--mode", "fresh", "--domain", "mcp.real-domain.org",
                          "--proxy", "caddy", "--dry-run"],
                         extra_env={"SUPERCHATDEV_MOCK_CURL_FAIL": "yes"})
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("源码下载失败", run.stderr)

    def test_archive_symlink_cannot_escape_as_root(self):
        bad = self.root / "malicious-source.tar.gz"
        with tarfile.open(bad, "w:gz") as tar:
            root = tarfile.TarInfo("SuperChatDev-main")
            root.type = tarfile.DIRTYPE
            tar.addfile(root)
            entry = tarfile.TarInfo("SuperChatDev-main/scripts")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc"
            tar.addfile(entry)
        result = self.piped(["--mode", "fresh", "--domain", "mcp.real-domain.org",
                             "--proxy", "caddy", "--dry-run"],
                            extra_env={"SUPERCHATDEV_TEST_ARCHIVE": str(bad)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("归档安全检查失败", result.stderr)

    def test_invalid_source_ref_is_rejected(self):
        run = self.piped(["--dry-run"], extra_env={"SUPERCHATDEV_REF": "../../etc/shadow"})
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("不安全的源码版本", run.stderr)

    def test_english_interactive_pty_diagnostics(self):
        """Python menus must read /dev/tty even if stdin was the remote script."""
        launcher = self.root / "remote-install.sh"
        launcher.write_text(LAUNCHER.read_text())
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(self.root)
            os.execve("/bin/bash", ["bash", str(launcher)], self.env)
        transcript = bytearray()
        code = None
        sent_language = False
        sent_choice = False
        deadline = time.monotonic() + 35
        try:
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.15)
                if readable:
                    try: part = os.read(master, 16384)
                    except OSError: part = b""
                    if part: transcript.extend(part)
                output = transcript.decode("utf-8", errors="replace")
                if not sent_language and "Choose [1]" in output:
                    os.write(master, b"2\n")
                    sent_language = True
                if sent_language and not sent_choice and "Choose [" in output[output.find("Choose [1]")+9:]:
                    os.write(master, b"3\n")
                    sent_choice = True
                try: finished, status = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError: finished, status = pid, 0
                if finished:
                    code = os.waitstatus_to_exitcode(status)
                    break
            if code is None:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                self.fail("Installer timed out waiting for its interactive TTY")
        finally:
            os.close(master)
        output = transcript.decode("utf-8", errors="replace")
        self.assertTrue(sent_language, output[-1300:])
        self.assertTrue(sent_choice, output[-1300:])
        self.assertEqual(code, 0, output[-1300:])
        self.assertIn("Choose operation", output)
        self.assertIn("Release:", output)


if __name__ == "__main__":
    unittest.main()
