# Install dsh-mesh / 安装指南

> 如果你只想让 AI 帮你装：把下面这段「复制给 AI」发给你的 DSH，它会按 [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) 执行。

## 复制给 AI 的 Prompt

```
请帮我安装 dsh-mesh 插件。按 https://github.com/LinYanZhi/dsh-mesh/blob/main/docs/INSTALL-FOR-AGENTS.md
的步骤执行，注意：
1) 先确认 Node >= 22、DSH >= 0.2.0-rc.2，并找到我当前使用的 DSH profile
2) 安装并验证 dsh-mesh-host / dsh-mesh-ui / dsh-mesh-autostart 三个插件
3) 需要重启 DSH 时先问我
4) 不要开启远程桌面控制（pcControl）
5) 每一步把验证结果告诉我，失败就停下来报告错误
```

## 你需要准备

- 一台装了 DSH 的电脑（Windows / macOS / Linux），Node.js >= 22
- 想组网时：另一台也装了 DSH 的设备；跨公网还需要一台有公网的 VPS 做中继（见 [SELF-HOST-RELAY.md](SELF-HOST-RELAY.md)）
- 不需要 Root / 管理员权限（Windows 远程桌面 helper 例外，需要管理员建计划任务）

## 手动安装（三步）

### 1. 安装插件

```sh
dsh plugin --profile web add dsh-mesh-host dsh-mesh-ui dsh-mesh-autostart
```

装完**重启 DSH**，打开 **设置 → AI 网络**，能看到面板就成功了。

### 2. 启动本机 mesh 节点

```sh
npm i -g dsh-mesh-node
dsh-mesh tls init     # 可选：自签 HTTPS（推荐）
dsh-mesh serve        # 默认监听 0.0.0.0:8124
```

### 3. 两台机器配对

A 机：

```sh
dsh-mesh pair --code
# 得到一个 30 分钟有效的配对码
```

B 机：

```sh
dsh-mesh peer add --url https://<A的地址>:8124 --code <配对码> --name node-a
dsh-mesh peer call mesh_self --to node-a
```

反向再配一次（B 出码、A 兑换）即成为对称网络。

## 安全默认值

- 远程桌面控制（`pc_action` / `pc_app` / `pc_window` / `pc_browser`）**默认关闭**
- 每个 peer 独立 token + 最小 ACL；token 一次性显示，请立即保存到安全位置
- 所有调用写入 `~/.dsh-mesh/audit.jsonl`
- 不要把 `~/.dsh-mesh/` 提交到任何 git 仓库

## 常见问题

| 现象 | 处理 |
|---|---|
| 设置页没有「AI 网络」 | 确认 `dsh plugin add` 成功后重启 DSH，浏览器 Ctrl+Shift+R 硬刷新 |
| 面板报错 / 空白 | 检查 profile 的 `cordis.patch.yml` 是否包含三个插件条目；看浏览器 console |
| `dsh-mesh serve` 启动失败 | 端口被占用（默认 8124）；用 `--port` 换端口 |
| 配对失败 | 确认对方 URL 的协议（https）、端口和证书指纹；必要时先 `dsh-mesh tls init` |
| Windows 上看不到窗口 | mesh 服务在 session 0；安装 `tools/pc-helper/install-desktop-helper-task.mjs` |
| 手机（dsh-go） | 在手机 proot 终端里同样用 `dsh plugin --profile web add ...`，路径可能是 `/root/.dsh` |

## 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-mesh-ui dsh-mesh-host dsh-mesh-autostart
npm uninstall -g dsh-mesh-node
```

配置文件在 `~/.dsh-mesh/`，需要时手动删除（含 token，删除后无法恢复）。

---

更多：[给 AI 的安装指南](INSTALL-FOR-AGENTS.md) · [架构](ARCHITECTURE.md) · [开发历程](HISTORY.md)
