# Quick start / 快速开始

> 安装步骤见 [INSTALL.md](INSTALL.md)（给人看）和 [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md)（给 AI 看）。

最短路径：

```sh
dsh plugin --profile web add dsh-mesh-host dsh-mesh-ui dsh-mesh-autostart
# 重启 DSH → 设置 → AI 网络
npm i -g dsh-mesh-node
dsh-mesh tls init && dsh-mesh serve
```