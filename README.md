# dsh-mesh

**把你自己几台电脑（和手机）上的 DSH 连成一个 AI 网络：互相看见、互相读文件、互相派任务。**

**A multi-node AI network for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): turn your PCs and phones into one mesh where agents can see each other, transfer files, and delegate work across devices.**

> 状态：**早期版本（0.x preview）**。能日常使用，但接口和配置格式还会变。适合愿意自己动手的开发者；不适合对稳定性/商业支持有要求的人。请先看 [适合谁 / 不适合谁](#适合谁--不适合谁)。

![AI 网络拓扑](docs/images/ai-network.png)

*「AI 网络」左侧栏页面：拓扑、链路类型（局域网/公网/内网穿透）、节点健康、通道地址与离线状态。公网 IP/域名默认隐藏，可在页头手动显示。*

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [适合谁 / 不适合谁](#适合谁--不适合谁)
- [安装前需要准备什么](#安装前需要准备什么)
- [安装](#安装)
- [5 分钟上手（两台机器）](#5-分钟上手两台机器)
- [界面里有什么](#界面里有什么)
- [架构](#架构)
- [安全与隐私](#安全与隐私)
- [已知限制](#已知限制)
- [让 AI 自己安装](#让-ai-自己安装)
- [文档](#文档)
- [English TL;DR](#english-tldr)
- [Contributing](#contributing)
- [License](#license)

---

## 它解决什么问题

多台电脑各装一个 DSH，但它们互相看不见：公司机上的 AI 不知道你家里那台的文件，你也没法让它把任务交给另一台机器跑。

dsh-mesh 让每台装了 DSH 的设备成为网络里的一个**对等节点**：

- **互相看得见**：一个侧栏页面看到所有节点、链路类型、延迟、版本、实例状态
- **跨机读/传文件**：让 AI 从对端读文件，或走 mesh 文件传输（分块 + 大小/哈希校验）
- **AI 之间互相派任务**：委托协议（任务信封 + 状态机 + 结果落盘），不是靠人转发
- **局域网优先**：同一网段直接连；跨公网时用你自己的 frp/樱花/Tailscale，不经过任何第三方云

核心不是"远程控制"，而是**AI 之间互相调用**：你负责配对一次和看状态，搬运交给它们。

## 适合谁 / 不适合谁

### ✅ 适合

- 有 **2 台以上**自己长期开机的电脑/手机，都跑 DSH
- 愿意用命令行装插件、配端口/防火墙，或愿意用 frp / 樱花 / Tailscale 打通网络
- 想让 AI 跨机器读文件、传文件、派任务
- 能接受早期软件：偶尔要人肉排障、看日志、提 issue

### ❌ 不适合

- 只有 1 台电脑、也不打算加第二台（装了只能看到自己）
- 完全不想碰命令行（现阶段没有一键安装器）
- 机器在**不可信网络**（公司公共网、合租、咖啡厅）又不愿配置配对码 + ACL
- 需要商业 SLA / 安全认证
- 想要通用"远程桌面 / SSH 替代品"（桌面直控是可选能力且默认关闭，不是它的定位）
- 主力 macOS / Linux / 手机（Windows 10/11 验证最充分，其他平台能跑但别指望零坑）
- 介意"DSH 插件是 in-process JS，权限等于你的用户权限"（所有插件都是这个模型）

## 安装前需要准备什么

### 每台机器

- **系统**：Windows 10/11 x64（主力）；macOS / Linux 可跑服务端与桥，但自启等部分功能未验证
- **DSH**：`0.2.2-rc.1`（兼容 `0.2.0-rc.2` ~ `0.2.x`；多台机器尽量同版本）
- **Node**：`22.19+` 或 `24+`（DSH 自带运行时）
- **权限**：管理员权限（装插件、防火墙、开机自启）
- 磁盘/内存占用很小（1–2 GB 足够）

### 网络（二选一或都配）

1. **同一局域网**（最简单）：两台机器能互访 `8124/tcp`
2. **跨网络**：每台机器需要一个公网 TCP 入口，常见做法：
   - 自建 frps（作者用法，见 [docs/SELF-HOST-RELAY.md](docs/SELF-HOST-RELAY.md)）
   - 樱花内网穿透（SakuraFrp）
   - Cloudflare Tunnel / Tailscale 等，原理相同：把 `127.0.0.1:8124` 映射出去

### 端口

| 端口 | 用途 |
|---|---|
| `8124/tcp` | mesh 服务（节点间通信；需要时绑 `0.0.0.0`） |
| `9100 / 9101 / 9102` | 各 DSH 实例宿主桥（只监听 `127.0.0.1`，不用对外开放） |
| `8129/udp` | 局域网发现（可选；被拦就手动填 IP） |
| `7000+`（示例） | 你自己的 frp 公网端口 |

## 安装

> 一条命令装齐（推荐）：UI 页面 + mesh 服务端 + 宿主桥 + 自启守护

```sh
dsh plugin --profile web add @linyanzhi/dsh-mesh
```

装完 **重启这个 DSH 实例**（只刷新页面不生效），左侧栏会出现 **AI 网络**。

也提供分包安装（进阶/旧方式）：

| 包 | 作用 |
|---|---|
| [`@linyanzhi/dsh-mesh`](https://www.npmjs.com/package/@linyanzhi/dsh-mesh) | 一条命令装齐（推荐） |
| [`dsh-mesh-ui`](https://www.npmjs.com/package/dsh-mesh-ui) | 「AI 网络」侧栏页 |
| [`dsh-mesh-host`](https://www.npmjs.com/package/dsh-mesh-host) | DSH 宿主桥（每个实例一个，loopback） |
| [`dsh-mesh-node`](https://www.npmjs.com/package/dsh-mesh-node) | mesh 服务端 / 节点传输 |
| [`dsh-mesh-autostart`](https://www.npmjs.com/package/dsh-mesh-autostart) | 引擎重启后保持 mesh 服务存活 |

## 5 分钟上手（两台机器）

### 1. 两台都装

```sh
dsh plugin --profile web add @linyanzhi/dsh-mesh
```

分别重启各自的 DSH 实例。

### 2. 确认入口

左侧栏出现 **AI 网络**。点开能看到本机实例、对端节点、右侧面板（局域网连接/公网连接/内网穿透/节点管理/文件传输/委托台账/告警/诊断）。

### 3. 被访问端生成配对码

「AI 网络」→「局域网连接」→ **生成我的配对码**，得到一次性配对码（默认 10 分钟有效）。

跨网络时，先把监听地址改成 `0.0.0.0:8124`，再用 frp/隧道映射出 `域名:端口`。

### 4. 另一台配对

「AI 网络」→「局域网连接」：

- 点 **扫描局域网** 找到对方 → 填配对码 → **用此节点配对**
- 或手动填 `https://IP:8124` + 配对码

配对成功后拓扑里出现对端，token 存在各自 `~/.dsh-mesh/`（不进 git、不上传）。

### 5. 验证

对 AI 说「看一下 AI 网络状态，列出所有节点」；或命令行：

```sh
dsh-mesh host status            # 宿主桥是否在 DSH 内存活
dsh-mesh cluster status         # 本机 + 已配对节点的实例/延迟
```

> 如果你是从源码仓库（`dsh-mesh` 开发仓）运行，还能用 `node scripts/mesh-health.mjs --fast` 等脚本。

更多细节见 [docs/INSTALL.md](docs/INSTALL.md) 和 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

## 界面里有什么

「AI 网络」页面（独立侧栏页，不再挤在设置里）：

- **拓扑图**：本机居中，其它设备扇形排开；连线 = 通道
- **通道类型**：局域网（绿实线）/ 公网（蓝虚线）/ 内网穿透如樱花（紫虚线）；离线通道变红
- **悬浮设备卡**：每条通道的地址与状态，断开的标红「离线」
- **右侧面板**：局域网连接（扫描/配对）、公网连接、内网穿透、节点管理、文件传输（本机/全网记录）、委托台账、告警历史、诊断建议、权限设置
- **隐私**：公网 IP/域名默认显示「公网地址已隐藏」，页头开关可展开并记忆
- **多实例**：一个 DSH 实例一个宿主桥（9100+），面板里逐实例展示

## 架构

```
                    +------------------------------+
                    |   Relay（可选，自建 frps）     |
                    +--------------+---------------+
         TLS + per-peer token     |
   +---------------+--------+------+--------+---------------+
   |               |        |               |               |
+--+---+       +---+--+  +--+---+       +---+--+       +----+----+
| PC 1 |<----->| PC 2 |  | PC 3 |<----->| PC 4 |<----->| Phone   |
| DSH  |       | DSH  |  | DSH  |       | DSH  |       | dsh-go  |
+------+       +------+  +------+       +------+       +---------+
每个节点 = DSH 引擎 + mesh server + host bridge（+ 可选桌面 helper）
```

- **mesh server**：每节点一个 MCP-over-HTTPS 服务，把本机能力暴露给 peer
- **host bridge**：DSH 宿主插件，让 mesh server 能创建会话、发消息、调用本机工具
- **relay**：可选；同局域网不需要。跨 NAT 时用自建 frps/隧道
- **桌面直控**（可选，默认关闭）：`pc_action` / `pc_app` / `pc_window` / `pc_browser`

## 安全与隐私

- **发现不等于连接**：局域网扫描只列节点；建立连接必须一方生成一次性配对码、另一方兑换
- 节点间 TLS（自签证书 + 指纹固定），每个 peer 独立 token（服务端只存哈希），可随时撤销
- 默认 ACL：允许读/检索/写对端 `~/Code`、读会话历史与日志、委托任务；`shell_run`、频道消息、远程桌面、修复类操作默认**关闭**
- `/api/dsh-mesh/*` 只接受本机回环请求
- 没有云端：数据只在你自己的机器和你的隧道之间
- 桌面直控默认关闭，需要显式开启；不建议在不可信网络裸奔
- 详细安全模型与风险：[SECURITY.md](SECURITY.md) · 权限说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 只读安全自检（不联网、不改配置）：`node tools/security-audit.mjs`

## 已知限制

- **0.x 早期**：接口、配置格式可能变化，升级前看 [CHANGELOG.md](CHANGELOG.md)
- **Windows 优先**：开机自启、远程重启等只做了 Windows
- **手机节点**：Android + proot 可跑，属实验性；樱花客户端需自己保证常驻
- **版本一致**：多台机器建议锁同版本 DSH + 插件；不一致时部分工具不可用
- **需要动手**：端口、防火墙、frp、证书、重启都可能要你亲自处理
- **不是通用远程桌面/SSH 替代品**；桌面控制是可选能力且默认关闭
- 没有多用户/团队权限：这是给**一个人自己的几台机器**用的

## 让 AI 自己安装

把这段发给你的 DSH AI：

```
请帮我安装 dsh-mesh 插件，按 https://github.com/LinYanZhi/dsh-mesh/blob/main/docs/INSTALL-FOR-AGENTS.md 执行：
1) 确认 Node >= 22、DSH >= 0.2.0-rc.2，找到我当前使用的 DSH profile
2) 安装并验证 @linyanzhi/dsh-mesh（或 dsh-mesh-host / dsh-mesh-ui / dsh-mesh-autostart）
3) 需要重启 DSH 时先问我
4) 不要开启远程桌面控制（pcControl）
5) 每一步报告验证结果，失败就停下来
```

## 文档

| 想知道什么 | 去哪 |
|---|---|
| 一步步安装（给人看） | [docs/INSTALL.md](docs/INSTALL.md) |
| 最短快速开始 | [docs/QUICKSTART.md](docs/QUICKSTART.md) |
| 让 AI 自己装 | [docs/INSTALL-FOR-AGENTS.md](docs/INSTALL-FOR-AGENTS.md) |
| 架构 / 权限 / 组件 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 开发历程（为什么这样设计） | [docs/HISTORY.md](docs/HISTORY.md) |
| 公网中继（自建 frps） | [docs/SELF-HOST-RELAY.md](docs/SELF-HOST-RELAY.md) |
| 安全模型 / 风险 | [SECURITY.md](SECURITY.md) |
| 安全自检脚本（只读） | `node tools/security-audit.mjs`（源码见 [tools/security-audit.mjs](tools/security-audit.mjs)） |
| 版本变更 | [CHANGELOG.md](CHANGELOG.md) |
| 参与开发 | [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |

> 本仓库用于发布说明、安装文档与 AI 安装指南；实际代码以 npm 包形式发布（`@linyanzhi/dsh-mesh` 等）。

## English TL;DR

**dsh-mesh** connects your own DSH instances (PCs and phones) into one AI network: sidebar topology with link types, cross-machine file transfer, and task delegation between agents. LAN-first; bring your own relay (frp/Sakura/Tailscale) only when crossing networks. No cloud relay, no accounts.

Requires Windows 10/11 (primary), DSH `0.2.2-rc.1` (compatible `0.2.0-rc.2`–`0.2.x`), reachable TCP `8124`, admin rights. Early 0.x preview; not a general remote-desktop/SSH replacement; desktop-control tools are opt-in and off by default.

```sh
dsh plugin --profile web add @linyanzhi/dsh-mesh
# restart DSH, then open "AI 网络" in the left sidebar
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). 中文 / English both welcome.

## License

MIT — see [LICENSE](LICENSE).
