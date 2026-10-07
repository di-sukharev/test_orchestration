# TaskForge paired benchmark results

Measured on 2026-10-07. One fresh Astra-high run per variant from seed `c0506e5ee654de6fa2d6c866a538da24a389507e`. Each total includes the root and every descendant agent. Independent evaluation and preparation are excluded.

| Variant | Sessions | Input (cached) | Output | Elapsed | API-equivalent USD, Standard | Frozen API checks | Exploratory API probes | Other checks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| solo | 1 | 2,771,533 (2,675,712) | 44,493 | 24m 12s | $5.8586 | 25/25 | 5/5 | 6/6 |
| orchestrated | 5 | 17,432,038 (16,825,344) | 146,429 | 54m 50s | $6.6217 | 25/25 | 5/5 | 5/5 |

Orchestration used **+13.03% more Standard API-equivalent token cost**, **6.24x total tokens**, and **2.27x wall time until stop**. This is a result for this pair, not a general savings claim.

**Completion differs:** solo completed its three self-review rounds and committed/pushed. Orchestration fixed eleven findings from three independent review rounds, then stopped to request an extra review because its last two production fixes were not freshly re-reviewed. Its status remains **open**, and the measured agent did not commit/push. The controller later published the unchanged application as an explicitly open-review snapshot. These are not two equally completed review processes.

## Model and cache breakdown

| Variant / model | Requests | Uncached input | Cached input | Cache hit rate | Output | Standard USD equivalent | Standard Codex credits |
|---|---:|---:|---:|---:|---:|---:|---:|
| solo / gpt-6-astra | 34 | 95,821 | 2,675,712 | 96.54% | 44,493 | $5.8586 | 146.4643 |
| orchestrated / gpt-6-astra | 68 | 77,171 | 3,087,744 | 97.56% | 12,234 | $4.4712 | 111.7788 |
| orchestrated / gpt-6-luna | 74 | 166,775 | 6,779,392 | 97.60% | 73,389 | $0.1212 | 3.0291 |
| orchestrated / gpt-6.1-sol | 83 | 362,748 | 6,958,208 | 95.05% | 60,806 | $2.0294 | 50.7344 |

## Separate agent caches

| Variant / agent | Models and efforts | Requests | Uncached input | Cached input | Output | Standard USD equivalent |
|---|---|---:|---:|---:|---:|---:|
| solo / root | gpt-6-astra / high | 34 | 95,821 | 2,675,712 | 44,493 | $5.8586 |
| orchestrated / root | gpt-6-astra / high | 68 | 77,171 | 3,087,744 | 12,234 | $4.4712 |
| orchestrated / /root/worker | gpt-6-luna / high | 74 | 166,775 | 6,779,392 | 73,389 | $0.1212 |
| orchestrated / /root/reviewer_1 | gpt-6.1-sol / high | 30 | 194,015 | 2,419,072 | 23,825 | $0.8682 |
| orchestrated / /root/reviewer_2 | gpt-6.1-sol / high | 26 | 100,458 | 2,363,264 | 24,418 | $0.6814 |
| orchestrated / /root/reviewer_3 | gpt-6.1-sol / high | 27 | 68,275 | 2,175,872 | 12,563 | $0.4798 |

## Interpretation and limits

- Dollars are API-equivalent calculations from measured tokens, **not verified cash charges**. Standard and Fast credit/dollar scenarios are retained in the JSON. Desktop config was `service_tier=default`; actual per-request tier is not exposed in these rollouts. Fast paid-credit/API pricing is 2× Standard; do not assume all agents used the same tier without separate evidence.
- [Official API prices](https://developers.openai.com/api/docs/pricing) and [Codex credit prices](https://learn.chatgpt.com/docs/pricing) were checked on 2026-10-07. Credit purchase prices depend on plan/agreement. No account-balance delta is attributed to this benchmark.
- Cached tokens are included in total input. Reasoning output is included in output and is never added twice. Fresh chats are not guaranteed cold caches. Per-response data and per-session totals are available in the sanitized usage JSON files.
- Both captured implementations are assessed with the same frozen 25-test API suite. Other checks include frozen installation, types, lint, own tests, build, and scripted E2E when present. Self-authored test counts are not a quality score. The five exploratory probes were derived from review findings after the runs, applied unchanged to both implementations, and were not pre-registered. Final visual quality remains **unassessed by the human**.
- Solo implements and reviews in one context. Orchestration changes both the model mix and reviewer independence. The trial cannot isolate those effects. n=1 per variant; solo ran first, dependency download caches and backend load can affect time.
- Private prompts, tool outputs from Codex sessions, credentials, and account balances were not published. Check logs contain only the independent runs against synthetic data.

## Revisions and integrity

- solo: commit `9b28469366d28f579467ffc381ccffe554e5b75d`, frozen input hashes match: `True`, measurement warnings: `0`.
- orchestrated: commit `f60ddde6d2ed45a4bef9289383ea15f4cac81171`, frozen input hashes match: `True`, measurement warnings: `0`.
