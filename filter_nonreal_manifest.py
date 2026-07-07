#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path


EXACT_SOURCE_PATTERNS = [
    r"flickr\.com/photos/cleopatraclyalin/",
    r"flickr\.com/photos/141893679@N05/",
    r"flickr\.com/photos/virtualcourtney/",
    r"flickr\.com/photos/virtualwolf/",
    r"flickr\.com/photos/vintage_illustration/",
    r"flickr\.com/photos/library-company-of-philadelphia/",
    r"flickr\.com/photos/lselibrary/",
    r"flickr\.com/photos/43233578@N04/",
    r"flickr\.com/photos/156452142@N06/",
]

TEXT_PATTERNS = [
    r"second\s*life",
    r"\bslurl\b",
    r"\bavatar\b",
    r"\bvirtual\b",
    r"\brender(?:ed|ing)?\b",
    r"\bcgi\b",
    r"3d[-_ ]?render",
    r"\bsims?\b",
    r"\bimvu\b",
    r"\banime\b",
    r"\bcartoon\b",
    r"\billustration\b",
    r"digital\s+art",
    r"ai[-_ ]?generated",
    r"midjourney",
    r"stable[-_ ]?diffusion",
    r"thank you to my sponsors",
    r"\bmainstore\b",
    r"\bmarketplace\b",
]


SOURCE_RX = re.compile("|".join(EXACT_SOURCE_PATTERNS), re.IGNORECASE)
TEXT_RX = re.compile("|".join(TEXT_PATTERNS), re.IGNORECASE)


def reject_reason(row: dict[str, str]) -> str:
    source = " ".join([row.get("source_url", ""), row.get("normalized_source_url", "")])
    source_match = SOURCE_RX.search(source)
    if source_match:
        return f"non_real_source_pattern:{source_match.group(0)}"

    text = " ".join(
        [
            row.get("source_url", ""),
            row.get("title", ""),
            row.get("author", ""),
            row.get("notes", ""),
        ]
    )
    text_match = TEXT_RX.search(text)
    if text_match:
        return f"non_real_text_pattern:{text_match.group(0)}"
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove obvious non-real/virtual/illustration rows from a manifest.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--removed-report", default="")
    args = parser.parse_args()

    manifest = Path(args.manifest)
    rows = list(csv.DictReader(manifest.open("r", newline="", encoding="utf-8")))
    if not rows:
        print(f"manifest={manifest} rows=0 removed=0 kept=0")
        return 0

    fieldnames = list(rows[0].keys())
    kept: list[dict[str, str]] = []
    removed: list[dict[str, str]] = []
    for row in rows:
        reason = reject_reason(row)
        if reason:
            removed.append({**row, "removed_reason": reason})
        else:
            kept.append(row)

    backup = manifest.with_suffix(manifest.suffix + ".before_nonreal_filter.bak")
    manifest.replace(backup)
    with manifest.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(kept)

    jsonl = manifest.with_suffix(".jsonl")
    if jsonl.exists():
        jsonl_backup = jsonl.with_suffix(jsonl.suffix + ".before_nonreal_filter.bak")
        jsonl.replace(jsonl_backup)
    with jsonl.open("w", encoding="utf-8") as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    report = Path(args.removed_report) if args.removed_report else manifest.with_name("removed_nonreal_report.csv")
    if removed:
        report_fields = fieldnames + ["removed_reason"]
        with report.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=report_fields)
            writer.writeheader()
            writer.writerows(removed)

    print(f"manifest={manifest} before={len(rows)} removed={len(removed)} kept={len(kept)} report={report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
