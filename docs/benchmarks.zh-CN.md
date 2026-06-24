# DRACO benchmark

Pi Fusion 是给 Pi agents 用的通用 model-fusion layer。我们用 research-style tasks 做 benchmark，因为这类任务可以和 hosted Fusion-style APIs 对比，也可以客观打分。

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

## Integrity policy

公开 benchmark summary 都经过 sanitization。公开 artifacts 不应包含：

- case prompts
- answers 或 private scoring criteria
- private source snippets
- benchmark-specific expected facts
- private case identifiers
- 会暴露 expected answers 的 scorer misses

Generation 使用 sanitized prompt-only cases。Scoring 只发生在 generation 之后。Raw experiment artifacts 会私下归档用于 audit，不属于 public repository。

## Methodology

- 10 个 sanitized prompt-only DRACO-style cases
- 固定顺序的 3 个 OpenAI Codex participants
- GPT-5.5 judge/scorer
- generation 阶段不读取 answers 或 private scoring criteria
- generation 结束后才 scoring
- 下表 full10 runs 均完成全部 10 个 cases，除非另有说明

## Sanitized runs

| Run | full10 score | Budget baseline | Delta vs baseline | Cases completed | Judge failures | Public status |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 129 | 65.30 | 64.70 | +0.60 | 10/10 | 0 | kept |
| 175 | 66.40 | 64.70 | +1.70 | 10/10 | 0 | validation |
| 200 | 66.20 | 64.70 | +1.50 | 10/10 | 0 | validation |

## Interpretation

这些结果说明，在 sanitized full10 validations 上，Pi Fusion 的 fusion pattern 超过了 64.70 的 Fusion API budget baseline。它们是对 model-fusion approach 的证据，不是说 Pi Fusion 整体超过 Fusion API，也不是说它超过所有 Fusion API modes。

Pi Fusion 仍然应该在其他任务类型上单独评估，例如 planning、debugging、review、writing 和 decision support。
