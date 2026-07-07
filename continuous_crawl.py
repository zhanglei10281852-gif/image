#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CRAWLER = ROOT / "desktop-scene-crawler" / "scripts" / "desktop_scene_crawler.py"
PYTHON = ROOT / ".venv" / "bin" / "python"
STOP_FILE = ROOT / "STOP_CRAWL"

QUERIES = [
    "书桌日常 咖啡 笔记本 site:douban.com/group/topic",
    "书桌日常 台灯 文具 site:douban.com/group/topic",
    "我的书桌 键盘 鼠标 site:douban.com/group/topic",
    "办公桌面 咖啡杯 笔记本 site:douban.com/group/topic",
    "学习桌 课本 台灯 文具 site:douban.com/group/topic",
    "餐桌 早餐 杯子 盘子 site:douban.com/group/topic",
    "餐桌 摆盘 杯子 盘子 site:douban.com/group/topic",
    "咖啡桌 书 遥控器 绿植 site:douban.com/group/topic",
    "茶几 书 杯子 遥控器 site:douban.com/group/topic",
    "厨房台面 砧板 食材 site:douban.com/group/topic",
    "厨房台面 咖啡 食材 site:douban.com/group/topic",
    "梳妆台 化妆品 镜子 site:douban.com/group/topic",
    "床头柜 台灯 书 杯子 site:douban.com/group/topic",
    "阳台桌 咖啡 书 site:douban.com/group/topic",
    "露台餐桌 咖啡 户外 site:douban.com/group/topic",
    "桌面收纳 书桌 日常 site:douban.com/group/topic",
    "工位改造 桌面 键盘 site:douban.com/group/topic",
    "租房改造 书桌 桌面 site:douban.com/group/topic",
    "咖啡角 杯子 桌面 site:douban.com/group/topic",
    "手工桌 工具 材料 site:douban.com/group/topic",
    "书桌日常 咖啡 笔记本 site:douban.com/note",
    "餐桌 早餐 杯子 盘子 site:douban.com/note",
    "厨房台面 砧板 食材 site:douban.com/note",
    "梳妆台 化妆品 镜子 site:douban.com/note",
    "书桌日常 咖啡 笔记本 site:lofter.com",
    "餐桌 早餐 杯子 盘子 site:lofter.com",
    "厨房台面 砧板 食材 site:lofter.com",
    "desk",
    "office desk",
    "computer desk",
    "laptop desk",
    "writing desk",
    "study desk",
    "work desk",
    "tabletop",
    "table top",
    "dining table",
    "breakfast table",
    "restaurant table",
    "cafe table",
    "coffee table",
    "kitchen counter",
    "kitchen countertop",
    "workbench",
    "lab bench",
    "vanity table",
    "nightstand",
    "bedside table",
    "picnic table",
    "patio table",
    "outdoor table",
    "balcony table",
    "terrace table",
    "desk coffee",
    "desk laptop",
    "desk books",
    "desk keyboard",
    "table coffee",
    "table plate",
    "table cup",
    "countertop food",
    "countertop kitchen",
    "workbench tools",
    "picnic table food",
    "patio table coffee",
    "desk setup mug notebook candid",
    "workspace coffee cup laptop desk",
    "study desk books lamp stationery",
    "home office desk keyboard mouse mug",
    "dining table plate cup breakfast",
    "coffee table books remote plant",
    "kitchen countertop cutting board ingredients",
    "vanity table cosmetics mirror",
    "workbench tools parts tabletop",
    "patio table coffee plate outdoor dining",
    "picnic table food cup outdoor",
    "balcony table coffee book",
    "cafe table coffee laptop candid",
    "书桌日常 咖啡杯 笔记本",
    "办公桌面 键盘 鼠标 咖啡",
    "学习桌 台灯 文具 课本",
    "餐桌 早餐 杯子 盘子",
    "厨房台面 砧板 食材",
    "阳台桌 咖啡 书",
    "露台餐桌 户外 咖啡",
]


def manifest_count(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    total = 0
    kept = 0
    with path.open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            total += 1
            if not row.get("risk_flag"):
                kept += 1
    return total, kept


def strict_manifest_count(path: Path) -> int:
    if not path.exists():
        return 0
    kept = 0
    with path.open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("risk_flag"):
                continue
            if (row.get("license_type") or "").strip() == "restricted":
                continue
            if not row.get("source_url") or not row.get("source_image_url"):
                continue
            if "/thumb/" in (row.get("source_image_url") or "").lower():
                continue
            try:
                if int(row.get("short_edge") or 0) < 512:
                    continue
            except ValueError:
                continue
            kept += 1
    return kept


def export_complete_excel_batches(manifest: Path, output_dir: Path, batch_size: int, log_path: Path) -> None:
    if batch_size <= 0:
        return
    kept = strict_manifest_count(manifest)
    complete_batches = kept // batch_size
    if complete_batches <= 0:
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    python = PYTHON if PYTHON.exists() else Path(sys.executable)
    for batch_idx in range(complete_batches):
        output = output_dir / f"桌面场景图片标注表_张磊_批次{batch_idx + 1:04d}.xlsx"
        build_cmd = [
            str(python),
            str(ROOT / "build_excel.py"),
            "--manifest",
            str(manifest),
            "--output",
            str(output),
            "--include-extra-fields",
            "--include-thumbnails",
            "--offset",
            str(batch_idx * batch_size),
            "--limit",
            str(batch_size),
        ]
        build_proc = subprocess.run(build_cmd, cwd=ROOT, text=True, capture_output=True)
        if build_proc.stdout.strip():
            log(build_proc.stdout.strip().replace("\n", " | "), log_path)
        if build_proc.returncode != 0:
            log(f"ERROR batch_excel returncode={build_proc.returncode} stderr={build_proc.stderr.strip()}", log_path)


def log(message: str, log_path: Path) -> None:
    line = f"{datetime.now().isoformat(timespec='seconds')} {message}"
    print(line, flush=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Continuously crawl tabletop scene images.")
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "desktop_scenes"))
    parser.add_argument("--provider", default="openverse")
    parser.add_argument("--exclude-manifest", action="append", default=[])
    parser.add_argument("--limit-per-query", type=int, default=50)
    parser.add_argument("--target-kept", type=int, default=100000)
    parser.add_argument("--sleep-between-queries", type=float, default=3.0)
    parser.add_argument("--sleep-between-candidates", type=float, default=0.2)
    parser.add_argument("--excel-output", default="")
    parser.add_argument("--batch-excel-dir", default="")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--provider-timeout", type=int, default=120)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = output_dir / "crawl.log"
    manifest = output_dir / "manifest.csv"

    python = PYTHON if PYTHON.exists() else Path(sys.executable)
    cycle = 0
    providers = [provider.strip() for provider in args.provider.split(",") if provider.strip()]
    if not providers:
        providers = ["openverse"]
    log(f"start provider={','.join(providers)} target_kept={args.target_kept} output_dir={output_dir}", log_path)

    while not STOP_FILE.exists():
        cycle += 1
        for query in QUERIES:
            if STOP_FILE.exists():
                break
            for provider in providers:
                if STOP_FILE.exists():
                    break
                total, kept = manifest_count(manifest)
                if args.target_kept > 0 and kept >= args.target_kept:
                    log(f"target reached total={total} kept={kept}", log_path)
                    return 0

                cmd = [
                    str(python),
                    str(CRAWLER),
                    "collect",
                    "--provider",
                    provider,
                    "--query",
                    query,
                    "--limit",
                    str(args.limit_per_query),
                    "--output-dir",
                    str(output_dir),
                ]
                for exclude_manifest in args.exclude_manifest:
                    cmd.extend(["--exclude-manifest", exclude_manifest])
                cmd.extend(["--sleep", str(args.sleep_between_candidates)])
                log(f"cycle={cycle} provider={provider} query={query!r} before_total={total} before_kept={kept}", log_path)
                try:
                    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=args.provider_timeout)
                except subprocess.TimeoutExpired as exc:
                    stderr = (exc.stderr or "").strip() if isinstance(exc.stderr, str) else ""
                    log(f"ERROR provider={provider} timed_out_after={args.provider_timeout}s stderr={stderr}", log_path)
                    continue
                if proc.stdout.strip():
                    log(proc.stdout.strip().replace("\n", " | "), log_path)
                if proc.returncode != 0:
                    log(f"ERROR provider={provider} returncode={proc.returncode} stderr={proc.stderr.strip()}", log_path)
                    if "429" in proc.stderr or "Too Many Requests" in proc.stderr:
                        log("rate limited; backing off for 90 seconds", log_path)
                        time.sleep(90)
                if args.excel_output or args.batch_excel_dir:
                    dedupe_cmd = [
                        str(python),
                        str(ROOT / "dedupe_manifest.py"),
                        "--manifest",
                        str(manifest),
                        "--drop-risk",
                        "low_resolution",
                        "--drop-risk",
                        "download_failed",
                        "--drop-risk",
                        "needs_manual_review",
                        "--drop-thumbnails",
                    ]
                    dedupe_proc = subprocess.run(dedupe_cmd, cwd=ROOT, text=True, capture_output=True)
                    if dedupe_proc.stdout.strip():
                        log(dedupe_proc.stdout.strip().replace("\n", " | "), log_path)
                    if dedupe_proc.returncode != 0:
                        log(f"ERROR dedupe returncode={dedupe_proc.returncode} stderr={dedupe_proc.stderr.strip()}", log_path)
                if args.excel_output:
                    build_cmd = [
                        str(python),
                        str(ROOT / "build_excel.py"),
                        "--manifest",
                        str(manifest),
                        "--output",
                        args.excel_output,
                    ]
                    build_proc = subprocess.run(build_cmd, cwd=ROOT, text=True, capture_output=True)
                    if build_proc.stdout.strip():
                        log(build_proc.stdout.strip().replace("\n", " | "), log_path)
                    if build_proc.returncode != 0:
                        log(f"ERROR excel returncode={build_proc.returncode} stderr={build_proc.stderr.strip()}", log_path)
                if args.batch_excel_dir:
                    export_complete_excel_batches(manifest, Path(args.batch_excel_dir), args.batch_size, log_path)
                time.sleep(args.sleep_between_queries)

    log("stop file detected; exiting", log_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        fallback_log = ROOT / "continuous_crawl.fatal.log"
        with fallback_log.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} fatal error\n")
            f.write(traceback.format_exc())
            f.write("\n")
        raise
