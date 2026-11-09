# Install guide for AI agents / 给 AI 的安装指南

> 你是被用户指派来安装 `dsh-mesh` 的 AI Agent。按本文执行；**不要凭猜测改配置**，每步验证后再继续。
> You are an AI agent asked to install dsh-mesh. Follow the steps, verify each one, and stop to ask the user when something does not match.

## 0. Security rules (read first / 先读)

- **Never print tokens or pairing codes into chat logs** unless the user explicitly asks; write them to local files instead.
- **Never enable remote desktop control (`pcControl.enabled`) without explicit user consent.** It is off by default; keep it off for installation tests.
- **Never restart the user's DSH instance without asking**, and never kill unrelated processes.
- Do not commit `~/.dsh-mesh/` (config, secrets, tokens, audit) into any git repository.
- If a step fails twice, stop and report the exact error instead of improvising.

## 1. Preconditions / 前置条件

| Requirement | Check |
|---|---|
| Node.js >= 22 | `node --version` |
| DSH installed and running | `dsh --version` (or `dsh web` works) |
| DSH >= 0.2.0-rc.2 (plugin API) | check `package.json` of the profile or ask the user |
| Ability to modify the DSH profile | the user's normal account is enough |

Locate the working DSH home/profile:

```sh
# Linux/macOS
echo $DSH_HOME      # usually ~/.dsh  (multi-instance: ~/.dsh0, ~/.dsh1, ...)
ls ~/.dsh/profiles/web
```

```powershell
# Windows
echo $env:DSH_HOME  # usually C:\Users\<user>\.dsh
dir $env:USERPROFILE\.dsh\profiles\web
```

If there are multiple instances (`.dsh0`, `.dsh1`, ...), ask the user which instance should get the plugins, and use that profile dir for every check below.

## 2. Install the DSH plugins / 安装 DSH 插件

```sh
dsh plugin --profile web add dsh-mesh-host dsh-mesh-ui dsh-mesh-autostart
```

What each package does:

- `dsh-mesh-host` — runs the loopback host bridge inside this DSH instance (session/tool control).
- `dsh-mesh-ui` — adds the **AI 网络** section to Settings (topology / peer health / delegation panel).
- `dsh-mesh-autostart` — supervises a `dsh-mesh` server inside the host process, so it survives engine restarts (phone/desktop apps).

### Verify the install

1. Package directories exist:

```sh
ls ~/.dsh/profiles/web/node_modules/dsh-mesh-host
ls ~/.dsh/profiles/web/node_modules/dsh-mesh-ui
ls ~/.dsh/profiles/web/node_modules/dsh-mesh-autostart
```

2. The profile patch contains the three plugin entries:

```sh
grep -E "dsh-mesh-(host|ui|autostart)" ~/.dsh/profiles/web/cordis.patch.yml
```

If `dsh plugin add` succeeded but the patch is missing entries, add them manually (one `insert` each):

```yaml
- insert:
    - id: dsh-mesh-host
      name: dsh-mesh-host
- insert:
    - id: dsh-mesh-ui
      name: dsh-mesh-ui
- insert:
    - id: dsh-mesh-autostart
      name: dsh-mesh-autostart
```

3. Restart the DSH instance (required for client plugins to load), then open the Web UI → **Settings → AI 网络**. The section should render without errors. If it does not appear: restart again, hard-refresh the browser (Ctrl+Shift+R), and check the browser console.

## 3. Start a mesh node / 启动 mesh 节点

Each machine runs its own mesh server. First run creates `~/.dsh-mesh/config.json` and `secrets.json` automatically.

```sh
npm i -g dsh-mesh-node
dsh-mesh tls init        # optional but recommended: self-signed TLS cert (fingerprint pinning)
dsh-mesh serve            # starts the MCP-over-HTTPS endpoint (default 0.0.0.0:8124)
```

Check it:

```sh
curl -k https://127.0.0.1:8124/health
```

Windows equivalents: `Invoke-WebRequest -SkipCertificateCheck https://127.0.0.1:8124/health`.

## 4. Pair two nodes (LAN quickstart) / 两台机器配对

Do this on node **A**:

```sh
dsh-mesh pair --code
# → prints a short pairing code, valid 30 minutes
```

On node **B**:

```sh
dsh-mesh peer add --url https://<A-ip-or-hostname>:8124 --code <CODE> --name node-a
dsh-mesh peer tools --to node-a
dsh-mesh peer call mesh_self --to node-a
```

Then repeat in the opposite direction (mint a code on B, redeem on A) if you want symmetrical delegation.

For internet access across NATs, deploy an frps relay on a VPS and give each node its own tunnel; see `docs/SELF-HOST-RELAY.md`.

## 5. Verify the host bridge / 验证宿主桥

`dsh-mesh-host` auto-creates a 0600 token file on first load:

- `~/.dsh-mesh/host-token` (instance 0), `~/.dsh-mesh/host-token-dsh1` (instance 1), ...

```sh
dsh-mesh host status
dsh-mesh host tools --instance dsh0
```

## 6. Optional: desktop control (off by default) / 可选：桌面控制

Only if the user explicitly asks for it:

1. On the target machine, enable in `~/.dsh-mesh/config.json`:

```json
{ "pcControl": { "enabled": true } }
```

2. Issue a controller token (keep it secret):

```sh
dsh-mesh token add --id controller --allow pc_action,pc_app,pc_window,pc_browser,mesh_self --yes
```

3. Windows services run in session 0 and cannot see the interactive desktop. If the mesh server runs as a service, install the user-session helper from this repo:

```powershell
node tools/pc-helper/install-desktop-helper-task.mjs
```

## 7. Rollback / 回滚

```sh
dsh plugin --profile web remove dsh-mesh-ui dsh-mesh-host dsh-mesh-autostart
# restore the profile patch from your backup if you edited it manually
npm uninstall -g dsh-mesh-node
```

Stop the mesh server and remove `~/.dsh-mesh/` only if the user asks (it contains tokens/audit).

## 8. Report to the user / 回报模板

```
installed: dsh-mesh-host/ui/autostart@<versions> on profile <path>
DSH restart required: <yes/no>
AI 网络 panel: <visible / not visible + console error>
mesh node: <started / not started>  health: <ok/error>
pairing: <node-a paired / skipped>
desktop control: <left disabled / enabled per user request>
open issues: <...>
```

---

More: [README](../README.md) · [INSTALL.md](INSTALL.md) · [HISTORY.md](HISTORY.md) · [SECURITY](../SECURITY.md)
