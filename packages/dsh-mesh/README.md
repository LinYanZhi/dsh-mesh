# @linyanzhi/dsh-mesh

One-command install for the dsh-mesh AI network.

```sh
dsh plugin --profile web add @linyanzhi/dsh-mesh
```

The package itself provides the **AI 网络** sidebar page (topology, peer health, node management, transfer history and usage help). It also installs:

- `dsh-mesh-node` — mesh server / peer transport
- `dsh-mesh-host` — per-instance host bridge
- `dsh-mesh-autostart` — keeps the server alive across engine restarts

After install, restart the profile and open **AI 网络** in the left sidebar. Pair another machine with a one-time code; discovery never auto-connects.

See https://github.com/LinYanZhi/dsh-mesh for architecture, security and pairing details.
