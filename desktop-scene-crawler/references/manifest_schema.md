# Manifest Schema

The crawler writes `manifest.csv` and `manifest.jsonl` with one row per kept image.

## Fields

- `record_id`: Stable short hash of normalized source URL and image URL.
- `source_type`: `web` or `stock`.
- `source_platform`: `wikimedia`, `flickr`, `unsplash`, `pexels`, `pixabay`, `urls`, or a declared channel name.
- `source_url`: Original source page URL. Required for `source_type=web`.
- `normalized_source_url`: Canonicalized URL used for deduplication.
- `source_image_url`: Resolved image file URL used for download.
- `fetched_at`: UTC ISO timestamp.
- `query`: Search query or URL-list label.
- `title`: Source title when available.
- `author`: Author/owner when available.
- `license_type`: Normalized license label such as `cc-by`, `cc-by-sa`, `cc0`, `unsplash`, `pexels`, `pixabay`, `unknown`, `restricted`.
- `license_url`: License URL when available.
- `image_path`: Local downloaded image path.
- `width`, `height`, `short_edge`: Pixel dimensions after download.
- `scene_setting`: `indoor`, `outdoor`, `semi_outdoor`, or `unknown`.
- `complexity_level`: `L1`, `L2`, `L3`, or `unknown`.
- `risk_flag`: Empty for acceptable records; otherwise `possible_infringement`, `banned_dataset`, `ai_or_render`, `low_resolution`, `duplicate_source_url`, `download_failed`, `invalid_image`, or `needs_manual_review`.
- `notes`: Short human-readable audit note.

## Effective-Output Rule

A row counts as effective only when:

- `risk_flag` is empty.
- `license_type` is not `restricted`.
- `source_type=web` has an openable `source_url`.
- `short_edge >= 512`.
- A human QA pass confirms table/surface plus object(s), acceptable blur/watermark, and complexity label.
