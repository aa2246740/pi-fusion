# Pi Fusion

**给 Pi agents 用的模型融合。**

Pi Fusion 会把一个 prompt 分发给一组独立模型，让它们并行工作、可选地收集 evidence，再由 judge model 综合、验证并输出最终答案，整个过程发生在 Pi 里。

它受 hosted Fusion-style APIs 启发，但实现为 Pi extension：你选择模型，保留 artifacts，并且可以把 fusion layer 接到现有 Pi 工具和上下文中。

官网：<https://aa2246740.github.io/pi-fusion/>

文档：[English](README.md) | 中文 | [Benchmarks](docs/benchmarks.md) | [中文基准说明](docs/benchmarks.zh-CN.md)

## 它能做什么

Pi Fusion 为一个模型答案不够用的任务提供通用 fusion layer：

- 多个 participant models 并行独立回答
- judge synthesis 和 contradiction analysis
- 可选 verification/revision loop
- 可选 web/evidence tools
- 用于确定性计算的 sandboxed bash
- model fallback 和 retry policy
- artifacts、evidence summaries、token usage 和 cost reporting
- Pi 原生命令和配置

适合研究、规划、架构决策、调试假设、代码/设计评审、产品比较、写作、文档综合，以及其他需要更高可靠性的高风险问题。

## 安装

Pi Fusion 是 Pi package/extension。

```bash
pi install git:https://github.com/aa2246740/pi-fusion@main
```

npm package 名称：

```bash
npm install @aa2246740/pi-fusion
```

本地开发：

```bash
cd pi-fusion
npm install
pi -e ./index.ts
```

Pi package discovery 在 `package.json` 中声明：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## 命令

```text
/pi-fusion-config       配置 participants、judge、tools 和 evidence backend
/pi-fusion-doctor       诊断模型和 evidence backend 可用性
/pi-fusion <prompt>     运行 fusion panel
```

示例：

```text
/pi-fusion Should we migrate this module to a plugin architecture?
/pi-fusion --fast Summarize the tradeoffs of these three implementation plans.
/pi-fusion --quality Compare the vendors and cite current sources.
```

## 配置

运行：

```text
/pi-fusion-config
```

你会选择：

1. participant models
2. judge model
3. 从可选模型列表中选择 fallback models
4. web/evidence policy
5. evidence backend mode，通常在运行时 auto-detect
6. sandboxed bash policy
7. monitor 和确认默认值

配置保存在：

```text
~/.pi/agent/pi-fusion/config.json
```

最小配置可以不启用 web retrieval：

```json
{
  "participants": [
    { "model": "openai/gpt-4.1" },
    { "model": "anthropic/claude-sonnet-4-5" }
  ],
  "judge": { "model": "openai/gpt-4.1" },
  "defaultFallbacks": [],
  "webPolicy": "optional",
  "toolPolicy": { "bash": "sandboxed" },
  "monitorDefault": false,
  "confirmBeforeRun": true
}
```

## Evidence layer

Pi Fusion 不是 scraper adapter，但它有一个可选 evidence layer，用于需要现时信息或来源支撑的任务。

如果没有配置或自动发现 evidence backend，Pi Fusion 仍然会作为 model-fusion engine 运行。如果发现兼容的 evidence backend，participant 和 judge models 可以使用 `web_search` 和 `web_fetch` tools。

运行时，Pi Fusion 会从常见 Pi/MCP 配置位置自动检测兼容的本地 MCP search/fetch servers。如果没有发现 backend，而 prompt 看起来需要 sources，Pi Fusion 会询问你是继续不带 web evidence、取消运行，还是为本次运行添加用户提供的上下文/evidence notes。

### MCP evidence backend

MCP 是第一种支持的 connector type。Pi Fusion 不要求也不内置 `unified-search`；任何兼容 MCP search/fetch server 都可以使用。多数用户可以把 evidence backend 留给 auto-detect。高级用户可以固定一个 explicit backend：

```json
{
  "webPolicy": "optional",
  "webBackend": {
    "type": "mcp",
    "serverName": "my-search",
    "searchServerName": "my-search",
    "searchTool": "web_search",
    "fetchServerName": "my-reader",
    "fetchTool": "web_fetch",
    "fetchFallback": "off",
    "maxResults": 5
  }
}
```

Expected search input:

```json
{ "query": "..." }
```

Pi Fusion 可以解析常见 search result shapes，例如带有 `title`、`url`/`link` 和 `snippet` 字段的 `organic[]`、`results[]` 或 `items[]`。

Expected fetch input:

```json
{ "url": "https://example.com" }
```

Pi Fusion 可以解析带有 `content`、`text` 或 `markdown` 的常见 fetch shapes。

### Internal/private backends

你可以在 MCP interface 后面使用 private MCP servers、company search、本地 crawlers 或 hosted search APIs。Provider-specific backend，例如 `unified-search`，应该被看作可选兼容实现，而不是 Pi Fusion 核心依赖。

## DRACO benchmark

Pi Fusion exceeds the Fusion API budget baseline on the DRACO 10-case benchmark。

我们在同一个用于对比 Fusion API budget baseline 的 10-case DRACO benchmark protocol 上评估了 Pi Fusion。

| System / run | full10 score | 相对 Fusion API budget |
| --- | ---: | ---: |
| Fusion API budget baseline | 64.70 | - |
| Pi Fusion kept validation | 65.30 | +0.60 |
| Pi Fusion best validation | 66.40 | +1.70 |
| Pi Fusion latest validation | 66.20 | +1.50 |

Latest validation 完成了全部 10 个 cases，judge failures 为 0。

生成阶段使用 sanitized prompt-only case files。Benchmark answer/rubric/scoring artifacts 在生成阶段不提供给 Pi Fusion，只在生成后由 scorer 使用。

更多方法论和 sanitized results 见 [`docs/benchmarks.zh-CN.md`](docs/benchmarks.zh-CN.md)。

## 开发

```bash
npm run check
npm test
```

## 安全

Pi extensions 会以你的本地权限运行。安装第三方 package 前请先审查源码。Pi Fusion 的 bash tool 是 sandboxed，面向确定性计算，而不是 arbitrary host access。

## License

MIT
