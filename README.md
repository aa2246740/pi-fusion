# Pi Fusion

**Model fusion for Pi agents.**

Pi Fusion turns one prompt into a panel of independent model agents, lets them work in parallel, optionally gather evidence, then uses a judge model to synthesize, verify, and report the final answer inside Pi.

It is inspired by hosted Fusion-style APIs, but packaged as a Pi extension: you choose the models, keep the artifacts, and can connect the fusion layer to your existing Pi tools and context.

Website: <https://aa2246740.github.io/pi-fusion/>

Docs: English | [中文](README.zh-CN.md) | [Benchmarks](docs/benchmarks.md) | [中文基准说明](docs/benchmarks.zh-CN.md)

## What it does

Pi Fusion provides a general-purpose fusion layer for tasks where one model answer is not enough:

- parallel participant models with independent answers
- judge synthesis and contradiction analysis
- optional verification/revision loop
- optional web/evidence tools
- sandboxed bash for deterministic calculations
- model fallback and retry policy
- artifacts, evidence summaries, token usage, and cost reporting
- Pi-native commands and configuration

Use it for research, planning, architecture decisions, debugging hypotheses, code/design review, product comparisons, writing, document synthesis, or other high-stakes questions.

## Install

Pi Fusion is a Pi package/extension.

```bash
pi install git:https://github.com/aa2246740/pi-fusion@main
```

The npm package name is:

```bash
npm install @aa2246740/pi-fusion
```

For local development:

```bash
cd pi-fusion
npm install
pi -e ./index.ts
```

Pi package discovery is declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Commands

```text
/pi-fusion-config       Configure participants, judge, tools, and evidence backend
/pi-fusion-doctor       Diagnose model and evidence backend availability
/pi-fusion <prompt>     Run a fusion panel
```

Examples:

```text
/pi-fusion Should we migrate this module to a plugin architecture?
/pi-fusion --fast Summarize the tradeoffs of these three implementation plans.
/pi-fusion --quality Compare the vendors and cite current sources.
```

## Configuration

Run:

```text
/pi-fusion-config
```

You will choose:

1. participant models
2. judge model
3. fallback models from a selectable model list
4. web/evidence policy
5. evidence backend mode, normally auto-detect at run time
6. sandboxed bash policy
7. monitor and confirmation defaults

Config is stored under:

```text
~/.pi/agent/pi-fusion/config.json
```

A minimal config can run without web retrieval:

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

Pi Fusion is not a scraper adapter, but it has an optional evidence layer for tasks that need current or source-grounded information.

If no evidence backend is configured or auto-detected, Pi Fusion still runs as a model-fusion engine. If a compatible evidence backend is discovered or configured, participant and judge models can use `web_search` and `web_fetch` tools.

At run time Pi Fusion will try to auto-detect compatible local MCP search/fetch servers from common Pi/MCP config locations. If none is found for a prompt that appears source-sensitive, Pi Fusion asks whether to continue without web evidence, cancel, or add user-provided context/evidence notes for that run.

### MCP evidence backend

MCP is the first supported connector type. Pi Fusion does **not** require or bundle `unified-search`; any compatible MCP search/fetch server can be used. Most users should leave evidence backend setup on auto-detect. Advanced users can pin an explicit backend:

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

Pi Fusion can parse common search result shapes such as `organic[]`, `results[]`, or `items[]` with `title`, `url`/`link`, and `snippet` fields.

Expected fetch input:

```json
{ "url": "https://example.com" }
```

Pi Fusion can parse common fetch shapes with `content`, `text`, or `markdown`.

### Internal/private backends

You may use private MCP servers, company search, local crawlers, or hosted search APIs behind the MCP interface. Provider-specific backends such as `unified-search` should be treated as optional compatible implementations, not core Pi Fusion dependencies.

## Benchmarks

Pi Fusion exceeds the Fusion API budget baseline on the DRACO 10-case benchmark.

We evaluated Pi Fusion on the same 10-case DRACO benchmark protocol used to compare against the Fusion API budget baseline.

| System / run | full10 score | Delta vs Fusion API budget |
| --- | ---: | ---: |
| Fusion API budget baseline | 64.70 | - |
| Pi Fusion kept validation | 65.30 | +0.60 |
| Pi Fusion best validation | 66.40 | +1.70 |
| Pi Fusion latest validation | 66.20 | +1.50 |

The latest validation completed all 10 cases with 0 judge failures.

Generation used sanitized prompt-only case files. The benchmark answer/rubric/scoring artifacts were not available to Pi Fusion during generation and were used only after generation by the scorer.

See [`docs/benchmarks.md`](docs/benchmarks.md) for methodology and sanitized results.

## Development

```bash
npm run check
npm test
```

## Security

Pi extensions run with your local permissions. Review source before installing third-party packages. Pi Fusion's bash tool is sandboxed and intended for deterministic calculations, not arbitrary host access.

## License

MIT
