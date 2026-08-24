[简体中文](README.zh.md)

# ci-runner

Trigger your CI and get it fixed — a dsh plugin bundle that runs GitHub
Actions workflows and local test pipelines, streams their logs back, tracks
their status, and when something fails hands the tail of the log to DeepSeek
for a Markdown root-cause report with fix steps.

- **Two sources, one interface**: GitHub Actions via `workflow_dispatch`
  (+ check-run APIs) and local command pipelines (`npm test`, `pytest`, …)
  through the platform shell.
- **Bounded log reading**: GitHub job logs streamed back per job and
  tail-truncated; local output captured with a per-stream cap so a runaway
  process can't blow up the agent context.
- **DeepSeek diagnosis**: on failure, the tail log plus a heuristic error
  classification is sent to the harness `ctx.llm` (or any configured
  OpenAI-compatible endpoint) to produce a report covering failure stage,
  error classification, most likely root cause, suggested fix steps and
  related files.
- **Status tracking**: poll runs to completion (`queued` / `in_progress` /
  `completed`) with configurable interval and a hard timeout.
- **Credentials by environment only**: the GitHub token is read from an
  environment variable at call time, never logged and never persisted; every
  returned log and report is masked against known secrets.
- **Zero runtime dependencies**: `fetch` + `node:child_process`, plain
  Node.js ESM, ships with five tools (`ci_trigger`, `ci_status`, `ci_logs`,
  `ci_watch`, `ci_diagnose`) and a matching CLI.

## How it works

```
your repo / your machine
   │   workflow_dispatch + check-run APIs      shell (npm test, pytest, …)
   ▼                                          ▼
GitHubApi (fetch)                    LocalRunner (child_process)
   │                                          │
   └──────────────► CiService ◄────────────────┘
        │    trigger · status · logs · watch · diagnose
        ├─► dsh adapter: five ci_* tools on ctx.tools (ctx.llm for analysis)
        ├─► CLI:        ci-runner trigger|status|logs|watch|diagnose
        └─► report:     Markdown with the five canonical sections
```

All state (stored local runs, config, secret-masking) lives in one
`CiService` instance, so tools and CLI behave identically. The dsh adapter
and the CLI are two thin entry points over it.

## Requirements

- Node.js >= 18.17 (global `fetch`)
- For the dsh integration: a working DeepSeek Harness install providing the
  `tools` service (and, for model-powered diagnosis, the `llm` service).
- A GitHub token in the environment (`GITHUB_TOKEN` by default) with
  `actions:write` scope for dispatch and `actions:read` for status/logs.

## Installation into dsh

### As a dsh bundle (recommended)

A bundle is an npm package that contributes a configuration layer. From the
profile you want to use:

```sh
dsh plugin --profile demo add ./path/to/ci-runner
```

This links the checkout and appends `dsh-ci-runner` to the profile's bundle
list because `package.json` declares `dsh.bundle`. Verify and boot:

```sh
dsh --profile demo --dump-config   # shows the "# == dsh-ci-runner" layer
dsh --profile demo
```

The contributed patch layer (`cordis.patch.yml`) inserts one plugin row
mounting the adapter entry (a package subpath resolved through the package's
`exports` map):

```yaml
- insert:
    - id: ci-runner
      name: dsh-ci-runner/adapter
```

### As a patch overlay (no packaging)

Point the plugin row directly at the adapter source. Create an overlay file
`ci-runner-patch.yml`:

```yaml
- insert:
    - id: ci-runner
      name: '<abs-path>/src/adapter.js'
```

and pass it to the harness:

```sh
dsh --patch ./ci-runner-patch.yml
```

### Applying plugin config

When installed as a bundle, plugin configuration is set through the profile
config (the layer contributed by the bundle) — every field is optional and
defaulted:

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

Without `diagnosis.llm`, analysis routes through the harness `ctx.llm`
service (preferred — matches the harness's configured provider). If neither
exists, diagnosis still produces a deterministic report (stage +
classification + log tail) with a note about the missing model.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `github.tokenEnv` | `GITHUB_TOKEN` | Env var holding the GitHub token (read at call time, never logged) |
| `github.defaultRepo` | `''` | Default `owner/repo` for GitHub calls |
| `github.defaultBranch` | `main` | Ref used when a trigger doesn't specify one |
| `github.apiBase` | `https://api.github.com` | REST base (GitHub Enterprise override) |
| `github.pollIntervalMs` | `5000` | Poll interval for status tracking |
| `github.pollTimeoutMs` | `600000` | Hard cap for waiting on a run |
| `github.dispatchWindowMs` | `20000` | How long a dispatch may take to surface a run id |
| `github.requestTimeoutMs` | `30000` | Per-request HTTP timeout |
| `github.readLogChars` | `30000` | Default tail cap for `ci_logs` |
| `local.cwd` | `.` | Working directory for command runs |
| `local.timeoutMs` | `120000` | Hard timeout per command |
| `local.maxOutputChars` | `40000` | Per-stream output cap |
| `local.templates` | `[{name: 'npm test', command: 'npm test'}, {name: 'pytest', command: 'pytest'}]` | Named command templates |
| `diagnosis.llm` | `null` | OpenAI-compatible endpoint override `{baseUrl, apiKey, model}` |
| `diagnosis.provider` | `''` | `ctx.llm` provider route (`''` = auto) |
| `diagnosis.model` | `''` | `ctx.llm` model (`''` = auto) |
| `diagnosis.maxTailChars` | `12000` | Chars of the log tail sent to the model |
| `diagnosis.timeoutMs` | `120000` | Hard budget for the analysis call |
| `diagnosis.temperature` | `0.2` | Sampling temperature |
| `diagnosis.providerLabel` | `OpenAI-compatible` | Label recorded in reports when the endpoint override is used |

Templates let the model and the CLI reference pipelines by name
(`ci_trigger {source: local, command: 'npm test'}`). Any value that doesn't
match a template name is treated as a raw shell command line.

## Tools

| Tool | Purpose |
| --- | --- |
| `ci_trigger` | Dispatch a GitHub `workflow_dispatch` (returns the run id) or run a local pipeline to completion |
| `ci_status` | Single poll: status, conclusion, failed stage, jobs and steps |
| `ci_logs` | Read logs, masked and tail-truncated; `job` selects one job |
| `ci_watch` | (Optionally trigger and) wait until a run finishes; failed runs include the log tail |
| `ci_diagnose` | End-to-end: run/wait, then send the failure tail to the analysis provider and return the Markdown report |

### Report structure

`ci_diagnose` (and the CLI `diagnose` command) always emit the canonical
sections:

```
# CI Failure Report
## Failure Stage          ← first failing job/step (or "Unknown")
## Error Classification   ← heuristic rule-based pre-analysis
## Most Likely Root Cause ← model analysis (or a note when no model is available)
## Suggested Fix Steps    ← model analysis
## Related Files          ← model analysis (or "None identifiable from the log")
## Timeline               ← start/end/duration when known
## Failure Log Tail       ← masked, tail-truncated
```

When a model is available, its free-form Markdown is parsed back into these
sections before rendering, so the structure is stable even as the model's
wording varies.

## CLI

```
ci-runner trigger  [--source github|local] [--repo owner/repo] [--workflow F]
                   [--ref R] [--inputs k=v ...] [--command CMD] [--template T]
                   [--cwd DIR]
ci-runner status   [--source s] --run ID [--repo r]
ci-runner logs     [--source s] --run ID [--job J] [--tail N] [--repo r]
ci-runner watch    [--source s] [--run ID | trigger flags] [--timeout-ms N]
                   [--interval-ms N] [--no-logs] [--json]
ci-runner diagnose [--source s] [--run ID | trigger flags] [--save PATH]
                   [--llm-base-url URL] [--llm-model M] [--llm-api-key K]
```

Global: `--config PATH` (JSON config file), `--json`, `--help`, `--version`.

For `diagnose` without a config file, pass `--llm-base-url` (+ `--llm-model`
and optionally `--llm-api-key`; keys can also come from `CI_RUNNER_LLM_API_KEY`
or `OPENAI_API_KEY`).

> Local run ids are process-local: `status`/`logs` on a local run work with a
> run id captured inside the same invocation. Across CLI invocations, drive
> local pipelines with `watch`/`diagnose` + `--command` (or use GitHub runs,
> whose state lives server-side). Inside dsh, all five tools share one
> process, so captured run ids stay valid for the plugin's lifetime.

## Examples

```sh
# GitHub: dispatch ci.yml on main with inputs and print the run id
ci-runner trigger --workflow ci.yml --repo acme/app --ref main --inputs env=prod

# Local: run the "pytest" template (or any raw command)
ci-runner trigger --source local --template pytest --cwd ./api

# Wait for run 123456789, show the tail if it failed
ci-runner watch --run 123456789 --repo acme/app --timeout-ms 600000

# Local failure → DeepSeek diagnosis (markdown report, also saved to disk)
ci-runner diagnose --source local --command "npm test" \
  --llm-base-url https://api.deepseek.com/v1 --llm-model deepseek-chat \
  --save report.md
```

## Security notes

- The GitHub token is read from `process.env[github.tokenEnv]` on every call
  and exists only in memory; it is never written to logs, reports or disk.
- All returned log text is masked against the GitHub token and any configured
  analysis API key (`***` substitution).
- Local commands run in the configured `cwd` only and are killed as a process
  tree on timeout — no orphaned grandchildren keep running.
- Diagnosis payloads contain the log tail only; the token never reaches the
  model.

## Project layout

```
bin/ci-runner.mjs        CLI launcher
cordis.patch.yml         bundle patch layer (mounts the adapter row)
src/
  adapter.js             Cordis plugin entry: name / inject / Config / apply
  index.js               public package surface (harness-free)
  config.js              canonical config, defaults, validation
  github.js              GitHub REST client (dispatch, runs, jobs, logs, checks)
  local.js               child_process runner (timeout, tree-kill, capped capture)
  logs.js                bounded buffers, tailing, ANSI cleanup, secret masking
  classify.js            rule-based failure classification
  llm.js                 prompt building + OpenAI-compatible client (harness-free)
  dsh-llm.js             ctx.llm stream adapter (harness-side)
  diagnose.js            run metadata + Markdown report assembly
  service.js             cross-source orchestration (tools and CLI share it)
  tools.js               the five ci_* tool definitions
  cli.js                 CLI implementation
test/                    node:test suites (mock GitHub API, temp scripts, diagnosis flow)
examples/                config + profile overlay examples
```

## Test

```sh
npm install   # peer deps (schemastery, dsh-llm) for the adapter tests
npm test      # node --test
```

## License

MIT