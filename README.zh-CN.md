# Tent / 帷幄

[English](README.md)

Tent 是项目的上下文图谱：记下你定了什么、做出了什么、哪些已经过时。

代码图谱画出代码怎样连在一起。Tent 记的是代码装不下的东西：你确认过的目标、后续工作要遵守的规则、否决过的方案，以及做出了什么的证据。Agent 开工前读它，干活时更新它。一条记录依据的代码或文档变了，Tent 会把它标成过时，让它被改正，而不是误导下一个会话。

你拍板，Agent 干活，Tent 记账。它支持 Claude Code 和 Codex，数据只在你的电脑上，你在本地网页里把它当一张图来看。

## 快速开始

1. **安装插件**，Claude Code 或 Codex 都可以（见[安装](#安装)）。
2. **在项目里对 Agent 说：**

   ```text
   给这个项目装上 Tent。
   ```

   Agent 会把现有代码画成一组 Node，项目的每一块各一个。每个 Node 挂着那块代码，写明改动时必须守住的规则、要跟着一起改的地方，以及怎么验证。做到一半的项目也是这样接进来。
3. **打开图谱。** Agent 最后会启动网页并给你地址。之后想再看，让它打开 Tent 的图谱就行。

## Tent 记什么

所有内容都在项目根目录的 `.tent/` 里，是一组 Markdown 文件，在 `.tent/.git` 里有自己的 Git 历史。Tent 不改项目里的任何文件：它把 `.tent/` 写进 Git 的本地排除列表（`.git/info/exclude`），不碰你的 `.gitignore`。

- **Node**：一条长期事实。`type` 只能是 `goal`、`prompt` 或 `output`，说明它依据的是什么：
  - `goal`：你确认过的意图，比如一个功能、一块代码。
  - `prompt`：后续工作遵守的规则或约定、带理由的决定，或一套做事的流程。
  - `output`：某个时间点看到的结果、检查或问题。

  `tags` 说明内容是什么形式，比如 `decision`、`issue`，不改变任何行为。
- **Role**：一个持续的工作方向，写明目的和边界。几个会话可以按同一个 Role 干活。
- **Card**：一次交接。它带一段简短的提示，并钉住它指向的 Node。写了交回给哪个 Role，结果就回到那个 Role 手里。

大部分工作用不到 Role 和 Card。

## Tent 告诉你什么

- **落后**：goal 或规则依据的材料，也就是它指向的文件或 Node，在记下之后改了或不见了。这条事实可能已经过时。
- **领先**：还没有东西实现的 goal，或者在产出之后又改过的 goal。挂着代码的 goal，在你改动它之前，都算由那块代码实现着。
- **会话开始时**，Agent 先读一份简短的摘要：哪些落后、哪些领先，有哪些 Card 在等它。
- **一轮结束时**，如果这一轮改了文件，Tent 会点出覆盖这些文件的 Node。Agent 改掉这一轮弄错的句子，记下值得留的东西，或者说一句不用记。

各块之间的依赖从 TypeScript、JavaScript、Python、Go、Rust、Java、C#、C、C++ 和 PHP 的 import 里分析出来。其他语言的代码照样按目录、按 Git 历史里哪些文件总一起改来画图。

## 图谱

网页把 Node 画成一张画布上的卡片，连着它的上级和它依赖的部分。落后和领先标在卡片上。

- 把一张卡拖到另一张上，两张卡就围成一个区域。Tent 用它已经记下的事实说出能核对的部分，比如一份产出还对不对得上它的目标，一条规则的材料在写下之后有没有改过。做得对不对，交给 Agent 判断。
- 各 Role 是左上角的机器人，旁边是它们手上的 Card。把卡片拖到机器人身上，就给它写一张 Card。
- 可以直接编辑 Node，也能在打开过的工作区之间切换。

## 安装

需要 Node.js 22.19+ 和 Git。从源码构建两个插件：

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
```

**Claude Code**，在克隆目录里运行：

```sh
claude plugin marketplace add "$PWD/release/claude-code"
claude plugin install tent@tent-local
```

**Codex**，在克隆目录里运行：

```sh
codex plugin marketplace add "$PWD/release/codex"
codex plugin add tent@tent-local
```

每个插件都自带四个 Skill、SessionStart 和 Stop 两个 Hook、CLI 和网页，不需要 npm install。Claude Code 装上插件 Hook 就启用；Codex 会请你审查它们。不启用 Hook，所有命令照样能用。详见 [docs/PLUGIN.md](docs/PLUGIN.md)。

也可以把下面这段发给你的 Agent：

```text
Install the Tent plugin from github.com/cucarol/tent: clone it, run
`npm ci --ignore-scripts && npm run plugin:build`, then add the marketplace
under release/claude-code (Claude Code) or release/codex (Codex) and install tent@tent-local.
Check that the four Tent Skills appear and that the Hooks are enabled.
```

每个 [Release](https://github.com/cucarol/tent/releases/latest) 都附有构建好的包。只要 CLI 的话，`npm install -g vibe-tent` 会提供 `tent` 命令。

## 手动用 CLI

这些命令平时由 Agent 通过 Skill 运行，你很少需要自己敲。下面的 `tent` 是 npm 装的命令；用插件时，Agent 运行包里的 `cli.mjs`。每条命令都会打印下一步要用的 id。

```sh
tent new .
echo "export function signIn(email) {}" > login.js

# 一个 goal：还没有东西实现它，摘要把它列为领先。
tent node create "Email sign-in" --type goal --body "Users sign in with an email address and a one-time code."
tent workspace brief

# 它下面的一条规则，依据 login.js；再记一个 output，表示工作已经做出来了。
tent node create "One-time codes" --type prompt --parent <goal-id> --resource login.js --body "A code works once and expires after 10 minutes."
tent node link-output <goal-id> --resource login.js

# 改代码：这条规则现在落后了。
echo "export const CODE_TTL_MINUTES = 30;" >> login.js
tent workspace brief
```

规则和代码哪个错了就改哪个，然后用完整读取返回的 `etag` 确认这条规则，摘要就会报告 `behind 0 · ahead 0`：

```sh
tent node get <prompt-id> --full --json
tent node confirm <prompt-id> --base-etag <etag>
```

替换内容的写入必须带上读到的 ETag，两个会话不会悄悄覆盖对方。网页用 `tent ui --workspace <项目文件夹>` 启动，Ctrl+C 停止。精确规则见 [docs/SPEC.md](docs/SPEC.md)。

## 现状

Tent 0.x 由一个人维护。文件格式和命令还可能变；[docs/SPEC.md](docs/SPEC.md) 是契约。

## 开发

```sh
npm ci
npm run build
npm run test:fast
npm run ui:dev -- --workspace <项目文件夹>
```

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

漏洞请按 [SECURITY.md](SECURITY.md) 的说明私下报告。不要开公开 issue。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
