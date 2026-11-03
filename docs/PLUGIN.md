# Tent Agent 插件

插件提供四个 Skill、Stop Hook 与同包 CLI。Node、Role、Card 的规则在 Core；Node 文件由宿主自带工具读取和编辑，Skill 按工作需要提供操作指引。

## 构建与安装

需要 Node.js 22.19+ 和 Git，Tent 只支持 Git 项目。`tent new <root>` 在 root 不属于任何 Git 仓库时先运行 `git init`；已有仓库和 worktree 不变。一次构建生成 Codex 与 Claude Code 两个完整插件包，共享同一份 CLI、四个 Skill、references 与 SPEC；宿主壳只提供清单、Hook 定义和启动脚本、插件描述与该宿主的 Hook 说明。插件运行时只使用 JavaScript 与 Node 内置模块，可在支持的 Windows、macOS 和 Linux 环境运行，无需 npm install。

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
      skills/tent-role/references/host-role.md
      skill-resources/
      cli.mjs
      wake.mjs
      docs/
  claude-code/
    .claude-plugin/marketplace.json
    plugins/tent/
      .claude-plugin/plugin.json
      hooks/{hooks.json,session.mjs}
      skills/<skill>/SKILL.md
      skills/tent-init/references/host-hooks.md
      skills/tent-role/references/host-role.md
      skill-resources/
      cli.mjs
      docs/
```

共用源码在 `skills/`、`skill-resources/` 与 `src/`；宿主壳在 `plugins/codex/tent/` 和 `plugins/claude-code/tent/`。构建只编译一次运行时，再复制到两个包；共用内容逐字节相同。每个壳的 `host-hooks.md` 和 `host-role.md` 原样放入该包的 `skills/tent-init/references/host-hooks.md` 和 `skills/tent-role/references/host-role.md`，Codex 的 `agents/openai.yaml` 由壳提供。`host-role.md` 写各宿主的会话怎么当 Role。Claude Code 在后台命令结束时会唤醒会话，所以空闲时用 `tent card watch` 等 Card；外部进程没有办法把消息送进 Claude Code 会话。Codex 的壳另带 `wake.mjs`：聊天接下 Role 时运行一次，就把这个聊天绑到这个 Role 上。之后它在后台常驻，用 `tent card watch` 等该 Role 的 Card，每批新 Card 用 `codex queue` 往这个聊天投一条消息，同一张 Card 只叫一次。别的会话用 `--tell <role-id>` 可以给绑到该 Role 的每个聊天捎一句话。聊天编号取自 `CODEX_THREAD_ID`，也可以用 `--thread` 指定。绑定记在 `.tent/temp/role-chats/`，后台进程退出就失效。不放系统临时目录，因为 Codex 沙箱有自己的临时目录，别的会话看不到。Windows 上优先用桌面应用自带的 `codex.exe`。版本统一取自 `package.json`。构建不覆盖已有交付，也不注册全局配置。运行依赖随包携带，安装后不依赖源码仓库的 node_modules 或全局 Tent。

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

新安装或修改后的 Hook 按宿主流程启用和审查；新增或变更后的定义须重新通过原生信任审阅。安装后在实际宿主中检查发现、启用和事件投递，配置文件存在不代表已经生效。

npm 包 `vibe-tent` 是单独的 CLI 包，用 `npm install -g vibe-tent` 安装后使用 `tent` 命令。它不包含完整的宿主插件安装结构。发布工作流用 npm 可信发布把 Release 上的同一个 tgz 发到 npm，不使用 token；npm 上已有该版本时跳过。

## 按需入口

| 工作                         | Skill     | CLI  |
| ---------------------------- | --------- | ---- |
| 新建空 Tent 和本地历史       | tent-init | new  |
| 查找、读取、维护有用事实     | tent-node | node |
| 创建、读取、维护持久工作方向 | tent-role | role |
| 记录、预览、接收一次输入     | tent-card | card |

普通工作不要求创建 Role 或 Card。Role 可以独立建立；没有 Role 的 Session 也可接收无 target 的 Card，有 target 时必须指定对应 Role。`new` 只建立空工作区；空图用 `workspace scan --draft <新文件>` 准备部分草稿，Agent 调整名字、边界并写正文，再用 `node create --draft <文件>` 保存。草稿保留 ref、父子关系和中断后的重试，未写正文的条目不进图谱。已有任何 Node 时，scan 只报告地图问题，不再出草稿；干净文本静默，有问题退出码 1。`--json` 直接返回 report 和 parts 树，树节点为 name、path、files、children。详见 [SPEC §7](SPEC.md#7-mapping-a-project)。

Skill 与 references 只给 Agent 一张清单：何时行动、运行哪条命令带哪些参数、读回执的哪个字段；机制、理由和概念写在本文与 SPEC。遵循[官方 Skill 编写建议](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)：每个 SKILL.md 正文少于 500 行；name 不超过 64 个字符，只用小写字母、数字和连字符；description 不超过 1024 个字符，用第三人称说明做什么、何时使用。reference 只从需要它的 SKILL.md 直接链接，不互相链接，也不链接本文；超过 100 行的 reference 开头提供目录。共用 Agent 文字不含宿主名。每次构建和 `test/contract-docs.test.ts` 按两个宿主分别检查这些规则，构建还检查 Hook 指向的包内文件。Skill 不要求每轮固定执行某条命令。

Agent 从 Skill 的实际安装位置调用同包入口：

```sh
node "<插件目录>/skill-resources/scripts/tent.mjs" new "<工作区目录>"
node "<插件目录>/skill-resources/scripts/tent.mjs" workspace scan --workspace "<工作区目录>" --json
```

Node、Role、Card 命令直接调用 Core，不登记宿主 Session。含 `.tent/` 的目录是工作区。CLI 与 Hook 从同仓 linked worktree 通过 Git 指针文件找到主检出的 `.tent/`，不启动 Git；子模块、独立仓库及没有主检出的 bare 仓库不继承外层工作区。其他 cwd 通过 `--workspace` 明确指定。路径从声明它的 Markdown 解析。真实文件、图片、网页等由宿主已有工具读取，Tent 不提供应用或格式适配。

需要画草图时，用 Excalidraw 本身保存工作区文件，再由 Node 引用该文件。

## Node 的维护者说明

Node 是 `.tent` 下的 Markdown。`type` 仍必填 `goal`、`prompt` 或 `output`，三者只保留名称，不决定覆盖、祖先规则、目标完成或读写行为。`description` 是可选的一句话字符串，不参与覆盖；非字符串由 `workspace check` 报为文档问题。tags 表达形态和主题，与覆盖无关。

`verified` 已退休，`workspace check` 会报告，不能用来确认 Node 或改变覆盖。一次性[元数据清理](MIGRATION.md#remove-retired-node-metadata)与 source 的 `track` 一并删除它。

正文面向没有本次对话的读者，记录已确认且以后有用的事实、约束、决定及依据。每个可独立维护的事实各占一个 Node；同时变化的事实可以放在一起。链接材料和其他 Node，避免复述。先读现有文件再编辑，需要查找时用宿主的搜索工具。

Node 名称在所有平台按 Windows 文件名校验：不得含 `< > : " / \ | ? *`、C0 控制字符（含 tab、CR、LF）、DEL、U+2028、U+2029 或结尾的点，也不得是任何大小写、带或不带扩展名的 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`、`COM¹`–`COM³`、`LPT¹`–`LPT³`；首尾空白会被去除。CLI 拒绝时给出原因，Skill 不重复这些规则。

`node create` 用 `--description`、`--resource` 和重复的 `--source` 一起创建文档，也保留 type、body、tags 与 parent；`--draft` 保存 scan 草稿中已写正文的条目，逐条移出并将剩余引用改指新 id，全部保存后删除草稿和报告。后续正文和 frontmatter 直接编辑文件；结构调整使用 `node rename|move|archive|delete`，版本列表使用 `node history <id>`，读取某版全文使用 `node history <id> --version <v>`，其中 `<v>` 是 `{commit,path}` JSON 对象。除 help、version 和 new 外，Tent CLI 命令及 Stop 收进有效的文件改动，格式问题保留原文件并报告。中间尚未被收进历史的版本不能恢复。

`resource` 是主要材料，`sources` 按顺序列出相关材料。CLI 的材料路径从 Workspace 根目录解析并保存为相对声明文档的地址；手写 Markdown 中 `./` 和 `../` 从声明文件解析，单个前导 `/` 从 `.tent` 开始，Workspace 外使用 `file:` URI。裸 source 是描述文本；尚不存在的路径用 `./`。Markdown 材料可加 `#标题` 选择该节（含标题与子节），按标题文本匹配；标题缺失或重复时材料不可用。材料读取交给宿主的工具。

目录成员只按项目自己的 Git 判断，不建立私有 Git ignore 环境，也不无规则遍历。仓库外的 `file:` 目录只保留为地址、检查存在，不列成员；Stop 只看本 Workspace Git 的改动。

文件、目录和末尾一个 `*` 的文件名前缀都能通过 `resource` 或 `sources` 提供普通覆盖。对每个改动文件，精确文件及实际改动的章节优先，否则取最近的目录或前缀，同等具体的都给。没有 `track` 或代码所有权，也不按 type 继承规则。linked worktree 的改动按 checkout 内相对路径匹配；Stop 给出的 Node 路径始终在主 checkout 的 `.tent` 下。

`status` 为 `draft`、`stable`（默认）或 `deprecated`，只作用于本文档；`node archive` 弃用子树，要重新启用 Node，改回其 status。`node delete` 删除子树；`node rename` 与 `node move` 保持 id 并更新指向它的链接。Card 来源仍钉住所选版本，Node 创建不会自动选择或回答某张 Card。

## Role 与 Card 的维护者说明

Role 在 `.tent/roles/<role-id>.md` 中保存持续方向的目的、边界、方法和 Node 入口。它提供上下文，不占用锁，也不登记或绑定宿主 Session；多个会话可以按同一 Role 工作。共享事实由 Node 保存，Role 只链接事实入口。

Card 保存一次固定输入：短指令、可选接收 Role、可选返回地址 returnTo，以及按顺序排列的来源。Node 和 Role 来源钉住所选版本，其他来源保留地址。CLI 将从 Workspace 根目录传入的路径转换为相对 Card 文档的地址。发布后的 prompt、title、sources 和 returnTo 不可修改，手工修改会报告为 `INPUT_CHANGED`。接收者开始时没有发送方的对话；prompt 写明目标，来源承载其余内容。需求变化写回来源 Node，接收者在 brief 中获知变化后读取当前 Node。

brief 常规刷新跳过已 closed、没有 returnTo 的 consumed、以及 deprecated 的 Card。完成名单保存在 `.tent/.git/tent-material-cache/`，随保留历史增量更新；未完成和新发现的 Card 仍读取当前文件头。手改已完成 Card 由 `workspace check` 报告，brief 不再检查它们。显式 show、take、按状态列出及 `--include-deprecated` 仍读真实文件。

Card 只记录四种投递状态：`pending`、`consumed`、`returned`、`closed`。`show` 只预览，`take` 记录接收；相同 Role 重试返回 `replayed: true`，应继续已有工作。没有 returnTo 的 Card 收下即完成；有 returnTo 的 Card 已接未交回时才算在做。target 与 returnTo 都是投递地址，不记录发送者，不能指向同一 Role。有 target 的 Card 必须带对应 Role 接收；带 returnTo 的公开 Card 也必须由一个不同的 Role 接收，只有不带 returnTo 的公开 Card 可以匿名接收。仅 pending Card 可以改派，不能改派给 returnTo；取消使用 `deprecate`，保留原输入与接收记录，默认列表隐藏它。旧 Card 没有 returnTo，按相同规则解释，无需转换。

`card return <id> --role <role-id> --result TEXT` 由接收 Role 交回，必须先 take；结果非空、单行、不超过 200 个 Unicode 字符（code points），细节写进 Node，结果可带 Node id。交回记录 returned 和 result，returnTo Role 再次 take 收下结果后变成 closed，原 receivedBy 不变。相同结果交回是重放，收回后也一样；换结果会拒绝，修正写进 Node，有新的工作再发 Card。不另存发送者、交回人或结果 Node 列表。Card 完成不由 goal 或 output 推导；后续变化不会撤回 Card 的交回结果。

Node 的普通 `sources` 可以保留与 Card 的来源关系，但 Node 的 type 和父子位置不决定 Card 是否完成。接收、交回与收回仍由 Card 命令显式表达；需要对方继续做事或拍板才发新 Card。

未完成的 Card 投递会阻断 Role 删除：它是 pending Card 的 target、pending/consumed/returned Card 的 returnTo，或带 returnTo 的 consumed Card 的 receivedBy。报错列出全部阻断 Card；可以撤销 Card，pending 的目标也可转交。作废 Card 一律不挡；交回后释放接收 Role，收回后释放返回 Role。删除不改写历史投递事实。

`card watch` 只观察提交到 Tent Git 的、指向指定 Role 的未作废 pending Card，以及 returnTo 为该 Role 的 returned Card，不写文件或历史。返回结果的一行是 `card-ID returned by role-X: <结果>`，直到该 Role take 收回前都会再次出现。空闲时每三秒检查 HEAD；`--timeout 0` 只检查一次，适合宿主的定时检查。宿主能在后台命令结束时唤醒 Agent 时，空闲 Role 可在后台运行它。公开输入通过 list 的 `--include-open` 查询。Hook 行为和宿主验收边界见下文。

## Hook 边界

两个宿主只注册 Stop，其 1–5 流程、预算和两段提示原文以 [SPEC §5](SPEC.md#5-what-the-agent-is-told) 为准。普通改代码不需要 Agent 先跑 Tent；读和改 Node 使用宿主自带工具。

两个宿主入口仍在 `plugins/codex/tent/hooks/session.mjs` 和 `plugins/claude-code/tent/hooks/session.mjs`。宿主壳只转译 Stop 输入与 JSON 外壳，复用 `tent hook stop` 的 Core 流程。Stop 比较本 checkout 与上次 Stop 的 HEAD 及未提交文件内容快照，现读 Node frontmatter 覆盖，收进本轮 Node 文件改动，然后给绝对文件指针和格式问题。每个 checkout 在共用 `.tent` 临时目录下有自己的快照；首次比较当前未提交文件。Workspace 不在 Git 仓库时 Stop 静默。Node 正文不进入通知，也没有条数、字节或截断预算。

章节的旧指纹和旧正文都不可用时不算已变，仍可回退到明确整篇文件或目录覆盖。首次从 HEAD 取旧正文比较。

验收两个真实宿主要分开看：包的内容正确不等于已安装或已信任，也不等于原生 Stop 已经进入模型请求。分别确认 Hook 信任、原生 Stop、改动文件覆盖指针、Node 格式问题和再次 Stop 静默，以及最后可见工作总结。手工 JSON 只证明处理器；不拿它冒充原生触发、模型推理或桌面延迟达标。宿主事件契约见 [Codex Hooks](https://learn.chatgpt.com/docs/hooks) 和 [Claude Code Hooks](https://code.claude.com/docs/en/hooks)。

速度测量每个宿主各取 11 对相邻交替的 Stop 命令与裸 `node -e 0`，使用每对墙钟差的中位数，不减两组中位数；保留全部原始配对和离群值，不筛快样本。两边都含 Node 启动，Tent 不额外套命令 shell；宿主自带 shell 不计为 Tent 开销。7,570 文件仓库的小改动护栏为额外 600 ms，全脏为两秒；在 `.scratch` 的项目与真实图谱副本上分别测量。未测新候选就不沿用旧数字声称通过，超时先报告，不为速度改覆盖或捕获语义。

`workspace brief` 的规则见 [SPEC](SPEC.md#brief)。

提示可能显示在界面或后续轮次，不能证明本次交付已维护上下文。Card 的接收、交回与收回由投递状态表达；Node 的 sources 可保留与 Card 的来源关系。Role 通过命令参数明确选择，没有隐式 Session 绑定。

更新插件时保留项目 `.tent/`、真实材料及无关宿主设置。

`tent --version` 显示版本、提交与构建会话开始时间；`tent version --json` 同时提供 dirty 状态和实际 runtime 路径。身份嵌入 CLI，移动安装位置或修改旁边的 package.json 不会改变它；源码入口的 `builtAt` 为 null，watch 重建沿用会话开始时的身份。提交不同不代表哪份更旧，外部安装也不会联网检查更新。
