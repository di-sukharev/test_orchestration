# Benchmark rules

- Implement the complete task in `TASK.md` on the branch assigned in the prompt.
- `benchmark/`, `TASK.md`, and this file are frozen benchmark inputs. Do not modify them.
- Work only in this repository. Do not inspect other experiment branches, other chats, or local Codex logs. Measurement is external.
- Do not create branches or worktrees. The assigned branch already exists. Do not switch branches.
- The final commit and a non-force push of the assigned branch are authorized after checks pass. Do not create a PR or deploy.
- No interactive browser use. Use tests, types, lint, and builds. The human performs the final visual check; do not claim it passed.
- You may add and run scripted headless E2E tests; if used, make them available as `bun run test:e2e`. They do not substitute for the human visual check.
- Use synthetic test data only. Never commit credentials, runtime databases, user session logs, or local machine paths.
- Root model is GPT-6 Astra with high reasoning for both runs. The run prompt defines delegation policy and takes precedence over skills.
- Do not change the assignment to reduce benchmark cost. Finish the entire task, including review and fixes.
