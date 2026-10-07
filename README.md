# Astra orchestration benchmark

One large, frozen TaskForge assignment, two independent fresh Astra chats, two branches from the same seed commit:

- `codex/astra-solo`: Astra high implements everything and performs its own review/fix cycles using the loop-code-review checklist. No subagents. This is explicitly an adaptation of the review skill, not its fresh-reviewer workflow.
- `codex/astra-orchestrated`: Astra high uses the pinned orchestration skill and loop-code-review, including Luna workers and Sol reviewers with their specified efforts and escalation rules.

Both implement [TASK.md](TASK.md). The pinned skills, prompts, acceptance checks, and measurement methodology are under `benchmark/`. This is a single paired exploratory trial, not a statistical estimate of savings for arbitrary tasks.

## Result — 2026-10-07

| Variant | Total tokens, including cached input | Input cache hit rate | Time until stop | Standard API-equivalent token cost | Independent API checks | Review status |
|---|---:|---:|---:|---:|---|---|
| [Astra solo](https://github.com/di-sukharev/test_orchestration/tree/codex/astra-solo) | 2,816,026 | 96.54% | 24m 12s | $5.86 | Frozen 25/25; exploratory 5/5 | 3 self-review rounds passed; committed/pushed |
| [Astra orchestrated](https://github.com/di-sukharev/test_orchestration/tree/codex/astra-orchestrated) | 17,578,467 | 96.52% | 54m 50s | $6.62 | Frozen 25/25; exploratory 5/5 | Open after 3 independent rounds |

In this pair, orchestration consumed **6.24× as many tokens**, cost **13.03% more** at the same Standard token rates, and took **2.27× as long until stopping**. It also stopped before completing its review/commit workflow: the last two production fixes required fresh review after the skill's three-round limit. The controller published its unchanged application as an explicitly open-review snapshot. This is not evidence of equivalent completion or a general result for all tasks.

The orchestrated cost breaks down as Astra lead **$4.47**, Luna worker **$0.12**, and three Sol reviewers **$2.03**. The lead made 68 model requests and 52 agent-wait calls; the waiting time itself is not token-billed, but repeated model resumptions contribute to the lead's measured usage. The worker was cheap, while coordination plus independent reviews consumed the budget.

Both implementations independently passed installation, TypeScript, lint, own tests, build, and the common API checks. Solo additionally passed 6 headless browser E2E tests. Orchestration passed 30 application tests including React/Happy DOM regressions; those are not browser E2E or a human visual review. Test counts use different granularity and are not comparable quality scores. Human visual/accessibility checks remain pending.

**These dollar figures are token-price estimates, not verified cash charges.** Actual per-request speed tier is absent from the logs; the desktop configuration was `service_tier=default`. The report includes Standard/Fast scenarios using [official API prices](https://developers.openai.com/api/docs/pricing) and [Codex credit rates](https://learn.chatgpt.com/docs/pricing). Every descendant agent and its actual cached input are included, with no assumed cache sharing or double-counting of reasoning output. Preparation, this experiment's controller, independent assessment, and snapshot publication are excluded from both implementation totals. Raw private session logs are not published.

See the [full comparison and per-agent cache/cost breakdown](benchmark/results/COMPARISON.md), [sanitized measurements and check logs](benchmark/results), [reproduction commands](benchmark/README.md), and [frozen methodology](benchmark/METHODOLOGY.md).

Upstream skill: https://github.com/di-sukharev/orchestration-skill
