# Install dsh-mesh / 安装指南

> 只想让 AI 帮你装？把下面这段发给你的 DSH：
> [docs/INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) 是给 AI 的完整手册。

## 你需要准备

- **系统**：Windows 10/11 x64（主力支持）；macOS / Linux 可跑，但自启等部分功能未验证
- **DSH**：`0.2.2-rc.1`（兼容 `0.2.0-rc.2` ~ `0.2.x`；多台机器尽量同版本）
- **Node**：`22.19+` 或 `24+`（DSH 自带运行时）
- **权限**：管理员权限（装插件、防火墙、开机自启）
- **网络**：同一局域网，或每台有可用的公网 TCP 入口（自建 frps / 樱花 / 隧道）
- **端口**：`8124/tcp` 节点间可达；`9100+` 只在 `127.0.0.1`；`8129/udp` 局域网发现（可选）

## 复制给 AI 的 Prompt

```
请帮我安装 dsh-mesh。按 https://github.com/LinYanZhi/dsh-mesh/blob/main/docs/INSTALL-FOR-AGENTS.md 执行：
1) 先确认 Node >= 22、DSH >= 0.2.0-rc.2，并找到我当前使用的 DSH profile
2) 安装 @linyanzhi/dsh-mesh（或拆开装 dsh-mesh-host / dsh-mesh-ui / dsh-mesh-autostart）
3) 需要重启 DSH 时先问我
4) 不要开启远程桌面控制（pcControl）
5) 每一步把验证结果告诉我，失败就停下来报告错误
```

## 手动安装

### 方式 A：一条命令（推荐）

```sh
dsh plugin --profile web add @linyanzhi/dsh-mesh
```

这个包会带齐：「AI 网络」侧栏页 + mesh 服务端 + 宿主桥 + 自启守护。

装完 **重启这个 DSH 实例**（只刷新页面不生效），左侧栏会出现 **AI 网络**。

### 方式 B：分包安装（进阶/排障用）

```sh
dsh plugin --profile web add dsh-mesh-ui dsh-mesh-host dsh-mesh-autostart
npm i -g dsh-mesh-node      # 仅当你需要手动管理 mesh 服务端时
```

分别作用：

| 包 | 作用 |
|---|---|
| `dsh-mesh-ui` | 「AI 网络」侧栏页（拓扑/节点/文件传输/委托/告警/诊断） |
| `dsh-mesh-host` | 每个 DSH 实例的宿主桥（loopback 9100+） |
| `dsh-mesh-node` | mesh 服务端 / 节点间传输（通常由 meta 包托管） |
| `dsh-mesh-autostart` | 引擎重启后保持 mesh 服务存活 |

## 打开「AI 网络」

左侧栏 → **AI 网络**。正常应看到：

- 本机实例（dsh0/dsh1…）
- 本机节点与已配对的对端节点
- 右侧面板：局域网连接 / 公网连接 / 内网穿透 / 节点管理 / 文件传输 / 委托台账 / 告警历史 / 诊断建议 / 权限设置

## 两台机器配对

### 1. 被访问端生成配对码

「AI 网络」→「局域网连接」→ **生成我的配对码**（默认 10 分钟有效、一次性）。

跨网络时先确认监听 `0.0.0.0:8124`，再用 frp/樱花把 `8124` 映射成 `域名:端口`。

### 2. 另一台兑换配对码

「AI 网络」→「局域网连接」：

- 点 **扫描局域网** → 找到对方 → 输入配对码 → **用此节点配对**
- 或者手动填 `https://IP:8124` + 配对码

CLI 备选：

```sh
dsh-mesh peer add --url https://<对端地址>:8124 --code <配对码> --name node-a
dsh-mesh peer call mesh_self --to node-a
```

配对成功后双方各存一份 token 到 `~/.dsh-mesh/`（不进 git、不上传）。

## 验证

```sh
# 宿主桥是否在 DSH 内存活
dsh-mesh host status

# 本机 + 已配对节点的实例/延迟
dsh-mesh cluster status
```

如果你有源码仓库（开发仓），还可以跑完整体检：

```sh
node scripts/mesh-health.mjs --fast
node scripts/self-update.mjs status --deep
```

再实际测一次文件或委托：

```sh
dsh-mesh peer call fs_list --to node-a --args-file args.json
dsh-mesh delegate --to node-a --policy new --goal-file goal.txt
```

## 安全默认值

- **发现 ≠ 连接**：局域网扫描只列节点，建立连接必须一次性配对码
- 节点间 TLS（自签证书 + 指纹固定）；每个 peer 独立 token，服务端只存哈希，可撤销
- 默认 ACL：读/检索/写对端 `~/Code`、读会话历史与日志、委托任务
- 默认关闭：`shell_run`、频道消息、远程桌面（`pc_*`）、修复类操作
- `/api/dsh-mesh/*` 只接受本机回环请求；没有云端
- 不要把 `~/.dsh-mesh/`（token/证书）提交到任何 git 仓库或发给别人

## 常见问题

| 现象 | 处理 |
|---|---|
| 侧栏没有「AI 网络」 | 确认装的是当前实例的 profile，并**重启该 DSH 实例**（不是只刷新） |
| 看不到对端 | 同网段？防火墙放行 `8124/tcp`？对端是否绑 `0.0.0.0`？用扫描/手动 `peer add` |
| 配对失败 | 码过期/用过（重新生成）；确认地址协议 `https://`、端口、证书指纹 |
| 公网/樱花隧道离线 | 隧道客户端没跑（每台都要常驻；手机樱花 App 要允许后台） |
| 文件传输面板为空 | 记录按节点存：拉文件时读取记录在对端；切「全网记录」可汇总 |
| 委托失败 | 看 `delegate status`；对端实例 down 或 ACL 拒绝；中文 goal 用文件传 |
| 版本 drift | 对齐 DSH 与插件版本；升级服务端代码后需重启实例 |

## 卸载 / 回滚

```sh
dsh plugin --profile web remove @linyanzhi/dsh-mesh
# 或分包：dsh plugin --profile web remove dsh-mesh-ui dsh-mesh-host dsh-mesh-autostart
```

删除前先备份 `~/.dsh-mesh/`（含 peers/token/证书/传输记录）；删除后配对关系不可恢复。

---

更多：[给 AI 的安装指南](INSTALL-FOR-AGENTS.md) · [架构](ARCHITECTURE.md) · [开发历程](HISTORY.md) · [安全](../SECURITY.md)
