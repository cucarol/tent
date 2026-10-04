# Tent / 帷幄

> *vibe 于帷幄之中*

[English](README.md)

Tent 把项目的工作上下文留在项目里：确认过的目标、后续工作要遵守的决定、某件事确实做过的证据，以及从一个 Agent 会话交给下一个会话的输入。它是 `.tent/` 里的一小组 Markdown 文件，组成一张图，由独立的 Git 历史保存版本。Agent 通过 Skill 和 CLI 读写它，你在本地网页里浏览和编辑。

当前版本 0.1.0，还在早期，会继续变化，见[现状](#现状)。

## 什么时候有用

Tent 面向一份交接文档已经装不下的项目：同时有几个方向，需求会被修改或撤回，工作跨越很多会话或几个 Agent。小任务用一份普通笔记更简单，效果也一样，那就用笔记。

安装 Tent 不意味着 Agent 会主动使用它，要你明确说：「用 Tent」「把这条记成 Node」「给报表那个 Role 发一张 Card」。

## 模型

所有内容都在项目文件夹根目录的 `.tent/` 里。真实文件留在原处，Tent 只指向它们。

- **Node**：一条长期事实，带 YAML frontmatter 的 Markdown。`type` 说明它的依据：`goal` 是用户确认过的意图，`prompt` 是后续工作要遵守的约定，`output` 是某个时间点观察到的证据。项目可以按 `primary[-secondary]` 的形式加后缀，比如 `prompt-decision`。
- **Role**：一个持续的工作方向，写明目的、边界和常用入口。它不是正在运行的 Agent，也不是权限或模型配置。
- **Card**：一次固定的输入。包括一段提示、它依据的 Node 和文件（其中 Node 和 Role 固定到当时的 Git 版本），可选一个目标 Role。会话用 take 记录自己收到了这张 Card。输入要改，就发一张新 Card。

写入时会核对 ETag，两个会话不会悄悄覆盖对方。Tent 的历史在 `.tent/.git`，和项目自己的仓库分开；`tent new` 只会把 `.tent/` 加进项目的 `.gitignore`。精确规则见 [docs/SPEC.md](docs/SPEC.md)。

## 安装

需要 Node.js 22.19+ 和 Git。

### Codex

从 [Releases](https://github.com/cucarol/tent/releases/tag/0.1.0) 下载 `tent-plugin-0.1.0.zip`，解压到准备保留的目录，再把该目录添加为本地 marketplace：

```sh
codex plugin marketplace add "<解压目录的绝对路径>"
codex plugin add tent@tent-local
```

解压目录必须同时包含 `.agents/` 和 `plugins/`。这个包自带 CLI、网页界面、Skill 和 Hook，不需要再运行 npm install。

也可以从源码构建：

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
codex plugin marketplace add "$PWD/release"
codex plugin add tent@tent-local
```

`npm run plugin:build` 把完整插件写到 `release/plugins/tent`：四个 Skill、两个 Hook、CLI 和网页界面，旁边再写一个本地 marketplace。Codex 会请你审查 SessionStart 和 Stop 两个 Hook；不启用它们，Tent 也能用。详见 [docs/PLUGIN.md](docs/PLUGIN.md)。

也可以把下面这段发给你的 Agent：

```text
Install the Tent plugin for Codex from github.com/cucarol/tent:
clone it, run `npm ci --ignore-scripts && npm run plugin:build`,
then `codex plugin marketplace add "<clone>/release"` and `codex plugin add tent@tent-local`.
Check that the four Skills appear, and let me review the new Hooks.
```

### 其他 Agent

目前只有 Codex 有安装包。能执行命令的 Agent 都可以直接用包里的 CLI：

```sh
node "<插件目录>/cli.mjs" --help
```

插件目录是下载包解压后的 `plugins/tent`，或源码构建后的 `release/plugins/tent`。若使用单独的 npm CLI 包，从同一 Release 下载 `cucarol-tent-0.1.0.tgz`，运行 `npm install -g "<cucarol-tent-0.1.0.tgz 的路径>"`。这会安装运行依赖并提供 `tent` 命令，不会注册 Codex 插件。

## 使用

下面的 `tent` 是 `node <插件目录>/cli.mjs` 的简写，Agent 会自己找到包里的那份。

1. **开始**：让 Agent 在项目文件夹里初始化 Tent，或者运行 `tent new .`。这一步只建一个空的 `.tent/`，不会扫描项目，也不会替你写 Node。
2. **记事实**：工作中让 Agent 把后面的会话不能搞错的东西记下来，比如确认过的目标、一个决定和它的理由、测试实际显示了什么；开工前先读相关的 Node。
3. **交接**：工作要交给另一个会话或方向时，建一张 Card，写上提示和它依赖的 Node。下一个会话 take 这张 Card，从那里开始。

大部分工作用不到 Role 和 Card。提交、审查和合并照常走你的 Git 流程。

## 网页界面

```sh
tent ui --workspace <项目文件夹>
```

本地网页会画出 Node、Role、Card 的图谱和它们之间的关系。可以编辑 Node、建 Card、在图上留批注，也能在打开过的工作区之间切换。服务在启动它的终端里运行，Ctrl+C 退出。`--port` 指定端口，`--no-open` 只打印地址、不打开浏览器。

## 现状

- **一个维护者，版本 0.1.0。** 文件格式和命令还可能变，以 [SPEC](docs/SPEC.md) 为准。
- **还没有证据表明它比普通笔记好。** 2026 年 10 月最新一轮针对需求会变化的项目进行对照，Markdown 组完成了集成；Tent 组的初始拆解超时，最终集成被共享 token 预算截断。Tent 中一处过期摘要在下一阶段自行修正，拆解阶段较高的观测成本再次出现；这些局部发现尚不能证明质量或效率收益。
- **Hook 需要宿主批准。** 第一轮测试中的 Hook 未获信任，没有投递不能说明宿主模式不支持它们。需要启用时，在宿主里审查并信任 Hook；所有命令不依赖 Hook。

## 开发

```sh
npm ci
npm run build
npm run test:fast
npm run ui:dev -- --workspace <项目文件夹>
```

见 [CONTRIBUTING.md](CONTRIBUTING.md)。漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)

## 友情链接

[Linux DO](https://linux.do)：连接开发者与技术爱好者的开放社区。
