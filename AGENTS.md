# Tent Agent Rules

Tent 把项目上下文维护成本地 Markdown 图谱：Node 记可复用的事实，Card 记交给某个 Role 的一轮输入，Role 是某类会话的定位。权威语义在 `docs/SPEC.md`，规则代码在 `src/core/`。

这份文件是本仓库所有会话共用的说明；只对某个 Role 生效的写在它的 Role 文件里。

## 开工

- 本仓库自己用 Tent，图在 `.tent/`，是本地协作状态，不提交。
- 拿着 Role 的会话，接手或压缩后读一次 `tent role show <role>` 和 `tent workspace brief --role <role>`：前者是定位，后者是手上的活。进度不写进 Role 文件。
- 要结果的 Card 做完就交回。跨 Role 的事发 Card，不改别的 Role 的 worktree。

## 谁定什么

- 未定且影响产品行为或架构的选择，先问维护者（本地协作里发 Card 给 judge）；已授权范围内的实现细节自己定。
- Agent 侧文字（Skill、references、Hook 句、CLI 提示）由 judge 写。
- 内部 subagent 仅作临时协作，不创建或冒充 Tent 持久协作对象。

## 设计约束

- 规则与权威语义放在 `src/core/` 和 `docs/SPEC.md`；CLI、插件层保持薄。
- Tent 只管 Agent 一轮工作的开头和结尾；读、改、搜交给宿主自带的工具，不另造。
- 复杂可以留在 Core 和服务里，Agent 看到的要轻、稳定：Hook 注入、Skill、CLI 输出和错误信息在同一状态下反复读字节相同，错误信息直接说下一条该敲什么。
- 不做旧兼容：产品代码不容忍旧格式，旧数据用一次性脚本彻底转换。
- 宿主差异（Hook 字段、唤醒方式）放在 `plugins/` 下各宿主的包里，不进 Core。

## 工程约定

- 提交使用 Conventional Commits：`feat|fix|chore|ci|test|refactor(scope): description`。
- 功能分支压成一个提交合入 main，完成集成后及时推送。
- 主 checkout 用于集成；并行写入需隔离，worktree 按需创建。
- 项目相关目录必须位于本项目根目录内：临时 worktree 放 `.worktrees/`，测试副本和临时数据放 `.scratch/`；不得在父目录或其他全局目录创建项目副本。完成后核验成果并清理临时目录。
- 格式、文件命名和测试分层见 `CONTRIBUTING.md`。

## 远端

- 远端是项目对外的门面，按洁癖标准管理：推上去的每个提交都要有意义、值得记录，不够格的留在本地。
- 一个提交是一件完整、值得记录的改动。措辞、笔误这类小修不单独推，并进下一件相关的改动。
- 在本地做完、窄测通过、压成一个提交后才推。不推半成品，不在远端反复改；CI 没过，在本地修好再推。
- 远端只留 `main` 和 `plugin-dist`。功能分支只为跑三平台 CI 推上去，用 `gh run watch` 等它通过，再快进 main 并推送，随后删掉远端分支，也删掉没合入的提交留下的 CI 运行记录。Role 之间交换分支走本地仓库，不经远端。
- 提交说明写给仓库外的读者：讲改了什么、为什么；不写 Card、Node 编号，也不写 Role 名或人名。
- 不强推 main，不改写已推送的历史。
- tag 只打在 CI 已通过的 main 提交上，与 `manifest.json.version` 完全一致，不加 `v` 前缀。
- 产品能力变了（比如支持新的宿主），仓库简介、README 和 Release 说明一起改。

## 验证

- 窄改动仅跑直接相关测试和 typecheck；阶段回归用 `npm run test:fast`。
- `npm test` / `npm run check` 仅用于发布门禁，或确实跨越 Core 契约、持久化、Service 生命周期和打包边界的改动，不为安心重复跑全套。
- 整套测试、构建打包、整轮浏览器验证、性能测量全机同一时间只跑一项；typecheck、格式检查和直接相关的测试随时可跑。
- 测试和试用不读写真实 `.tent/`，在 `.scratch/` 的副本上做。
- 证据够复查就行：提交号、跑的命令、原始输出和数字。不做封存清单、逐件 SHA 主核，也不对自己子任务的产物再全量核一遍。
- 非作者独立验收只用于碰 Core 契约、持久化、Service 生命周期、打包边界、Hook 与 Skill 行为的改动，以及发版前；其他改动作者测完即可集成，judge 抽查。
- 实验和测量的严谨度跟着要做的决定走；实验脚本不走独立验收。
