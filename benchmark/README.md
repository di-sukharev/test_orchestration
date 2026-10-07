# Reproduce and inspect

The task, acceptance suite, prompts, and skill snapshots were frozen in seed commit `c0506e5ee654de6fa2d6c866a538da24a389507e`. Their SHA-256 hashes are in `manifest.json` and were verified after both runs. The measurement/evaluation scripts and result files were appended after the runs; original frozen inputs were not modified.

- `results/COMPARISON.md`: comparison, per-model costs, and separate agent caches.
- `results/*-usage.json`: one allowlisted numeric usage record per model response, session totals, parent relationships, models/efforts, and tool-call counts. No raw chat text, account balances, credentials, or tool output from the chats.
- `results/*-evaluation.json` and `*-check-*.txt`: independent check metadata and logs against synthetic test data.
- `results/*-exploratory.*`: five additional API test methods derived from review findings, executed unchanged on both captured implementations after their measured runs. They were not pre-registered and do not replace the frozen acceptance score.
- `results/run-registry.json`: root IDs, seed, commits, settings, and review status.

## Evaluate a branch

The two application branches contain their own lockfiles, code, README, and REVIEW.md. Install/build the selected branch before running HTTP probes. Do not switch branches while its agent or server is running.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
python3 benchmark/acceptance.py
```

`evaluate.py` automates those commands and also runs `test:e2e` if the branch defines it. The evaluation scripts were added on `main`, so keep a copy outside the application checkout when evaluating either original branch:

```sh
python3 /path/to/evaluate.py /path/to/application-checkout solo --output-dir /tmp/fresh-evaluation
python3 /path/to/exploratory.py /path/to/application-checkout
```

The exploratory cases cover non-ASCII case-insensitive search, anonymous unknown-route errors, loss of concurrent disjoint PATCH fields, authorization after a delayed-body write is demoted, and NUL input handling. The NUL case accepts either clean rejection or lossless storage because the frozen contract did not explicitly forbid NUL; it rejects server errors and truncation. It has three stored-field subcases, counted as one test method. Races use a partial HTTP body, a 200 ms wait, a second completed operation, and then completion of the first body, repeated three times.

These probes all passed on both captured versions. They do not assess the entire UI, every race, accessibility, or absence of vulnerabilities. Solo's self-assigned readiness score and the independent reviewers' scores are not comparable, so the comparison uses observable checks and explicitly reports the open review.

## Collect tokens without exporting private chats

```sh
python3 benchmark/collect_usage.py ROOT_THREAD_ID --output /tmp/usage.json
python3 -m unittest discover -s benchmark -p 'test_collect_usage.py'
```

The collector reads the local Codex `state_5.sqlite` read-only and follows explicit parent-thread links. It sums unique `token_usage_record` responses in each session and cross-checks them against cumulative counters. The final exports have zero consistency warnings. Input includes cached input, and reasoning output is already part of output. Cache writes are tracked separately (zero in these runs). Actual service tier is not recorded, so dollar and credit figures remain pricing scenarios.

The five collector unit tests cover cache/reasoning pricing, duplicate records/snapshots, descendant discovery and unrelated-session exclusion, parent metadata, and unknown model rates. The data export keeps only usage/timing/model identifiers and tool-name/count metadata. Never publish the source rollout JSONL files.

```sh
python3 benchmark/render_comparison.py benchmark/results
```

Timing uses each root's task-start and task-complete event timestamps. Orchestration's stop includes the final request for additional review; it is not a successful end-to-end completion time. The root fixed eleven findings across three fresh Sol review rounds, then requested another round because the last fixes were not independently re-reviewed. The controller's subsequent snapshot commit did not change application code and is excluded from measured usage/time.
