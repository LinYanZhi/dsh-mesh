# dsh-mesh — instructions for AI agents

This repository is a **DSH (DeepSeek Harness) plugin monorepo**. If a user asks you to install, upgrade or debug it, follow the checklist below. Full detail: [docs/INSTALL-FOR-AGENTS.md](docs/INSTALL-FOR-AGENTS.md).

## Quick path (installing on a DSH host)

```sh
# 1. check prerequisites
node --version                 # must be >= 22
dsh --version                  # DSH >= 0.2.0-rc.2

# 2. install plugins into the user's profile
dsh plugin --profile web add dsh-mesh-host dsh-mesh-ui dsh-mesh-autostart

# 3. verify package files landed
ls ~/.dsh/profiles/web/node_modules | grep dsh-mesh

# 4. restart the DSH instance (ask the user first), then check Settings → AI 网络

# 5. optional mesh server
npm i -g dsh-mesh-node
dsh-mesh tls init
dsh-mesh serve
curl -k https://127.0.0.1:8124/health
```

Windows uses the same commands (PowerShell); profile path is `$env:USERPROFILE\.dsh\profiles\web`.

## Hard rules

- **Never print tokens/pairing codes into chat** unless the user explicitly asks; write them to files instead.
- **Never enable desktop control (`pcControl`) without explicit user consent** — it is off by default.
- **Ask before restarting DSH**; never kill unrelated processes.
- Never commit `~/.dsh-mesh/` (config, secrets, audit) to any repository.
- If a step fails twice, stop and report the exact error.

## Verify after install

```sh
dsh-mesh host status            # host bridge alive inside DSH
dsh-mesh host tools --instance dsh0
```

Web UI check: Settings → **AI 网络** panel visible, no console errors. The server-side route `GET /api/dsh-mesh/status` on the DSH web port should return JSON with `"ok": true`.

## Repo conventions

- `packages/*` are the published npm packages (`dsh-mesh-node`, `dsh-mesh-host`, `dsh-mesh-ui`, `dsh-mesh-autostart`).
- `tools/*` are helper scripts copied into user installations (PC session-0 helper, phone kit, ops).
- Do not add secrets, personal paths, private IPs or credentials to this repository.
- License: MIT.
