# 自建中继（frps）/ Self-hosted relay

> 同一局域网不需要中继。只有当你希望**跨网络**（家里 ↔ 公司 ↔ 手机）互联时，才需要给节点一个公网入口。
> 本文用最常用的 **frp** 举例：一台有公网 IP 的 VPS 跑 frps，每台节点跑 frpc，把本机 `127.0.0.1:8124` 映射出去。

---

## 1. 你需要准备

- 一台**有公网 IP 的 Linux VPS**（作者用 2C/2G 的轻量云服务器，frps 内存占用很小）
- 一个可用端口：默认 `7000`（frps 控制端口）
- 每台节点机器能访问 VPS 的 `7000`，以及你分配给各节点的隧道端口（示例 `7011`、`7012`…）
- 可选：域名（不必须，直接 IP 也能用；dsh-mesh 用证书指纹 pin，不依赖域名）

> 安全提醒：不要把节点的 `8124` 直接暴露到公网。正确做法是 `frpc` 把 `127.0.0.1:8124` 转发到 frps，公网只看到隧道端口。

## 2. 部署 frps（VPS 上）

下载 frp release（linux amd64），解压到 `/opt/frps/`，编辑 `/opt/frps/frps.toml`：

```toml
bindPort = 7000

# 认证令牌：改成你自己的随机长字符串，不要提交到 git
auth.method = "token"
auth.token = "CHANGE_ME_TO_A_LONG_RANDOM_TOKEN"

# dashboard 只监听本机，用于自己排查
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "CHANGE_ME_TOO"

# 可选：强制 TLS（frpc 端也要配 transport.tls）
# transport.tls.force = true
```

systemd 服务 `/etc/systemd/system/frps.service`：

```ini
[Unit]
Description=frps
After=network.target

[Service]
Type=simple
ExecStart=/opt/frps/frps -c /opt/frps/frps.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now frps
sudo systemctl status frps
```

**防火墙 / 云安全组**：入方向放行 `7000/tcp` 和你计划给各节点的隧道端口（如 `7011-7020/tcp`）。

## 3. 每台节点跑 frpc

在节点机器上准备 `frpc.toml`（Windows 可用 `C:\Users\<你>\Code\dsh-mesh\.runtime\frpc\frpc.toml`，不要提交到 git）：

```toml
serverAddr = "你的VPS公网IP或域名"
serverPort = 7000

auth.method = "token"
auth.token = "CHANGE_ME_TO_A_LONG_RANDOM_TOKEN"

# 如果 frps 开了 transport.tls.force，这里也要开
# transport.tls.enable = true

[[proxies]]
name = "home-pc-mesh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8124
remotePort = 7011
```

- `localPort` 必须是 `8124`（mesh 服务默认端口），且 mesh 监听在 `127.0.0.1`
- `remotePort` 每台机器分配不同值（例如家里 `7011`、公司 `7012`、手机 `7014`）
- 启动：`frpc -c frpc.toml`

### 开机自启

- **Windows**：用计划任务（登录触发或开机触发）跑 `frpc.exe -c <path>\frpc.toml`，窗口隐藏；也可用项目里的 `dsh-mesh-autostart` 插件托管
- **Linux**：写 systemd unit，同上
- **手机（Android + proot）**：把 frpc 放到 proot 内，配置同上；依赖手机端常驻进程/自启能力

## 4. 在 dsh-mesh 里使用

1. 节点 mesh 服务保持监听 `127.0.0.1:8124`
2. 配对时，对端地址填：`https://你的VPS:7011`（对应家里那台的 remotePort）
3. 两台机器交换一次性配对码：

```sh
# A（被访问端）出码
dsh-mesh pair --code

# B（主动连接端）兑换
dsh-mesh peer add --url https://你的VPS:7011 --code <配对码> --name home
```

4. 配对成功后 `dsh-mesh cluster status` 应看到节点在线。

> 如果用的是面板：被访问端「局域网连接」生成配对码，另一台手动填 `https://VPS:端口` + 码。

## 5. 验证

在任意机器：

```sh
# 直连隧道端口，看 mesh 是否应答
curl -k https://你的VPS:7011/health

# Windows PowerShell
Test-NetConnection 你的VPS -Port 7011
```

返回 JSON（含 `"ok": true`、`version`、`node`）即隧道通。

## 6. 安全建议

- **不要**把 `8124` 暴露到公网；只暴露 frps 控制端口和隧道端口
- frps 的 `auth.token` 要长且随机，**只放在服务器和节点本地配置里**，不要提交 git、不要发聊天
- 隧道端口可以用非默认值，减少被扫；云安全组尽量限制来源 IP（有固定出口时）
- dsh-mesh 自身仍然做 TLS + 证书指纹 pin + token ACL；frp 只是传输层
- 定期轮换 frps token：改 frps.toml → 重启 frps → 同步改各节点 frpc.toml → 重启 frpc
- 公共/不可信网络不要依赖"隐藏端口"当安全措施

## 7. 常见问题

| 现象 | 排查 |
|---|---|
| `Connection refused` | frpc 没跑 / remotePort 没在 frps 上注册 / 安全组未放行 |
| `dial tcp ... connect: connection refused`（frpc 日志） | `localPort` 写错，或 mesh 没在 `127.0.0.1:8124` 监听 |
| `token in login doesn't match` | frpc 与 frps 的 token 不一致 |
| TLS 握手失败 | 一边开了 `transport.tls.force`，另一边没开 |
| 隧道通但 dsh-mesh 连不上 | 配对地址协议/端口错，或对端证书指纹变了（重新配对） |
| 经常断 | VPS 网络抖动；frpc 配 `transport.heartbeatInterval`；或改用 Sakura/Tailscale 做备用 |

## 8. 不想自建？

同样原理的替代品：

- **樱花内网穿透（SakuraFrp）**：面板建 TCP 隧道，本地 `127.0.0.1:8124`，得到 `域名:端口`
- **Cloudflare Tunnel**：`cloudflared tunnel --url http://127.0.0.1:8124`
- **Tailscale / WireGuard**：直接把几台机器放进同一虚拟局域网，走局域网模式

选择原则：**只要能让对端访问到本机的 `8124` 即可**，dsh-mesh 不关心你用哪种隧道。
