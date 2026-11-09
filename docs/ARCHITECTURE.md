# Architecture

## Layers

1. **DSH engine** (per instance): runs agents, sessions, tools.
2. **mesh server** (`node src/cli.js serve`): MCP-over-HTTP server per node, exposes tools to peer nodes.
3. **host bridge** (DSH host plugin): lets the mesh server drive local DSH instances (create sessions, prompt, channel wake).
4. **relay / control plane** (one VPS, self-hostable): frps tunnels so nodes behind NAT are reachable; enrollment + token issuance; peers directory.
5. **controller tools**: `pc_*` direct desktop control (Windows), phone-side CLI/daemon.

## Delegation

A controller node sends a task envelope to a target node. The target's AI runs in a new DSH session and writes `status.json` / `result.json` into the task directory; the coordinator reads them. States: submitted -> working -> (question) -> done/failed/cancelled.

## Direct control

`pc_action` (lock, show-desktop, task-manager, media/volume keys, sleep, shutdown/restart with confirm), `pc_app` (list/start/close whitelisted apps), `pc_window` (list/focus/minimize/close via WM_CLOSE), `pc_browser` (open URL, CDP tabs on loopback). All are whitelisted enumerations - not a remote shell/keyboard.

Session-0 note: mesh servers may run as a service (session 0) and cannot see the interactive desktop. dsh-mesh ships an optional per-user helper (`pc-desktop-helper`) that the mesh forwards desktop operations to.

## Security

Per-node tokens with explicit allow-lists; deny-by-default ACL; audit log; rate limits; TLS fingerprint pinning; optional invite-code enrollment.