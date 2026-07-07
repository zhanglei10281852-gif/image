#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def is_better(row: dict[str, str], current: dict[str, str] | None) -> bool:
    if current is None:
        return True
    if current.get("risk_flag") == "duplicate_source_url":
        return True
    if row.get("risk_flag") == "" and current.get("risk_flag") != "":
        return True
    if row.get("image_path") and not current.get("image_path"):
        return True
    return False


def dedupe_manifest(manifest: Path, drop_risks: set[str] | None = None, drop_thumbnails: bool = False) -> tuple[int, int]:
    drop_risks = drop_risks or set()
    if not manifest.exists():
        return 0, 0
    with manifest.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        by_url: dict[str, dict[str, str]] = {}
        order: list[str] = []
        total = 0
        for row in reader:
            total += 1
            if row.get("risk_flag") in drop_risks:
                continue
            if drop_thumbnails and "/thumb/" in (row.get("source_image_url") or "").lower():
                continue
            key = (row.get("normalized_source_url") or row.get("source_url") or "").strip()
            if not key:
                key = f"__missing__:{total}"
            if key not in by_url:
                order.append(key)
            if row.get("risk_flag") == "duplicate_source_url":
                row["risk_flag"] = ""
                row["notes"] = (row.get("notes") or "").replace("Duplicate normalized source_url", "").strip("; ")
            if is_better(row, by_url.get(key)):
                by_url[key] = row

    rows = [by_url[key] for key in order]
    backup = manifest.with_suffix(manifest.suffix + ".bak")
    manifest.replace(backup)
    with manifest.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    jsonl = manifest.with_suffix(".jsonl")
    if jsonl.exists():
        jsonl_backup = jsonl.with_suffix(jsonl.suffix + ".bak")
        jsonl.replace(jsonl_backup)
    with jsonl.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return total, len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove duplicate normalized_source_url rows from crawler manifests.")
    parser.add_argument("--manifest", default="data/desktop_scenes/manifest.csv")
    parser.add_argument("--drop-risk", action="append", default=[], help="risk_flag value to remove before dedupe; repeatable")
    parser.add_argument("--drop-thumbnails", action="store_true", help="remove rows whose image URL is a thumbnail URL")
    args = parser.parse_args()
    before, after = dedupe_manifest(Path(args.manifest), set(args.drop_risk), args.drop_thumbnails)
    print(f"deduped manifest={args.manifest} before={before} after={after} removed={before-after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
