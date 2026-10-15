# Optional Cloudflare Tunnel

[Project](../README.en.md) · [中文](zh-CN/CLOUDFLARE.md)

Public access priority: **custom HTTPS domain first, Cloudflare Tunnel second, sslip.io third**. Cloudflare Tunnel does not require a public IP or open inbound ports.

## Install only on opt-in
The standard SuperChatDev installation and upgrades never install cloudflared. Web Admin cannot execute sudo or apt. From an SSH session on Debian/Ubuntu:

    curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --install-cloudflared --yes

Uses Cloudflare's official signed APT repository. You can also preinstall cloudflared manually.

### First-time setup without any public endpoint

If you selected named Tunnel during a fresh install but have not provisioned it, SSH-forward your local Admin page:

    ssh -L 18787:127.0.0.1:18787 user@your-server

Open http://localhost:18787/admin/, sign in, and configure the named tunnel. Fresh Cloudflare installs allow only the local loopback HTTP Origin in addition to the public issuer; this does not open the service to the Internet. Chromium/Firefox support Secure cookies on localhost; Safari has compatibility limitations, so use an initial Quick Tunnel if local login is rejected.

## Quick Tunnel
Navigate to /admin/#tunnel, confirm your Admin password, and start Quick. Its random trycloudflare.com URL is detected automatically; the effective OAuth issuer, allowed HTTP origins and /mcp address are synchronized. Reconnect ChatGPT after the URL changes.

The installer recommends Cloudflare second after a custom domain; explicit opt-in installation supports first-boot Quick auto-start (--access-method cloudflare --cloudflare-mode quick --auto-cloudflared). Quick is only for testing: no SLA, 200 concurrent in-flight requests max and no SSE.

## Named stable Tunnel
For DNS on Cloudflare, the Admin supports automated API provisioning by supplying Tunnel name, hostname, Account ID, Zone ID and a one-time Cloudflare API Token with Tunnel Edit + DNS Edit. It creates the remote tunnel, adds ingress for http://127.0.0.1:18787 with catch-all 404, and creates a proxied CNAME without overwriting DNS. The management API token is never persisted; the tunnel-scoped token is stored in a 0600 file and launched with token-file rather than on the command line.

Alternatively, configure a remotely-managed tunnel's public hostname, local HTTP service and DNS in Cloudflare Dashboard, and import only its Add Replica run token into Admin.

Named tunnels restart with the gateway using persisted configuration. Stop disables autostart; Resume reenables it; Remove deletes local credentials (not Cloudflare remote tunnel/DNS). All mutating Admin actions require login, CSRF and Admin password reconfirmation.

The diagnostics probe checks local and public /health independently. Inspect egress port 7844 TCP/UDP, hostname/route, DNS and log messages when public health fails. Keep OAuth/Admin protections enabled. Cloudflare Access is optional and must be tested against OAuth callbacks.

Official docs:
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
