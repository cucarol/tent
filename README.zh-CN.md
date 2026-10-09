# Tent / 帷幄

[English](README.md)

**vibe 于帷幄之中**

Tent 是项目的上下文图谱，与代码图谱相对应。代码图谱画出代码怎样连在一起。Tent 记下发生了什么、为什么：用户确认过的目标、后续工作要遵守的约定、做出了什么的证据。它让领先看得见：还没有任何实现的目标。它让落后看得见：依据的材料在记录之后变了的事实。它不是笔记本，也不是任务看板。Agent 通过 Skill 和 CLI 读写它。你在本地网页里浏览它。

## 什么时候有用

Tent 面向一份交接笔记已经装不下的项目：同时有几个方向，需求会被修改，工作跨越很多会话或几个 Agent。小任务用一份普通笔记更简单，效果也一样。

## 模型

所有内容都在项目根目录的 `.tent/` 里。含有 `.tent/` 的文件夹就是工作区。`.tent/` 在 `.tent/.git` 里有自己的 Git 历史，和你的仓库分开。真实文件留在原处，Tent 只指向它们。`tent new` 在 `.tent/` 之外只改一处：把 `.tent/` 加进项目的 `.gitignore`。

- **Node**：一条长期事实，是带 YAML frontmatter 的 Markdown。`type` 只能是 `goal`、`prompt` 或 `output`，说明内容依据的是什么：
  - `goal`：用户确认过的意图。
  - `prompt`：后续工作遵守的约定。
  - `output`：某个时间点观察到的证据。

  `tags` 说明内容是什么形式、关于什么。它们自由填写，不改变任何行为。Tent 提供一组建议预设，比如 `decision` 和 `evidence`。
- **Role**：一个持续的工作方向，写明目的、边界和入口。它不是正在运行的 Agent，也不是权限。
- **Card**：一次固定的输入，包含一段提示、它的来源和可选的目标 Role。来源里的 Node 和 Role 钉在当时的 Git 版本。会话接收（take）一张 Card，Tent 记下这次接收。Card 发出后不再改变；输入要改，就发一张新 Card。

把图谱和你的文件对照，会得到两种判断。Node 的材料，也就是它指向的文件或 Node，在 Tent 记录版本之后变了，它就处于**落后**。goal 下面任何位置都没有未作废的 output 时，它处于**领先**；tags 不影响这一点。goal 自己变了也会领先：它的正文或材料一变，下面的每个 output 都落后，goal 处于领先，直到这些 output 复核完。如果只是某个 output 自己的材料变了，这个 output 落后，但 goal 不会因此领先：实现已经有了，只是需要复核。Card 里的 goal，只要还有一个回应它的 output 没有落后，就算完成；回应它的 output 全部落后时，Card 显示 `needs-review`。

作为材料传给 CLI 的文件路径，比如 `--resource` 或 Card 的 `--source`，从工作区根目录解析。替换内容的写入必须带上读到的 ETag，两个会话不会悄悄覆盖对方。精确规则见 [docs/SPEC.md](docs/SPEC.md)。

## 安装

需要 Node.js 22.19+ 和 Git。

### Codex

从[最新 Release](https://github.com/cucarol/tent/releases/latest) 下载 `tent-plugin-<version>.zip`，解压到准备长期保留的目录，目录里有 `.agents/` 和 `plugins/`。把这个目录添加为本地 marketplace，再安装插件：

```sh
codex plugin marketplace add "<解压目录的绝对路径>"
codex plugin add tent@tent-local
```

插件自带四个 Skill、两个 Hook、CLI 和网页界面。它不需要 npm install。Codex 会请你审查 SessionStart 和 Stop 两个 Hook；不启用它们，所有命令照样能用。详见 [docs/PLUGIN.md](docs/PLUGIN.md)。

从源码构建：

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
codex plugin marketplace add "$PWD/release"
codex plugin add tent@tent-local
```

`npm run plugin:build` 把插件写到 `release/plugins/tent`，旁边再写一个本地 marketplace。已有构建结果时，它拒绝覆盖。

也可以把下面这段发给你的 Agent：

```text
Install the Tent plugin for Codex from github.com/cucarol/tent:
clone it, run `npm ci --ignore-scripts && npm run plugin:build`,
then `codex plugin marketplace add "<clone>/release"` and `codex plugin add tent@tent-local`.
Check that the four Skills appear, and let me review the new Hooks.
```

### 其他 Agent

目前只有 Codex 有插件包。能执行 shell 命令的 Agent 都可以直接用包里的 CLI：

```sh
node "<插件目录>/cli.mjs" --help
```

插件目录是下载包解压后的 `plugins/tent`，或源码构建后的 `release/plugins/tent`。只装 CLI 的话，运行 `npm install -g vibe-tent`。这会提供 `tent` 命令，不会注册 Codex 插件。每个 Release 也附有同一个包 `vibe-tent-<version>.tgz`。

## 使用

下面的 `tent` 是 npm 装的命令；用插件时换成 `node "<插件目录>/cli.mjs"`。每条命令都会打印下一步要用的 id。`<goal-id>`、`<card-id>`、`<output-id>` 和 `<etag>` 代表这些值。

1. **建一个 Tent。** 在项目根目录运行，会建一个空的 `.tent/`，带自己的 Git 历史。

   ```sh
   tent new .
   ```

2. **记一个 goal。** 简报把它列为领先：还没有东西实现它。

   ```sh
   tent node create "Email sign-in" --type goal --body "Users sign in with an email address and a one-time code."
   tent workspace brief
   ```

3. **发一张 Card。** Card 带着提示，并把这个 goal 钉在当前版本。

   ```sh
   tent card create --prompt "Implement email sign-in." --source <goal-id>
   ```

4. **接收它。** 干活的会话接收这张 Card，Tent 记下这次接收。

   ```sh
   tent card take <card-id>
   ```

5. **关联产出。** 工作落成文件后，output 把它记在 goal 下面，并回应这张 Card。

   ```sh
   echo "export function signIn(email) {}" > login.js
   tent node link-output <goal-id> --resource login.js --card <card-id>
   ```

6. **改动材料。** 简报现在把这个 output 列为落后，把 Card 列为 `needs-review`。

   ```sh
   echo "export const CODE_TTL_MINUTES = 10;" >> login.js
   tent workspace brief
   ```

7. **确认。** 复核改动之后，用完整读取返回的 `etag` 确认这个 output。

   ```sh
   tent node get <output-id> --full --json
   tent node confirm <output-id> --base-etag <etag>
   ```

现在 `tent workspace brief` 报告 `behind 0 · ahead 0`。

日常工作里，你开口时 Agent 会通过 Skill 运行这些命令：「用 Tent」「把这条记成 goal」「给报表那个 Role 发一张 Card」。大部分工作用不到 Role 和 Card。提交、审查和合并照常走你的 Git 流程。

## 网页界面

```sh
tent ui --workspace <项目文件夹>
```

服务在当前终端里运行，Ctrl+C 停止。页面先打开「现在」：各 Role 从 Card 接手的工作、上次访问以来的产出，以及领先和落后的内容。「图谱」画出 Node、Role、Card 和它们之间的链接，带同样的标记。你可以编辑和确认 Node、写 Card，也能在打开过的工作区之间切换。`--port` 指定端口。`--no-open` 只打印地址，不打开浏览器。

## 现状

- **一个维护者。** 文件格式和命令还可能变。[docs/SPEC.md](docs/SPEC.md) 是契约。
- **还没有证据表明它比普通笔记好。** 最近一次对照在 2026 年 10 月进行，对象是一个需求会变化的项目。Markdown 组完成了集成。Tent 组的初始拆解超时，最终集成被共享 token 预算截断。一处过期的 Tent 摘要在下一阶段得到修正。拆解成本偏高的情况再次出现。这些局部发现不能证明质量或效率上的收益。
- **Hook 需要宿主批准。** 第一轮测试里 Hook 没有获得信任，所以那次没有收到 Hook 不能说明宿主送不到。要启用，就在宿主里审查并信任它们。所有命令都不依赖 Hook。

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
