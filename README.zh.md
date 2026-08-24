[English](README.md)

# ci-runner

触发你的 CI，并让它自己给出修复建议——一个 dsh 插件 bundle：触发 GitHub
Actions 工作流与本地测试流水线，回读日志，跟踪运行状态；失败时把日志尾部交给
DeepSeek，生成包含根因与修复步骤的 Markdown 诊断报告。

- **两种来源，同一套接口**：GitHub Actions（`workflow_dispatch` +
  check-run API）与本地命令流水线（`npm test`、`pytest` 等，走平台 shell）。
- **有界的日志回读**：GitHub 任务日志按 job 分段拉取并截取尾部；本地输出按
  流设置上限，失控进程也不会撑爆上下文。
- **DeepSeek 失败诊断**：失败时把日志尾部 + 规则式错误分类交给
  harness 的 `ctx.llm`（或任意配置的 OpenAI 兼容接口），产出包含失败阶段、
  错误类型、最可能的根因、建议修复步骤、相关文件的 Markdown 报告。
- **状态跟踪**：轮询 `queued / in_progress / completed` 直至结束，间隔与
  超时均可配置。
- **凭据只走环境变量**：GitHub token 在调用时刻从环境变量读取，不进日志、
  不落盘；所有返回的日志与报告都会对已知密钥做掩码。
- **零运行时依赖**：`fetch` + `node:child_process`，纯 Node.js ESM，内置
  五个工具（`ci_trigger`、`ci_status`、`ci_logs`、`ci_watch`、
  `ci_diagnose`）与配套 CLI。

## 工作方式

```
你的仓库 / 你的机器
   │   workflow_dispatch + check-run API         shell（npm test、pytest…）
   ▼                                             ▼
GitHubApi (fetch)                       LocalRunner (child_process)
   │                                             │
   └──────────────► CiService ◄──────────────────┘
        │   trigger · status · logs · watch · diagnose
        ├─► dsh adapter：在 ctx.tools 注册五个 ci_* 工具（分析走 ctx.llm）
        ├─► CLI：       ci-runner trigger|status|logs|watch|diagnose
        └─► 报告：      固定五个章节的 Markdown
```

所有状态（本地运行结果、配置、密钥掩码）都在一个 `CiService` 实例中，
工具与 CLI 行为完全一致；dsh adapter 与 CLI 只是它的两个薄入口。

## 环境要求

- Node.js >= 18.17（全局 `fetch`）
- dsh 集成需要：可用的 DeepSeek Harness（提供 `tools` 服务；模型诊断还需要
  `llm` 服务）。
- 环境变量中的 GitHub token（默认 `GITHUB_TOKEN`），dispatch 需要
  `actions:write`，状态/日志需要 `actions:read`。

## 接入 dsh

### 作为 dsh bundle（推荐）

bundle 是以 npm 包形式提供配置层的分发单元。在目标 profile 下执行：

```sh
dsh plugin --profile demo add ./path/to/ci-runner
```

该命令会把本目录链接进 profile 的 bundle 列表（因为 `package.json` 声明了
`dsh.bundle`）。验证并启动：

```sh
dsh --profile demo --dump-config   # 应看到 "# == dsh-ci-runner" 配置层
dsh --profile demo
```

bundle 自带的补丁层（`cordis.patch.yml`）插入一行插件，挂载 adapter 入口
（包子路径，通过 package.json 的 `exports` 映射解析）：

```yaml
- insert:
    - id: ci-runner
      name: dsh-ci-runner/adapter
```

### 作为补丁覆盖文件（不打包）

直接把插件行指向 adapter 源码。新建覆盖文件 `ci-runner-patch.yml`：

```yaml
- insert:
    - id: ci-runner
      name: '<绝对路径>/src/adapter.js'
```

然后：

```sh
dsh --patch ./ci-runner-patch.yml
```

### 插件配置

以 bundle 方式安装后，通过 profile 配置为 bundle 层贡献的字段来配置，所有
字段可选且带默认值：

```yaml
# profile/config.yml
ci-runner:
  github:
    defaultRepo: acme/app
    defaultBranch: main
  diagnosis:
    llm:
      baseUrl: https://api.deepseek.com/v1
      apiKey: sk-...
      model: deepseek-chat
```

不配置 `diagnosis.llm` 时，分析走 harness 的 `ctx.llm` 服务（推荐，跟随
harness 已配置的供应商）。两者都没有时，诊断仍会输出确定性报告（失败阶段 +
错误分类 + 日志尾部），并注明缺少模型。

## 配置项

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `github.tokenEnv` | `GITHUB_TOKEN` | 存放 GitHub token 的环境变量（调用时读取，绝不记录） |
| `github.defaultRepo` | `''` | 默认 `owner/repo` |
| `github.defaultBranch` | `main` | 未指定 ref 时使用的分支 |
| `github.apiBase` | `https://api.github.com` | REST 基址（企业版可覆盖） |
| `github.pollIntervalMs` | `5000` | 状态轮询间隔 |
| `github.pollTimeoutMs` | `600000` | 等待运行结束的硬上限 |
| `github.dispatchWindowMs` | `20000` | dispatch 后等待 run id 出现的时间 |
| `github.requestTimeoutMs` | `30000` | 单次 HTTP 请求超时 |
| `github.readLogChars` | `30000` | `ci_logs` 默认尾部截断字符数 |
| `local.cwd` | `.` | 命令运行目录 |
| `local.timeoutMs` | `120000` | 单条命令硬超时 |
| `local.maxOutputChars` | `40000` | 每流输出上限 |
| `local.templates` | `[{name:'npm test',command:'npm test'},{name:'pytest',command:'pytest'}]` | 命名命令模板 |
| `diagnosis.llm` | `null` | OpenAI 兼容端点覆盖 `{baseUrl, apiKey, model}` |
| `diagnosis.provider` | `''` | `ctx.llm` 供应商路由（`''` = 自动） |
| `diagnosis.model` | `''` | `ctx.llm` 模型（`''` = 自动） |
| `diagnosis.maxTailChars` | `12000` | 交给模型的日志尾部字符数 |
| `diagnosis.timeoutMs` | `120000` | 分析调用硬预算 |
| `diagnosis.temperature` | `0.2` | 采样温度 |
| `diagnosis.providerLabel` | `OpenAI-compatible` | 使用端点覆盖时记录在报告中的提供方标签 |

模板让模型与 CLI 能按名字引用流水线（`ci_trigger {source: local,
command: 'npm test'}`）；不以模板名匹配的值会被当作原始 shell 命令行执行。

## 工具

| 工具 | 用途 |
| --- | --- |
| `ci_trigger` | 触发 GitHub `workflow_dispatch`（返回 run id）或跑完一条本地流水线 |
| `ci_status` | 单次轮询：状态、结论、失败阶段、job 与 step |
| `ci_logs` | 回读日志（掩码 + 尾部截断），`job` 可选单个 job |
| `ci_watch` | （可选先触发并）等待运行结束；失败时附带日志尾部 |
| `ci_diagnose` | 端到端：运行/等待后，把失败尾部交给分析方并返回 Markdown 报告 |

### 报告结构

`ci_diagnose`（与 CLI 的 `diagnose`）总是输出固定章节：

```
# CI Failure Report
## Failure Stage           ← 首个失败的 job/step（未知则为 Unknown）
## Error Classification    ← 规则式预分类
## Most Likely Root Cause  ← 模型分析（无模型时注明）
## Suggested Fix Steps     ← 模型分析
## Related Files           ← 模型分析（"None identifiable from the log"）
## Timeline                ← 已知的开始/结束/耗时
## Failure Log Tail        ← 掩码 + 尾部截断
```

有模型时，模型产出的自由格式 Markdown 会被解析回上述章节后再渲染，保证结构
稳定，不随模型措辞变化。

## CLI

```
ci-runner trigger  [--source github|local] [--repo owner/repo] [--workflow F]
                   [--ref R] [--inputs k=v ...] [--command CMD] [--template T]
                   [--cwd DIR]
ci-runner status   [--source s] --run ID [--repo r]
ci-runner logs     [--source s] --run ID [--job J] [--tail N] [--repo r]
ci-runner watch    [--source s] [--run ID | 触发参数] [--timeout-ms N]
                   [--interval-ms N] [--no-logs] [--json]
ci-runner diagnose [--source s] [--run ID | 触发参数] [--save PATH]
                   [--llm-base-url URL] [--llm-model M] [--llm-api-key K]
```

全局：`--config PATH`（JSON 配置文件）、`--json`、`--help`、`--version`。

不使用配置文件做 `diagnose` 时，传 `--llm-base-url`（可加 `--llm-model` 与
`--llm-api-key`；密钥也可来自 `CI_RUNNER_LLM_API_KEY` 或
`OPENAI_API_KEY`）。

> 本地 run id 是进程内状态：`status`/`logs` 只能引用同一次调用中捕获的本地
> run id。跨 CLI 调用时，用 `watch`/`diagnose` + `--command` 直接驱动本地
> 流水线（或使用状态存于服务端的 GitHub run）。在 dsh 内五个工具共享同一
> 进程，捕获的 run id 在插件生命周期内一直有效。

## 示例

```sh
# GitHub：在 main 上触发 ci.yml 并带 inputs，打印 run id
ci-runner trigger --workflow ci.yml --repo acme/app --ref main --inputs env=prod

# 本地：跑 "pytest" 模板（也可以是任意原始命令）
ci-runner trigger --source local --template pytest --cwd ./api

# 等待 run 123456789，失败则显示日志尾部
ci-runner watch --run 123456789 --repo acme/app --timeout-ms 600000

# 本地失败 → DeepSeek 诊断（Markdown 报告，同时存盘）
ci-runner diagnose --source local --command "npm test" \
  --llm-base-url https://api.deepseek.com/v1 --llm-model deepseek-chat \
  --save report.md
```

## 安全说明

- GitHub token 在每次调用时从 `process.env[github.tokenEnv]` 读取，仅存在于
  内存，绝不写入日志、报告或磁盘。
- 所有返回的日志文本都会对 GitHub token 与配置的分析 API key 做掩码
  （`***` 替换）。
- 本地命令只在配置的 `cwd` 下运行，超时按进程树整体杀死，不会留下孤儿孙
  进程。
- 诊断载荷只包含日志尾部，token 永远不会到达模型。

## 目录结构

```
bin/ci-runner.mjs        CLI 启动器
cordis.patch.yml         bundle 补丁层（挂载 adapter 行）
src/
  adapter.js             Cordis 插件入口：name / inject / Config / apply
  index.js               公开包面（零 harness 依赖）
  config.js              规范配置、默认值、校验
  github.js              GitHub REST 客户端（dispatch、runs、jobs、logs、checks）
  local.js               child_process 运行器（超时、进程树杀死、上限捕获）
  logs.js                有界缓冲、尾部截取、ANSI 清理、密钥掩码
  classify.js            规则式失败分类
  llm.js                 提示词构建 + OpenAI 兼容客户端（零 harness 依赖）
  dsh-llm.js             ctx.llm 流适配（harness 侧）
  diagnose.js            运行元数据 + Markdown 报告组装
  service.js             跨来源编排（工具与 CLI 共用）
  tools.js               五个 ci_* 工具定义
  cli.js                 CLI 实现
test/                    node:test 测试（mock GitHub API、临时脚本、诊断流程）
examples/                配置与 profile 覆盖示例
```

## 测试

```sh
npm install   # 安装 peer 依赖（schemastery、dsh-llm）供 adapter 测试使用
npm test      # node --test
```

## License

MIT