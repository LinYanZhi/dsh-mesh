# dsh-mesh-ui

DSH left-sidebar page for a `dsh-mesh` AI network: topology, peer health, local instances, delegation ledger and alerts. Public addresses (IP/domain) are hidden by default; LAN addresses remain visible.

## Install

```sh
dsh plugin --profile web add dsh-mesh-ui
```

This installs `dsh-mesh-node` as a dependency. The page is read-only; it reads the local `~/.dsh-mesh` mesh state and never uploads or hardcodes peer addresses.

To make this DSH instance a mesh node, also install the host bridge:

```sh
dsh plugin --profile web add dsh-mesh-host
```

See https://github.com/LinYanZhi/dsh-mesh
