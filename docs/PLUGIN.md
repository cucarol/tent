# Tent Agent 插件

插件提供四个 Skill、SessionStart 与请求异步执行的 Stop Hook，以及同包 CLI。Node、Role、Card 的读写规则在 Core；Skill 按工作需要提供操作指引。

## 构建与安装

需要 Node.js 22.19+ 和 Git。可从 [0.1.1 Release](https://github.com/cucarol/tent/releases/tag/0.1.1) 下载 `tent-plugin-0.1.1.zip`，解压到准备保留的目录。交付根目录下应同时有 `.agents/plugins/marketplace.json` 和 `plugins/tent/`；使用下方 marketplace 命令安装，无需 npm install。插件运行时只使用 JavaScript、Node 内置模块与静态资源，同一个包可在支持的 Windows、macOS 和 Linux 环境运行。

从源码构建时执行：

```sh
npm ci --ignore-scripts
npm run plugin:build
```

`release/plugins/tent/` 是完整插件；`plugins/tent/` 是源模板。可指定另一个尚不存在的输出目录，如 `release/local/plugins/tent`。构建不会覆盖已有交付或注册全局配置。运行依赖随包携带，安装后不依赖源码仓库的 node_modules、全局 Tent 或下载媒体工具。

交付根目录包含本地 marketplace，可通过宿主的插件流程安装：

```sh
codex plugin marketplace add "<交付根目录的绝对路径>"
codex plugin add tent@tent-local
```

插件清单位于 `.codex-plugin/plugin.json`，Hook 定义位于 `hooks/hooks.json`。新安装或修改后的 Hook 需要宿主信任审查；不要手写信任值。安装后在实际宿主中检查发现、启用和事件投递，配置文件存在不代表已经生效。

npm 包 `vibe-tent`（Release 中附为 `vibe-tent-0.1.1.tgz`）是单独的 CLI 包，用 `npm install -g vibe-tent` 安装后使用 `tent` 命令。它不是完整的 Codex 插件交付目录。

## 按需入口

| 工作 | Skill | CLI |
| --- | --- | --- |
| 新建空 Tent 和独立本地 Git | tent-init | new |
| 查找、读取、维护有用事实 | tent-node | node |
| 创建、读取、维护持久工作方向 | tent-role | role |
| 记录、预览、接收一次输入 | tent-card | card |

普通工作不要求创建 Role 或 Card。Role 可以独立建立；没有 Role 的 Session 也可接收无 target 的 Card，有 target 时必须指定对应 Role。初始化不分析项目或生成首批 Node；当前 Agent 在工作中按需维护相关事实，没有额外 Return。

Agent 从 Skill 的实际安装位置调用同包入口：

```sh
node "<插件目录>/skill-resources/scripts/tent.mjs" new "<工作区目录>"
node "<插件目录>/skill-resources/scripts/tent.mjs" node list --workspace "<工作区目录>" --json
```

Node、Role、Card 命令直接调用 Core，不登记宿主 Session。含 `.tent/` 的目录是唯一工作区；其他 cwd 通过 `--workspace` 明确指定。路径从声明它的 Markdown 解析。真实文件、图片、网页等由宿主已有工具读取，Tent 不提供应用或格式适配。

需要画草图时，用 Excalidraw 本身保存工作区文件，再由 Node 引用该文件。

包内包含 CLI 与 Web UI 静态资源。运行同包 `cli.mjs ui --workspace <工作区路径>` 可打开界面（例如 `node <插件路径>/cli.mjs ui --workspace <工作区路径>`）；`--no-open` 只打印地址。服务仅在当前终端前台运行，Ctrl+C 退出，不注册 Session。其他命令直接读写文档和 Git，无需启动 UI 服务。

## Role 与 Card 的维护者说明

Role 在 `.tent/roles/<role-id>.md` 中保存持续方向的目的、边界、方法和 Node 入口。它提供上下文，不占用锁，也不登记或绑定宿主 Session；多个会话可以按同一 Role 工作。共享事实由 Node 保存，Role 只链接事实入口。

Card 保存一次固定输入：短指令、可选接收 Role，以及按顺序排列的来源。Node 和 Role 来源钉住所选版本，其他来源保留地址。CLI 将从 Workspace 根目录传入的路径转换为相对 Card 文档的地址。发布后的 prompt、title 和 sources 不可修改；需求变化写回来源 Node，接收者在 brief 中获知变化后读取当前 Node。尚未决定的要求留在 draft Node。

`show` 只预览，`take` 记录接收。重复接收返回 `replayed: true`，应继续已有工作。`pending` 表示尚未接收，`consumed` 表示已经接收，完成后仍保持该状态。有 target 的 Card 必须带对应 Role 接收；公开 Card 可不带 Role。仅 pending Card 可以改派；取消使用 `deprecate`，保留原输入与接收记录，默认列表隐藏它。

进度由 Card 来源中的 goal 和实际产出决定：`received-no-output` 表示已接收但尚无对应结果，`needs-review` 表示有待复核的响应，`has-output` 表示每个请求目标下已有当前有效的实现产出。`goalCount` 与 `totalGoalCount` 分别是已满足与请求的目标数。没有 goal 来源的 Card 只显示接收情况。当前实现产出的生成或确认时间提供完成时间；确认无关产出不会完成 Card。

产出通过 `node link-output --card <id>` 标明回答哪张 Card，无需另发回复 Card。显式 Card 可以跨 Role，但必须已接收、未作废，并在产出的 goal 祖先链上有来源目标。省略 Card 时，`--role` 必须匹配该目标唯一未完成 Card 的接收 Role。文件在 Workspace checkout 落地后才关联，候选分支应先集成。落后的响应需要复核，不能据此宣称完成。

`card watch` 只观察提交到 Tent Git 的、指向指定 Role 的未作废 pending Card，不写文件或历史；空闲时每三秒检查 HEAD。公开 Card 通过 list 的 `--include-open` 查询。Hook 行为和宿主验收边界见下文。

## 作者与确认

Node 正文或语义元数据变化时记录 OKF 原生 `generated: {by, at}`；确认时记录 `verified: [{by, at}]`，按 actor 保留最新一项。确认不改正文或生成时间，内容修改也不抹掉既有复核记录。读取、无变化保存和生命周期修改不刷新生成时间。`stale_after` 到期使 Node 落后；`status: deprecated` 的 Node 不进入当前上下文。

写入与确认支持 `--by`，JSON 写入和批量条目支持 `by`。已知身份使用 `human:<id>`、`process:<id>` 或 `<producer>/<version>`；无法取得可靠宿主身份时写实际运行的 `tent/<version>`，不猜模型或冒充人工。只有 `human:` 验证者显示为人工复核，其余是机器确认，无验证者则未验证。Web 保存和确认默认使用本机用户名，可显式覆盖。信任档位由验证记录推导，不是权限控制。

## Hook 边界

SessionStart 提供可用工作区、当前包入口、构建身份和 `workspace brief` 提示，不注入完整简报。Stop 从本轮已有会话记录提取确证的文件提供、读取和修改事件，在本地记录地址、轮次、时间和 Stop 时观察到的哈希；不保存文件或会话正文。随后最多用英文提出三个带候选答案的具体问题：未关联产出服务于哪条需求、材料变化后 Node 判断是否仍成立、是否有新需求或决定需要保存。意图信号只认“决定、确认、改成、新增需求”等明确表述，普通“请、需要、fix”不触发；本轮已改 Node 或 Card 时不再问意图。完整 JSON 不超过 2 KiB。重复 Stop 静默；取消保留已观察事实但不提问。配置请求异步执行，处理器不返回阻断或续作决策；实际宿主须验证该能力和输出投递，不支持时保持 Stop 禁用，使用 Start 和正常 CLI。

`workspace brief` 在 4 KiB 内用英文展示落后与领先两种同步状态计数、落后 Node、领先时长、最近输入和产出、未关联产出与输入 Card。未关联产出仅指 session 写入、但尚未被任何 output Node 记录的文件；未关联产出列表只列过去 7 天内最近 3 个 session 的观察，更早的只计数。独立 output Node 不算未记录产物。`workspace drift` 分页保留完整待检查关系。即使没有 Hook，这两个命令也会重新观察 Node 已声明的本地材料版本。保存 Node 时自动记录新材料版本，已变化或读不到的旧材料保留原基线，普通保存不能清除落后。用 `node check` 查看，复核判断后用 `node confirm`；修正正文可用 `node write --confirm` 同时确认，write-many 更新条目也支持 `confirm: true`。用 `node link-output` 在目标下新建 output Node；全部 goal 祖先都提供隐式来源，最近的 goal 只作为显示归属。目标变化会使其产物落后，更新并确认产物后解除。基线按 Node ID 与文档保存在同一 Git 提交，Markdown 不增加同步或哈希字段。已接收 Card 的 Node 来源变化会在 brief 中提示重读；取消任务用 `card deprecate`，默认列表和简报会隐藏它，显式查看或接收仍会给出警告与现行引用。详见 Node/Card Skill；同步状态不改变 OKF `status`。

提示可能显示在界面或后续轮次，不能证明本次交付已维护上下文。Card 接收后保持已接收；产出通过 Node 的 sources 关联 Card。Role 通过命令参数明确选择，没有隐式 Session 绑定。

更新插件时保留项目 `.tent/`、真实材料及无关宿主设置。验收分别记录包结构、安装发现、实际 CLI 操作与宿主 Hook 投递；手工输入 Hook JSON 不算真实事件验证。

`tent --version` 显示版本、提交与构建会话开始时间；`tent version --json` 同时提供 dirty 状态和实际 runtime 路径。身份嵌入 CLI，移动安装位置或修改旁边的 package.json 不会改变它；源码入口的 `builtAt` 为 null，watch 重建沿用会话开始时的身份。SessionStart 会展示身份，并在工作区明确是 Tent 源码 checkout 时提示提交不一致。提交不同不代表哪份更旧，外部安装也不会联网检查更新。
