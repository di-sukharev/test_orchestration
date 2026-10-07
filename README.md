# Astra orchestration benchmark

One large, frozen TaskForge assignment, two independent fresh Astra chats, two branches from the same seed commit:

- `codex/astra-solo`: Astra high implements everything and performs its own review/fix cycles using the loop-code-review checklist. No subagents. This is explicitly an adaptation of the review skill, not its fresh-reviewer workflow.
- `codex/astra-orchestrated`: Astra high uses the pinned orchestration skill and loop-code-review, including Luna workers and Sol reviewers with their specified efforts and escalation rules.

Both implement [TASK.md](TASK.md). The pinned skills, prompts, acceptance checks, and measurement methodology are under `benchmark/`. This is a single paired exploratory trial, not a statistical estimate of savings for arbitrary tasks.

Results will include all descendant agents, measured cached input, uncached input, output, duration, independently checked quality, and a documented price estimate. Raw private chat/session logs are never published. Preparation and independent assessment costs are excluded from both implementation totals and disclosed separately. Final human visual review remains pending until performed by the user.

Upstream skill: https://github.com/di-sukharev/orchestration-skill
