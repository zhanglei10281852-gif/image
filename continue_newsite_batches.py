#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import re
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
OUT = ROOT / "data" / "desktop_scenes_batch7_continuous_newsites"
MANIFEST = OUT / "manifest.csv"
EXCEL_DIR = ROOT / "outputs" / "桌面场景图片标注表_张磊_分批_第七轮"
LOG = OUT / "continuous_newsites.log"
STOP_FILE = ROOT / "STOP_CRAWL_NEWSITES"
START_BATCH_NUMBER = 7
BATCH_SIZE = 100

EXCLUDE_MANIFESTS = [
    ROOT / "data" / "desktop_scenes" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch2" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch3" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch4" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch5" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch6" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch7" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch7_newsites5" / "manifest.csv",
    ROOT / "data" / "desktop_scenes_batch7_newsites6" / "manifest.csv",
    ROOT / "known_source_urls.csv",
]

QUERIES = [
    ("startupstockphotos_web", "desk laptop coffee", 10),
    ("startupstockphotos_web", "office desk computer", 10),
    ("startupstockphotos_web", "flat lay desktop objects", 10),
    ("startupstockphotos_web", "headphones desk object", 10),
    ("startupstockphotos_web", "smartphone pen desk", 10),
    ("startupstockphotos_web", "computer keyboard desk", 10),
    ("startupstockphotos_web", "notebook desk coffee", 10),
    ("startupstockphotos_web", "tablet pencil desk", 10),
    ("startupstockphotos_web", "hands typing desk", 10),
    ("startupstockphotos_web", "desk work objects", 10),
    ("startupstockphotos_web", "mobile phone desk", 10),
    ("startupstockphotos_web", "office workspace desk", 10),
    ("wikimedia", "desk laptop coffee", 60),
    ("wikimedia", "dining table plates cutlery", 60),
    ("wikimedia", "kitchen counter food bowl", 60),
    ("wikimedia", "workbench tools table", 60),
    ("wikimedia", "tea set wooden table", 60),
    ("isorepublic_web", "plates on dining table", 45),
    ("isorepublic_web", "breakfast table coffee cup", 45),
    ("isorepublic_web", "restaurant table plates cutlery", 45),
    ("isorepublic_web", "laptop keyboard desk coffee", 45),
    ("isorepublic_web", "kitchen counter food bowl", 45),
    ("picography_web", "plates dining table", 45),
    ("picography_web", "coffee cup table", 45),
    ("picography_web", "laptop desk keyboard", 45),
    ("freestocks_web", "breakfast table coffee cup", 45),
    ("freestocks_web", "restaurant table plates", 45),
    ("freestocks_web", "desk laptop keyboard", 45),
    ("negativespace_web", "coffee cup desk", 45),
    ("negativespace_web", "laptop desk keyboard", 45),
    ("freeimages_uk_web", "dining table plate cup cutlery", 55),
    ("freeimages_uk_web", "office desk computer keyboard", 55),
    ("freeimages_uk_web", "kitchen counter bowl food", 55),
    ("libreshot_web", "tea cup wooden table", 45),
    ("libreshot_web", "restaurant table plate cutlery", 45),
    ("libreshot_web", "office desk computer coffee", 45),
    ("foodiesfeed_web", "breakfast table coffee cup", 35),
    ("foodiesfeed_web", "restaurant table plate food", 35),
    ("picjumbo_web", "plates on dining table", 15),
    ("picjumbo_web", "restaurant table plates cutlery", 15),
    ("picjumbo_web", "laptop keyboard desk coffee", 15),
]

BAD_TEXT = [
    "second life",
    "avatar",
    "virtual",
    "render",
    "cgi",
    "3d render",
    "anime",
    "cartoon",
    "illustration",
    "digital art",
    "ai generated",
    "midjourney",
    "stable diffusion",
    "mockup",
    "istockphoto",
    "premium",
    "shutterstock",
]

BAD_SUBJECT_WORDS = [
    "alpine",
    "animal picture",
    "beach",
    "background",
    "car",
    "cloud",
    "forest",
    "highway",
    "landscape",
    "mountain",
    "nature",
    "road",
    "sea",
    "sky",
    "street",
    "sunset",
    "wallpaper",
    "bare stony room",
    "room coffee table",
]

SURFACE_WORDS = [
    "desk",
    "table",
    "counter",
    "countertop",
    "desktop",
    "workbench",
    "dining",
    "surface",
    "workspace",
    "workplace",
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
    "tools",
    "pen",
    "phone",
    "tablet",
    "monitor",
    "computer",
    "cutlery",
    "glass",
    "vegetable",
    "salad",
    "bowl",
    "spoon",
    "fork",
    "knife",
    "wine",
    "dinner",
    "breakfast",
    "lunch",
    "meal",
    "pizza",
    "sandwich",
    "bread",
    "fruit",
    "garlic",
    "potato",
    "napkin",
    "candle",
    "vase",
    "flower",
    "typewriter",
    "drink",
    "beer",
    "lemonade",
    "menu",
    "placemat",
    "teapot",
    "tea",
    "headphones",
    "earbuds",
    "pencil",
    "smartphone",
    "post-it",
]


def has_term(text: str, terms: list[str]) -> bool:
    for term in terms:
        escaped = re.escape(term.lower()).replace(r"\ ", r"[-_\s]+")
        pattern = r"(?<![a-z0-9])" + escaped + r"(?![a-z0-9])"
        if re.search(pattern, text):
            return True
    return False


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
    source_url = (row.get("source_url") or "").strip()
    image_url = (row.get("source_image_url") or "").strip().lower()
    if not source_url or not image_url or source_url == image_url:
        return False
    if "/thumb/" in image_url or "/thumbnail" in image_url:
        return False
    try:
        if int(row.get("short_edge") or 0) < 512:
            return False
    except ValueError:
        return False
    all_text = " ".join(
        row.get(key, "")
        for key in ["source_url", "source_image_url", "query", "title", "author", "notes"]
    ).lower()
    if has_term(all_text, BAD_TEXT):
        return False
    evidence_text = " ".join(
        row.get(key, "")
        for key in ["source_url", "source_image_url", "title", "author", "notes"]
    ).lower()
    if has_term(evidence_text, BAD_SUBJECT_WORDS):
        return False
    return has_term(evidence_text, SURFACE_WORDS) and has_term(evidence_text, OBJECT_WORDS)


def clean_manifest() -> int:
    rows = read_rows()
    if not rows:
        return 0

    fields = list(rows[0].keys())
    kept: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        normalized = (row.get("normalized_source_url") or row.get("source_url") or "").strip()
        if not normalized or normalized in seen:
            continue
        if not strict_ok(row):
            continue
        text = " ".join([row.get("query", ""), row.get("title", ""), row.get("source_url", "")]).lower()
        if not row.get("scene_setting") or row.get("scene_setting") == "unknown":
            row["scene_setting"] = "outdoor" if any(word in text for word in ["outdoor", "patio", "terrace", "picnic"]) else "indoor"
        if not row.get("complexity_level") or row.get("complexity_level") == "unknown":
            row["complexity_level"] = "L2"
        seen.add(normalized)
        kept.append(row)

    shutil.copy2(MANIFEST, MANIFEST.with_suffix(".before_clean.csv"))
    with MANIFEST.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(kept)
    with MANIFEST.with_suffix(".jsonl").open("w", encoding="utf-8") as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(kept)


def export_complete_batches() -> None:
    count = clean_manifest()
    complete = count // BATCH_SIZE
    EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    for idx in range(complete):
        batch_number = START_BATCH_NUMBER + idx
        output = EXCEL_DIR / f"桌面场景图片标注表_张磊_批次{batch_number:04d}.xlsx"
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
            str(idx * BATCH_SIZE),
            "--limit",
            str(BATCH_SIZE),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
        if proc.stdout.strip():
            log(proc.stdout.strip().replace("\n", " | "))
        if proc.returncode != 0:
            log(f"ERROR export batch={batch_number} rc={proc.returncode} stderr={proc.stderr.strip()}")


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
        proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=90)
    except subprocess.TimeoutExpired:
        log(f"TIMEOUT provider={provider} query={query!r}")
        return
    if proc.stdout.strip():
        log(proc.stdout.strip().replace("\n", " | "))
    if proc.returncode != 0:
        log(f"ERROR provider={provider} rc={proc.returncode} stderr={proc.stderr.strip()[:500]}")

    subprocess.run(
        [
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
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    clean_manifest()
    export_complete_batches()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    cycle = 0
    log("continuous new-site production started")
    while not STOP_FILE.exists():
        cycle += 1
        for provider, query, limit in QUERIES:
            if STOP_FILE.exists():
                break
            collect_once(provider, query, limit)
            time.sleep(1)
        log(f"cycle={cycle} kept={clean_manifest()}")
    log("STOP_CRAWL_NEWSITES detected; exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
