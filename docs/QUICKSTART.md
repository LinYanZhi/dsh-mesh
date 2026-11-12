# Quick start / 快速开始

> 详细步骤见 [INSTALL.md](INSTALL.md)（给人看）和 [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md)（给 AI 看）。

## 一台机器

```sh
dsh plugin --profile web add @linyanzhi/dsh-mesh
# 重启这个 DSH 实例 → 左侧栏出现「AI 网络」
```

## 两台机器（同一局域网）

1. 两台都执行上面的安装并重启
2. 被访问端：「AI 网络」→「局域网连接」→ 生成我的配对码
3. 另一台：「AI 网络」→「局域网连接」→ 扫描局域网 → 填配对码 → 用此节点配对
4. 拓扑里出现对方即成功

## 跨网络

- 被访问端把 mesh 监听改成 `0.0.0.0:8124`
- 用自建 frps / 樱花 / Cloudflare Tunnel 把 `8124` 映射到公网
- 配对时填 `https://域名:端口`
- 不建议把 `8124` 直接裸奔在公网；至少用配对码 + ACL

## 验证

```sh
dsh-mesh host status       # 宿主桥存活
dsh-mesh cluster status    # 节点/实例/延迟
```

如果你有源码仓库（开发仓），还可以跑 `node scripts/mesh-health.mjs --fast` 和 `node scripts/self-update.mjs status --deep`。
