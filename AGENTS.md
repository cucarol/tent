# Tent Agent Rules

## 协作边界

- 内部 subagent 仅作临时协作，不创建或冒充 Tent 持久协作对象。
- 未定且影响产品行为或架构的选择先与维护者确认；已授权范围内的常规实现细节自行决定。

## 工程约定

- 提交使用 Conventional Commits：`feat|fix|chore|ci|test|refactor(scope): description`。
- 功能分支压成一个提交合入 main，完成集成后及时推送。
- `archive/full-history` 保存重写前的本地历史，不推送、不删除。
- 主 checkout 用于集成；并行写入需隔离，worktree 按需创建。
- 项目相关目录必须位于本项目根目录内：临时 worktree 放 `.worktrees/`，测试副本和临时数据放 `.scratch/`；不得在父目录或其他全局目录创建项目副本。完成后核验成果并清理临时目录。
- 发布 tag 与 `manifest.json.version` 完全一致，不加 `v` 前缀。
- 规则与权威语义放在 `src/core/` 和 `docs/SPEC.md`；CLI、插件层保持薄。
- `.tent/` 是本地协作状态，不提交到产品仓库。

## 验证

- 窄改动仅跑直接相关测试和 typecheck；阶段回归用 `npm run test:fast`。
- `npm test` / `npm run check` 仅用于发布门禁，或确实跨越 Core 契约、持久化、Service 生命周期和打包边界的改动，不为安心重复跑全套。
