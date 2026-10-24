# Tent Agent Rules

## 协作边界

- 内部 subagent 仅作临时协作，不创建或冒充 Tent 持久协作对象。
- 未定且影响产品行为或架构的选择先与维护者确认；已授权范围内的常规实现细节自行决定。

## 工程约定

- 提交使用 Conventional Commits：`feat|fix|chore|ci|test|refactor(scope): description`。
- 功能分支压成一个提交合入 main，完成集成后及时推送。
- 主 checkout 用于集成；并行写入需隔离，worktree 按需创建。
- 项目相关目录必须位于本项目根目录内：临时 worktree 放 `.worktrees/`，测试副本和临时数据放 `.scratch/`；不得在父目录或其他全局目录创建项目副本。完成后核验成果并清理临时目录。
- 规则与权威语义放在 `src/core/` 和 `docs/SPEC.md`；CLI、插件层保持薄。

## 远端

- 远端是项目对外的门面，按洁癖标准管理：推上去的每个提交都要有意义、值得记录，不够格的留在本地。
- 一个提交是一件完整、值得记录的改动。措辞、笔误这类小修不单独推，并进下一件相关的改动。
- 在本地做完、窄测通过、压成一个提交后才推。不推半成品，不在远端反复改；CI 没过，在本地修好再推。
- 远端只留 `main` 和 `plugin-dist`。功能分支只为跑三平台 CI 推上去，用 `gh run watch` 等它通过，再快进 main 并推送，随后删掉远端分支，也删掉没合入的提交留下的 CI 运行记录。Role 之间交换分支走本地仓库，不经远端。
- 提交说明写给仓库外的读者：讲改了什么、为什么；不写 Card、Node 编号，也不写 Role 名或人名。
- 不强推 main，不改写已推送的历史。
- tag 只打在 CI 已通过的 main 提交上，与 `manifest.json.version` 完全一致，不加 `v` 前缀。
- 产品能力变了（比如支持新的宿主），仓库简介、README 和 Release 说明一起改。
- `.tent/` 是本地协作状态，不提交到产品仓库。

## 验证

- 窄改动仅跑直接相关测试和 typecheck；阶段回归用 `npm run test:fast`。
- `npm test` / `npm run check` 仅用于发布门禁，或确实跨越 Core 契约、持久化、Service 生命周期和打包边界的改动，不为安心重复跑全套。
