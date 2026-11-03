# Tent / 帷幄

[English](README.md)

Tent 是项目的上下文图谱：记下你定了什么、做出了什么。

代码图谱画出代码怎样连在一起。Tent 记的是代码装不下的东西：你的 goal、你给的 prompt，以及由此做出来的 output。Agent 开工前读它，干活时更新它。

你拍板，Agent 干活，Tent 记账。它支持 Claude Code 和 Codex，数据是你电脑上的 Markdown 文件。

## 快速开始

1. **安装插件**，Claude Code 或 Codex 都可以（见[安装](#安装)）。
2. **在项目里对 Agent 说：**

   ```text
   给这个项目装上 Tent。
   ```

   Agent 会把现有代码画成一组 Node，项目的每一块各一个。每个 Node 挂着那块代码，写明改动时必须守住的规则、要跟着一起改的地方，以及怎么验证。做到一半的项目也是这样接进来。

3. **读图谱。** 每个 Node 是 `.tent/` 下的一个 Markdown 文件，套在它的上级下面。用任何编辑器都能打开。

## Tent 记什么

所有内容都在项目根目录的 `.tent/` 里，是一组 Markdown 文件，在 `.tent/.git/history.sqlite` 里有独立的 SQLite 历史。Tent 不改项目里的任何文件：它把 `.tent/` 写进 Git 的本地排除列表（`.git/info/exclude`），不碰你的 `.gitignore`。

- **Node**：一条长期事实。`type` 只能是 `goal`、`prompt` 或 `output`。`tags` 说明内容是什么形式，比如 `decision`、`issue`，不改变任何行为。
- **Role**：一个持续的工作方向，写明目的和边界。几个会话可以按同一个 Role 干活。
- **Card**：一次交接。它带一段简短的提示，并钉住它指向的 Node。写了交回给哪个 Role，结果就回到那个 Role 手里。

大部分工作用不到 Role 和 Card。

## Tent 告诉你什么

- **动手之前**，Agent 可以运行 `tent load <文件>`。Tent 列出管这些文件的 Node，再列出它们自己和上方每个 goal 下的 prompt，让 Agent 从「为了什么」和「要照着做什么」开始。
- **一轮结束时**，如果这一轮改了文件，Tent 会带着类型列出管这些文件的 Node。Agent 拿每个 Node 去对它记的东西：goal 对你现在要什么，prompt 对做过的决定，output 对工作区，对不上就改。这一轮定下了什么就记，什么都没变就不提。改的文件没有 Node 管时，Tent 提醒一次，把值得留的记下来。goal 改了，Tent 会点名，Agent 会告诉你。

各块之间的依赖从 TypeScript、JavaScript、Python、Go、Rust、Java、C#、C、C++ 和 PHP 的 import 里分析出来。其他语言的代码照样按目录、按 Git 历史里哪些文件总一起改来画图。

## 安装

需要 Node.js 22.19+。Git 用于观察项目仓库、沿用的目录忽略规则解释及初始化时的本地 exclude 步骤；SQLite 历史本身不依赖 Git。旧私有 Git 工作区须先在离线副本上做[一次性迁移](docs/MIGRATION.md)。0.2.0 的工作区升级后跑一次[清理脚本](docs/MIGRATION.md#map-layout-from-020)；没用过图谱的跑了也不会改什么。

**Claude Code：**

```sh
claude plugin install tent --marketplace "https://github.com/cucarol/tent.git#plugin-dist"
```

如果你的 Claude Code 没有 `--marketplace` 选项，先运行 `claude plugin marketplace add "https://github.com/cucarol/tent.git#plugin-dist"`，再运行 `claude plugin install tent@tent`。

**Codex：**

```sh
codex plugin marketplace add cucarol/tent --ref plugin-dist && codex plugin add tent@tent
```

每个插件都自带四个 Skill、Stop 四个 Hook 和 CLI，不需要 npm install。Claude Code 装上插件 Hook 就启用；Codex 会请你审查它们。不启用 Hook，所有命令照样能用。详见 [docs/PLUGIN.md](docs/PLUGIN.md)。

也可以把下面这段发给你的 Agent：

```text
Install the Tent plugin. In Claude Code run
claude plugin install tent --marketplace "https://github.com/cucarol/tent.git#plugin-dist"
In Codex run
codex plugin marketplace add cucarol/tent --ref plugin-dist && codex plugin add tent@tent
Check that the four Tent Skills appear and that the Hooks are enabled.
```

每个 [Release](https://github.com/cucarol/tent/releases/latest) 都附有构建好的包。只要 CLI 的话，`npm install -g vibe-tent` 会提供 `tent` 命令。

### 从源码安装

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
```

然后在克隆目录里：Claude Code 运行 `claude plugin marketplace add "$PWD/release/claude-code"` 和 `claude plugin install tent@tent-local`；Codex 运行 `codex plugin marketplace add "$PWD/release/codex"` 和 `codex plugin add tent@tent-local`。

## 手动用 CLI

这些命令平时由 Agent 通过 Skill 运行，你很少需要自己敲。`tent` 是 npm 装的命令；用插件时，Agent 运行包里的 `cli.mjs`。

替换内容的写入必须带上读到的 ETag，两个会话不会悄悄覆盖对方。精确规则见 [docs/SPEC.md](docs/SPEC.md)。

## 现状

Tent 0.x 由一个人维护。文件格式和命令还可能变；[docs/SPEC.md](docs/SPEC.md) 是契约。

## 开发

```sh
npm ci
npm run build
npm run test:fast
```

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

漏洞请按 [SECURITY.md](SECURITY.md) 的说明私下报告。不要开公开 issue。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
