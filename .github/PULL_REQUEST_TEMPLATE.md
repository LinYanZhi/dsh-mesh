## 改动

<!-- 一句话说明改了什么 -->

## 原因

<!-- 修复的 issue / 真实场景 / 为什么现在需要 -->

## 验证

- [ ] `node --check` 通过
- [ ] `node packages/dsh-mesh-node/src/selftest.js` 通过（如涉及 node 包）
- [ ] `node tools/check-public-build.mjs` 通过（如涉及公开包/构建）
- [ ] 手工验证步骤：

## 风险 / 回滚

<!-- 行为/API/依赖变化；怎么回滚 -->

## 备注

- 不要提交 token、配对码、私网地址、个人路径。
- 如果改的是 `packages/*`（构建产物），请说明；维护者会以源码为准并 rebuild。
