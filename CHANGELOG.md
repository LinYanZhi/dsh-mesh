# Changelog

## 0.3.50 — 2026-11-19

- Fix 拓扑把 Sakura 账号里非 mesh 的隧道（如 home1_music 8787 / home1_music_tls 8790）也画成 AI 网络链路，导致个人1号↔个人2号出现 5 条线；现在只统计 `localPort` 指向当前 mesh server（8124）的 Sakura 隧道。
- 公网 IP/隧道配置未改：自建 frps 仍是 `8.166.118.83:7011~7014`，各节点端口正确。

## 0.3.49 — 2026-11-19

- 回滚 0.3.48 的「看演示 / 上手三步」：演示弹层硬编码 `#fff` 背景，在 DSH 深色主题下变成白底白字（白屏），且默认注入主界面不合适；已移除这两块 UI。
- 保留 0.3.48 的其他修复：`deviceType` 白屏修复、CI 测试、selftest、client 源码拆分。
- 版本：`dsh-mesh-ui@0.0.90`、`@linyanzhi/dsh-mesh@0.3.49`（`dsh-mesh-node` 无改动）。

## 0.3.48 — 2026-11-18

- 版本：`dsh-mesh-node@0.0.24`、`dsh-mesh-ui@0.0.89`、`@linyanzhi/dsh-mesh@0.3.48`（Trusted Publishing 发布）
- Fix 「AI 网络」整块白屏：公开镜像脱敏时 `deviceType` / `formFactorOf` 定义被删；改为 hardware 快照泛化推断并前置，公开包已通过构建不变量检查。感谢 @1349422030 的报告与 PR #10。
- UI: 新增新人上手三步引导（本机就绪 → 发现第二台 → 开始派活）与只读演示模式。
- CI: selftest 53 项、公开构建不变量、客户端纯函数测试全部进 GitHub Actions。
- Refactor: `client.js` 源码拆分为 template + client-parts + CSS，生成物保持不变。
- UI: 新增只读「演示模式」（示例设备/派发/结果/文件传输），不发起任何网络请求；用于单机第一次打开时看完整闭环。

## 0.3.47 — 2026-11-17

- 版本：`dsh-mesh-node@0.0.23`、`dsh-mesh-ui@0.0.88`、`@linyanzhi/dsh-mesh@0.3.47`（Trusted Publishing 发布）
- `dsh-mesh-node`: fix `session_history` on non-`~/.dshN` layouts — `homeOf()` now tries `DSH_HOME` → `~/.dsh` → `~/.dshN` and accepts the first candidate whose `sessions/` exists (issues #4, PR #6).
- `dsh-mesh-node`: fix `session_history` on the Electron desktop app — the script spawn now sets `ELECTRON_RUN_AS_NODE=1` so it does not launch a GUI until timeout (issue #3).
- `dsh-mesh-node`: ship the missing `scripts/session-history.mjs` in the published package (issue #1, PR #7). The source repo already had it; `build-public.mjs` did not copy it.
- `dsh-mesh-node`: export `"./package.json"` so `dsh-mesh-ui`'s `resolveRepo()` fallback no longer throws `ERR_PACKAGE_PATH_NOT_EXPORTED` (issues #2/#8, PR #9).
- `dsh-mesh` CLI: any subcommand accepts `--help`/`-h` and prints help instead of acting (`peer patch --help` no longer rewrites the overlay); `peer add` output now explains that the profile is not mounted automatically and that bare patch entries are silently ignored (issue #5).
- Public build: sanitize the `packages/dsh-mesh` (meta) copy with the same personal-device rules as `dsh-mesh-ui`; the rebuilt mirror no longer carries personal device labels.
- Public repo root now has a `package.json`, so `dsh plugin --profile web add github:LinYanZhi/dsh-mesh` installs the meta plugin (fixes dsh.so L5 install-inventory check on the next re-test).
- AI docs: rewritten `docs/INSTALL-FOR-AGENTS.md`, added `docs/AI-CHECKLIST.md`, `docs/AI-PROMPTS.md`, `docs/TROUBLESHOOTING.zh.md`, and `tools/ai-install.mjs`.
- Thanks to @wenyuwen2011 (issues #1–#5, PRs #6/#7), @blackll7 (issue #8) and @wyf115 (PR #9) for the detailed reports and patches; the fixes were merged into `main`. This project is a dev preview: `main` is the development board, no separate release gate.

## 2026-11-09 — 0.0.2

- `dsh-mesh-node@0.0.2`: tunnel status collection (self-hosted frps + Sakura account tunnels), stricter TLS/cluster handling, new `sakura-api.js` / `tunnels.js` core modules.
- `dsh-mesh-ui@0.0.2`: topology panel redesign — three-channel links (LAN / public relay / Sakura), relay server cards, device filtering, layout autofit and drag fixes.

## 2026-11-09 — 0.0.1

- First public release: `dsh-mesh-node@0.0.1`, `dsh-mesh-host@0.0.1`, `dsh-mesh-ui@0.0.1`, `dsh-mesh-autostart@0.0.1` (host/autostart later 0.0.2 with `dsh.bundle` manifests).

> 更早的历史（0.1.0+ 内部版本）来自私有仓，未公开。

