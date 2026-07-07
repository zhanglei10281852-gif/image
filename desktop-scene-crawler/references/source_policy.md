# Source Policy

## Allowed

- Supplier-owned compliant stock resources. Mark `source_type=stock`; include a compliance statement in `notes`; `source_url` may be empty only for these records.
- Public web source pages that can be opened later: Wikimedia File pages, Flickr photo pages, Unsplash/Pexels/Pixabay photo pages, public blog/article/gallery pages, public social permalinks, public lifestyle/product context pages.
- Search engines only as discovery. Never save a search result thumbnail as the deliverable image.

## Required for web records

- `source_type=web`.
- Openable `source_url` for the original page, not a search results page.
- `fetched_at` timestamp.
- `source_platform`.
- `license_type`; use `restricted` or `unknown` when not clearly reusable. Records with `restricted` do not count as effective output under the provided spec.
- Downloaded image path plus width/height/short edge.

## Banned

- Academic/research datasets and mirrors: COCO, Open Images, ImageNet, Objectron, CO3D, ScanNet, Objaverse, benchmark datasets, Hugging Face dataset mirrors, Kaggle dataset mirrors if the image origin is not individually traceable.
- Bulk image packs with no source page.
- Private/login-only pages, follower-only posts, paid stock without purchased rights.
- AI-generated images, 3D renders, illustrations, obvious composites.
- White-background ecommerce SKU shots, pure screenshots, memes, floor plans, empty rooms, pure scenery, pure portraits, distant whole-room photos where the table/surface is not a clear local subject.

## Banned URL/Text Signals

Treat these as strong reject signals in URL, title, source page text, or metadata:

`coco`, `openimages`, `image-net`, `imagenet`, `objectron`, `co3d`, `scannet`, `objaverse`, `huggingface.co/datasets`, `kaggle.com/datasets`, `benchmark`, `midjourney`, `stable-diffusion`, `ai-generated`, `render`, `cgi`, `3d-render`, `white-background`, `product-packshot`, `floor-plan`.
