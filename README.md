# dsh-mesh

**把多台电脑和手机组成一个可互相委托、可直控桌面的 AI 网络。**

**A multi-node AI network for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): turn your PCs and phones into one mesh where agents can delegate work across devices and operate desktops directly.**

> Status: **v0.1.0 in development** — the source is being consolidated from an internal deployment. APIs and package layout may change before the first stable release. Watch / star the repo to follow progress.

## 为什么做这个 / Why

一台机器上的 AI 再聪明，也看不到你另一台电脑的窗口、文件和应用。dsh-mesh 把每一台装了 DSH 的设备变成网络里的一个**对等节点**：

- 每台设备既是 **host**（能被委托、被控制）也是 **controller**（可委托、可控制别人）
- 跨设备任务用**委托协议**（任务信封 + 状态机 + 结果落盘），而不是靠人转发
- 手机可以直接 `lock` / `show-desktop` / 关闭窗口 / 打开应用 / 操作浏览器，延迟约 0.5 秒
- 所有节点通过自建中继（frps）在公网互通，不依赖 Cloudflare 等第三方

## 架构 / Architecture

```
                    +------------------------------+
                    |        Relay / Control Plane |
                    |  frps + enrollment + tokens  |
                    |  (self-hostable, one VPS)    |
                    +--------------+---------------+
         TLS + per-node token      |
   +---------------+--------+------+--------+---------------+ 
   |               |        |               |               |
+--+---+       +---+--+  +--+---+       +---+--+       +----+----+
| PC 1 |       | PC 2 |  | PC 3 |       | PC 4 |       | Phone   |
| DSH  |<----->| DSH  |  | DSH  |<----->| DSH  |<----->| dsh-go  |
| mesh |       | mesh |  | mesh |       | mesh |       | mesh    |
+------+       +------+  +------+       +------+       +---------+
   每个节点 = DSH 引擎 + mesh server + host bridge + 可选桌面 helper
```

## 功能 / Features

- **对等 mesh**：节点之间两两配对，任一节点可向其他节点发委托
- **委托协议**：`delegate / status / reply`，任务有信封、会话、状态与结果文件
- **桌面直控**（可选，默认关闭）：`pc_action`（锁屏/显示桌面/音量/媒体键/关机等）、`pc_app`（启停应用）、`pc_window`（窗口列表/关闭/聚焦）、`pc_browser`（打开浏览器 / CDP 标签页）
- **安全模型**：每节点独立 token + 最小 ACL、deny-by-default、审计日志、限频、可撤销
- **自更新 / 自启**：git 拉取 + supervisor 重启；手机端插件托管（引擎重启后自动恢复）
- **手机支持**：dsh-go（Android）作为控制器，可直控 4 台电脑；低延迟 daemon
- **可视化面板**：设置页「AI 网络」拓扑、委托面板、设备状态

## 快速开始 / Quick start

> 安装器与文档正在整理，预计随 v0.1.0 发布：
> 1. 在一台有公网的 VPS 上部署 relay（`docs/SELF-HOST-RELAY.md`）
> 2. 每台设备安装 `dsh-mesh-node` 插件，输入邀请码入网
> 3. 手机安装 dsh-go 后同样一键入网

## 安全 / Security

远程控制默认**关闭**，必须显式开启；入网需要邀请码；所有调用进审计日志；建议只在**你自己的设备**上使用。详见 [SECURITY.md](SECURITY.md)。

## 路线图 / Roadmap

- [ ] v0.1.0：公开源码、npm 包（`dsh-mesh-node` / `dsh-mesh-ui`）、自建 relay 指南
- [ ] v0.2.0：一键入网（邀请码）、控制面板、Windows/macOS 安装器
- [ ] v0.3.0：dsh-go 插件市场一键安装、手机端体验优化
- [ ] 后续：多 relay 高可用、P2P 打洞、更多平台

## 贡献 / Contributing

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎 issue / PR。

## License

MIT — 见 [LICENSE](LICENSE)。