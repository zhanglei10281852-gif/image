#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "bin" / "python"


def main() -> int:
    parser = argparse.ArgumentParser(description="Start a detached batch crawl process.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--batch-excel-dir", required=True)
    parser.add_argument("--exclude-manifest", action="append", default=[])
    parser.add_argument("--provider", default="openverse")
    parser.add_argument("--limit-per-query", type=int, default=80)
    parser.add_argument("--target-kept", type=int, default=100000)
    parser.add_argument("--sleep-between-queries", type=float, default=1.0)
    parser.add_argument("--sleep-between-candidates", type=float, default=0.1)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--provider-timeout", type=int, default=120)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    batch_excel_dir = Path(args.batch_excel_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    batch_excel_dir.mkdir(parents=True, exist_ok=True)

    python = PYTHON if PYTHON.exists() else Path(sys.executable)
    cmd = [
        str(python),
        str(ROOT / "continuous_crawl.py"),
        "--output-dir",
        str(output_dir),
        "--provider",
        args.provider,
        "--limit-per-query",
        str(args.limit_per_query),
        "--target-kept",
        str(args.target_kept),
        "--sleep-between-queries",
        str(args.sleep_between_queries),
        "--sleep-between-candidates",
        str(args.sleep_between_candidates),
        "--batch-excel-dir",
        str(batch_excel_dir),
        "--batch-size",
        str(args.batch_size),
        "--provider-timeout",
        str(args.provider_timeout),
    ]
    for manifest in args.exclude_manifest:
        cmd.extend(["--exclude-manifest", manifest])

    log_path = output_dir / "crawl.detached.log"
    log_file = log_path.open("ab", buffering=0)
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
    (output_dir / "crawl.pid").write_text(f"{proc.pid}\n", encoding="utf-8")
    print(proc.pid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
