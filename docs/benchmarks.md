# DRACO benchmark

Pi Fusion is a general model-fusion layer for Pi agents. Its open-source positioning is centered on scored validation: DRACO full10 runs, prompt-only generation, scorer-only rubric access, and sanitized aggregate results.

Pi Fusion scored **73.80** on a sealed fixed DRACO-10 validation run. That is **+4.80** above the reported Fusion API headline result of **69.00** and **+9.10** above the reported Fusion API budget baseline of **64.70**.

In this document, **DRACO-verified** means the claim is backed by completed 10-case DRACO benchmark runs and post-generation scoring. It does not mean Pi Fusion is officially certified by DRACO, and it is not a claim that Pi Fusion beats every Fusion API mode on every evaluation.

We evaluated Pi Fusion on a fixed 10-case DRACO validation protocol. Final answers were sealed before the scorer loaded any rubric or scoring artifacts.

## Scoring recording

The repository includes a short recording of the scoring stage:

[Watch the DRACO scorer recording](assets/draco-scored-validation.mp4)

The video shows the important integrity boundary: final answers are already sealed before the scorer loads the rubric and emits DRACO scores.

## Validation summary

| System / run | DRACO score | Delta vs reported Fusion API | Delta vs reported budget |
| --- | ---: | ---: | ---: |
| Pi Fusion latest sealed DRACO-10 validation | **73.80** | **+4.80** | **+9.10** |
| Reported Fusion API headline result | 69.00 | - | +4.30 |
| Reported Fusion API budget baseline | 64.70 | -4.30 | - |

The latest validation completed all 10 cases with 0 judge failures.

Generation used sanitized prompt-only case files. The benchmark answer/rubric/scoring artifacts were not available to Pi Fusion during generation and were used only after generation by the scorer.

## Integrity policy

Published benchmark summaries are sanitized. Public artifacts must not include:

- case prompts
- answers or private scoring criteria
- private source snippets
- benchmark-specific expected facts
- private case identifiers
- scorer misses that reveal expected answers

Generation used sanitized prompt-only cases. Scoring happened after generation. Raw experiment artifacts are archived privately for audit and are not part of the public repository.

## Methodology

- 10 sanitized prompt-only DRACO-style cases
- fixed 4-participant quality panel
- GPT-5.5 judge/scorer
- generation did not read answers or rubrics
- scoring occurred only after generation
- all listed full10 runs completed all 10 cases unless noted

## Sanitized runs

| Run | DRACO score | Reported Fusion API | Delta vs Fusion API | Budget baseline | Delta vs budget | Cases completed | Judge failures | Public status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-07-01 sealed DRACO-10 | **73.80** | 69.00 | **+4.80** | 64.70 | **+9.10** | 10/10 | 0 | latest |

## Interpretation

This result shows Pi Fusion's fusion pattern exceeding both the reported 69.00 Fusion API headline result and the 64.70 Fusion API budget baseline on a sealed fixed DRACO-10 validation subset. It is evidence for the model-fusion approach, not a claim that Pi Fusion beats Fusion API overall or beats every Fusion API mode on every evaluation.

The important distinction is that Pi Fusion is not presented as an unscored multi-model prompt demo. Its benchmark claim is tied to a fixed protocol, completed full10 runs, and scoring that happens only after generation is sealed.

Pi Fusion should be evaluated separately for other task families such as planning, debugging, review, writing, and decision support.
