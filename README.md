# dsh-knowledge-base

为 DeepSeek Harness 提供**按任务的知识库**：会话顶部「对话 / 轨迹 / Readme」旁新增一个 **知识库** 标签，
每个任务一份 Markdown 文档，把对话提炼成**任务目的 / 操作规则 / 方法 / 权限边界 / 映射 / 决策 / 当前状态**，
让换模型、换会话之后仍能接着执行同一个任务。

> A per-task knowledge base for DeepSeek Harness: one Markdown document per task, browsable in a **Knowledge** tab
> next to Chat and Trajectory, so another model can pick the task up.

知识库**不是**执行记录：`README.dsh.md`、日志、逐字对话都属于执行记录，不写进知识库目录。

## 产物

```
<工作区>/knowledge-base/
├── index.md              # 全部任务索引（自动生成）
└── <任务名>.md            # 一个任务一份，文件名 = 任务名
```

任务文档固定结构（第 8 节由插件自动维护，其余由模型通过工具写入）：

```markdown
# 知识库 · <任务名>

> 状态：进行中 · 更新：2026-11-10 10:36 · 来源会话：<session id>
> 工作区：`<cwd>`
> 用法：换模型或新会话接手同一任务时，先读第 7 节，再读第 2、4 节确认规则与边界；第 8 节由插件按对话自动维护。

## 1. 任务目的
## 2. 操作规则
## 3. 方法与流程
## 4. 权限边界
## 5. 映射
## 6. 关键决策与结论
## 7. 当前状态与下一步
## 8. 对话纪要（自动生成）
```

## 界面

| 区域 | 行为 |
| --- | --- |
| 标签 | 会话顶部 `对话 / 轨迹 / Readme / 知识库`，`conversation.view` 注册 id `knowledge-base`、order 30 |
| 顶栏 | 知识库目录、任务数、最近更新时间；「刷新」「复制文档」 |
| 左栏 | 任务文档列表：任务名、一行目的、状态、更新时间；本会话的文档带「本会话」标记 |
| 右栏 | 选中文档的 Markdown（标题、引用、列表、表格、行内代码/加粗） |
| 中线 | 可左右拖动调整占比（双击区域用 ← → 微调，窄屏自动单栏） |

数据全部来自 Host 投影 `useProjection('knowledgeBase')`；标签可见时每 8 秒调用一次
`sessions.refreshProjections` 取最新值，不在前端折叠事件。

## 模型侧

系统提示里会注入一段「## 知识库」说明（`injectPrompt: false` 可关闭），并注册工具：

| 动作 | 参数 | 行为 |
| --- | --- | --- |
| `write` | `task` + 任意小节（`purpose/rules/methods/boundaries/mappings/decisions/next`）+ `note` | 只覆盖传入的小节，其余保留磁盘内容；写入后重写索引 |
| `read` | `task` | 返回整份文档 |
| `list` | — | 列出全部任务文档（任务、状态、更新时间、目的） |

每轮 `turn/end` 后插件还会用会话投影重渲染**本任务**的文档：刷新头部时间、第 8 节对话纪要（每轮的问题、
回答、改动文件、工具计数、失败次数），并重写 `index.md`。模型没调用工具时也会按会话首轮问题自动命名任务落盘，
所以对话不会因为模型忘记写知识库而丢失。

## 安装

**A. 从 GitHub 安装（推荐，便于升级）**

```
plugin_manager install_bundle  github:JackX-666/dsh-knowledge-base
```

等价写法：`plugin_manager install_bundle  https://github.com/JackX-666/dsh-knowledge-base.git`
升级时重装一次即可。装完**刷新一次页面**，会话顶部会出现「知识库」标签。

**B. 用 tarball（离线 / 内网）**

1. 在仓库目录打包：`pnpm pack --pack-destination .`
2. 把 `.tgz` 拷到目标机器：`plugin_manager install_bundle  file:D:\plugins\dsh-knowledge-base-1.0.0.tgz`

**C. 本机开发目录（改代码即时生效）**

```
plugin_manager install_bundle  D:\AI Agent\DeepseekHarness\dsh-knowledge-base
```

目录直链安装：改 `client.js` 后刷新页面；改 `index.js`（Host 半）后重新安装或重启 DSH 以加载新的模块代际。

**目标机器需要满足**

- DSH 版本包含 `conversation.view`、`sessionProjections`、`tools`、`systemPrompt` 四项能力；
- 插件只读写**当前会话工作区的** `knowledge-base/` 目录，不需要额外权限；
- Windows / macOS / Linux 均可，代码里没有平台相关分支。
- 无构建步骤、无 npm 运行时依赖；Node 版本随 DSH 即可。

## 配置

`cordis.patch.yml` 里该 bundle 插入的行（id `knowledge-base`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `knowledge-base` | 相对工作区的知识库目录 |
| `autoWrite` | `true` | 每轮结束是否重渲染本任务文档并写索引 |
| `injectPrompt` | `true` | 是否注入「## 知识库」系统提示段 |
| `maxTurns` | `60` | 对话纪要保留的最近轮数 |
| `maxDocs` | `40` | 传给界面的文档数上限 |
| `maxDocChars` | `8000` | 非当前任务的单份文档在视图里的字符上限 |

## 设计约束

- **数据源只有两处**：Session 日志（投影折叠）与知识库目录里的文件；没有额外状态库、不轮询 agent 状态。
- **合并而不是覆盖**：模型没传的小节保留磁盘内容，所以用户手写、别的模型写的文档不会被静默清空。
- **任务名即文件名**：过滤 `\ / : * ? " < > |`、控制字符与 Windows 保留名，最长 48 字符；同名任务视为同一任务，
  来源会话累加。
- **外来文档不动**：知识库目录里不是本插件格式（没有 `# 知识库 · ` 标题）的 `.md` 只出现在扫描结果里、被标记为
  foreign，插件不会改写它。
- **子代理不自动写盘**：`header.origin === 'subagent'` 的会话跳过 `turn/end` 自动落盘（与父会话共享工作区），
  但它仍可主动调用 `knowledge_base`。
- 状态结构变化时提升投影 `stateVersion`（当前 1）。

## 验证

```
node scripts/verify.mjs
```

覆盖：客户端模块工厂与 `conversation.view` 注册、标签本地化、视图渲染（标题/小节/列表/文档名）、
Host 侧任务名安全化与命名、Session 日志折叠、文档渲染与回解析往返、小节合并保留、外来文档标记。

运行时检查：

- `plugin_manager list_plugins` 应显示 `dsh-knowledge-base` 为 `fiberPhase: active`；
- `Slots.listSubTree` 的 `conversation.view` 占用者应包含 `knowledge-base`（order 30）；
- 系统提示应出现「## 知识库」段，工具列表应出现 `knowledge_base`；
- 新会话完成一轮后，`knowledge-base/` 下应出现以任务命名的文档与 `index.md`。

## 已知限制

- 视觉渲染只能在有浏览器控制时确认；无浏览器控制时仅验证到槽位注册与静态渲染。
- 任务文档由模型主动写入；模型不调用 `knowledge_base` 时，第 1–7 节只有骨架，第 8 节仍完整。
- 多个会话同时写同一任务文档时，后完成的一轮获胜（按会话串行写盘以降低交错概率）。

## 许可

MIT © 2026 JackX-666，见 [LICENSE](LICENSE)。
