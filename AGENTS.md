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

## Permissions & roles (never hand-edit ACLs)

Tokens use **role capability packs** instead of per-tool allowlists:

| Role | Capabilities | Default use |
|---|---|---|
| `observer` | read-only status/files/git/logs + delegation list | watch-only nodes |
| `controller` | observer + `delegate*` + `pc_*` desktop control | phones / nodes that initiate delegation |
| `node` | inherit the node ACL (legacy-compatible) | normal PC nodes |
| `admin` | reserved; equals node today (real escalation still needs node ACL change) | explicit admin ops |

- Roles only **narrow** the node ACL (intersection); they can never exceed it.
- `controller` intentionally **excludes** `host_call`, `host_session_*`, `service_restart`, `mesh_config_patch`, `fs_write`, `shell_run`. Dangerous cross-machine work must be delegated to the target machine's AI (which runs locally), never auto-granted.
- Enrollment: `dsh-mesh pair --code --role controller` → the peer redeems the code and receives that role; the peer cannot pick its own role.
- Inspect / migrate: `dsh-mesh token list`, `dsh-mesh token migrate-roles [--yes]` (auto-infers observer/controller/node from legacy ACLs, backs up `secrets.json` first, keeps custom ACLs).
- If a call returns `E_DENIED`, do **not** retry in a loop: either switch the token role or delegate the action to the target machine's AI.

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
