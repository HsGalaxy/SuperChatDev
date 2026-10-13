#!/usr/bin/env bash
# SuperChatDev: zero-clone installer for Debian/Ubuntu.
# Run from checkout OR pipe the HTTPS GitHub source into "sudo bash".
set -Eeuo pipefail
umask 077

REPO="HsGalaxy/SuperChatDev"
REF="$(printenv SUPERCHATDEV_REF || printf main)"
case "$REF" in *..*|/*|-*) echo "不安全的源码版本 / Invalid source ref" >&2; exit 2 ;; esac
if [[ ! "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]]; then
  echo "不安全的源码版本 / Invalid source ref" >&2; exit 2
fi

LANG_CHOICE="$(printenv SUPERCHATDEV_LANG || printf zh)"
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--lang" ]]; then LANG_CHOICE="$arg"; prev=""; continue; fi
  case "$arg" in
    --lang) prev="--lang" ;;
    --lang=*) LANG_CHOICE="$(printf '%s' "$arg" | cut -d= -f2-)" ;;
  esac
done
case "$LANG_CHOICE" in
  zh|zh-CN|cn) LANG_CHOICE=zh ;;
  en|en-US) LANG_CHOICE=en ;;
  *) echo "语言只能是 zh 或 en / Language must be zh or en" >&2; exit 2 ;;
esac
say() { if [[ "$LANG_CHOICE" == en ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
die() { say "$1" "$2" >&2; exit 1; }

SOURCE_DIR=""
# bash -s (piped script) must download the requested ref even if the user's
# current directory happens to be an older source checkout.
SCRIPT_ROOT=""
case "$0" in
  bash|-bash|sh|-sh) ;;
  *) SCRIPT_ROOT="$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)" ;;
esac
if [[ -n "$SCRIPT_ROOT" && -f "$SCRIPT_ROOT/scripts/interactive_installer.py" &&
      -f "$SCRIPT_ROOT/RELEASE.json" ]]; then
  SOURCE_DIR="$SCRIPT_ROOT"
fi

CLEANUP_DIR=""
cleanup() { if [[ -n "$CLEANUP_DIR" && -d "$CLEANUP_DIR" ]]; then rm -rf -- "$CLEANUP_DIR"; fi; }
trap cleanup EXIT

if [[ -z "$SOURCE_DIR" ]]; then
  say "SuperChatDev 一键安装 · 从 GitHub 获取源码…" \
      "SuperChatDev one-command installer · downloading source from GitHub…"
  command -v curl >/dev/null 2>&1 ||
    die "缺少 curl，请先安装 curl。" "curl is required."
  if ! command -v tar >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    if [[ "$(id -u)" != 0 ]]; then
      die "缺少 tar 或 Python 3，请使用 sudo 安装。" \
          "tar or Python 3 is missing. Run with sudo."
    fi
    command -v apt-get >/dev/null 2>&1 ||
      die "自动安装依赖仅支持 Debian/Ubuntu。" \
          "Automatic prerequisites need Debian/Ubuntu."
    say "补齐基础依赖 tar / Python 3…" "Installing tar / Python 3 prerequisites…"
    apt-get update
    apt-get install -y ca-certificates tar python3
  fi
  CLEANUP_DIR="$(mktemp -d -t superchatdev-XXXXXXXX)"
  ARCHIVE="$CLEANUP_DIR/source.tar.gz"
  SOURCE_DIR="$CLEANUP_DIR/source"
  mkdir -p -- "$SOURCE_DIR"
  URL="https://codeload.github.com/$REPO/tar.gz/$REF"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
       --connect-timeout 15 --max-time 180 --retry 3 --output "$ARCHIVE" "$URL" ||
    die "源码下载失败，请检查 GitHub 网络。" \
        "Source download failed. Check GitHub connectivity."
  # Tar is downloaded over HTTPS, but reject unsafe archive members before
  # unpacking as root: traversal, symlinks, hardlinks and special devices.
  if ! python3 - "$ARCHIVE" <<'PYSAFE'
import sys
import tarfile
from pathlib import PurePosixPath

try:
    with tarfile.open(sys.argv[1], "r:gz") as archive:
        root = None
        total = 0
        count = 0
        for entry in archive:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or not path.parts or ".." in path.parts:
                raise ValueError("unsafe path")
            if root is None:
                root = path.parts[0]
            if path.parts[0] != root:
                raise ValueError("multiple archive roots")
            if not (entry.isfile() or entry.isdir()):
                raise ValueError("symlink, hardlink or device")
            count += 1
            total += entry.size
            if count > 5000 or entry.size > 20_000_000 or total > 100_000_000:
                raise ValueError("archive is too large")
        if count < 10:
            raise ValueError("incomplete archive")
except (OSError, tarfile.TarError, ValueError) as error:
    print("Archive rejected:", type(error).__name__, file=sys.stderr)
    sys.exit(2)
PYSAFE
  then
    die "源码归档安全检查失败。" "Source archive safety check failed."
  fi
  tar -xzf "$ARCHIVE" --strip-components=1 -C "$SOURCE_DIR"
  [[ -f "$SOURCE_DIR/scripts/interactive_installer.py" && -f "$SOURCE_DIR/RELEASE.json" ]] ||
    die "下载内容不是有效的 SuperChatDev 项目。" \
        "Downloaded archive is not a valid SuperChatDev project."
fi

command -v python3 >/dev/null 2>&1 ||
  die "缺少 Python 3。" "Python 3 is missing."

# "curl ... | sudo bash": standard input contains the shell script. Reattach TTY
# so Python menus work. In noninteractive CI, preserve stdin and require --yes.
if [[ -r /dev/tty ]] && ( : </dev/tty ) 2>/dev/null; then
  python3 "$SOURCE_DIR/scripts/interactive_installer.py" "$@" </dev/tty
else
  python3 "$SOURCE_DIR/scripts/interactive_installer.py" "$@"
fi
