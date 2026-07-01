# DRACO benchmark

Pi Fusion 是给 Pi agents 用的通用 model-fusion layer。它的开源定位重点是有评分验证：DRACO full10 runs、prompt-only generation、scorer-only rubric access，以及 sanitized aggregate results。

Pi Fusion 在 sealed fixed DRACO-10 validation run 上拿到 **73.80**。这比 reported Fusion API headline result **69.00** 高 **+4.80**，比 reported Fusion API budget baseline **64.70** 高 **+9.10**。

本文里的 **DRACO verified** 指的是公开 claim 有完整 10-case DRACO benchmark runs 和 generation 之后的 scoring 支撑。它不表示 Pi Fusion 得到了 DRACO 官方认证，也不是说 Pi Fusion 在所有评估里超过所有 Fusion API modes。

我们在固定 10-case DRACO validation protocol 上评估了 Pi Fusion。Final answers sealed 之后，scorer 才加载 rubric 和 scoring artifacts。

## Scoring 录屏

仓库包含一段 scoring 阶段短录屏：

[观看 DRACO scorer 录屏](assets/draco-scored-validation.mp4)

这段视频展示了关键 integrity boundary：final answers 已经 sealed，之后 scorer 才加载 rubric 并产出 DRACO scores。

## Validation summary

| System / run | DRACO score | 相对 reported Fusion API | 相对 reported budget |
| --- | ---: | ---: | ---: |
| Pi Fusion latest sealed DRACO-10 validation | **73.80** | **+4.80** | **+9.10** |
| Reported Fusion API headline result | 69.00 | - | +4.30 |
| Reported Fusion API budget baseline | 64.70 | -4.30 | - |

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
- 固定 4-participant quality panel
- GPT-5.5 judge/scorer
- generation 阶段不读取 answers 或 private scoring criteria
- generation 结束后才 scoring
- 下表 full10 runs 均完成全部 10 个 cases，除非另有说明

## Sanitized runs

| Run | DRACO score | Reported Fusion API | 相对 Fusion API | Budget baseline | 相对 budget | Cases completed | Judge failures | Public status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-07-01 sealed DRACO-10 | **73.80** | 69.00 | **+4.80** | 64.70 | **+9.10** | 10/10 | 0 | latest |

## Interpretation

这个结果说明，在 sealed fixed DRACO-10 validation subset 上，Pi Fusion 的 fusion pattern 超过了 reported 69.00 Fusion API headline result 和 64.70 Fusion API budget baseline。它是对 model-fusion approach 的证据，不是说 Pi Fusion 整体超过 Fusion API，也不是说它在所有评估里超过所有 Fusion API modes。

关键差异在于：Pi Fusion 不是一个没有评分的 multi-model prompt demo。它的 benchmark claim 绑定固定 protocol、完成的 full10 runs，以及 generation sealed 之后才发生的 scoring。

Pi Fusion 仍然应该在其他任务类型上单独评估，例如 planning、debugging、review、writing 和 decision support。
