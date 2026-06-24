# DRACO benchmark

Pi Fusion is a general model-fusion layer for Pi agents. We benchmark it on research-style tasks because they are comparable to hosted Fusion-style APIs and can be scored objectively.

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
- fixed 3 OpenAI Codex participants in order
- GPT-5.5 judge/scorer
- generation did not read answers or rubrics
- scoring occurred only after generation
- all listed full10 runs completed all 10 cases unless noted

## Sanitized runs

| Run | full10 score | Budget baseline | Delta vs baseline | Cases completed | Judge failures | Public status |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 129 | 65.30 | 64.70 | +0.60 | 10/10 | 0 | kept |
| 175 | 66.40 | 64.70 | +1.70 | 10/10 | 0 | validation |
| 200 | 66.20 | 64.70 | +1.50 | 10/10 | 0 | validation |

## Interpretation

These results show Pi Fusion's fusion pattern exceeding the 64.70 Fusion API budget baseline on sanitized full10 validations. They are evidence for the model-fusion approach, not a claim that Pi Fusion beats Fusion API overall or beats every Fusion API mode.

Pi Fusion should be evaluated separately for other task families such as planning, debugging, review, writing, and decision support.
