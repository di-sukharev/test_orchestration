#!/usr/bin/env python3
"""Render a reproducible comparison from sanitized metrics and check logs."""
import argparse
import json
from pathlib import Path


def duration(seconds):
    if seconds is None:
        return "incomplete"
    rounded = round(seconds)
    return f"{rounded // 60}m {rounded % 60:02d}s"


def external_result(folder, label, evaluation):
    for check in evaluation["checks"]:
        if check["command"] == ["python3", "benchmark/acceptance.py"]:
            for line in reversed((folder / check["log"]).read_text().splitlines()):
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if isinstance(value, dict) and "passed" in value and "tests" in value:
                    return f'{value["passed"]}/{value["tests"]}'
    return "unavailable"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    args = parser.parse_args()
    lines = ["# TaskForge paired benchmark results", "", "Measured on 2026-10-07. One fresh Astra-high run per variant from seed `c0506e5ee654de6fa2d6c866a538da24a389507e`. Each total includes the root and every descendant agent. Independent evaluation and preparation are excluded.", "", "| Variant | Sessions | Input (cached) | Output | Elapsed | API-equivalent USD, Standard | Frozen API checks | Exploratory API probes | Other checks |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    data = {}
    for label in ("solo", "orchestrated"):
        metrics = json.loads((args.results / f"{label}-usage.json").read_text())
        evaluation = json.loads((args.results / f"{label}-evaluation.json").read_text())
        data[label] = (metrics, evaluation)
        t = metrics["totals"]
        checks = [c for c in evaluation["checks"] if c["command"] != ["python3", "benchmark/acceptance.py"]]
        passed = sum(c["exit_code"] == 0 and not c["timed_out"] for c in checks)
        cost = f'${t["api_equivalent_usd_standard"]:.4f}' if t["api_equivalent_usd_standard"] is not None else "unavailable"
        probe_file = args.results / f"{label}-exploratory.json"
        probes = json.loads(probe_file.read_text()).get("summary", {}) if probe_file.exists() else {}
        probe_score = f'{probes["passed"]}/{probes["tests"]}' if "passed" in probes else "unavailable"
        lines.append(f'| {label} | {metrics["session_count"]} | {t["input_tokens"]:,} ({t["cached_input_tokens"]:,}) | {t["output_tokens"]:,} | {duration(metrics["elapsed_seconds"])} | {cost} | {external_result(args.results, label, evaluation)} | {probe_score} | {passed}/{len(checks)} |')
    a, b = (data[label][0] for label in ("solo", "orchestrated"))
    at, bt = a["totals"], b["totals"]
    if at["api_equivalent_usd_standard"] and bt["api_equivalent_usd_standard"] is not None:
        change = (bt["api_equivalent_usd_standard"] / at["api_equivalent_usd_standard"] - 1) * 100
        lines += ["", f"Orchestration used **{change:+.2f}% more Standard API-equivalent token cost**, **{bt['total_tokens'] / at['total_tokens']:.2f}x total tokens**, and **{b['elapsed_seconds'] / a['elapsed_seconds']:.2f}x wall time until stop**. This is a result for this pair, not a general savings claim.", "", "**Completion differs:** solo completed its three self-review rounds and committed/pushed. Orchestration fixed eleven findings from three independent review rounds, then stopped to request an extra review because its last two production fixes were not freshly re-reviewed. Its status remains **open**, and the measured agent did not commit/push. The controller later published the unchanged application as an explicitly open-review snapshot. These are not two equally completed review processes."]
    lines += ["", "## Model and cache breakdown", "", "| Variant / model | Requests | Uncached input | Cached input | Cache hit rate | Output | Standard USD equivalent | Standard Codex credits |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for label, (metrics, evaluation) in data.items():
        for model, t in metrics["by_model"].items():
            ratio = t["cached_input_tokens"] / t["input_tokens"] if t["input_tokens"] else 0
            lines.append(f'| {label} / {model} | {t["request_count"]} | {t["input_tokens"] - t["cached_input_tokens"]:,} | {t["cached_input_tokens"]:,} | {ratio:.2%} | {t["output_tokens"]:,} | ${t["api_equivalent_usd_standard"]:.4f} | {t["codex_credits_standard"]:.4f} |')
    lines += ["", "## Separate agent caches", "", "| Variant / agent | Models and efforts | Requests | Uncached input | Cached input | Output | Standard USD equivalent |", "|---|---|---:|---:|---:|---:|---:|"]
    for label, (metrics, evaluation) in data.items():
        for session in metrics["sessions"]:
            t = session["usage"]
            settings = ", ".join(sorted({str(r["model"]) + " / " + str(r["effort"]) for r in session["requests"]}))
            cost = sum(r["api_equivalent_usd_standard"] for r in session["requests"])
            lines.append(f'| {label} / {session["agent_path"] or "root"} | {settings} | {session["request_count"]} | {t["input_tokens"] - t["cached_input_tokens"]:,} | {t["cached_input_tokens"]:,} | {t["output_tokens"]:,} | ${cost:.4f} |')
    lines += ["", "## Interpretation and limits", "", "- Dollars are API-equivalent calculations from measured tokens, **not verified cash charges**. Standard and Fast credit/dollar scenarios are retained in the JSON. Desktop config was `service_tier=default`; actual per-request tier is not exposed in these rollouts. Fast paid-credit/API pricing is 2× Standard; do not assume all agents used the same tier without separate evidence.", "- [Official API prices](https://developers.openai.com/api/docs/pricing) and [Codex credit prices](https://learn.chatgpt.com/docs/pricing) were checked on 2026-10-07. Credit purchase prices depend on plan/agreement. No account-balance delta is attributed to this benchmark.", "- Cached tokens are included in total input. Reasoning output is included in output and is never added twice. Fresh chats are not guaranteed cold caches. Per-response data and per-session totals are available in the sanitized usage JSON files.", "- Both captured implementations are assessed with the same frozen 25-test API suite. Other checks include frozen installation, types, lint, own tests, build, and scripted E2E when present. Self-authored test counts are not a quality score. The five exploratory probes were derived from review findings after the runs, applied unchanged to both implementations, and were not pre-registered. Final visual quality remains **unassessed by the human**.", "- Solo implements and reviews in one context. Orchestration changes both the model mix and reviewer independence. The trial cannot isolate those effects. n=1 per variant; solo ran first, dependency download caches and backend load can affect time.", "- Private prompts, tool outputs from Codex sessions, credentials, and account balances were not published. Check logs contain only the independent runs against synthetic data.", "", "## Revisions and integrity", ""]
    for label, (metrics, evaluation) in data.items():
        warnings = [warning for s in metrics["sessions"] for warning in s["warnings"]]
        lines.append(f'- {label}: commit `{evaluation["commit"]}`, frozen input hashes match: `{all(evaluation["frozen_input_integrity"].values())}`, measurement warnings: `{len(warnings)}`.')
        lines.extend(f"  - {warning}" for warning in warnings)
    (args.results / "COMPARISON.md").write_text("\n".join(lines) + "\n")
