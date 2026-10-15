#!/usr/bin/env python3
"""Interactive, owner-run installer for the single-owner Core MCP runtime.

Fresh installs on Debian/Ubuntu and safe in-place upgrades. No network services
or privileged operations run in --dry-run or --check mode.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import grp
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

# When loaded through importlib or executed directly, resolve sibling i18n module.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from installer_lang import set_language, tr, error_message

SOURCE = Path(__file__).resolve().parents[1]
APP = Path("/opt/chatgpt-dev-mcp")
VAR = Path("/var/lib/chatgpt-dev-mcp")
ETC = Path("/etc/chatgpt-dev-mcp")
ENV_FILE = ETC / "service.env"
UNIT = Path("/etc/systemd/system/chatgpt-dev-mcp.service")
SERVICE = "chatgpt-dev-mcp.service"
BACKUPS = Path("/var/backups/chatgpt-dev-mcp-installer")
CADDY = Path("/etc/caddy/Caddyfile")
SITE = Path("/etc/caddy/sites-enabled/chatgpt-dev-mcp.caddy")
VERSION = json.loads((SOURCE / "RELEASE.json").read_text())["version"]
OWNER = "chatgpt-mcp"
RUNNER = "chatgpt-runner"

class InstallError(Exception):
    pass

def step(message: str):
    print("\n>>> " + error_message(message), flush=True)

def run(*argv: str, env: dict | None = None):
    print("+", " ".join(argv), flush=True)
    try:
        subprocess.run(argv, check=True, env=env)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise InstallError(tr("Command failed: ") + " ".join(argv)) from exc

def capture(*argv: str) -> str:
    try:
        return subprocess.check_output(argv, stderr=subprocess.STDOUT, text=True, timeout=12).strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return ""

def confirm(prompt: str, default: bool = False) -> bool:
    ending = "[Y/n]" if default else "[y/N]"
    while True:
        answer = input(prompt + " " + ending + " ").strip().lower()
        if not answer:
            return default
        if answer in ("yes", "y", "是"): return True
        if answer in ("no", "n", "否"): return False
        print(tr("Please enter y or n."))

def choose(prompt: str, options: list[tuple[str, str]], preferred: str) -> str:
    print(prompt)
    for key, label in options:
        print(f"  {key}. {label}")
    while True:
        value = input(tr("Choose [{default}]: ", default=preferred)).strip() or preferred
        if value in dict(options):
            return value
        print(tr("Unknown option."))

def validate_domain(value: str) -> str:
    value = value.strip().lower().rstrip(".")
    try:
        value = value.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise InstallError("Invalid hostname") from error
    if len(value) > 253 or "." not in value or value.startswith("-"):
        raise InstallError("Use a fully qualified DNS name, not a URL or IP address.")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
           for label in value.split(".")):
        raise InstallError("Invalid domain label")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        raise InstallError("An HTTPS domain name, not an IP address, is required")
    if value in {"example.com", "mcp.example.com"} or value.endswith(".example"):
        raise InstallError("Replace the documentation example with your actual domain")
    return value

def valid_port(value: int) -> int:
    if not 1024 < value < 65536:
        raise InstallError("The loopback port must be between 1025 and 65535")
    return value

# These are external IP-echo endpoints, not DNS configuration or system
# metadata services. Never accept a non-public address as a suggestion.
PUBLIC_IPV4_ENDPOINTS = (
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com",
    "https://checkip.amazonaws.com",
)


def parse_public_ipv4(value: str) -> str | None:
    try:
        address = ipaddress.ip_address(value.strip())
    except (ValueError, AttributeError):
        return None
    if not isinstance(address, ipaddress.IPv4Address):
        return None
    if not address.is_global or address.is_multicast or address.is_reserved or address.is_unspecified:
        return None
    return str(address)


def detect_public_ipv4() -> str | None:
    # Avoid HTTP(S)_PROXY: a proxy's *own* exit IP is not the machine's.
    # Timeouts and response caps keep onboarding usable on restricted hosts.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for endpoint in PUBLIC_IPV4_ENDPOINTS:
        try:
            request = urllib.request.Request(
                endpoint, headers={"User-Agent": "SuperChatDev-Installer/0.3",
                                   "Accept": "text/plain"})
            with opener.open(request, timeout=2.5) as response:
                data = response.read(65)
            if len(data) > 64:
                continue
            ip = parse_public_ipv4(data.decode("ascii", errors="strict"))
            if ip is not None:
                return ip
        except (OSError, ValueError, UnicodeError):
            continue
    return None


def choose_access_method():
    # Explicit recommendation order: existing domain, Cloudflare, sslip.io.
    option=choose(tr("Choose public access method:"),[
      ("1",tr("Custom HTTPS domain (recommended; Caddy or existing proxy)")),
      ("2",tr("Cloudflare Tunnel (no public IP or inbound ports; optional cloudflared)")),
      ("3",tr("Automatic sslip.io hostname (requires reachable public IP)"))
    ],"1")
    if option=="2":
        return "pending.trycloudflare.com","cloudflare"
    if option=="3":
        ip=detect_public_ipv4()
        if ip:
            domain=f"{ip}.sslip.io"
            print(tr("Selected MCP domain: {domain}",domain=domain))
            return domain,"sslip"
        print(tr("Public IPv4 detection was unavailable; enter a domain instead."))
    # Manual custom HTTPS domain, with validation/error recovery.
    while True:
        value=input(tr("Public MCP domain (e.g. mcp.yourdomain.org): ")).strip()
        try:return validate_domain(value),"custom"
        except InstallError as error:
            print(tr("Invalid domain, please try again: {reason}",reason=error_message(str(error))))


def ensure_cloudflared():
    # Called only by --install-cloudflared or an explicitly selected
    # Cloudflare first-install option. Never a base prerequisite.
    if shutil.which("cloudflared"):
        step("cloudflared is already installed; skipping optional installation")
        return
    if not shutil.which("apt-get"):
        raise InstallError("cloudflared optional install requires Debian/Ubuntu apt; install it manually on this OS")
    step("Installing optional cloudflared from signed official Cloudflare apt repository")
    import urllib.request
    uri="https://pkg.cloudflare.com/cloudflare-main.gpg"
    with urllib.request.urlopen(urllib.request.Request(uri,headers={"User-Agent":"SuperChatDev/installer"}),timeout=12) as response:
        key=response.read(512*1024+1)
    if len(key)>512*1024 or len(key)<128:
        raise InstallError("Cloudflare apt signing key download invalid")
    keyring=Path("/usr/share/keyrings/cloudflare-main.gpg")
    keyring.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    atomic_write(keyring,key,0o644)
    repo=Path("/etc/apt/sources.list.d/cloudflared.list")
    atomic_write(repo,b"deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n",0o644)
    run("apt-get","update")
    run("apt-get","install","-y","cloudflared")
    if not shutil.which("cloudflared"):raise InstallError("cloudflared installed but is not on PATH")


def choose_install_domain() -> str:
    print("\n" + tr("Detecting your server's public IPv4 address..."), flush=True)
    ip = detect_public_ipv4()
    options = [("1", tr("Enter my own domain"))]
    suggested = f"{ip}.sslip.io" if ip else None
    if suggested:
        options.append(("2", tr("Use suggested sslip.io domain: {domain}", domain=suggested)))
        print(tr("Detected public IPv4: {ip}", ip=ip))
        print(tr("The detected address may be an outbound gateway; verify that inbound traffic reaches this VPS."))
    else:
        print(tr("Public IPv4 detection was unavailable; you can still enter a domain manually."))
    selected = choose(tr("Choose your MCP domain:"), options,
                      "2" if suggested else "1")
    if selected == "2" and suggested:
        print(tr("Selected MCP domain: {domain}", domain=suggested))
        return suggested
    while True:
        value = input(tr("Public MCP domain (e.g. mcp.yourdomain.org): ")).strip()
        try:
            return validate_domain(value)
        except InstallError as error:
            print(tr("Invalid domain, please try again: {reason}",
                     reason=error_message(str(error))))



def quote_env(value: str) -> str:
    if not isinstance(value, str) or "\n" in value or "\r" in value or "\0" in value:
        raise InstallError("Invalid EnvironmentFile value")
    # systemd EnvironmentFile double quoting is not shell code.
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

def render_env(values: dict[str, str]) -> str:
    return "# Root-only secrets. Do not commit, paste into chat, or print this file.\n" + "".join(
        k + "=" + quote_env(v) + "\n" for k, v in values.items()
    )

def atomic_write(path: Path, value: str, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (".core-mcp-" + secrets.token_hex(8))
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)

def verify_release() -> int:
    release = json.loads((SOURCE / "RELEASE.json").read_text())
    expected = release["files"]
    for name, digest in expected.items():
        parts = Path(name).parts
        if (not parts or ".." in parts or Path(name).is_absolute()
            or not (name.startswith("src/") or name.startswith("web/")
                    or name in ("package.json", "README.md", "CHANGELOG.md"))):
            raise InstallError("Unsafe release manifest path: " + name)
        f = SOURCE / name
        if f.is_symlink() or not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != digest:
            raise InstallError("Release checksum mismatch: " + name)
    return len(expected)

def distro() -> str:
    if not Path("/etc/os-release").exists():
        return "unknown"
    values = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            values[k] = v.strip('"')
    ident = values.get("ID", "")
    if ident in ("debian", "ubuntu"):
        return ident
    return "unknown"

def node_version() -> int:
    result = capture("node", "-p", "process.versions.node.split('.')[0]")
    try: return int(result)
    except ValueError: return 0

def ensure_node(allow_install: bool):
    if node_version() >= 22:
        return
    if not allow_install:
        raise InstallError("Node.js >=22 is required. Retry after installing it, or choose signed NodeSource setup.")
    if distro() not in ("debian", "ubuntu"):
        raise InstallError("Automatic Node installation supports only Debian/Ubuntu.")
    step("Install Node.js 22 from the signed NodeSource APT repository")
    run("apt-get", "update")
    run("apt-get", "install", "-y", "ca-certificates", "curl", "gnupg")
    key_url = "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
    try:
        with urllib.request.urlopen(key_url, timeout=30) as response:
            key = response.read(300000)
    except (urllib.error.URLError, TimeoutError) as err:
        raise InstallError("Cannot retrieve the NodeSource signing key") from err
    import tempfile
    with tempfile.NamedTemporaryFile() as keyfile:
        keyfile.write(key); keyfile.flush()
        keyring = "/usr/share/keyrings/nodesource.gpg"
        # Never pipe a remote shell script into bash.
        run("gpg", "--batch", "--yes", "--dearmor", "--output", keyring, keyfile.name)
        # The root bootstrap uses umask 077; APT verifies signatures as _apt.
        # The public keyring must be world-readable (not the private token files).
        os.chmod(keyring, 0o644)
    atomic_write(Path("/etc/apt/sources.list.d/nodesource.list"),
        "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n", 0o644)
    run("apt-get", "update")
    run("apt-get", "install", "-y", "nodejs")
    if node_version() < 22:
        raise InstallError("NodeSource setup finished, but Node.js >=22 is not on the service PATH.")

def ensure_prerequisites(allow_node: bool):
    if distro() not in ("debian", "ubuntu"):
        raise InstallError("Fresh automatic installation is supported only on Debian and Ubuntu with systemd.")
    if not shutil.which("apt-get") or not shutil.which("systemctl"):
        raise InstallError("APT and systemd are required.")
    missing = [x for x in ("python3", "curl", "git", "flock", "setpriv", "useradd")
               if not shutil.which(x)]
    if missing:
        step("Install missing system packages: " + ", ".join(missing))
        run("apt-get", "update")
        run("apt-get", "install", "-y", "python3", "curl", "git", "util-linux", "passwd")
    ensure_node(allow_node)
    if not Path("/usr/bin/node").exists() and not Path("/usr/local/bin/node").exists():
        raise InstallError("Node must be in a system-accessible location, not a root-only nvm directory.")

def ensure_account(name: str, own_group: bool):
    try: account = pwd.getpwnam(name)
    except KeyError:
        command = ["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin"]
        if own_group: command.append("--user-group")
        else: command += ["--gid", RUNNER]
        command += ["--home-dir", str(VAR / ("runtime" if name == RUNNER else "")), name]
        run(*command)
        account = pwd.getpwnam(name)
    if account.pw_uid == 0:
        raise InstallError("Refusing root as the execution identity: " + name)
    return account

def directory(path: Path, uid: int, gid: int, mode: int):
    if path.exists() and path.is_symlink():
        raise InstallError("Directory symlink refused: " + str(path))
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, uid, gid)
    os.chmod(path, mode)

def create_users_and_paths():
    runner = ensure_account(RUNNER, True)
    owner = ensure_account(OWNER, False)
    group = grp.getgrnam(RUNNER)
    directory(VAR, 0, 0, 0o755)
    directory(VAR / "state", owner.pw_uid, group.gr_gid, 0o700)
    directory(VAR / "workspace", runner.pw_uid, group.gr_gid, 0o2770)
    directory(VAR / "runtime", runner.pw_uid, group.gr_gid, 0o700)
    directory(ETC, 0, 0, 0o700)
    directory(APP, 0, 0, 0o755)
    return runner, owner

def create_credentials():
    for name in ("owner-password", "admin-password"):
        target = ETC / name
        if target.exists():
            raise InstallError("A credentials file already exists: " + str(target) +
                               ". Use upgrade or manually reconcile it.")
        atomic_write(target, secrets.token_urlsafe(40) + "\n")
    return (ETC / "owner-password").read_text().strip(), (ETC / "admin-password").read_text().strip()

def env_settings(domain: str, port: int, runner, dc: bool, owner_pass: str, admin_pass: str, bootstrap_quick: bool = False, allow_local_admin: bool = False):
    home = str(VAR / "runtime")
    cargo = str(VAR / "workspace" / ".rust-cargo")
    execution = {"PATH": cargo + "/bin:/usr/local/bin:/usr/bin:/bin", "HOME": home,
                 "CARGO_HOME": cargo, "RUSTUP_HOME": str(VAR / "workspace" / ".rustup")}
    values = {
        "HOST": "127.0.0.1", "PORT": str(port),
        "PUBLIC_BASE_URL": "https://" + domain,
        "WORKSPACE_ROOT": str(VAR / "workspace"),
        "MCP_DATA_ROOT": str(VAR / "state"),
        "MCP_OWNER_PASSWORD": owner_pass,
        "MCP_ADMIN_PASSWORD": admin_pass,
        "OAUTH_REDIRECT_ORIGINS": "https://chatgpt.com,https://chat.openai.com",
        "FILE_DOWNLOAD_ORIGINS": "https://files.oaiusercontent.com,https://*.blob.core.windows.net",
        "HTTP_ALLOWED_ORIGINS": (f"http://localhost:{port},http://127.0.0.1:{port}" if allow_local_admin else ""),
        "MAX_FILE_BYTES": str(512 * 1024 * 1024),
        "MAX_RESOURCE_BYTES": str(8 * 1024 * 1024),
        "MAX_JOBS": "4",
        "EXECUTION_UID": str(runner.pw_uid),
        "EXECUTION_GID": str(runner.pw_gid),
        "EXECUTION_HOME": home,
        "EXECUTION_ENV": json.dumps(execution, separators=(",", ":")),
        "MCP_TOOL_PROFILE": "core",
    }
    if bootstrap_quick:
        values["TUNNEL_BOOTSTRAP_QUICK"] = "true"
    if dc:
        values["DESKTOP_COMMANDER_COMMAND"] = json.dumps([
            "node", str(APP / "upstream/node_modules/@wonderwhy-er/desktop-commander/dist/index.js")
        ], separators=(",", ":"))
    return values

def unit_text(node: str) -> str:
    if not node.startswith(("/usr/bin/", "/usr/local/bin/")) or any(c.isspace() for c in node):
        raise InstallError("Node executable must have an absolute, system-accessible path.")
    return f"""# Managed by Core MCP installer. Preserve this file during routine upgrades.
[Unit]
Description=ChatGPT Core MCP Development Runtime
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User={OWNER}
Group={RUNNER}
WorkingDirectory={APP}
EnvironmentFile={ENV_FILE}
ExecStart={node} {APP}/src/server.mjs
Restart=on-failure
RestartSec=5
UMask=0007
KillMode=process
NoNewPrivileges=true
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL
AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_KILL
ProtectSystem=strict
ProtectHome=true
ProtectProc=invisible
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths={VAR}
InaccessiblePaths={ETC}
TasksMax=256
MemoryMax=2G
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
"""

def caddy_site(domain: str, port: int) -> str:
    return f"""# Core MCP managed reverse proxy; OAuth and signed URLs are not access-logged.
{domain} {{
    encode zstd gzip
    # Never log OAuth authorization codes or signed artifact query strings.
    log {{
        output discard
    }}
    reverse_proxy 127.0.0.1:{port} {{
        transport http {{
            dial_timeout 10s
            response_header_timeout 180s
        }}
    }}
    header X-Content-Type-Options nosniff
}}
"""

def check_backend(port: int, version: str = VERSION):
    for attempt in range(50):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                state = json.load(r)
            if state.get("ok") is True and state.get("version") == version:
                return
        except (OSError, urllib.error.URLError, ValueError, TimeoutError):
            pass
        time.sleep(0.25 if attempt < 12 else 0.5)
    raise InstallError(f"Backend health check failed: expected {version} on 127.0.0.1:{port}")

def inspect_exists(path: Path):
    try:
        return path.exists()
    except OSError:
        return tr("unknown (restricted)")

def verify_nonsecret_setup():
    count = verify_release()
    print(tr("Release: {version}, verified {count} file hashes",
             version=VERSION, count=count))
    print(tr("OS: {os}, installed Node major: {node}",
             os=distro(), node=node_version() or tr("missing")))
    print(tr("systemctl:"), bool(shutil.which("systemctl")))
    print(tr("service exists:"), UNIT.exists())
    print(tr("env file exists:"), inspect_exists(ENV_FILE), tr("(contents not displayed)"))
    print(tr("credential files exist:"), inspect_exists(ETC / "owner-password"),
          inspect_exists(ETC / "admin-password"), tr("(contents not displayed)"))
    print(tr("workspace exists:"), (VAR / "workspace").is_dir())
    if shutil.which("systemctl"):
        print(tr("service active:"), capture("systemctl", "is-active", SERVICE))
    try:
        port = 18787
        if inspect_exists(ENV_FILE) is True:
            try:
                # --check must work without root. Never require reading a
                # root-only secret file merely to display diagnostics.
                lines = ENV_FILE.read_text().splitlines()
            except (OSError, PermissionError):
                lines = []
            for line in lines:
                if line.startswith("PORT="):
                    port = int(line.split("=",1)[1].strip().strip('"\\u0027'))
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            state=json.load(r)
        print(tr("local /health:"), state.get("ok"),state.get("version"))
    except Exception:
        print(tr("local /health:"), tr("unreachable (no credentials were used)"))

def port_available(port):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1",port))
        except OSError as exc:
            raise InstallError(f"Local port {port} is already occupied; choose another port.") from exc

def install_dc():
    if not shutil.which("npm"):
        raise InstallError("npm is required when Desktop Commander is enabled")
    step("Install optional Desktop Commander (pinned, no lifecycle scripts)")
    upstream = APP / "upstream"
    upstream.mkdir(mode=0o755, parents=True, exist_ok=True)
    pkg = upstream / "package.json"
    if not pkg.exists():
        atomic_write(pkg, '{"name":"chatgpt-mcp-upstream","private":true}\n', 0o644)
    run("npm","install","--prefix",str(upstream),"--ignore-scripts","--omit=dev",
        "--save-exact","--no-audit","--no-fund","@wonderwhy-er/desktop-commander@0.2.52")
    if not (upstream/"node_modules/@wonderwhy-er/desktop-commander/dist/index.js").exists():
        raise InstallError("Desktop Commander entry point not found after npm installation")

def backup_state(backup: Path):
    state=VAR/"state"
    secret_dir=backup/"private-state"
    secret_dir.mkdir(mode=0o700)
    for pattern in ("admin-settings.json","oauth-*.json"):
        for file in state.glob(pattern):
            if file.is_file() and not file.is_symlink():
                shutil.copy2(file,secret_dir/file.name)
                os.chmod(secret_dir/file.name,0o600)

def install_caddy(domain: str, port: int, backup: Path):
    step("Configure HTTPS with Caddy")
    if not shutil.which("caddy"):
        if distro() not in ("debian","ubuntu"):
            raise InstallError("Caddy auto-install supports Debian/Ubuntu only")
        run("apt-get","update")
        run("apt-get","install","-y","caddy")
    previous = CADDY.read_text() if CADDY.exists() else ""
    prior_site = SITE.read_text() if SITE.exists() else None
    if domain in previous and not previous.lstrip().startswith("# Core MCP managed"):
        raise InstallError("Domain already appears in the main Caddyfile; configure manually.")
    if prior_site is not None and not prior_site.startswith("# Core MCP managed"):
        raise InstallError("Existing Caddy site is not managed by this installer.")
    if CADDY.exists():
        shutil.copy2(CADDY,backup/"previous-Caddyfile")
    if SITE.exists():
        shutil.copy2(SITE,backup/"previous-Caddy-site")
    SITE.parent.mkdir(parents=True,exist_ok=True)
    atomic_write(SITE,caddy_site(domain,port),0o644)
    import_line="import /etc/caddy/sites-enabled/*.caddy"
    if import_line not in previous:
        content=previous.rstrip()+"\n\n# Core MCP managed site directory\n"+import_line+"\n"
        atomic_write(CADDY,content,0o644)
    try:
        run("caddy","validate","--config",str(CADDY))
        if capture("systemctl","is-active","caddy")=="active":
            run("systemctl","reload","caddy")
        else:
            run("systemctl","enable","--now","caddy")
    except Exception:
        if (backup/"previous-Caddyfile").exists():
            shutil.copy2(backup/"previous-Caddyfile",CADDY)
        else:
            CADDY.unlink(missing_ok=True)
        if (backup/"previous-Caddy-site").exists():
            shutil.copy2(backup/"previous-Caddy-site",SITE)
        else:
            SITE.unlink(missing_ok=True)
        raise

def make_backup():
    directory(BACKUPS,0,0,0o700)
    name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    base = BACKUPS/name
    base.mkdir(mode=0o700)
    return base

def install_release(backup, mode: str):
    if mode not in ("fresh", "upgrade"):
        raise InstallError("Invalid release deployment mode")
    run(sys.executable,str(SOURCE/"scripts/deploy_files.py"),"apply",
        str(SOURCE),str(APP),str(backup/"runtime"),mode)

def rollback_release(backup):
    record=backup/"runtime/rollback.json"
    if record.exists():
        run(sys.executable,str(SOURCE/"scripts/deploy_files.py"),"rollback",
            str(APP),str(backup/"runtime"))

def start_service(port):
    run("systemctl","daemon-reload")
    run("systemctl","enable","--now",SERVICE)
    run("systemctl","restart",SERVICE)
    check_backend(port)

def upgrade():
    if not UNIT.exists() or not ENV_FILE.exists():
        raise InstallError("Cannot upgrade without existing unit and environment. Use fresh install.")
    if node_version()<22:raise InstallError("Node.js >=22 is required.")
    port = 18787
    # Use the existing configured port without evaluating this root-only env file.
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("PORT="):
            port=valid_port(int(line[5:].strip().strip('"\u0027')))
    backup = make_backup()
    backup_state(backup)
    step("Upgrade runtime only; preserve users, proxy, credentials and workspace")
    installed=False
    try:
        install_release(backup, 'upgrade'); installed=True
        run("systemctl","restart",SERVICE)
        check_backend(port)
    except Exception:
        if installed or (backup/"runtime/rollback.json").exists():
            step("Health failure: roll back runtime files")
            rollback_release(backup)
            run("systemctl","restart",SERVICE)
        raise
    print("\n" + tr("Upgrade successful: v{version}  |  http://127.0.0.1:{port}/health",
                     version=VERSION,port=port))
    print(tr("Protected backup:"),backup)

def fresh(args):
    if UNIT.exists() or ENV_FILE.exists():
        raise InstallError("An existing installation was detected. Use upgrade mode; no overwrites.")
    # An interrupted previous fresh install may have left credentials but
    # no unit. Do not reset them; require the owner to inspect them first.
    first_install_secrets = (ETC / "owner-password", ETC / "admin-password")
    leftovers = [str(p) for p in first_install_secrets if p.exists()]
    if leftovers:
        raise InstallError("Incomplete previous installation: credentials already exist: " +
                           ", ".join(leftovers) + ". Inspect and reconcile before retrying.")
    domain=validate_domain(args.domain)
    port=valid_port(args.port)
    port_available(port)
    ensure_prerequisites(args.auto_node)
    if args.proxy=="cloudflare" and args.auto_cloudflared:
        ensure_cloudflared()
    runner, owner = create_users_and_paths()
    backup=make_backup()
    backup_state(backup)
    installed=False
    started=False
    try:
        step("Verify and install release")
        install_release(backup, 'fresh'); installed=True
        if args.with_dc:
            install_dc()
        owner_pass, admin_pass=create_credentials()
        atomic_write(ENV_FILE,render_env(env_settings(domain,port,runner,args.with_dc,owner_pass,admin_pass,bootstrap_quick=args.proxy=='cloudflare' and args.cloudflare_mode=='quick',allow_local_admin=args.proxy=='cloudflare')))
        node=shutil.which("node") or ""
        node=str(Path(node).resolve())
        atomic_write(UNIT,unit_text(node),0o644)
        step("Start protected systemd service and verify local /health")
        start_service(port); started=True
        if args.proxy=="caddy":
            install_caddy(domain,port,backup)
        # Cloudflare Quick bootstraps asynchronously inside the gateway after startup;
        # no cloudflared installation or background network command is implicit.
    except BaseException:
        step("Installation incomplete; restoring runtime and stopping newly created unit")
        # Credentials and the environment file were absent at entry; all
        # created files below belong to this failed attempt and must be
        # cleaned up so the *same* fresh command can be retried.
        cleanup_errors = []
        if UNIT.exists():
            try:
                run("systemctl","disable","--now",SERVICE)
            except Exception as error:
                cleanup_errors.append(str(error))
            try:
                UNIT.unlink(missing_ok=True)
                run("systemctl","daemon-reload")
            except Exception as error:
                cleanup_errors.append(str(error))
        if installed or (backup/"runtime/rollback.json").exists():
            try:
                rollback_release(backup)
            except Exception as error:
                cleanup_errors.append(str(error))
        for path in (ENV_FILE, *first_install_secrets):
            try:
                path.unlink(missing_ok=True)
            except OSError as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            print("Cleanup requires manual attention: " + "; ".join(cleanup_errors),
                  file=sys.stderr)
        print("Private state and workspaces have not been deleted.")
        print(tr("For troubleshooting, inspect"), backup)
        raise
    print("\n" + tr("SUCCESS: Core MCP {version}", version=VERSION))
    public_ready=args.proxy!="cloudflare"
    if args.proxy=="cloudflare":
        # Only advertise a real public address; never display the placeholder
        # pending.trycloudflare.com as if it were a working service.
        if args.cloudflare_mode=="quick":
            quick=VAR/"state"/"cloudflare-tunnel"/"quick-url"
            for _ in range(40):
                if quick.is_file():
                    try:
                        addr=quick.read_text(encoding="ascii").strip()
                        if re.fullmatch(r"https://[a-z0-9-]+\.trycloudflare\.com",addr):
                            domain=addr.removeprefix("https://")
                            public_ready=True
                            break
                    except (OSError,UnicodeError):pass
                time.sleep(0.25)
        print(tr("Cloudflare mode selected: see Admin → Cloudflare Tunnel for live address and OAuth status"))
        if not public_ready:
            print(tr("Public Tunnel is not ready. Do not use the placeholder hostname. Check journalctl -u chatgpt-dev-mcp or SSH-forward 18787 to configure a named Tunnel."))
    if public_ready:
        print(tr("MCP endpoint:"), "https://"+domain+"/mcp")
        print(tr("Admin console:"), "https://"+domain+"/admin/")
    print(tr("HTTPS mode:"), args.proxy)
    if args.proxy=="cloudflare":
        print(tr("Cloudflare Tunnel needs outbound connectivity, not inbound 80/443. Use Admin to configure Quick or named Tunnel and verify the public OAuth issuer."))
    else:
        print(tr("Domain DNS must resolve here and ports 80/443 must be reachable for Caddy TLS."))
    print(tr("Owner and admin passwords are stored separately in root-only files under"), ETC)
    print(tr("To reveal a password locally, use a root SSH terminal; never paste secrets in chat."))
    print(tr("Private release backup:"), backup)
    print(tr("Next: register the HTTPS MCP app in ChatGPT; refresh/review/publish its actions."))

def main():
    parser=argparse.ArgumentParser(
        description="SuperChatDev · 专为 ChatGPT 网页版设计的 MCP 开发环境 / ChatGPT Web MCP runtime")
    parser.add_argument("--lang",choices=["zh","en"],default=None,
                        help="界面语言 / UI language (default: zh)")
    parser.add_argument("--mode", choices=["fresh","upgrade","check"],
                        help="fresh 新装 / upgrade 升级 / check 检测")
    parser.add_argument("--domain",help="公网域名 / public DNS hostname, not a URL")
    parser.add_argument("--proxy",choices=["caddy","external","cloudflare"],default=None,
                        help="HTTPS: managed Caddy or your existing reverse proxy")
    parser.add_argument("--access-method",choices=["custom","cloudflare","sslip"],default=None,
                        help="接入方式 / custom preferred, Cloudflare second, sslip third")
    parser.add_argument("--cloudflare-mode",choices=["quick","named"],default="quick",
                        help="Cloudflare Quick testing or remotely-managed named tunnel")
    parser.add_argument("--auto-cloudflared",action="store_true",
                        help="Explicitly opt in to installing cloudflared only when using Cloudflare")
    parser.add_argument("--install-cloudflared",action="store_true",
                        help="Only install the optional cloudflared binary via signed Cloudflare apt repo")
    parser.add_argument("--port",type=int,default=18787,
                        help="本地端口 / loopback port")
    parser.add_argument("--with-dc",action="store_true",
                        help="同时安装可选 Desktop Commander / optional bridge")
    parser.add_argument("--auto-node",action="store_true",
                        help="允许从有签名的 NodeSource 源安装 Node 22+")
    parser.add_argument("--yes",action="store_true",
                        help="明确允许非交互安装（需同时提供 --mode）")
    parser.add_argument("--dry-run",action="store_true",
                        help="只打印安装计划，不修改系统 / non-destructive")
    args=parser.parse_args()

    desired_lang = args.lang or os.environ.get("SUPERCHATDEV_LANG") or "zh"
    set_language(desired_lang)
    if (not args.lang and not os.environ.get("SUPERCHATDEV_LANG")
            and sys.stdin.isatty() and args.mode is None and not args.dry_run):
        print("\nSuperChatDev · 语言 / Language")
        print("  1. 简体中文（默认）")
        print("  2. English")
        while True:
            selected=input("请选择 / Choose [1]: ").strip() or "1"
            if selected in ("1","2"): break
            print("输入 1 或 2 / Enter 1 or 2")
        set_language("zh" if selected=="1" else "en")

    if args.install_cloudflared:
        if args.dry_run:
            print(tr("DRY RUN: optional cloudflared package would be installed from signed Cloudflare apt repo"))
            return 0
        if os.geteuid()!=0:raise InstallError("Optional cloudflared installation requires root SSH")
        if not args.yes and not sys.stdin.isatty():
            raise InstallError("Explicit --yes is required for unattended cloudflared installation")
        if not args.yes and not confirm(tr("Install optional cloudflared now?"),False):return 0
        ensure_cloudflared()
        return 0
    if args.mode=="check":
        verify_nonsecret_setup();return 0
    if args.mode is None and not args.dry_run:
        if not sys.stdin.isatty():
            raise InstallError(
                "Interactive installer requires a TTY; use --mode, --domain and --yes for automation.")
        print("\nSuperChatDev",VERSION,"|",tr("Installer wizard"))
        selection=choose(tr("Choose operation:"),[
            ("1",tr("Fresh install on Debian/Ubuntu")),
            ("2",tr("Upgrade an existing installation")),
            ("3",tr("Read-only diagnostics")),
            ("4",tr("Quit"))],"2" if UNIT.exists() else "1")
        if selection=="4": return 0
        if selection=="3": verify_nonsecret_setup(); return 0
        args.mode="fresh" if selection=="1" else "upgrade"
    if args.mode is None: args.mode="fresh"
    if args.mode=="fresh":
        if not args.domain:
            if args.access_method=="cloudflare":
                args.domain="pending.trycloudflare.com"
            elif args.dry_run:
                args.domain="mcp.my-domain.org"
            elif args.access_method=="sslip":
                ip=detect_public_ipv4()
                if not ip:
                    raise InstallError("Cannot select sslip.io: public IPv4 detection was unavailable")
                args.domain=f"{ip}.sslip.io"
            elif args.access_method=="custom" and sys.stdin.isatty():
                args.domain=validate_domain(
                    input(tr("Public MCP domain (e.g. mcp.yourdomain.org): ")).strip())
            elif sys.stdin.isatty():
                args.domain,args.access_method=choose_access_method()
            else:
                raise InstallError("--domain is required for non-interactive installation unless --access-method cloudflare")
        args.domain=validate_domain(args.domain)
        if args.access_method=="cloudflare":
            args.proxy="cloudflare"
        elif args.proxy=="cloudflare":
            raise InstallError("--proxy cloudflare requires --access-method cloudflare")
        valid_port(args.port)
        if not args.proxy:
            if args.dry_run or not sys.stdin.isatty(): args.proxy="external"
            else:
                args.proxy={"1":"caddy","2":"external"}[choose(tr("HTTPS proxy:"),[
                    ("1",tr("Managed Caddy (automated ACME TLS, ports 80/443)")),
                    ("2",tr("Existing proxy (you will configure HTTPS separately)"))],"1")]
        if not args.dry_run and sys.stdin.isatty():
            if args.proxy=="cloudflare" and not args.auto_cloudflared:
                args.auto_cloudflared=confirm(tr("Install optional cloudflared now?"),False)
            if not args.with_dc:
                args.with_dc=confirm(tr("Install optional Desktop Commander bridge?"), False)
            if node_version()<22 and not args.auto_node:
                args.auto_node=confirm(
                    tr("Node >=22 missing. Configure signed NodeSource APT repo?"), False)
    count=verify_release()
    print("\n"+tr("Core MCP v{version}; release checksum verified: {count} files",
                 version=VERSION,count=count))
    print(tr("Action:"),args.mode,"|",tr("target:"),APP)
    if args.mode=="fresh":
        print(tr("Domain:"),args.domain,"|",tr("HTTPS proxy:"),args.proxy,
              "|",tr("optional cloudflared:"),args.auto_cloudflared,
              "|",tr("backend port:"),args.port,"|",tr("optional DC:"),args.with_dc,
              "|",tr("permit NodeSource:"),args.auto_node)
        print(tr("Will create two unprivileged service accounts, protected credentials and persistent workspace."))
    else:
        print(tr("Upgrade runtime only; keep existing systemd unit, credentials, state and proxy."))
    if args.dry_run:
        print(tr("DRY RUN: No packages, users, configs, files or services were changed."))
        return 0
    if os.geteuid()!=0:
        raise InstallError("Run the actual installation as root in your SSH terminal.")
    if not args.yes and not sys.stdin.isatty():
        raise InstallError("A non-interactive privileged install requires explicit --yes.")
    if not args.yes and not confirm(tr("Proceed with privileged changes?"),True):
        print(tr("Cancelled."));return 0
    if args.mode=="fresh": fresh(args)
    else: upgrade()
    return 0

if __name__=="__main__":
    try:
        sys.exit(main())
    except (InstallError, ValueError, OSError) as error:
        print("\n"+tr("ERROR:"),error_message(str(error)),file=sys.stderr)
        sys.exit(1)
