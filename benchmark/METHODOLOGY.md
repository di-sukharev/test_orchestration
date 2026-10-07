# Protocol frozen before execution

Date: 2026-10-07. Runtime: local Codex desktop, Bun 1.4.2. Root model: `gpt-6-astra`, high reasoning. Both runs use the same desktop defaults and the same seed commit. Start fresh chats, never fork an existing chat. Execute sequentially to avoid CPU/port contention. The second chat must not inspect the first branch or its output. Session IDs and source hashes will be recorded in the results.

The treatment changes implementation/review workflow and model mix together. Solo uses same-context self-review; orchestration uses fresh review agents. This experiment cannot isolate model mix, reviewer independence, or orchestration individually. Skill snapshots are copied byte-for-byte from their selected source versions.

## Measurements

- Discover the root and every descendant by parent-thread metadata, not by title or directory alone. Include retries, research, planning, implementation, review, fixes, and final commit/push turns.
- Read token-count events from local Codex rollouts. Retain an allowlist of numeric counters and model/effort/timing identifiers only. Do not publish prompts, tool output, account balance, or raw session logs.
- Input tokens include cached input. Uncached input = input - cached input. Reasoning output is a subset of output, not an additional charge. Keep cache-write tokens as a separate diagnostic.
- Deduplicate unchanged cumulative token events. Use per-request usage (cross-checked against cumulative counters), so context-size and model/rate changes can be priced correctly. Never sum repeated cumulative snapshots.
- Cache hits are measured separately for each agent/session. Never infer a shared cache or a guaranteed cold cache. Fresh chats do not prove cold provider caches.
- Duration is root task-start to final task-complete, including worker waits. Sum model time only if available; do not sum concurrent wall times into elapsed time.
- Dollar figures are estimates from published token/credit rates, not verified account charges. Account balance deltas are contaminated by other simultaneous work. Record actual service tier when exposed; otherwise label pricing scenarios explicitly. Do not silently assume Standard when Fast is possible.
- Standard Codex credits per million input/cached/output: Astra 250/25/1250; GPT-6.1 Sol 50/2.5/250; GPT-6 Sol 50/5/250; GPT-6 Luna 2.5/0.25/12.5. Codex has no separate cache-write charge. Paid-credit Fast is 2x Standard. API-equivalent Standard USD per million: Astra 10/1/50; GPT-6.1 Sol 2/0.1/10; GPT-6 Sol 2/0.2/10; Luna 0.1/0.01/0.5. API cache writes and long-context requests require their documented rates. Do not present API-equivalent dollars as cash spent in Codex.
- Sources checked on 2026-10-07: https://learn.chatgpt.com/docs/pricing ; https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/models/gpt-6-astra ; https://developers.openai.com/api/docs/models/gpt-6-sol .

## Quality assessment

Run the same frozen external HTTP acceptance suite and compare pass/total, independently rerun typecheck/lint/build/tests, and inspect requirement coverage and material security/data defects. Report own tests separately; more self-authored tests is not itself a better score. Human visual quality is explicitly unassessed. Do not give a subjective numerical score without evidence. A run that does not finish is reported as incomplete, never cheaper-and-equivalent. Persist evaluation logs and sanitized metrics in results on main after both branches finish.

Limitations: n=1 per variant, order effects and package/provider cache effects, stochastic model output, same-context solo review, and potentially variable backend load. Savings describe only this pair. No conclusion is predetermined.
