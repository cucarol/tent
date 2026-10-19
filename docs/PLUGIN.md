# Tent Agent 插件

插件提供四个 Skill、SessionStart 与同步 Stop Hook，以及同包 CLI。Node、Role、Card 的读写规则在 Core；Skill 按工作需要提供操作指引。

## 构建与安装

需要 Node.js 22.19+ 和 Git。一次构建生成 Codex 与 Claude Code 两个完整插件包，共享同一份 CLI、Web UI、四个 Skill、references 与 SPEC；宿主壳只提供清单、Hook 定义和启动脚本、界面描述与该宿主的 Hook 说明。插件运行时只使用 JavaScript、Node 内置模块与静态资源，可在支持的 Windows、macOS 和 Linux 环境运行，无需 npm install。

从源码构建时执行：

```sh
npm ci --ignore-scripts
npm run plugin:build
```

默认交付到尚不存在的 `release/`；也可用 `npm run plugin:build -- .scratch/local-distribution` 指定新的交付根目录。目录结构是：

```text
release/
  .agents/plugins/marketplace.json       # Git 分发：./codex/plugins/tent
  .claude-plugin/marketplace.json        # Git 分发：./claude-code/plugins/tent
  codex/
    .agents/plugins/marketplace.json
    plugins/tent/
      .codex-plugin/plugin.json
      hooks/{hooks.json,session.mjs}
      skills/<skill>/{SKILL.md,agents/openai.yaml}
      skills/tent-init/references/host-hooks.md
      skill-resources/
      cli.mjs
      ui-dist/
      docs/
  claude-code/
    .claude-plugin/marketplace.json
    plugins/tent/
      .claude-plugin/plugin.json
      hooks/{hooks.json,session.mjs}
      skills/<skill>/SKILL.md
      skills/tent-init/references/host-hooks.md
      skill-resources/
      cli.mjs
      ui-dist/
      docs/
```

共用源码在 `skills/`、`skill-resources/` 与 `src/`；宿主壳在 `plugins/codex/tent/` 和 `plugins/claude-code/tent/`。构建只编译一次运行时与 UI，再复制到两个包；共用内容逐字节相同。每个壳的 `host-hooks.md` 原样放入该包的 `skills/tent-init/references/host-hooks.md`，Codex 的 `agents/openai.yaml` 由壳提供。版本统一取自 `package.json`。构建不覆盖已有交付，也不注册全局配置。运行依赖随包携带，安装后不依赖源码仓库的 node_modules 或全局 Tent。

Codex 安装交付中的 `codex/` marketplace：

```sh
codex plugin marketplace add "<交付根目录的绝对路径>/codex"
codex plugin add tent@tent-local
```

Claude Code 安装交付中的 `claude-code/` marketplace：

```sh
claude plugin marketplace add "<交付根目录的绝对路径>/claude-code"
claude plugin install tent@tent-local
```

两套 marketplace 的本地来源都相对各自根目录指向 `./plugins/tent`。清单分别是 `.codex-plugin/plugin.json` 和 `.claude-plugin/plugin.json`；Hook 定义都在包内的 `hooks/hooks.json`。Codex 使用 `PLUGIN_ROOT`，Claude Code 使用 `CLAUDE_PLUGIN_ROOT` 找到自己的启动脚本，各脚本固定传入自己的宿主名。结构与安装格式依据 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)和 [Claude Code marketplace 文档](https://code.claude.com/docs/en/plugin-marketplaces)；Claude Code 壳使用其[插件清单](https://code.claude.com/docs/en/plugins-reference)与 [Hook](https://code.claude.com/docs/en/hooks)标准目录。

发布工作流在门禁和打包成功后，将完整双宿主分发发布到 `plugin-dist` 分支。该分支每次替换为一个没有父提交的新提交，只含分发根的两份 `tent` catalogue 与 `codex/`、`claude-code/`；不继承源码历史、不夹带 Release 附件，也不改源码检出和索引。两份根 catalogue 分别指向各自宿主目录。zip 仍附在版本 Release 上，解压后沿用上面的 `tent-local` 安装方式。

`plugin-dist` 首次发布后，可直接从 Git 安装，省去手动下载 zip。支持这些命令的宿主版本中，分别运行以下单行命令（Bash 或 PowerShell 7）：

```sh
codex plugin marketplace add cucarol/tent --ref plugin-dist && codex plugin add tent@tent
```

```sh
claude plugin install tent --marketplace "https://github.com/cucarol/tent.git#plugin-dist"
```

Codex 的 Git ref 与 catalogue 路径遵循[官方打包文档](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)，Claude Code 的 `#ref` 遵循[官方 Git marketplace 说明](https://code.claude.com/docs/en/plugins/host-marketplace#host-your-marketplace)。旧版 Claude Code 没有 `--marketplace` 时，先 `claude plugin marketplace add "https://github.com/cucarol/tent.git#plugin-dist"`，再 `claude plugin install tent@tent`。宿主的信任确认仍按正常流程完成。

新安装或修改后的 Hook 按宿主流程启用和审查；Codex 已发布的 Hook 定义逐字节保留。安装后在实际宿主中检查发现、启用和事件投递，配置文件存在不代表已经生效。

npm 包 `vibe-tent` 是单独的 CLI 包，用 `npm install -g vibe-tent` 安装后使用 `tent` 命令。它不包含完整的宿主插件安装结构。

## 按需入口

| 工作                         | Skill     | CLI  |
| ---------------------------- | --------- | ---- |
| 新建空 Tent 和独立本地 Git   | tent-init | new  |
| 查找、读取、维护有用事实     | tent-node | node |
| 创建、读取、维护持久工作方向 | tent-role | role |
| 记录、预览、接收一次输入     | tent-card | card |

普通工作不要求创建 Role 或 Card。Role 可以独立建立；没有 Role 的 Session 也可接收无 target 的 Card，有 target 时必须指定对应 Role。`new` 只建立空工作区；init Skill 随后用 `workspace scan --draft <新文件>` 准备模块批量草稿，由 Agent 一轮修订名字、边界、正文和出处，再通过现有 write-many 一次写入并检查。草稿生成不创建 Node，不调用模型；已有图谱进入维护流程。草稿材料地址遵循 CLI 的工作区根目录输入规则，Node 改名或重排后仍由写入入口归一。预检问题随摘要返回，exit 1 时已经创建的草稿仍可编辑。

Skill 与 references 只给 Agent 一张清单：何时行动、运行哪条命令带哪些参数、读回执的哪个字段；机制、理由和概念写在本文与 SPEC。遵循[官方 Skill 编写建议](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)：每个 SKILL.md 正文少于 500 行；name 不超过 64 个字符，只用小写字母、数字和连字符；description 不超过 1024 个字符，用第三人称说明做什么、何时使用。reference 只从需要它的 SKILL.md 直接链接，不互相链接，也不链接本文；超过 100 行的 reference 开头提供目录。共用 Agent 文字不含宿主名。每次构建和 `test/contract-docs.test.ts` 按两个宿主分别检查这些规则，构建还检查 Hook 指向的包内文件。Skill 不要求每轮固定执行某条命令。

Agent 从 Skill 的实际安装位置调用同包入口：

```sh
node "<插件目录>/skill-resources/scripts/tent.mjs" new "<工作区目录>"
node "<插件目录>/skill-resources/scripts/tent.mjs" node list --workspace "<工作区目录>" --json
```

Node、Role、Card 命令直接调用 Core，不登记宿主 Session。含 `.tent/` 的目录是工作区。CLI 与 Hook 从同仓 linked worktree 通过 Git 指针文件找到主检出的 `.tent/`，不启动 Git；子模块、独立仓库及没有主检出的 bare 仓库不继承外层工作区。其他 cwd 通过 `--workspace` 明确指定。路径从声明它的 Markdown 解析。真实文件、图片、网页等由宿主已有工具读取，Tent 不提供应用或格式适配。

需要画草图时，用 Excalidraw 本身保存工作区文件，再由 Node 引用该文件。

包内包含 CLI 与 Web UI 静态资源。运行同包 `cli.mjs ui --workspace <工作区路径>` 可打开界面（例如 `node <插件路径>/cli.mjs ui --workspace <工作区路径>`）；`--no-open` 只打印地址。服务仅在当前终端前台运行，Ctrl+C 退出，不注册 Session。init 使用宿主可见、可停止的后台命令并加 `--idle-timeout 300`，没有成功的已认证页面请求满 5 分钟后自动关闭；页面轮询和从本次启动打开的其他工作区共用续期，退出时关闭所有子服务并清理计时器。CLI 同时打印地址和空闲有效期。不带该参数的普通手动 UI 生命周期不变。其他命令直接读写文档和 Git，无需启动 UI 服务。

## Node 的维护者说明

Skill 按 `goal`、`prompt`、`output` 三种类型介绍 Node，类型名就是它的含义，Skill 只写每种类型怎么对待；形态与主题由 tags 表达，Skill 列出的预设与 Core 的 `NODE_TAG_PRESETS` 一致，`node tags` 列出在用标签。Agent 自己的结论在用户同意前是 `output`。goal 子树下任何当前 output 都算该 goal 的结果，所以 goal 的开放问题、调研和待决事项放在 `prompt`。`goal` 与 `prompt` 不写提交号、测试数和交付状态，这些由 Git 与 Card 记录；有用的验证写成带日期的 output。

正文面向没有本次对话的读者：首句说明这是什么、如何使用；直接陈述事实，标注未验证内容；output 写明检查了什么、何时检查。省略一次性细节、原始工具输出和 Git 已记录的内容；已知时保留谁在何时确认了决定，不编造。能被单独读取或修改的事实各占一个 Node，同时变化的事实放在一起，父 Node 设定范围；链接材料和其他 Node 而不复述，正文中的 `[主题](node-ID)` 在保存时转换为相对路径。先更新拥有该事实的 Node，再考虑新建；新建结果不明确时，先确认 Node 是否已存在再重试。

Node 名称在所有平台按 Windows 文件名校验：不得含 `< > : " / \ | ? *`、C0 控制字符（含 tab、CR、LF）、DEL、U+2028、U+2029 或结尾的点，也不得是任何大小写、带或不带扩展名的 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`、`COM¹`–`COM³`、`LPT¹`–`LPT³`；首尾空白会被去除。CLI 拒绝时给出原因，Skill 不重复这些规则。

`resource` 是主要材料，`sources` 按顺序列出相关材料。CLI 参数（`--resource`、`--sources-json`、`link-output --resource`、`card create --source`，以及 `node write --input-json` 与 write-many 中的 frontmatter）从 Workspace 根目录解析：`docs/x.md`、`./docs/x.md` 与 `/docs/x.md` 指同一文件，`.tent/Area/Topic/Topic.md` 指 Node 文件，也可写 Node id。没有匹配文件的裸 source 保留为描述；尚不存在的文件用 `./`；Workspace 以外用 `file:` URI。保存后的地址相对声明它的文件，由 Tent 在保存时改写；存储形式中单个前导 `/` 从 `.tent/` 开始，只有原始 Markdown 编辑和正文链接需要手写这种形式。Markdown 材料可加 `#标题` 只跟踪该节（含标题与子节），按标题文本匹配，百分号编码亦可；编辑其他节不会使该材料变化；标题缺失或重复时材料不可用，由 `workspace check` 报告；无片段或非 Markdown 文件跟踪整个文件。Card 来源仍钉住完整 Node 版本。指向能支持该事实的最窄材料。`goal` 与 `prompt` 用材料指明意图和规则的依据；goal 也可通过本工作区的目录或前缀材料持有实现它的代码，不要求 `track: structure`。单个代码文件仍是引用，不因此获得 goal 自身意图基线；具体实现也可在正文链接，或作为 output 的 `resource` 跟踪。

`node append` 不需要先读或 ETag；`--heading` 与现有同名节匹配时追加到该节末尾。正文编辑交给 Agent 自带的文件工具或 `node write`。替换整个正文前须完整读取（`--full`）；分页或部分读取得到的 `read:` ETag 只允许元数据修改，不能替换或确认正文。保存后保留回执中的 ETag 与 version，无需回读。ETag 冲突时重新读取、合并后用新 ETag 保存。Card 钉住的来源版本不能作为编辑基础。`node write-many` 的每个 create 条目需要本批唯一的 `ref`，`@ref` 可用于 parent、链接与材料地址。批次先校验并准备全部最终文档，在一个 Workspace 锁下写入，并把改动的文档记入一个 Tent 提交；失败的批次回滚它自己的文档、目录和顺序改动，回滚失败时报告受影响的路径与冲突并保留外部编辑。锁只串行化 Tent 写入者，不让文件写入与 Git 对外部编辑器或进程终止具有原子性。

落后（behind）：goal 或 prompt 已记录的材料变化或缺失，或任意 Node 的 `stale_after` 到期。output 记录某一时刻的结果，自己的材料或任意祖先 goal 后续变化都不会让它落后，`asset` 标签也没有例外。完整读取 output 时，`changedSince` 分别列出变化的自身材料、直属 goal 和更上层 goal；这些信息不进 brief 的落后清单。领先（ahead）：goal 自己或现行后代 goal 持有本工作区目录或前缀材料时，创建和确认会记录该 goal 自身正文与声明的意图基线；普通保存和原生收录保留该基线。自身基线或一份完整匹配的现行 output 任一成立即可清除领先，缺失或改变的基线不算匹配。分组 goal 仍比较自己的意图，不把子 goal 正文合并进来。单个文件、Node/Role 引用和外部 URL 不获得这项豁免；其余 goal 子树下没有现行 output，或者没有一份 output 的 goal 基线与当前正文、材料全部匹配时领先。基线未知或材料不可核对不构成匹配；不同 output 的局部匹配不能拼成一份证据。复核实现后确认范围内的 goal，或确认一份仍成立的 output、另建一份匹配的 output，可清除该 goal 的领先，其他旧 output 的变化说明保留。材料 behind 仍独立判断。现行 output 的范围不变，不增加时间字段或重放历史。Card 投递状态独立于 goal 的领先与产出状态。一个 goal 可同时落后和领先。读完整 Node 和变化的材料后，仍成立用 `node confirm`，需要修正用 `node write --confirm`；output 的普通重写、append、节编辑和元数据修改都保留原基线。确认 output 刷新其比较基线并清除已核实的变化说明，确认 goal 不代替确认 output。Tent 把材料版本记入 Git，不需要手填哈希。

`node link-output` 在 goal 下新建 output，名称默认取文件名，只带 `--tags` 给出的标签；文件须已在 Workspace checkout 中，候选分支或 worktree 应先集成。从 linked worktree 调用仍写入主检出的 `.tent/`；材料、漂移和 brief 读取主检出文件，未合入的分支变化不使 Node 落后。本地材料按声明的地址读取，缺失时不从其他检出回退。`status` 为 `draft`、`stable`（默认）或 `deprecated`，只作用于本文档；`node archive` 弃用子树，`node restore --archive-commit` 撤销；`node delete` 永久删除子树，只在用户要求时使用。`node rename` 与 `node move` 保持 id 并更新指向它的链接。

显式 `--context` 的首页与 `--full` 实时读取附带独立于 `text` 的 `context`（不超过 1 KiB）：祖先、按类型分组的子 Node、入链与出链（正文中 Markdown 链接以外的已知 Node id 记为 `mention`）、钉住该 Node 的 Card 及其投递状态、接收者、返回地址和结果；output 另列 goal 链与同步状态，goal 保留范围内的 prompt 与子树 output。省略的计数可用 `node relations` 展开；历史读取保留钉住的内容，但没有 `context`。`node history` 跨移动列出已捕获的版本；用其中的 `version: {commit, path}` 和 `node get --version-json` 读取历史字节，再由 Agent 自己比较。Tent 只保存材料地址，材料由宿主已有工具读取。

## Role 与 Card 的维护者说明

Role 在 `.tent/roles/<role-id>.md` 中保存持续方向的目的、边界、方法和 Node 入口。它提供上下文，不占用锁，也不登记或绑定宿主 Session；多个会话可以按同一 Role 工作。共享事实由 Node 保存，Role 只链接事实入口。

Card 保存一次固定输入：短指令、可选接收 Role、可选返回地址 returnTo，以及按顺序排列的来源。Node 和 Role 来源钉住所选版本，其他来源保留地址。CLI 将从 Workspace 根目录传入的路径转换为相对 Card 文档的地址。发布后的 prompt、title、sources 和 returnTo 不可修改，手工修改会报告为 `INPUT_CHANGED`。接收者开始时没有发送方的对话；prompt 写明目标，来源承载其余内容。需求变化写回来源 Node，接收者在 brief 中获知变化后读取当前 Node；尚未决定的要求留在 draft Node。

Card 只记录四种投递状态：`pending`、`consumed`、`returned`、`closed`。`show` 只预览，`take` 记录接收；相同 Role 重试返回 `replayed: true`，应继续已有工作。没有 returnTo 的 Card 收下即完成；有 returnTo 的 Card 已接未交回时才算在做。target 与 returnTo 都是投递地址，不记录发送者，不能指向同一 Role。有 target 的 Card 必须带对应 Role 接收；带 returnTo 的公开 Card 也必须由一个不同的 Role 接收，只有不带 returnTo 的公开 Card 可以匿名接收。仅 pending Card 可以改派，不能改派给 returnTo；取消使用 `deprecate`，保留原输入与接收记录，默认列表隐藏它。旧 Card 没有 returnTo，按相同规则解释，无需转换。

`card return <id> --role <role-id> --result TEXT` 由接收 Role 交回，必须先 take；结果非空、单行、不超过 200 个 Unicode 字符（code points），细节写进 Node，结果可带 Node id，界面显示为链接。交回记录 returned 和 result，returnTo Role 再次 take 收下结果后变成 closed，原 receivedBy 不变。相同结果交回是重放，收回后也一样；换结果会拒绝，修正写进 Node，有新的工作再发 Card。不另存发送者、交回人或结果 Node 列表。Card 完成不由 goal 或 output 推导；goal 的领先、产出与确认语义独立保留，后续变化不会撤回 Card 的交回结果。

产出通过 `node link-output --card <id>` 标明回答哪张 Card。显式 Card 可以跨 Role，但必须是未作废的 consumed Card，并在产出的 goal 祖先链上有来源目标；returned 和 closed 不接受新的产出关联。省略 Card 时，`--role` 必须匹配该目标唯一 consumed 且带 returnTo 的 Card 的接收 Role。没有相关 Card 时仍可直接建立 output。文件在 Workspace checkout 落地后才关联，候选分支应先集成。结果通知使用原 Card 的交回；需要对方继续做事或拍板才发新 Card。

未完成的 Card 投递会阻断 Role 删除：它是 pending Card 的 target、pending/consumed/returned Card 的 returnTo，或带 returnTo 的 consumed Card 的 receivedBy。报错列出全部阻断 Card；可以撤销 Card，pending 的目标也可转交。作废 Card 一律不挡；交回后释放接收 Role，收回后释放返回 Role。删除不改写历史投递事实。

`card watch` 只观察提交到 Tent Git 的、指向指定 Role 的未作废 pending Card，以及 returnTo 为该 Role 的 returned Card，不写文件或历史。返回结果的一行是 `card-ID returned by role-X: <结果>`，直到该 Role take 收回前都会再次出现。空闲时每三秒检查 HEAD；`--timeout 0` 只检查一次，适合宿主的定时检查。宿主能在后台命令结束时唤醒 Agent 时，空闲 Role 可在后台运行它。公开输入通过 list 的 `--include-open` 查询。Hook 行为和宿主验收边界见下文。

## 作者与确认

Node 正文或语义元数据变化时记录 OKF 原生 `generated: {by, at}`；确认时记录 `verified: [{by, at}]`，按 actor 保留最新一项。确认不改正文或生成时间，内容修改也不抹掉既有复核记录。读取、无变化保存和生命周期修改不刷新生成时间。`stale_after` 到期使 Node 落后；`status: deprecated` 的 Node 不进入当前上下文。

写入与确认支持 `--by`，JSON 写入和批量条目支持 `by`。已知身份使用 `human:<id>`、`process:<id>` 或 `<producer>/<version>`；无法取得可靠宿主身份时写实际运行的 `tent/<version>`，不猜模型或冒充人工。只有 `human:` 验证者显示为人工复核，其余是机器确认，无验证者则未验证。Web 保存和确认默认使用本机用户名，可显式覆盖。信任档位由验证记录推导，不是权限控制。

## Hook 边界

SessionStart 先收录待处理的原生 Node 编辑，仅在有待收录改动时拿写锁，不再保存会话基线。随后以事实陈述注入约 300 B：`Tent Workspace`、`Tent CLI`、`workspace brief` 提示与构建身份各一行，源码 checkout 提交不一致时再加一行；不注入完整简报。Stop 同步运行：同仓各 linked worktree 的写入先换算为相对该检出顶层的路径，匹配主检出的模块；相对 Codex patch 路径从会话检出顶层解析，其他仓库不匹配。返回只问规则和决定，不要求先合入代码。它只从转录尾部确定本轮写入的文件、用材料索引点名模块并检测廉价的决定正则；不收录原生 Node 编辑、不算 behind、不观察文件哈希、不写会话观察、不等 `mutation.lock`。原生编辑留到下一次正常 Tent 命令收录，落后状态由输入一侧的 brief 报告。只有本轮写入的文件被模块覆盖才续作：模块是 `sources` 中持有 `track: structure` 目录或前缀材料的有效 Node，不看标签，普通证据目录不参与。Core 统一解析成员；前缀只允许最后一段末尾的一个 `*`。每个文件只点名最具体的覆盖模块，同样具体的都保留，带祖先名字链和可打开的 Node 文件路径而不展开正文。最多五个模块、每模块八个文件，多出模块写 `+N more modules`。

点名采用 SPEC 的固定英文文案，合并可能的新决定。Stop 不查询文件存在性或 ignore，模块点名只按声明地址，不因文件被忽略、已跟踪或不可用而过滤。意图信号只认“决定、确认、改成、新增需求”等明确表述，普通“请、需要、fix”不触发；本轮有明确 Node 或 Card 写入证据时不再提示意图。包含宿主信封的完整 JSON 不超过 2 KiB，溢出先删文件名、再删模块，保留固定文案和问题类别。Codex 用 `decision: block` 与 `reason`；Claude Code 用 `hookSpecificOutput` 的 `hookEventName: Stop` 与 `additionalContext`。`stop_hook_active: true` 立即静默，包括续作执行工具后的 Stop；取消、没有覆盖写入的轮次也静默，不自动执行 check 或 confirm。有效提问投递前，在 `.tent/temp/stop-reviews/` 以宿主、会话和轮次的 SHA-256 建独占空 claim，重复事件最多投递一次，无全局锁或重试；claim 写失败不续作，claim 后崩溃可能丢失该次投递。claim 不存转录或文件内容，也不压制不同轮次的相同文件。

材料索引的派生缓存只放现有 `.tent/.git/tent-material-cache/stop-material-index.json`。每次重扫 Node 目录并读取完整当前头部字节，按路径和字节的 SHA-256 验证；同长度、mtime 不变的元数据编辑也会失效，新增、删除或损坏缓存均从当前权威重建。缓存写失败直接计算，不修改项目文件、Node/Card/Role、Git 提交或引用；缓存不代替权威字节或忽略规则。278 个 Node 的热 Stop 要满足 p50 ≤ 300 ms、最大 ≤ 1 s，启动与导入不计；持有工作区锁时也不得等待。完整续作成本另计。

Codex 以原生 `turn_id` 定位轮次；Claude Code CLI 用 `--host claude-code`，以原生 `prompt_id` 对应转录的 `promptId`，没有身份的版本静默。Claude Read、Write、Edit 需匹配成功的结构化工具结果，侧链不计入。未观察到的 shell 或外部编辑器改动、取消轮次和未投递的提问都无法兜底内容保鲜；必须跟随内容变化的规则另挂具体文件或 SPEC 小节。两个实际宿主都须验证消息抵达且只续作一次；Hook 自身热耗时与完整续作成本分别记录。官方契约：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)。

`workspace brief` 展示落后与领先两种同步状态计数、无效 Node、待接收 Card、待收回结果、仍需处理的 Card、领先原因、已接收 Card 的来源变化和落后详情，并给出可打开的根 Node 文件。可选详情按 4 KiB 预算裁剪，无效 Node、待接收 Card 和待收回结果不省略；不再读取会话观察日志或列出未关联产出。`workspace drift` 分页保留完整待检查关系。即使没有 Hook，这两个命令也会重新观察 Node 已声明的本地材料版本。保存 Node 时自动记录新材料版本，已变化或读不到的旧材料保留原基线，普通保存不能清除落后。用 `node check` 查看，复核判断后用 `node confirm`；修正正文可用 `node write --confirm` 同时确认，write-many 更新条目也支持 `confirm: true`。用 `node link-output` 在目标下新建 output Node；全部 goal 祖先都保留比较基线，最近的 goal 作为显示归属。目标变化由 goal 领先表达，旧产物保持冻结；完整读取时用 changedSince 说明此后的变化。基线按 Node ID 与文档保存在同一 Git 提交，Markdown 不增加同步或哈希字段。已接收 Card 的 Node 来源变化会在 brief 中提示重读；取消任务用 `card deprecate`，默认列表和简报会隐藏它，显式查看或接收仍会给出警告与现行引用。细节见上文 Node 与 Card 的维护者说明；同步状态不改变 OKF `status`。

提示可能显示在界面或后续轮次，不能证明本次交付已维护上下文。Card 的接收、交回与收回由投递状态表达；产出通过 Node 的 sources 关联 Card。Role 通过命令参数明确选择，没有隐式 Session 绑定。

更新插件时保留项目 `.tent/`、真实材料及无关宿主设置。验收分别记录包结构、安装发现、实际 CLI 操作与宿主 Hook 投递；手工输入 Hook JSON 不算真实事件验证。

`tent --version` 显示版本、提交与构建会话开始时间；`tent version --json` 同时提供 dirty 状态和实际 runtime 路径。身份嵌入 CLI，移动安装位置或修改旁边的 package.json 不会改变它；源码入口的 `builtAt` 为 null，watch 重建沿用会话开始时的身份。SessionStart 会展示身份，并在工作区明确是 Tent 源码 checkout 时提示提交不一致。提交不同不代表哪份更旧，外部安装也不会联网检查更新。

按文件反查用 `node search --resource <工作区路径>`：返回精确关联及目录/前缀覆盖的有效 Node，最具体的在前，并指出匹配字段和材料地址。它只读头部，不返回正文 ETag；继续读正文或编辑时使用文件工具或 `node get`。关键词搜索交给 Agent 的 grep/rg 等工具；不维护单独的 description 摘要。
