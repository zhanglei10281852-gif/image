#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from pathlib import Path


DEFAULT_PATTERNS = [
    "data/**/manifest.csv",
    "sample_run/manifest.csv",
]


def manifest_paths(patterns: list[str]) -> list[Path]:
    paths: list[Path] = []
    for pattern in patterns:
        matches = sorted(Path().glob(pattern))
        if matches:
            paths.extend(matches)
        else:
            path = Path(pattern)
            if path.exists():
                paths.append(path)
    return paths


def collect_urls(paths: list[Path]) -> dict[str, dict[str, str]]:
    seen: dict[str, dict[str, str]] = {}
    for path in paths:
        if not path.exists():
            continue
        with path.open("r", newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                normalized = (row.get("normalized_source_url") or row.get("source_url") or "").strip()
                if not normalized or normalized in seen:
                    continue
                seen[normalized] = {
                    "normalized_source_url": normalized,
                    "source_url": (row.get("source_url") or "").strip(),
                    "first_manifest": str(path),
                }
    return seen


def write_known_urls(output: Path, rows: dict[str, dict[str, str]]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["normalized_source_url", "source_url", "first_manifest"],
            lineterminator="\n",
        )
        writer.writeheader()
        for key in sorted(rows):
            writer.writerow(rows[key])


def main() -> int:
    parser = argparse.ArgumentParser(description="Export crawled source URLs for future duplicate skipping.")
    parser.add_argument("--output", default="known_source_urls.csv")
    parser.add_argument("--manifest", action="append", default=[], help="manifest CSV or glob pattern; repeatable")
    args = parser.parse_args()

    patterns = args.manifest or DEFAULT_PATTERNS
    paths = manifest_paths(patterns)
    rows = collect_urls(paths)
    write_known_urls(Path(args.output), rows)
    print(f"wrote {args.output} urls={len(rows)} manifests={len(paths)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
