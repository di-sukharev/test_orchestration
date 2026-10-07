Implement TASK.md completely on codex/astra-solo. This is the solo arm of a real cost benchmark. Work in the assigned repository and read AGENTS.md first.

You are GPT-6 Astra with high reasoning. Personally do all research, design, coding, testing, code review, and fixes. Do not spawn or use any agents, other chats, Codex subprocesses, code-scout, or orchestration. This explicit user instruction overrides skill delegation rules.

After implementation, read benchmark/skills/loop-code-review/SKILL.md and apply its checklist and iterative review/fix discipline yourself in this same context, up to three rounds. This is an intentional self-review adaptation: do not delegate and do not stop because the unadapted skill delegates. Treat authentication, authorization, and persistence as high risk. Record findings and fixes in REVIEW.md. Do not claim independent or fresh-context review.

Run all required checks including the frozen external acceptance suite. Complete the full task without asking routine implementation questions. Commit your task files and push only codex/astra-solo without force after checks pass. Preserve frozen benchmark inputs. Report final check results, review rounds, remaining human checks, commit hash, and push status. Do not estimate tokens or costs. Do not open an interactive browser or inspect the competing branch.
