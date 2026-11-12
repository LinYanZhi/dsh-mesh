# dsh-mesh — instructions for AI agents

This repository is the **release, docs and install-guide repo** for dsh-mesh (a DSH plugin bundle). The actual code is published to npm (`@linyanzhi/dsh-mesh`, `dsh-mesh-ui`, `dsh-mesh-host`, `dsh-mesh-node`, `dsh-mesh-autostart`). If a user asks you to install, upgrade or debug it, follow the checklist below. Full detail: [docs/INSTALL-FOR-AGENTS.md](docs/INSTALL-FOR-AGENTS.md).

## Quick path (installing on a DSH host)

```sh
# 1. check prerequisites
node --version                 # must be >= 22
dsh --version                  # DSH >= 0.2.0-rc.2 (0.2.2-rc.1 recommended)

# 2. install the bundle into the user's profile
dsh plugin --profile web add @linyanzhi/dsh-mesh

# 3. verify package files landed
ls ~/.dsh/profiles/web/node_modules | grep dsh-mesh

# 4. restart the DSH instance (ask the user first), then check the left-sidebar **AI 网络** page

# 5. verify host bridge + nodes from the global CLI
dsh-mesh host status
dsh-mesh cluster status
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
| `controller` | observer + `delegate*` + `host_session_create/prompt` + `pc_*` desktop control | phones / nodes that initiate delegation |
| `operator` | controller + `file_write_chunk` (file transfer writes) | explicitly authorized operators |
| `node` | inherit the node ACL (legacy-compatible) | normal PC nodes |
| `admin` | reserved; equals node today (real escalation still needs node ACL change) | explicit admin ops |

- Roles only **narrow** the node ACL (intersection); they can never exceed it.
- `controller` intentionally **excludes** `host_call`, `service_restart`, `mesh_config_patch`, `plugin_install`, `fs_write`, `shell_run`. Dangerous cross-machine work must be delegated to the target machine's AI (which runs locally), never auto-granted.
- Enrollment: `dsh-mesh pair --code --role controller` → the peer redeems the code and receives that role; the peer cannot pick its own role.
- Inspect / migrate: `dsh-mesh token list`, `dsh-mesh token migrate-roles [--yes]` (auto-infers observer/controller/node from legacy ACLs, backs up `secrets.json` first, keeps custom ACLs).
- If a call returns `E_DENIED`, do **not** retry in a loop: either switch the token role or delegate the action to the target machine's AI.

## File transfer (quota-limited)

- `file_read_chunk` / `file_write_chunk` move base64 chunks: **4 MB per chunk, 256 MB per file, 2 GB per day** by default (`config.transfer`).
- `file_hash` (sha256) and `transfer_usage` verify and report usage. Prefer LAN/direct links; relay bandwidth is limited.
- `find_files` uses Everything `es.exe` when present, else `fd`; `search_text` uses `ripgrep`; `tool_inventory` lists what the node has.

## Verify after install

```sh
dsh-mesh host status            # host bridge alive inside DSH
dsh-mesh host tools --instance dsh0
```

Web UI check: left-sidebar **AI 网络** page visible, LAN onboarding card opens, no console errors. The server-side route `GET /api/dsh-mesh/status` on the DSH web port should return JSON with `"ok": true`.

## Repo conventions

- This repo ships **docs + release notes only**; npm packages are published separately:
  `@linyanzhi/dsh-mesh` (bundle), `dsh-mesh-ui`, `dsh-mesh-host`, `dsh-mesh-node`, `dsh-mesh-autostart`.
- `tools/*` helper scripts live in the source repo, not here.
- Do not add secrets, personal paths, private IPs or credentials to this repository.
- License: MIT.
