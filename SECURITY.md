# Security

> dsh-mesh 是给**你自己的设备**用的 AI 网络。它默认不设防到"装上就能用"，所以安全边界需要你确认一遍。
> 本文是公开版安全模型；完整版（含具体风险矩阵与运营 checklist）在源码仓 `docs/SECURITY-MODEL.md`。

## 威胁模型（Threat model）

- 使用者是**一个人**，网络里是**自己的几台设备**（PC + 手机），不是多租户/团队环境
- 目标是跨机 AI 协作：读文件、传文件、委托任务、可选桌面控制
- 给 AI 全权 = 对端 AI 能以**你的用户身份**做任何事（读写、执行、读凭据、操作桌面）
- 主要威胁：① 对端设备被攻破；② 公网明文被嗅探/中间人；③ token/凭据泄露；④ 不可信网络里的陌生节点；⑤ 恶意插件

## 信任分层（建议）

| 层级 | 谁 | 权限 | 网络要求 |
|---|---|---|---|
| **Owner（全权）** | 你自己的设备 | 读写工作区、执行白名单、委托、文件传输、可选桌面控制 | 必须 TLS + 指纹 pin；公网必须隧道 |
| **Temporary（临时）** | 测试机 / 他人设备 | 只读或仅委托；不给写、不给 `pc_*`、不给 shell | 优先局域网；配对码短 TTL、用完撤销 |
| **Untrusted（未配对）** | 发现的其它节点 | 仅能看到广播，不可调用 | — |

实现：**按 peer 配 token 角色/ACL**，不要所有 peer 共用一份默认 ACL。

## 全权授权的四个"必须"

1. **跨公网必须 TLS + 指纹 pin**：`node.tls.enabled=true`；配对时 `--fingerprint`（或 `--ca`）；证书轮换后重新配对
2. **凭据目录排除在 fsRoots 之外**：全权 ≠ 交出 `~/.ssh`、`~/.dsh*/.credentials.yaml`、`~/.dsh-mesh`（token/私钥）、浏览器 profile、`.git-credentials`
3. **网络收口**：mesh 默认 `bind: 127.0.0.1`；跨网只走隧道；隧道端口非默认、云安全组限制来源；frps `auth.token` 长随机、dashboard 只监听 `127.0.0.1`
4. **可观测 + 可撤销**：`~/.dsh-mesh/audit.jsonl`、peer 清单巡检、异常告警、`token revoke` 一键撤销

## 默认值

| 项 | 默认 | 备注 |
|---|---|---|
| `node.bind` | `127.0.0.1` | 不主动暴露 |
| `node.tls.enabled` | `false` | 跨公网必须手动开 |
| `acl.allow` | 默认工具集（读/写/委托/传输/日志） | deny-by-default，但对所有已配对 peer 生效 |
| `acl.fsRoots` | 源码仓目录 | 不含主目录；但含代码 = 含 `.git` 配置 |
| `shell.enabled` | `false` | `shell_run` 双闸门 |
| `repair.enabled` | `false` | 修复类工具默认关 |
| `pc_*` 桌面控制 | 默认关 | 需要显式开启 |
| 配对码 | 一次性，默认 30 分钟、失败 5 次 | — |
| 传输配额 | 4 MB/块、256 MB/文件、2 GB/天 | 防滥用 |
| 审计 | `audit.jsonl` | 只增；分享前脱敏 |

## 自检（只读）

```sh
node tools/security-audit.mjs          # 人类可读
node tools/security-audit.mjs --json   # 给脚本/AI 解析
node tools/security-audit.mjs --strict # 有 P0 时 exit 2
```

检查项：`bind`/TLS/证书、监听地址是否所有网卡、ACL 是否放行高风险工具（`shell_run`/`host_call`/`channel_*`/`repair_*`/`pc_*`）、`fsRoots` 是否覆盖凭据目录、公网 peer 是否 https 且带指纹、`secrets.json`/`host-token` 存在性、frpc 是否把 8124 映射到公网端口。

**不联网、不改配置、不打印 token/私钥。**

## 明确不做（避免误解）

- 不是零信任/多租户平台：没有企业 SSO、没有审计认证
- 不防"你自己的机器被管理员级入侵"
- 不防恶意插件：DSH 插件是 in-process JS，权限等于你
- 全权 peer 就是全权：边界靠设备信任 + fsRoots + 网络，而不是沙箱

## 补充：fsRoots 内部也要查凭据（2026-11-12）

`acl.fsRoots` 只限制"能读哪些目录"，**不保证目录里的内容安全**。如果工作区内残留 `.credentials.yaml`、`*.token`、`host-token*` 等文件，已配对的 peer 仍然可以读。

建议：
- 定期扫 `fsRoots` 内的凭据/令牌文件，移到 fsRoots 之外（例如 `~/.dsh-mesh-secrets-archive/<日期>/`，移动不删除，保留清单）
- `tools/security-audit.mjs` 会检查 fsRoots 是否覆盖主目录/凭据目录；文件级扫描需要自己按上面规则做
- 归档目录不要在 fsRoots 内，否则等于没做

## Reporting a vulnerability

Please open a private security advisory on GitHub, or contact the maintainer via the GitHub profile. Do not create a public issue for unpatched vulnerabilities.
