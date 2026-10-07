#!/usr/bin/env python3
"""Export allowlisted usage only; never export chat content or account data."""
import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path

FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")
# Published 2026-10-07. USD is API-equivalent, not an account invoice.
RATES = {
    "gpt-6-astra": (10, 1, 12.5, 50, 250, 25, 1250),
    "gpt-6.1-sol": (2, .1, 2.5, 10, 50, 2.5, 250),
    "gpt-6-sol": (2, .2, 2.5, 10, 50, 5, 250),
    "gpt-6-luna": (.1, .01, .125, .5, 2.5, .25, 12.5),
}


def number_usage(usage):
    result = {field: int(usage.get(field, 0)) for field in FIELDS}
    if any(value < 0 for value in result.values()):
        raise ValueError("Negative usage")
    if result["cached_input_tokens"] + result["cache_write_input_tokens"] > result["input_tokens"]:
        raise ValueError("Cache counts exceed input")
    if result["reasoning_output_tokens"] > result["output_tokens"]:
        raise ValueError("Reasoning output exceeds output")
    return result


def price(model, usage):
    if model not in RATES:
        return {"api_equivalent_usd_standard": None, "codex_credits_standard": None}
    input_rate, cache_rate, write_rate, output_rate, credit_input, credit_cache, credit_output = RATES[model]
    cached = usage["cached_input_tokens"]
    writes = usage["cache_write_input_tokens"]
    uncached = usage["input_tokens"] - cached
    long = usage["input_tokens"] > 272000
    dollar = ((uncached - writes) * input_rate + cached * cache_rate + writes * write_rate) * (2 if long else 1)
    dollar += usage["output_tokens"] * output_rate * (1.5 if long else 1)
    credit = uncached * credit_input + cached * credit_cache + usage["output_tokens"] * credit_output
    return {"api_equivalent_usd_standard": dollar / 1e6, "codex_credits_standard": credit / 1e6}


def parent_of(row):
    try:
        source = json.loads(row["source"])
    except (ValueError, TypeError):
        return None
    sub = source.get("subagent", {}) if isinstance(source, dict) else {}
    for info in sub.values():
        if isinstance(info, dict) and info.get("parent_thread_id"):
            return info["parent_thread_id"]
    return None


def parse_session(row):
    model, effort = row["model"], row["reasoning_effort"]
    requests, seen, starts, ends, warnings = [], set(), [], [], []
    tool_calls, wait_timeouts = {}, {}
    final_total, record_total, context_tier = None, None, None
    with Path(row["rollout_path"]).open() as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                warnings.append("Incomplete JSONL line while session is active")
                continue
            p = event.get("payload", {})
            kind = event.get("type")
            if kind == "response_item" and p.get("type") in ("function_call", "custom_tool_call"):
                name = p.get("name", "unknown")
                tool_calls[name] = tool_calls.get(name, 0) + 1
                if name.split(".")[-1] in ("wait_agent", "wait"):
                    try:
                        arguments = json.loads(p.get("arguments", "{}"))
                        timeout = arguments.get("timeout_ms", arguments.get("timeoutMs"))
                        if isinstance(timeout, int):
                            key = str(timeout)
                            wait_timeouts[key] = wait_timeouts.get(key, 0) + 1
                    except (ValueError, TypeError):
                        pass
            if kind == "turn_context":
                model, effort = p.get("model", model), p.get("effort", effort)
                context_tier = p.get("service_tier")
            if kind == "event_msg":
                if p.get("type") == "task_started":
                    starts.append(event["timestamp"])
                if p.get("type") == "task_complete":
                    ends.append(event["timestamp"])
                if p.get("type") == "token_count" and p.get("info"):
                    final_total = number_usage(p["info"]["total_token_usage"])
            if kind != "token_usage_record":
                continue
            # Forwarded child records belong to their own session, never both.
            if p.get("thread_id") and p["thread_id"] != row["id"]:
                continue
            identity = p.get("response_id") or (p.get("turn_id"), event.get("ordinal"))
            if identity in seen:
                continue
            seen.add(identity)
            usage = number_usage(p["usage"])
            record_total = number_usage(p["thread_token_usage"]) if p.get("thread_token_usage") else None
            requests.append({"index": len(requests) + 1, "timestamp": event["timestamp"],
                             "model": model, "effort": effort, "recorded_service_tier": context_tier,
                             **usage, **price(model, usage)})
    if not requests:
        warnings.append("No per-response usage records found; no estimated substitutes used")
    totals = {field: sum(r[field] for r in requests) for field in FIELDS}
    if record_total and totals != record_total:
        warnings.append("Per-response sum differs from last thread_token_usage; investigate before treating totals as final")
    if final_total and totals != final_total:
        warnings.append("Per-response sum differs from last token_count; may be pending flush, investigate if complete")
    if not all(r["model"] in RATES for r in requests):
        warnings.append("Unknown model rate; cost total unavailable")
    return {"thread_id": row["id"], "parent_thread_id": parent_of(row),
            "agent_path": row["agent_path"], "starts": starts, "completions": ends,
            "usage": totals, "request_count": len(requests), "requests": requests,
            "tool_call_counts": tool_calls, "agent_wait_timeouts_ms": wait_timeouts,
            "warnings": warnings}


def total_cost(requests, field):
    return sum(r[field] for r in requests) if all(r[field] is not None for r in requests) else None


def collect(database, root_id):
    con = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = {r["id"]: dict(r) for r in con.execute("SELECT id,source,rollout_path,model,reasoning_effort,agent_path FROM threads")}
    con.close()
    if root_id not in rows:
        raise ValueError("Root thread not found")
    selected = {root_id}
    while True:
        children = {ident for ident, row in rows.items() if parent_of(row) in selected}
        if children <= selected:
            break
        selected |= children
    sessions = [parse_session(rows[ident]) for ident in sorted(selected)]
    root = next(s for s in sessions if s["thread_id"] == root_id)
    requests = [r for s in sessions for r in s["requests"]]
    totals = {field: sum(s["usage"][field] for s in sessions) for field in FIELDS}
    totals["uncached_input_tokens"] = totals["input_tokens"] - totals["cached_input_tokens"]
    totals["cache_hit_ratio"] = totals["cached_input_tokens"] / totals["input_tokens"] if totals["input_tokens"] else 0
    totals["api_equivalent_usd_standard"] = total_cost(requests, "api_equivalent_usd_standard")
    totals["codex_credits_standard"] = total_cost(requests, "codex_credits_standard")
    totals["api_equivalent_usd_fast_scenario"] = totals["api_equivalent_usd_standard"] * 2 if totals["api_equivalent_usd_standard"] is not None else None
    totals["codex_credits_fast_scenario"] = totals["codex_credits_standard"] * 2 if totals["codex_credits_standard"] is not None else None
    elapsed = None
    if root["starts"] and root["completions"] and root["completions"][-1] >= root["starts"][-1]:
        elapsed = (dt.datetime.fromisoformat(root["completions"][-1].replace("Z", "+00:00")) - dt.datetime.fromisoformat(root["starts"][0].replace("Z", "+00:00"))).total_seconds()
    by_model = {}
    for name in sorted({r["model"] for r in requests}):
        group = [r for r in requests if r["model"] == name]
        by_model[name] = {field: sum(r[field] for r in group) for field in FIELDS}
        by_model[name].update(request_count=len(group), api_equivalent_usd_standard=total_cost(group, "api_equivalent_usd_standard"), codex_credits_standard=total_cost(group, "codex_credits_standard"))
    return {"schema_version": 1, "root_thread_id": root_id,
            "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "session_count": len(sessions), "elapsed_seconds": elapsed,
            "pricing_note": "API-equivalent USD and Codex credit scenarios, not verified cash charges. Actual request tier is unknown unless explicitly recorded. Reasoning output is already included in output.",
            "pricing_sources": ["https://learn.chatgpt.com/docs/pricing", "https://developers.openai.com/api/docs/pricing"],
            "totals": totals, "by_model": by_model, "sessions": sessions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("thread_id")
    parser.add_argument("--database", type=Path, default=Path.home() / ".codex/state_5.sqlite")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = collect(args.database, args.thread_id)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("root_thread_id", "session_count", "elapsed_seconds", "totals", "by_model")}, indent=2))
