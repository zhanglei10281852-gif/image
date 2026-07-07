---
name: desktop-scene-crawler
description: Collect, download, validate, and package traceable real photos of desktop/tabletop/local surface scenes with visible objects. Use when Codex needs to implement or run compliant image collection for tabletop scenes, generate manifests with source URLs/licenses/fetch times, filter banned academic datasets or AI/render/product-shot content, or audit batches against the desktop scene image specification.
---

# Desktop Scene Crawler

## Core Rule

Collect only real photographs where both are visible:

- A table/surface/counter/workbench/picnic table/vanity/nightstand-like support surface.
- At least one recognizable object on that surface.

Reject AI images, renders, illustrations, white-background product shots, whole-room distant views where the surface is too small, severe blur, short edge under 512 px, large watermarks over the subject, academic datasets, dataset mirrors, private/login-only pages, and search-result thumbnails.

## Workflow

1. Read `references/source_policy.md` when deciding whether a source/channel is allowed.
2. Read `references/manifest_schema.md` before changing manifest output fields.
3. Use `scripts/desktop_scene_crawler.py` for collection and validation.
4. Prefer official/public APIs and source pages. Treat Google/Bing Images only as discovery; download from the original page and record that page URL.
5. Set unknown visual labels (`scene_setting`, `complexity_level`) to `unknown` unless a human or downstream reviewer has confirmed them.
6. Deduplicate on normalized `source_url`, not image hash, unless the user explicitly asks for stronger deduplication.

## Quick Commands

Install runtime dependencies in the working environment:

```bash
python3 -m pip install -r desktop-scene-crawler/scripts/requirements.txt
```

Collect from Wikimedia Commons without API keys:

```bash
python3 desktop-scene-crawler/scripts/desktop_scene_crawler.py collect \
  --provider wikimedia \
  --query "desk setup mug notebook" \
  --limit 50 \
  --output-dir data/desktop_scenes
```

Collect from a reviewed source URL list:

```bash
python3 desktop-scene-crawler/scripts/desktop_scene_crawler.py collect \
  --provider urls \
  --url-list source_urls.txt \
  --output-dir data/desktop_scenes
```

Validate an existing batch:

```bash
python3 desktop-scene-crawler/scripts/desktop_scene_crawler.py validate \
  --manifest data/desktop_scenes/manifest.csv \
  --output-dir data/desktop_scenes
```

## Supported Providers

- `wikimedia`: MediaWiki API, no key required. Records Wikimedia File page URL and license metadata when available.
- `flickr`: Flickr API, requires `FLICKR_API_KEY`. Use CC/license filters by default.
- `unsplash`: Unsplash API, requires `UNSPLASH_ACCESS_KEY`. Calls the download tracking endpoint before saving.
- `pexels`: Pexels API, requires `PEXELS_API_KEY`.
- `pixabay`: Pixabay API, requires `PIXABAY_API_KEY`.
- `urls`: A human-reviewed text file of source pages or direct image URLs. For HTML pages, the script uses `og:image` / `twitter:image` / large `<img>` candidates and still records the page as `source_url`.

## Search Guidance

Use three-part queries: scene/surface + object + casual/lifestyle style. Examples:

- `desk setup mug notebook candid`
- `kitchen countertop cutting board ingredients`
- `coffee table books remote plant lived in`
- `patio table coffee plate outdoor dining`
- `书桌日常 咖啡杯 笔记本 随手拍`
- `厨房台面 砧板 食材 生活记录`

Use negative filters mentally or in platform search when possible: `render`, `CGI`, `AI generated`, `midjourney`, `stable diffusion`, `white background product`, `floor plan`, `empty room`, `screenshot`, `meme`.

## Batch Expectations

Aim for a balanced mix across office desks, dining/breakfast tables, coffee tables, kitchen counters, study desks, vanities/bathroom counters, workbenches, outdoor/patio/picnic tables, and cafe/restaurant tables.

Target complexity distribution:

- `L1`: 25%, simple near view, 1-3 objects.
- `L2`: 50%, clear surface, 3-8 objects, light environment context.
- `L3`: 25%, local scene with more visible background and still-recognizable objects.

The script cannot prove visual suitability by itself. Use it to enforce traceability, resolution, source bans, duplicate URLs, obvious text/URL risks, and manifest completeness; then run human QA for scene-pair and complexity labels.
