#!/usr/bin/env python3
"""Same independent evaluation for both completed branches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def run(command, cwd, timeout=300):
    start = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, start_new_session=True)
    timed_out = False
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
    return {"command": command, "exit_code": process.returncode, "timed_out": timed_out,
            "seconds": round(time.monotonic() - start, 3), "output": output}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    parser.add_argument("label", choices=["solo", "orchestrated"])
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repository.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=repo, text=True).strip()
    manifest = json.loads((repo / "benchmark/manifest.json").read_text())
    integrity = {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() == checksum for name, checksum in manifest["sha256"].items()}
    results = []
    commands = [["bun", "install", "--frozen-lockfile"], ["bun", "run", "typecheck"],
                ["bun", "run", "lint"], ["bun", "test"], ["bun", "run", "build"],
                ["python3", "benchmark/acceptance.py"]]
    package = json.loads((repo / "package.json").read_text())
    if "test:e2e" in package.get("scripts", {}):
        commands.append(["bun", "run", "test:e2e"])
    for index, command in enumerate(commands):
        result = run(command, repo)
        log_name = f"{args.label}-check-{index + 1}.txt"
        log = result.pop("output").replace(str(repo), "$REPO").replace(str(Path.home()), "$HOME")
        (args.output_dir / log_name).write_text(log)
        result["log"] = log_name
        results.append(result)
        print(json.dumps(result), flush=True)
    summary = {"label": args.label, "commit": commit, "branch": branch, "frozen_input_integrity": integrity,
               "checks": results, "human_visual_review": "not performed"}
    (args.output_dir / f"{args.label}-evaluation.json").write_text(json.dumps(summary, indent=2) + "\n")
