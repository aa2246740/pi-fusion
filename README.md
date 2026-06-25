# Pi Fusion

**DRACO-verified model fusion for Pi agents.**

Pi Fusion turns one prompt into a panel of independent model agents, lets them work in parallel, optionally gather evidence, then uses a judge model to synthesize, verify, and report the final answer inside Pi.

The core claim is not just orchestration. Pi Fusion has scored DRACO full10 validation runs: prompt-only generation, scorer-only rubric access, all 10 cases completed, and sanitized public benchmark summaries.

It is inspired by hosted Fusion-style APIs, but packaged as a Pi extension: you choose the models, keep the artifacts, and can connect the fusion layer to your existing Pi tools and context.

Website: <https://aa2246740.github.io/pi-fusion/>

Docs: English | [中文](README.zh-CN.md) | [Benchmarks](docs/benchmarks.md) | [中文基准说明](docs/benchmarks.zh-CN.md)

## Why this repository stands out

Many fusion demos stop at running several models and merging the text. Pi Fusion is positioned around scored validation:

- **DRACO full10 tested**: validated on a 10-case DRACO benchmark protocol.
- **Scorer-only rubric access**: generation used sanitized prompt-only cases; answer/rubric/scoring artifacts were loaded only after generation.
- **Budget baseline comparison**: published validations exceeded the 64.70 Fusion API budget baseline, with runs at 65.30, 66.40, and 66.20.
- **0 judge failures in the latest validation**: the latest published validation completed all 10 cases.
- **Audit-friendly artifacts**: run artifacts, evidence summaries, token usage, and costs are kept locally, while public benchmark summaries stay sanitized.

## What it does

Pi Fusion provides a general-purpose fusion layer for tasks where one model answer is not enough:

- parallel participant models with independent answers
- judge synthesis and contradiction analysis
- optional verification/revision loop
- optional web/evidence tools
- sandboxed bash for deterministic calculations
- per-participant workspace sandboxes with read/write tools
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

## Workspace sandboxes

For project-sized prompts, Pi Fusion copies the current Pi working directory into a Pi Fusion-owned baseline and creates one isolated writable sandbox per Participant Model. Participants can list, search, read, write, and edit files only inside their own sandbox through scoped `workspace_*` tools.

Sandbox writes do not modify the real user workspace. After the run, Pi Fusion records each participant's sandbox root, changed files, and ChangeSet artifacts under the run directory so the judge and user can review concrete file-level work instead of relying only on prose.

## DRACO-Verified Benchmark Results

Pi Fusion exceeds the Fusion API budget baseline on scored DRACO full10 validations.

In this repository, **DRACO-verified** means the public benchmark claim is backed by completed DRACO 10-case runs, prompt-only generation, scorer-only rubric access, and sanitized aggregate results. It is not a claim that Pi Fusion beats every Fusion API mode.

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

Pi extensions run with your local permissions. Review source before installing third-party packages. Pi itself does not provide an in-process security sandbox. Pi Fusion therefore treats workspace sandboxes as product-level isolation: files are copied into participant-owned directories, participant writes stay there, and applying any ChangeSet to the real workspace is deliberately separate from a Fusion Run.

Pi Fusion's bash tool is sandboxed and intended for deterministic calculations, not arbitrary host access.

## License

MIT
