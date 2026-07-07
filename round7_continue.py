#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "bin" / "python"
if not PYTHON.exists():
    PYTHON = Path(sys.executable)

CRAWLER = ROOT / "desktop-scene-crawler" / "scripts" / "desktop_scene_crawler.py"
OUT = ROOT / "data" / "desktop_scenes_batch7"
MANIFEST = OUT / "manifest.csv"
EXCEL_DIR = ROOT / "outputs" / "桌面场景图片标注表_张磊_分批_第七轮"
LOG = OUT / "round7_continue.log"
STOP_FILE = ROOT / "STOP_CRAWL_ROUND7"

EXCLUDE_MANIFESTS = [
    ROOT / "data" / "desktop_scenes" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch2" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch3" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch4" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch5" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch6" / "manifest.csv",
    ROOT / "known_source_urls.csv",
]

QUERIES = [
    # New sites only. Do not use the earlier Flickr/PxHere/Wikimedia sources.
    ("libreshot_web", "laptop wooden table desk", 40),
    ("libreshot_web", "vegetable salad wooden table", 40),
    ("libreshot_web", "restaurant table cutlery plate", 40),
    ("libreshot_web", "beer lemonade table glass", 40),
    ("libreshot_web", "coffee wooden table cup", 40),
    ("libreshot_web", "office desk laptop smartphone", 40),
    ("libreshot_web", "kitchen table vegetables", 40),
    ("libreshot_web", "food ingredients wooden table", 40),
    ("freeimages_uk_web", "dining table plate cup cutlery", 60),
    ("freeimages_uk_web", "breakfast table bowl cup plate", 60),
    ("freeimages_uk_web", "kitchen table food plate cup", 60),
    ("freeimages_uk_web", "office desk computer keyboard", 60),
    ("freeimages_uk_web", "restaurant table plate glass", 60),
    ("freeimages_uk_web", "cutlery plate dining table", 60),
]

BAD_TEXT = [
    "second life",
    "slurl",
    "avatar",
    "virtual",
    "render",
    "cgi",
    "3d render",
    "sims",
    "imvu",
    "anime",
    "cartoon",
    "illustration",
    "digital art",
    "ai generated",
    "midjourney",
    "stable diffusion",
    "floor plan",
    "screenshot",
    "white background",
    "packshot",
    "product shot",
]

SURFACE_WORDS = [
    "desk",
    "table",
    "counter",
    "countertop",
    "workbench",
    "bench",
    "nightstand",
    "vanity",
    "patio",
    "picnic",
    "workspace",
    "kitchen",
    "dining",
    "coffee table",
    "home office",
    "office",
]

OBJECT_WORDS = [
    "coffee",
    "cup",
    "mug",
    "book",
    "notebook",
    "laptop",
    "keyboard",
    "mouse",
    "plate",
    "food",
    "breakfast",
    "lamp",
    "plant",
    "tools",
    "cosmetics",
    "stationery",
    "pen",
    "cutting",
    "board",
    "phone",
    "tablet",
    "monitor",
]


def log(message: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def read_rows() -> list[dict[str, str]]:
    if not MANIFEST.exists():
        return []
    with MANIFEST.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def strict_ok(row: dict[str, str]) -> bool:
    if row.get("risk_flag"):
        return False
    if (row.get("license_type") or "").strip() == "restricted":
        return False
    source_url = (row.get("source_url") or "").strip()
    image_url = (row.get("source_image_url") or "").strip()
    if not source_url or not image_url or source_url == image_url:
        return False
    low_image = image_url.lower()
    if "/thumb/" in low_image or "google" in low_image:
        return False
    try:
        if int(row.get("short_edge") or 0) < 512:
            return False
    except ValueError:
        return False
    text = " ".join(
        row.get(key, "")
        for key in ["source_url", "source_image_url", "query", "title", "author", "notes"]
    ).lower()
    if any(word in text for word in BAD_TEXT):
        return False
    if not any(word in text for word in SURFACE_WORDS):
        return False
    if not any(word in text for word in OBJECT_WORDS):
        return False
    return True


def clean_manifest() -> int:
    rows = read_rows()
    if not rows:
        return 0

    fieldnames = list(rows[0].keys())
    kept: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in rows:
        normalized = (row.get("normalized_source_url") or row.get("source_url") or "").strip()
        if not normalized or normalized in seen_urls:
            continue
        if not strict_ok(row):
            continue
        text = " ".join([row.get("query", ""), row.get("title", ""), row.get("source_url", "")]).lower()
        if not row.get("scene_setting") or row.get("scene_setting") == "unknown":
            if any(word in text for word in ["patio", "picnic", "outdoor", "garden", "balcony", "terrace"]):
                row["scene_setting"] = "outdoor"
            else:
                row["scene_setting"] = "indoor"
        if not row.get("complexity_level") or row.get("complexity_level") == "unknown":
            row["complexity_level"] = "L2"
        seen_urls.add(normalized)
        kept.append(row)

    backup = MANIFEST.with_suffix(".round7_continue_clean.bak")
    shutil.copy2(MANIFEST, backup)
    with MANIFEST.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(kept)
    with MANIFEST.with_suffix(".jsonl").open("w", encoding="utf-8") as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(kept)


def export_complete_batches() -> None:
    count = clean_manifest()
    complete = count // 100
    EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    for batch_idx in range(complete):
        output = EXCEL_DIR / f"桌面场景图片标注表_张磊_批次{batch_idx + 1:04d}.xlsx"
        if output.exists():
            continue
        cmd = [
            str(PYTHON),
            str(ROOT / "build_excel.py"),
            "--manifest",
            str(MANIFEST),
            "--output",
            str(output),
            "--include-extra-fields",
            "--include-thumbnails",
            "--offset",
            str(batch_idx * 100),
            "--limit",
            "100",
        ]
        proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
        if proc.stdout.strip():
            log(proc.stdout.strip().replace("\n", " | "))
        if proc.returncode != 0:
            log(f"ERROR export rc={proc.returncode} stderr={proc.stderr.strip()}")


def collect_once(provider: str, query: str, limit: int) -> None:
    cmd = [
        str(PYTHON),
        str(CRAWLER),
        "collect",
        "--provider",
        provider,
        "--query",
        query,
        "--limit",
        str(limit),
        "--output-dir",
        str(OUT),
        "--sleep",
        "0.01",
    ]
    for manifest in EXCLUDE_MANIFESTS:
        if manifest.exists():
            cmd.extend(["--exclude-manifest", str(manifest)])
    log(f"collect provider={provider} query={query!r} before={clean_manifest()}")
    try:
        proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        log(f"TIMEOUT provider={provider} query={query!r}")
        return
    if proc.stdout.strip():
        log(proc.stdout.strip().replace("\n", " | "))
    if proc.returncode != 0:
        log(f"ERROR provider={provider} rc={proc.returncode} stderr={proc.stderr.strip()[:500]}")

    dedupe_cmd = [
        str(PYTHON),
        str(ROOT / "dedupe_manifest.py"),
        "--manifest",
        str(MANIFEST),
        "--drop-risk",
        "low_resolution",
        "--drop-risk",
        "download_failed",
        "--drop-risk",
        "needs_manual_review",
        "--drop-thumbnails",
    ]
    subprocess.run(dedupe_cmd, cwd=ROOT, text=True, capture_output=True)
    clean_manifest()
    export_complete_batches()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    cycle = 0
    log("round7 continuous crawl started")
    export_complete_batches()
    while not STOP_FILE.exists():
        cycle += 1
        for provider, query, limit in QUERIES:
            if STOP_FILE.exists():
                break
            collect_once(provider, query, limit)
            time.sleep(2)
        log(f"cycle={cycle} complete kept={clean_manifest()}")
    log("STOP_CRAWL_ROUND7 detected; exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
