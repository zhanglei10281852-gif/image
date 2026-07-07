#!/usr/bin/env python3
"""Collect traceable tabletop-scene photo candidates and write QA manifests."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import mimetypes
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, parse_qsl, quote, urlencode, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from PIL import Image, UnidentifiedImageError


USER_AGENT = (
    "desktop-scene-crawler/1.0 "
    "(traceable tabletop scene collection; contact: local research workflow)"
)
DEFAULT_TIMEOUT = 30
MIN_SHORT_EDGE = 512

BANNED_PATTERNS = [
    r"\bcoco\b",
    r"open[-_ ]?images?",
    r"image[-_ ]?net|imagenet",
    r"objectron",
    r"\bco3d\b",
    r"scannet",
    r"objaverse",
    r"huggingface\.co/datasets",
    r"kaggle\.com/datasets",
    r"benchmark",
]

AI_RENDER_PATTERNS = [
    r"midjourney",
    r"stable[-_ ]?diffusion",
    r"ai[-_ ]?generated",
    r"\brender(ed|ing)?\b",
    r"\bcgi\b",
    r"3d[-_ ]?render",
    r"second\s*life",
    r"\bslurl\b",
    r"\bavatar\b",
    r"\bvirtual\b",
    r"\bsims?\b",
    r"\bimvu\b",
    r"\banime\b",
    r"\bcartoon\b",
    r"\billustration\b",
    r"digital\s+art",
    r"thank you to my sponsors",
    r"flickr\.com/photos/cleopatraclyalin",
    r"flickr\.com/photos/141893679@N05",
]

PRODUCT_SHOT_PATTERNS = [
    r"white[-_ ]?background",
    r"packshot",
    r"product[-_ ]?shot",
    r"sku",
    r"floor[-_ ]?plan",
    r"screenshot",
    r"\bmeme\b",
]

OUTDOOR_SCENE_PATTERNS = [
    r"outdoor",
    r"patio",
    r"terrace",
    r"garden",
    r"picnic",
    r"camp(ing)?",
    r"balcony",
    r"courtyard",
    r"露台",
    r"户外",
    r"野餐",
    r"露营",
    r"庭院",
]

SEMI_OUTDOOR_SCENE_PATTERNS = [
    r"semi[-_ ]?outdoor",
    r"balcony",
    r"porch",
    r"veranda",
    r"cafe",
    r"restaurant terrace",
    r"阳台",
    r"半户外",
    r"外摆",
    r"咖啡厅",
]

INDOOR_SCENE_PATTERNS = [
    r"desk",
    r"workspace",
    r"home office",
    r"study",
    r"kitchen",
    r"counter(top)?",
    r"dining",
    r"coffee table",
    r"vanity",
    r"nightstand",
    r"workbench",
    r"书桌",
    r"办公",
    r"工位",
    r"学习桌",
    r"厨房",
    r"餐桌",
    r"茶几",
    r"梳妆台",
    r"床头柜",
]

CHINESE_WEB_DOMAINS = [
    "douban.com",
    "lofter.com",
    "zhihu.com",
    "jianshu.com",
    "duitang.com",
    "tuchong.com",
    "zcool.com.cn",
    "meipian.cn",
    "sohu.com",
    "163.com",
    "smzdm.com",
    "xiachufang.com",
    "thepaper.cn",
    "toutiao.com",
    "bilibili.com",
]

TRACKING_QUERY_PREFIXES = ("utm_",)
TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "spm",
    "ref",
    "ref_src",
}


@dataclass
class Candidate:
    source_type: str
    source_platform: str
    source_url: str
    source_image_url: str
    query: str = ""
    title: str = ""
    author: str = ""
    license_type: str = "unknown"
    license_url: str = ""
    notes: str = ""


@dataclass
class ManifestRow:
    record_id: str
    source_type: str
    source_platform: str
    source_url: str
    normalized_source_url: str
    source_image_url: str
    fetched_at: str
    query: str
    title: str
    author: str
    license_type: str
    license_url: str
    image_path: str
    width: int
    height: int
    short_edge: int
    scene_setting: str
    complexity_level: str
    risk_flag: str
    notes: str


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_url(url: str) -> str:
    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "https").lower()
    netloc = parsed.netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    path = re.sub(r"/+$", "", parsed.path or "/")
    query_pairs = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        lk = key.lower()
        if lk in TRACKING_QUERY_KEYS or any(lk.startswith(prefix) for prefix in TRACKING_QUERY_PREFIXES):
            continue
        query_pairs.append((key, value))
    query = urlencode(sorted(query_pairs), doseq=True)
    return urlunparse((scheme, netloc, path, "", query, ""))


def short_hash(*parts: str) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part.encode("utf-8", errors="ignore"))
        h.update(b"\0")
    return h.hexdigest()[:16]


def text_has(patterns: Sequence[str], *values: str) -> bool:
    haystack = " ".join(v or "" for v in values).lower()
    return any(re.search(pattern, haystack, flags=re.IGNORECASE) for pattern in patterns)


def infer_risk(candidate: Candidate) -> Tuple[str, str]:
    values = [candidate.source_url, candidate.source_image_url, candidate.title, candidate.notes]
    if candidate.source_platform == "urls" and normalize_url(candidate.source_url) == normalize_url(candidate.source_image_url):
        return "needs_manual_review", "Direct image URL needs an original source page before it can count"
    if text_has(BANNED_PATTERNS, *values):
        return "banned_dataset", "URL/title matched banned academic dataset signals"
    if text_has(AI_RENDER_PATTERNS, *values):
        return "ai_or_render", "URL/title matched AI or render signals"
    if text_has(PRODUCT_SHOT_PATTERNS, *values):
        return "needs_manual_review", "URL/title matched product/screenshot/floor-plan risk signals"
    if candidate.license_type in {"restricted"}:
        return "possible_infringement", "License is restricted"
    return "", ""


def infer_scene_setting(candidate: Candidate) -> str:
    values = [candidate.query, candidate.title, candidate.source_url, candidate.notes]
    if text_has(SEMI_OUTDOOR_SCENE_PATTERNS, *values):
        return "semi_outdoor"
    if text_has(OUTDOOR_SCENE_PATTERNS, *values):
        return "outdoor"
    if text_has(INDOOR_SCENE_PATTERNS, *values):
        return "indoor"
    return "unknown"


def request_json(session: requests.Session, url: str, *, params=None, headers=None) -> dict:
    for attempt in range(5):
        resp = session.get(url, params=params, headers=headers, timeout=DEFAULT_TIMEOUT)
        if resp.status_code in {429, 500, 502, 503, 504} and attempt < 4:
            retry_after = parse_int(resp.headers.get("Retry-After"))
            delay = retry_after if retry_after > 0 else min(90, 5 * (2 ** attempt))
            time.sleep(delay)
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("unreachable request retry state")


def request_text(session: requests.Session, url: str, *, params=None, headers=None) -> str:
    for attempt in range(5):
        resp = session.get(url, params=params, headers=headers, timeout=DEFAULT_TIMEOUT)
        if resp.status_code in {429, 500, 502, 503, 504} and attempt < 4:
            retry_after = parse_int(resp.headers.get("Retry-After"))
            delay = retry_after if retry_after > 0 else min(120, 10 * (2 ** attempt))
            time.sleep(delay)
            continue
        resp.raise_for_status()
        return resp.text
    raise RuntimeError("unreachable text request retry state")


def provider_wikimedia(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    api = "https://commons.wikimedia.org/w/api.php"
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": f'{query} filetype:bitmap',
        "gsrnamespace": 6,
        "gsrlimit": min(limit, 50),
        "prop": "imageinfo|info",
        "iiprop": "url|size|mime|extmetadata|user",
        "inprop": "url",
        "format": "json",
        "formatversion": 2,
    }
    emitted = 0
    while emitted < limit:
        params["gsrlimit"] = min(limit - emitted, 50)
        data = request_json(session, api, params=params)
        for page in data.get("query", {}).get("pages", []):
            imageinfo = (page.get("imageinfo") or [{}])[0]
            image_url = imageinfo.get("url", "")
            mime = imageinfo.get("mime", "")
            if not image_url or not mime.startswith("image/"):
                continue
            meta = imageinfo.get("extmetadata") or {}
            license_short = (meta.get("LicenseShortName") or {}).get("value", "unknown")
            license_url = (meta.get("LicenseUrl") or {}).get("value", "")
            artist = strip_html((meta.get("Artist") or {}).get("value", "")) or imageinfo.get("user", "")
            emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="wikimedia",
                source_url=page.get("fullurl", ""),
                source_image_url=image_url,
                query=query,
                title=page.get("title", ""),
                author=artist,
                license_type=normalize_license(license_short),
                license_url=license_url,
            )
            if emitted >= limit:
                break
        continuation = data.get("continue")
        if not continuation:
            break
        params.update(continuation)


def provider_flickr(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    api_key = os.environ.get("FLICKR_API_KEY")
    if not api_key:
        raise SystemExit("FLICKR_API_KEY is required for provider=flickr")
    params = {
        "method": "flickr.photos.search",
        "api_key": api_key,
        "text": query,
        "media": "photos",
        "content_type": 1,
        "safe_search": 1,
        "license": "1,2,3,4,5,6,7,9,10",
        "extras": "url_o,url_l,url_c,license,owner_name,description",
        "per_page": min(limit, 250),
        "format": "json",
        "nojsoncallback": 1,
    }
    data = request_json(session, "https://www.flickr.com/services/rest/", params=params)
    for photo in data.get("photos", {}).get("photo", []):
        image_url = photo.get("url_o") or photo.get("url_l") or photo.get("url_c")
        if not image_url:
            continue
        source_url = f"https://www.flickr.com/photos/{photo.get('owner')}/{photo.get('id')}"
        yield Candidate(
            source_type="web",
            source_platform="flickr",
            source_url=source_url,
            source_image_url=image_url,
            query=query,
            title=photo.get("title", ""),
            author=photo.get("ownername", ""),
            license_type=f"flickr-license-{photo.get('license', 'unknown')}",
            notes=strip_html((photo.get("description") or {}).get("_content", ""))[:300],
        )


def flickr_license_label(license_id: str) -> str:
    return {
        "4": "cc-by-2.0",
        "5": "cc-by-sa-2.0",
        "7": "no-known-copyright-restrictions",
        "9": "cc0",
        "10": "public-domain",
    }.get(str(license_id), "restricted")


def clean_flickr_text(value: str) -> str:
    value = html.unescape(value or "")
    value = value.replace("\\/", "/")
    value = value.replace('\\"', '"')
    return strip_html(value)


def provider_flickr_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    search_url = "https://www.flickr.com/search/"
    emitted = 0
    seen_ids: set[str] = set()
    page = 1
    while emitted < limit and page <= 20:
        params = {
            "text": query,
            "media": "photos",
            "license": "4,5,7,9,10",
            "page": page,
        }
        page_text = request_text(session, search_url, params=params, headers={"User-Agent": "Mozilla/5.0"})
        page_text = page_text.replace("\\/", "/")
        blocks = re.findall(
            r'"_flickrModelRegistry":"photo-lite-models".*?"exportMetaType":"model"',
            page_text,
            flags=re.DOTALL,
        )
        if not blocks:
            break
        page_emitted = 0
        for block in blocks:
            if emitted >= limit:
                break
            id_matches = re.findall(r'"id":"(\d{6,})"', block)
            if not id_matches:
                continue
            photo_id = id_matches[-1]
            if photo_id in seen_ids:
                continue
            seen_ids.add(photo_id)

            license_match = re.search(r'"license":(\d+)', block)
            license_id = license_match.group(1) if license_match else ""
            license_type = flickr_license_label(license_id)
            if license_type == "restricted":
                continue

            sized_urls: list[tuple[int, str]] = []
            for width, height, url in re.findall(r'"width":(\d+),"height":(\d+),"url":"(//live\.staticflickr\.com/[^"]+)"', block):
                score = parse_int(width) * parse_int(height)
                if score <= 0:
                    continue
                sized_urls.append((score, "https:" + html.unescape(url)))
            if not sized_urls:
                continue
            sized_urls.sort(reverse=True)
            image_url = sized_urls[0][1]
            if re.search(r"_[sqtmn]\.", image_url):
                continue

            path_alias_match = re.search(r'"pathAlias":"([^"]*)"', block)
            owner_match = re.search(r'"ownerNsid":"([^"]+)"', block)
            owner = path_alias_match.group(1) if path_alias_match and path_alias_match.group(1) else (owner_match.group(1) if owner_match else "")
            if not owner:
                continue
            source_url = f"https://www.flickr.com/photos/{owner}/{photo_id}"

            title_match = re.search(r'"title":"(.*?)"', block, flags=re.DOTALL)
            username_match = re.search(r'"username":"(.*?)"', block, flags=re.DOTALL)
            realname_match = re.search(r'"realname":"(.*?)"', block, flags=re.DOTALL)
            description_match = re.search(r'"description":"(.*?)"', block, flags=re.DOTALL)
            author = clean_flickr_text(realname_match.group(1) if realname_match and realname_match.group(1) else (username_match.group(1) if username_match else ""))

            emitted += 1
            page_emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="flickr_web",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=clean_flickr_text(title_match.group(1) if title_match else ""),
                author=author,
                license_type=license_type,
                license_url="https://www.flickr.com/creativecommons/",
                notes=clean_flickr_text(description_match.group(1) if description_match else "")[:300],
            )
        if page_emitted == 0:
            break
        page += 1


def decode_duckduckgo_url(url: str) -> str:
    if url.startswith("//"):
        url = "https:" + url
    parsed = urlparse(url)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        uddg = parse_qs(parsed.query).get("uddg", [""])[0]
        return uddg or url
    return url


def provider_duckduckgo_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_urls: set[str] = set()
    offset = 0
    while emitted < limit and offset <= 450:
        params = {"q": query, "s": str(offset)}
        page_text = request_text(session, "https://html.duckduckgo.com/html/", params=params, headers={"User-Agent": "Mozilla/5.0"})
        soup = BeautifulSoup(page_text, "html.parser")
        links = [decode_duckduckgo_url(a.get("href", "")) for a in soup.select("a.result__a")]
        links = [link for link in links if link.startswith(("http://", "https://"))]
        if not links:
            break
        page_emitted = 0
        for source_url in links:
            if emitted >= limit:
                break
            normalized = normalize_url(source_url)
            if normalized in seen_urls:
                continue
            seen_urls.add(normalized)
            domain = urlparse(source_url).netloc.lower().removeprefix("www.")
            if not any(domain == allowed or domain.endswith("." + allowed) for allowed in CHINESE_WEB_DOMAINS):
                continue
            try:
                candidate = candidate_from_url(session, source_url)
            except Exception:
                continue
            if not candidate.source_image_url:
                continue
            candidate.source_platform = f"duckduckgo:{domain}"
            candidate.query = query
            if candidate.license_type == "restricted":
                candidate.license_type = "unknown"
            candidate.notes = "; ".join(x for x in [candidate.notes, "public source page discovered via DuckDuckGo; image extracted from original source page; license not explicitly stated"] if x)
            emitted += 1
            page_emitted += 1
            yield candidate
        if page_emitted == 0 and offset > 120:
            break
        offset += 30


def provider_pxhere_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    page = 1
    while emitted < limit and page <= 25:
        search_text = request_text(
            session,
            "https://pxhere.com/en/photos",
            params={"q": query, "page": page},
            headers={"User-Agent": "Mozilla/5.0"},
        )
        links = []
        for link in re.findall(r'href="(/en/photo/\d+)"', search_text):
            source_url = requests.compat.urljoin("https://pxhere.com", link)
            if source_url not in seen_pages:
                seen_pages.add(source_url)
                links.append(source_url)
        if not links:
            break
        page_emitted = 0
        for source_url in links:
            if emitted >= limit:
                break
            try:
                page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
            except requests.RequestException:
                continue
            soup = BeautifulSoup(page_text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            image_url = ""
            download_url = ""
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if href.startswith("https://get.pxhere.com/photo/") and href.lower().endswith((".jpg", ".jpeg", ".png")):
                    download_url = href
                    break
            if download_url:
                image_url = download_url
            if not image_url:
                meta = soup.select_one('meta[property="og:image"]') or soup.select_one('meta[name="twitter:image"]')
                if meta and meta.get("content"):
                    image_url = meta["content"].strip()
            if not image_url:
                continue
            author = ""
            author_link = soup.select_one('a[href^="/en/photographer/"]')
            if author_link:
                author = author_link.get_text(" ", strip=True)
            emitted += 1
            page_emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="pxhere",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=title,
                author=author,
                license_type="cc0",
                license_url="https://pxhere.com/en/license",
                notes="PxHere public photo page; download URL extracted from original source page",
            )
        if page_emitted == 0:
            break
        page += 1


def provider_foodiesfeed_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-") or "table"
    search_urls = [
        f"https://www.foodiesfeed.com/s/{quote(slug)}",
        f"https://www.foodiesfeed.com/ja/s/{quote(slug)}",
    ]
    for search_url in search_urls:
        if emitted >= limit:
            break
        try:
            search_text = request_text(session, search_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        links: list[str] = []
        for match in re.findall(r'/(?:ja/)?free-food-photo/[^"\'<>\\\s]+', search_text):
            source_url = requests.compat.urljoin("https://www.foodiesfeed.com", match)
            if source_url not in seen_pages:
                seen_pages.add(source_url)
                links.append(source_url)
        for source_url in links:
            if emitted >= limit:
                break
            try:
                page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
            except requests.RequestException:
                continue
            soup = BeautifulSoup(page_text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            image_url = ""
            meta = soup.select_one('meta[property="og:image"]') or soup.select_one('meta[name="twitter:image"]')
            if meta and meta.get("content"):
                image_url = meta["content"].strip()
            if not image_url or "/generated/thumbnails/" in image_url:
                masters = re.findall(r'https?://[^"\'<>\\\s]+/generated/masters/[^"\'<>\\\s]+\.(?:jpg|jpeg|png|webp)', page_text)
                image_url = masters[0] if masters else ""
            if not image_url:
                continue
            emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="foodiesfeed",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=title,
                author="Foodiesfeed",
                license_type="cc0",
                license_url="https://www.foodiesfeed.com/",
                notes="Foodiesfeed public photo page; master image URL extracted from original source page",
            )


def provider_libreshot_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    page = 1
    while emitted < limit and page <= 6:
        try:
            search_text = request_text(
                session,
                "https://libreshot.com/",
                params={"s": query, "paged": page} if page > 1 else {"s": query},
                headers={"User-Agent": "Mozilla/5.0"},
            )
        except requests.RequestException:
            break
        links: list[str] = []
        soup = BeautifulSoup(search_text, "html.parser")
        raw_hrefs = [a["href"] for a in soup.find_all("a", href=True)]
        raw_hrefs.extend(re.findall(r'"url"\s*:\s*"(https://libreshot\.com/[^"]+/)"', search_text))
        for href in raw_hrefs:
            if any(skip in href for skip in ["/free-images/", "/free-stock-images-categories/", "/about-libreshot/", "/license-information/"]):
                continue
            if not re.match(r"https://libreshot\.com/[^/?#]+/$", href):
                continue
            if href not in seen_pages:
                seen_pages.add(href)
                links.append(href)
        if not links:
            break
        page_emitted = 0
        for source_url in links:
            if emitted >= limit:
                break
            try:
                page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
            except requests.RequestException:
                continue
            soup = BeautifulSoup(page_text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            image_url = ""
            for a in soup.find_all("a", href=True):
                href = a["href"]
                label = a.get_text(" ", strip=True).lower()
                if "full size" in label and re.search(r"\.(?:jpg|jpeg|png|webp)$", href, re.IGNORECASE):
                    image_url = href
                    break
            if not image_url:
                candidates = re.findall(r'https://libreshot\.com/wp-content/uploads/[^"\'<>\\\s]+\.(?:jpg|jpeg|png|webp)', page_text)
                full_size = [
                    url for url in candidates
                    if not re.search(r"-\d+x\d+\.", url)
                    and "cropped-" not in url
                    and "Green-Minimalist" not in url
                ]
                image_url = full_size[0] if full_size else ""
            if not image_url:
                continue
            emitted += 1
            page_emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="libreshot",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=title,
                author="LibreShot",
                license_type="libreshot-free",
                license_url="https://libreshot.com/license-information/",
                notes="LibreShot public photo page; full-size download URL extracted from original source page",
            )
        if page_emitted == 0:
            break
        page += 1


def provider_freeimages_uk_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    gallery_urls = [
        "https://www.freeimages.co.uk/galleries/home/diningroom/index.htm",
        "https://www.freeimages.co.uk/galleries/home/kitchen/index.htm",
        "https://www.freeimages.co.uk/galleries/home/office/index.htm",
        "https://www.freeimages.co.uk/galleries/food/index.htm",
    ]
    query_terms = [term for term in re.split(r"[^a-z0-9]+", query.lower()) if len(term) >= 3]
    emitted = 0
    seen_pages: set[str] = set()
    for gallery_url in gallery_urls:
        if emitted >= limit:
            break
        try:
            index_text = request_text(session, gallery_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        index_soup = BeautifulSoup(index_text, "html.parser")
        links: list[tuple[str, str]] = []
        for a in index_soup.find_all("a", href=True):
            href = a["href"]
            if "slides/" not in href or not href.endswith(".htm"):
                continue
            source_url = requests.compat.urljoin(gallery_url, href)
            label = " ".join([a.get_text(" ", strip=True), href]).lower()
            if query_terms and not any(term in label for term in query_terms):
                # Keep broad tabletop categories, but do not wander into unrelated appliance-only pages.
                broad_terms = ["table", "plate", "cup", "food", "dining", "kitchen", "desk", "office", "cutlery", "breakfast"]
                if not any(term in label for term in broad_terms):
                    continue
            if source_url not in seen_pages:
                seen_pages.add(source_url)
                links.append((source_url, label))
        for source_url, label in links:
            if emitted >= limit:
                break
            try:
                page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
            except requests.RequestException:
                continue
            soup = BeautifulSoup(page_text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            image_url = ""
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if "pics/" in href and re.search(r"\.(?:jpg|jpeg|png)$", href, re.IGNORECASE):
                    image_url = requests.compat.urljoin(source_url, href)
                    break
            if not image_url:
                pics = re.findall(r'https?://(?:www\.)?freeimageslive\.com/[^"\'<>\\\s]+/pics/[^"\'<>\\\s]+\.(?:jpg|jpeg|png)', page_text)
                image_url = pics[0] if pics else ""
            if not image_url:
                continue
            emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="freeimages_uk",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=title,
                author="FreeImages.co.uk",
                license_type="freeimages-uk-free",
                license_url="https://www.freeimages.co.uk/terms.htm",
                notes="FreeImages.co.uk public gallery page; full-size pics URL extracted from original source page",
            )


def provider_picjumbo_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    search_urls = [
        f"https://picjumbo.com/search/{quote(query)}",
        f"https://picjumbo.com/free-photos/{quote(query.split()[0] if query.split() else 'table')}/",
    ]
    for search_url in search_urls:
        if emitted >= limit:
            break
        try:
            search_text = request_text(session, search_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        soup = BeautifulSoup(search_text, "html.parser")
        links: list[str] = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if not href.startswith("https://picjumbo.com/"):
                continue
            if any(skip in href for skip in ["/premium", "/free-images/", "/free-photos/", "/search/", "/wp-content/", "#", "/page/", "/resources", "/about-", "/faq", "/news", "/download"]):
                continue
            if not re.match(r"https://picjumbo\.com/[^/?#]+/$", href):
                continue
            if href not in seen_pages:
                seen_pages.add(href)
                links.append(href)
        for source_url in links:
            if emitted >= limit:
                break
            try:
                page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
            except requests.RequestException:
                continue
            soup = BeautifulSoup(page_text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            image_url = ""
            meta = soup.select_one('meta[property="og:image"]')
            if meta and meta.get("content"):
                image_url = html.unescape(meta["content"].strip())
            if not image_url or "istockphoto.com" in image_url:
                continue
            emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="picjumbo",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=title,
                author="picjumbo",
                license_type="picjumbo-free",
                license_url="https://picjumbo.com/faq-and-terms/",
                notes="picjumbo public photo page; large og:image URL extracted from original source page",
            )


def provider_isorepublic_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    page = 1
    while emitted < limit and page <= 5:
        try:
            search_text = request_text(
                session,
                "https://isorepublic.com/",
                params={"s": query, "paged": page} if page > 1 else {"s": query},
                headers={"User-Agent": "Mozilla/5.0"},
            )
        except requests.RequestException:
            break
        soup = BeautifulSoup(search_text, "html.parser")
        links: list[str] = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if re.match(r"https://isorepublic\.com/photo/[^/?#]+/$", href) and href not in seen_pages:
                seen_pages.add(href)
                links.append(href)
        if not links:
            break
        page_emitted = 0
        for source_url in links:
            if emitted >= limit:
                break
            try:
                page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
            except requests.RequestException:
                continue
            soup = BeautifulSoup(page_text, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            image_url = ""
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if "wp-content/uploads" in href and re.search(r"\.(?:jpg|jpeg|png|webp)$", href, re.IGNORECASE):
                    image_url = href
                    break
            if not image_url:
                meta = soup.select_one('meta[property="og:image"]')
                image_url = meta["content"].strip() if meta and meta.get("content") else ""
            if not image_url:
                continue
            emitted += 1
            page_emitted += 1
            yield Candidate(
                source_type="web",
                source_platform="isorepublic",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=title,
                author="ISO Republic",
                license_type="cc0",
                license_url="https://isorepublic.com/license/",
                notes="ISO Republic public photo page; download image URL extracted from original source page",
            )
        if page_emitted == 0:
            break
        page += 1


def provider_simple_stock_web(
    session: requests.Session,
    query: str,
    limit: int,
    *,
    platform: str,
    search_url: str,
    page_rx: str,
    license_type: str,
    license_url: str,
    author: str,
) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    try:
        search_text = request_text(session, search_url, headers={"User-Agent": "Mozilla/5.0"})
    except requests.RequestException:
        return
    soup = BeautifulSoup(search_text, "html.parser")
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if re.match(page_rx, href) and href not in seen_pages:
            seen_pages.add(href)
            links.append(href)
    for source_url in links:
        if emitted >= limit:
            break
        try:
            page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        soup = BeautifulSoup(page_text, "html.parser")
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        image_url = ""
        for a in soup.find_all("a", href=True):
            label = a.get_text(" ", strip=True).lower()
            href = a["href"]
            if "download" in label and re.search(r"\.(?:jpg|jpeg|png|webp)$", href, re.IGNORECASE):
                image_url = href
                break
        if not image_url:
            meta = soup.select_one('meta[property="og:image"]') or soup.select_one('meta[name="twitter:image"]')
            image_url = meta["content"].strip() if meta and meta.get("content") else ""
        if not image_url:
            continue
        emitted += 1
        yield Candidate(
            source_type="web",
            source_platform=platform,
            source_url=source_url,
            source_image_url=image_url,
            query=query,
            title=title,
            author=author,
            license_type=license_type,
            license_url=license_url,
            notes=f"{author} public photo page; image URL extracted from original source page",
        )


def provider_negativespace_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    return provider_simple_stock_web(
        session,
        query,
        limit,
        platform="negativespace",
        search_url=f"https://negativespace.co/?s={quote(query)}",
        page_rx=r"https://negativespace\.co/[^/?#]+/$",
        license_type="cc0",
        license_url="https://negativespace.co/license/",
        author="NegativeSpace",
    )


def provider_picography_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    return provider_simple_stock_web(
        session,
        query,
        limit,
        platform="picography",
        search_url=f"https://picography.co/search/{quote(query)}",
        page_rx=r"https://picography\.co/[^/?#]+/$",
        license_type="picography-free",
        license_url="https://picography.co/terms/",
        author="Picography",
    )


def provider_freestocks_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    return provider_simple_stock_web(
        session,
        query,
        limit,
        platform="freestocks",
        search_url=f"https://freestocks.org/search/{quote(query)}?cat=",
        page_rx=r"https://freestocks\.org/photo/[^/?#]+/$",
        license_type="freestocks-free",
        license_url="https://freestocks.org/terms-of-use/",
        author="freestocks.org",
    )


def provider_startupstockphotos_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    links: list[str] = []

    for page in range(1, 5):
        try:
            data = request_json(
                session,
                "https://startupstockphotos.com/wp-json/wp/v2/posts",
                params={"per_page": min(50, max(10, limit)), "search": query, "page": page},
                headers={"User-Agent": "Mozilla/5.0"},
            )
        except requests.RequestException:
            break
        if not data:
            break
        for item in data:
            href = item.get("link") or ""
            if re.match(r"https://startupstockphotos\.com/photos/[^/?#]+/$", href) and href not in seen_pages:
                seen_pages.add(href)
                links.append(href)
        if len(data) < min(50, max(10, limit)):
            break

    for search_url in [f"https://startupstockphotos.com/search/{quote(query)}/", "https://startupstockphotos.com/"]:
        try:
            search_text = request_text(session, search_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        for href in re.findall(r'https://startupstockphotos\.com/photos/[^"\'<>\s]+/', search_text):
            if href not in seen_pages:
                seen_pages.add(href)
                links.append(href)

    for source_url in links:
        if emitted >= limit:
            break
        try:
            page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        soup = BeautifulSoup(page_text, "html.parser")
        title = ""
        meta_title = soup.select_one('meta[property="og:title"]')
        if meta_title and meta_title.get("content"):
            title = html.unescape(meta_title["content"].strip())
        if not title and soup.title and soup.title.string:
            title = soup.title.string.strip()

        image_url = ""
        content_match = re.search(r'"contentUrl"\s*:\s*"(https://startupstockphotos\.com/wp-content/uploads/[^"]+\.jpe?g)"', page_text)
        if content_match:
            image_url = html.unescape(content_match.group(1))
        if not image_url:
            download = soup.select_one("a.download[href]")
            image_url = download["href"].strip() if download else ""
        if not image_url:
            meta = soup.select_one('meta[property="og:image"]')
            image_url = meta["content"].strip() if meta and meta.get("content") else ""
        if not image_url or "istockphoto" in image_url:
            continue

        emitted += 1
        yield Candidate(
            source_type="web",
            source_platform="startupstockphotos",
            source_url=source_url,
            source_image_url=image_url,
            query=query,
            title=strip_html(title),
            author="Startup Stock Photos",
            license_type="cc0",
            license_url="https://startupstockphotos.com/terms/",
            notes="Startup Stock Photos public photo page; full-size contentUrl/download URL extracted from original source page",
        )


def provider_skitterphoto_web(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    emitted = 0
    seen_pages: set[str] = set()
    category_map = {
        "food": "food",
        "dining": "food",
        "table": "food",
        "plate": "food",
        "coffee": "food",
        "desk": "technology",
        "laptop": "technology",
        "computer": "technology",
        "keyboard": "technology",
        "workbench": "industry",
        "tools": "industry",
    }
    categories = []
    lowered_query = query.lower()
    for word, category in category_map.items():
        if word in lowered_query and category not in categories:
            categories.append(category)
    categories.extend(c for c in ["food", "technology", "business-finance", "industry"] if c not in categories)

    search_urls = [f"https://skitterphoto.com/photos/search/{quote(query)}"]
    search_urls.extend(f"https://skitterphoto.com/photos/categories/{category}" for category in categories[:4])
    links: list[str] = []
    for search_url in search_urls:
        if len(links) >= max(limit * 3, limit):
            break
        try:
            search_text = request_text(session, search_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        for href in re.findall(r"https://skitterphoto\.com/photos/\d+/[^\"'<>\\s]+", search_text):
            href = href.rstrip("/")
            if href not in seen_pages:
                seen_pages.add(href)
                links.append(href)

    for source_url in links:
        if emitted >= limit:
            break
        try:
            page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        soup = BeautifulSoup(page_text, "html.parser")
        title = ""
        meta_title = soup.select_one('meta[property="og:title"]')
        if meta_title and meta_title.get("content"):
            title = html.unescape(meta_title["content"].strip())
        if not title and soup.title and soup.title.string:
            title = soup.title.string.strip()
        image_url = ""
        meta = soup.select_one('meta[property="og:image"]')
        if meta and meta.get("content"):
            image_url = html.unescape(meta["content"].strip())
        if not image_url:
            img = soup.select_one("figure.photo img[data-src]")
            image_url = img["data-src"].strip() if img else ""
        if not image_url or "thumbnail" in image_url.lower() or "avatar" in image_url.lower():
            continue
        author = ""
        author_meta = soup.select_one('meta[itemprop="name"]')
        if author_meta and author_meta.get("content"):
            author = author_meta["content"].strip()
        emitted += 1
        yield Candidate(
            source_type="web",
            source_platform="skitterphoto",
            source_url=source_url,
            source_image_url=image_url,
            query=query,
            title=strip_html(title),
            author=author or "Skitterphoto",
            license_type="cc0",
            license_url="https://skitterphoto.com/license",
            notes="Skitterphoto public photo page; full-size default image URL extracted from original source page",
        )


def provider_openverse(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    api = "https://api.openverse.org/v1/images/"
    emitted = 0
    page = 1
    while emitted < limit:
        params = {
            "q": query,
            "page_size": min(limit - emitted, 50),
            "page": page,
            "license_type": "commercial,modification",
        }
        data = request_json(session, api, params=params)
        results = data.get("results") or []
        if not results:
            break
        for item in results:
            image_url = item.get("url") or ""
            source_url = item.get("foreign_landing_url") or ""
            if not image_url or not source_url:
                continue
            provider = item.get("provider") or item.get("source") or "openverse"
            license_code = item.get("license") or "unknown"
            license_version = item.get("license_version") or ""
            emitted += 1
            yield Candidate(
                source_type="web",
                source_platform=f"openverse:{provider}",
                source_url=source_url,
                source_image_url=image_url,
                query=query,
                title=item.get("title") or "",
                author=item.get("creator") or "",
                license_type=normalize_openverse_license(license_code, license_version),
                license_url=item.get("license_url") or "",
                notes=f"openverse_id={item.get('id', '')}",
            )
            if emitted >= limit:
                break
        if not data.get("next"):
            break
        page += 1


def provider_unsplash(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    access_key = os.environ.get("UNSPLASH_ACCESS_KEY")
    if not access_key:
        raise SystemExit("UNSPLASH_ACCESS_KEY is required for provider=unsplash")
    headers = {"Authorization": f"Client-ID {access_key}"}
    params = {"query": query, "per_page": min(limit, 30), "content_filter": "high"}
    data = request_json(session, "https://api.unsplash.com/search/photos", params=params, headers=headers)
    for photo in data.get("results", []):
        links = photo.get("links") or {}
        urls = photo.get("urls") or {}
        download_location = links.get("download_location")
        if download_location:
            try:
                session.get(download_location, headers=headers, timeout=DEFAULT_TIMEOUT).raise_for_status()
            except requests.RequestException:
                pass
        yield Candidate(
            source_type="web",
            source_platform="unsplash",
            source_url=links.get("html", ""),
            source_image_url=urls.get("raw") or urls.get("full") or urls.get("regular", ""),
            query=query,
            title=photo.get("description") or photo.get("alt_description") or "",
            author=((photo.get("user") or {}).get("name") or ""),
            license_type="unsplash",
            license_url="https://unsplash.com/license",
        )


def provider_pexels(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    api_key = os.environ.get("PEXELS_API_KEY")
    if not api_key:
        raise SystemExit("PEXELS_API_KEY is required for provider=pexels")
    headers = {"Authorization": api_key}
    params = {"query": query, "per_page": min(limit, 80)}
    data = request_json(session, "https://api.pexels.com/v1/search", params=params, headers=headers)
    for photo in data.get("photos", []):
        src = photo.get("src") or {}
        yield Candidate(
            source_type="web",
            source_platform="pexels",
            source_url=photo.get("url", ""),
            source_image_url=src.get("original") or src.get("large2x") or src.get("large", ""),
            query=query,
            title=photo.get("alt", ""),
            author=photo.get("photographer", ""),
            license_type="pexels",
            license_url="https://www.pexels.com/license/",
        )


def provider_pixabay(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    api_key = os.environ.get("PIXABAY_API_KEY")
    if not api_key:
        raise SystemExit("PIXABAY_API_KEY is required for provider=pixabay")
    params = {
        "key": api_key,
        "q": query,
        "image_type": "photo",
        "safesearch": "true",
        "per_page": min(limit, 200),
    }
    data = request_json(session, "https://pixabay.com/api/", params=params)
    for hit in data.get("hits", []):
        yield Candidate(
            source_type="web",
            source_platform="pixabay",
            source_url=hit.get("pageURL", ""),
            source_image_url=hit.get("largeImageURL") or hit.get("webformatURL", ""),
            query=query,
            title=hit.get("tags", ""),
            author=hit.get("user", ""),
            license_type="pixabay",
            license_url="https://pixabay.com/service/license-summary/",
        )


def provider_shopify_burst(session: requests.Session, query: str, limit: int) -> Iterator[Candidate]:
    search_url = "https://www.shopify.com/stock-photos/photos/search"
    params = {"utf8": "✓", "q": query}
    search_text = request_text(session, search_url, params=params, headers={"User-Agent": "Mozilla/5.0"})
    links = re.findall(r'href="(/stock-photos/photos/[^"]+)"', search_text)
    seen_links = set()
    emitted = 0
    for raw_link in links:
        if emitted >= limit:
            break
        link = html.unescape(raw_link)
        if "/stock-photos/photos/search" in link:
            continue
        source_url = requests.compat.urljoin("https://www.shopify.com", link).split("?")[0]
        if source_url in seen_links:
            continue
        seen_links.add(source_url)
        try:
            page_text = request_text(session, source_url, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException:
            continue
        slug = Path(urlparse(source_url).path).name
        image_url = extract_burst_download_url(page_text, slug)
        if not image_url:
            continue
        title_match = re.search(r'<meta property="og:title" content="([^"]+)"', page_text)
        title = html.unescape(title_match.group(1)) if title_match else Path(urlparse(source_url).path).name.replace("-", " ")
        emitted += 1
        yield Candidate(
            source_type="web",
            source_platform="shopify_burst",
            source_url=source_url,
            source_image_url=image_url,
            query=query,
            title=strip_html(title),
            author="Shopify Burst",
            license_type="shopify-burst",
            license_url="https://www.shopify.com/stock-photos/legal/license",
        )


def extract_burst_download_url(page_text: str, slug: str) -> str:
    candidates = [
        html.unescape(x).replace("\\u0026", "&").rstrip(");,")
        for x in re.findall(r'https://burst\.shopifycdn\.com/photos/[^"\'<\\ ]+', page_text)
    ]
    matching = [url for url in candidates if f"/{slug}.jpg" in url]
    for url in matching:
        if "width=" not in url and "exif=0" in url:
            return url
    for url in matching:
        if "width=1850" in url:
            return url
    return ""


def provider_urls(session: requests.Session, url_list: Path, limit: int) -> Iterator[Candidate]:
    count = 0
    for raw in url_list.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if count >= limit:
            break
        count += 1
        try:
            candidate = candidate_from_url(session, line)
        except requests.RequestException as exc:
            yield Candidate(
                source_type="web",
                source_platform="urls",
                source_url=line,
                source_image_url="",
                notes=f"download_failed: {exc}",
            )
            continue
        yield candidate


def candidate_from_url(session: requests.Session, url: str) -> Candidate:
    head = session.get(url, timeout=DEFAULT_TIMEOUT, stream=True, allow_redirects=True)
    head.raise_for_status()
    content_type = head.headers.get("content-type", "").split(";")[0].lower()
    final_url = head.url
    if content_type.startswith("image/"):
        return Candidate(
            source_type="web",
            source_platform="urls",
            source_url=final_url,
            source_image_url=final_url,
            title=Path(urlparse(final_url).path).name,
            license_type="unknown",
            notes="Direct image URL; verify source page manually if this is web-crawled output",
        )

    html = head.content[:2_000_000]
    soup = BeautifulSoup(html, "html.parser")
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    image_url = extract_best_image_url(soup, final_url)
    return Candidate(
        source_type="web",
        source_platform=urlparse(final_url).netloc.lower().removeprefix("www.") or "urls",
        source_url=final_url,
        source_image_url=image_url,
        title=title,
        license_type=infer_license_from_page(soup),
        license_url=extract_license_url(soup, final_url),
    )


def extract_best_image_url(soup: BeautifulSoup, base_url: str) -> str:
    for selector in [
        ('meta[property="og:image"]', "content"),
        ('meta[name="twitter:image"]', "content"),
        ('meta[property="twitter:image"]', "content"),
    ]:
        tag = soup.select_one(selector[0])
        if tag and tag.get(selector[1]):
            return requests.compat.urljoin(base_url, tag[selector[1]].strip())

    scored: List[Tuple[int, str]] = []
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or img.get("data-original")
        if not src:
            continue
        width = parse_int(img.get("width"))
        height = parse_int(img.get("height"))
        alt = img.get("alt", "")
        score = width * height
        full_url = requests.compat.urljoin(base_url, src)
        lowered = " ".join([alt.lower(), full_url.lower()])
        if any(word in lowered for word in ["/view/group/sqxs/", "/icon/", "/avatar/", "default-avatar"]):
            continue
        if any(word in lowered for word in ["avatar", "logo", "icon", "/icon/", "sprite"]):
            score -= 1_000_000
        if any(word in full_url.lower() for word in ["/view/group_topic/", "/view/note/", "/view/photo/", "/view/status/"]):
            score += 1_000_000
        scored.append((score, full_url))
    scored.sort(reverse=True)
    return scored[0][1] if scored else ""


def infer_license_from_page(soup: BeautifulSoup) -> str:
    text = soup.get_text(" ", strip=True).lower()[:50_000]
    if "creative commons" in text or "cc-by" in text or "cc by" in text:
        return "creative-commons"
    if "all rights reserved" in text:
        return "restricted"
    return "unknown"


def extract_license_url(soup: BeautifulSoup, base_url: str) -> str:
    for link in soup.find_all("a", href=True):
        text = " ".join([link.get_text(" ", strip=True), link["href"]]).lower()
        if "creativecommons.org/licenses" in text or "license" in text:
            return requests.compat.urljoin(base_url, link["href"])
    return ""


def normalize_license(raw: str) -> str:
    value = strip_html(raw).lower().strip()
    value = re.sub(r"\s+", " ", value)
    if not value:
        return "unknown"
    if "public domain" in value or value == "pd" or "cc0" in value:
        return "cc0"
    if "cc by-sa" in value or "cc-by-sa" in value:
        return "cc-by-sa"
    if "cc by" in value or "cc-by" in value or "attribution" in value:
        return "cc-by"
    if "all rights" in value or "restricted" in value:
        return "restricted"
    return value[:80]


def normalize_openverse_license(code: str, version: str) -> str:
    value = (code or "").lower().strip()
    if not value:
        return "unknown"
    if value == "cc0":
        return "cc0"
    if value == "pdm":
        return "public-domain"
    prefix = "cc-" + value.replace("_", "-")
    return f"{prefix}-{version}" if version else prefix


def strip_html(value: str) -> str:
    return BeautifulSoup(value or "", "html.parser").get_text(" ", strip=True)


def parse_int(value) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def safe_extension(url: str, content_type: str) -> str:
    ext = Path(urlparse(url).path).suffix.lower()
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff"}:
        return ".jpg" if ext == ".jpeg" else ext
    guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
    if guessed in {".jpe", ".jpeg"}:
        return ".jpg"
    return guessed or ".jpg"


def download_image(session: requests.Session, url: str, dest_stem: Path, referer: str = "") -> Tuple[Path, int, int]:
    if not url:
        raise ValueError("missing source_image_url")
    headers = {"Referer": referer} if referer else None
    resp = session.get(url, timeout=DEFAULT_TIMEOUT, stream=True, headers=headers)
    resp.raise_for_status()
    content_type = resp.headers.get("content-type", "")
    if content_type and not content_type.lower().startswith("image/"):
        raise ValueError(f"not an image content-type: {content_type}")
    ext = safe_extension(resp.url, content_type)
    dest = dest_stem.with_suffix(ext)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with tmp.open("wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 256):
            if chunk:
                f.write(chunk)
    try:
        with Image.open(tmp) as im:
            im.verify()
        with Image.open(tmp) as im:
            width, height = im.size
    except UnidentifiedImageError as exc:
        tmp.unlink(missing_ok=True)
        raise ValueError("invalid image") from exc
    tmp.replace(dest)
    return dest, width, height


def load_existing_sources(*manifests: Path) -> set:
    sources = set()
    for manifest in manifests:
        if not manifest or not manifest.exists():
            continue
        with manifest.open("r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            sources.update(row.get("normalized_source_url", "") for row in reader if row.get("normalized_source_url"))
    return sources


def append_rows(manifest_csv: Path, manifest_jsonl: Path, rows: List[ManifestRow]) -> None:
    if not rows:
        return
    manifest_csv.parent.mkdir(parents=True, exist_ok=True)
    write_header = not manifest_csv.exists()
    fields = list(asdict(rows[0]).keys())
    with manifest_csv.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if write_header:
            writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))
    with manifest_jsonl.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(asdict(row), ensure_ascii=False) + "\n")


def collect(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir)
    image_dir = output_dir / "images"
    output_dir.mkdir(parents=True, exist_ok=True)
    image_dir.mkdir(parents=True, exist_ok=True)
    manifest_csv = output_dir / "manifest.csv"
    manifest_jsonl = output_dir / "manifest.jsonl"

    session = requests.Session()
    session.headers.update({"User-Agent": args.user_agent or USER_AGENT})
    exclude_manifests = [Path(p) for p in (args.exclude_manifest or [])]
    seen_sources = load_existing_sources(manifest_csv, *exclude_manifests)

    providers = {
        "wikimedia": lambda: provider_wikimedia(session, args.query, args.limit),
        "openverse": lambda: provider_openverse(session, args.query, args.limit),
        "duckduckgo_web": lambda: provider_duckduckgo_web(session, args.query, args.limit),
        "pxhere_web": lambda: provider_pxhere_web(session, args.query, args.limit),
        "foodiesfeed_web": lambda: provider_foodiesfeed_web(session, args.query, args.limit),
        "libreshot_web": lambda: provider_libreshot_web(session, args.query, args.limit),
        "freeimages_uk_web": lambda: provider_freeimages_uk_web(session, args.query, args.limit),
        "picjumbo_web": lambda: provider_picjumbo_web(session, args.query, args.limit),
        "isorepublic_web": lambda: provider_isorepublic_web(session, args.query, args.limit),
        "negativespace_web": lambda: provider_negativespace_web(session, args.query, args.limit),
        "picography_web": lambda: provider_picography_web(session, args.query, args.limit),
        "freestocks_web": lambda: provider_freestocks_web(session, args.query, args.limit),
        "startupstockphotos_web": lambda: provider_startupstockphotos_web(session, args.query, args.limit),
        "skitterphoto_web": lambda: provider_skitterphoto_web(session, args.query, args.limit),
        "flickr": lambda: provider_flickr(session, args.query, args.limit),
        "flickr_web": lambda: provider_flickr_web(session, args.query, args.limit),
        "unsplash": lambda: provider_unsplash(session, args.query, args.limit),
        "pexels": lambda: provider_pexels(session, args.query, args.limit),
        "pixabay": lambda: provider_pixabay(session, args.query, args.limit),
        "shopify_burst": lambda: provider_shopify_burst(session, args.query, args.limit),
        "urls": lambda: provider_urls(session, Path(args.url_list), args.limit),
    }
    if args.provider not in providers:
        raise SystemExit(f"Unsupported provider: {args.provider}")
    if args.provider != "urls" and not args.query:
        raise SystemExit("--query is required unless --provider urls")
    if args.provider == "urls" and not args.url_list:
        raise SystemExit("--url-list is required for --provider urls")

    rows: List[ManifestRow] = []
    kept = 0
    skipped = 0
    duplicate_skipped = 0
    for candidate in providers[args.provider]():
        normalized = normalize_url(candidate.source_url)
        record_id = short_hash(normalized, candidate.source_image_url)
        fetched_at = utc_now()
        risk_flag, risk_note = infer_risk(candidate)
        local_path = ""
        width = height = short_edge = 0

        if not candidate.source_url and candidate.source_type == "web":
            risk_flag = risk_flag or "needs_manual_review"
            risk_note = risk_note or "Missing source_url"
        if normalized in seen_sources:
            duplicate_skipped += 1
            continue

        if not risk_flag or args.keep_risky:
            try:
                dest, width, height = download_image(session, candidate.source_image_url, image_dir / record_id, referer=candidate.source_url)
                short_edge = min(width, height)
                local_path = str(dest.relative_to(output_dir))
                if short_edge < args.min_short_edge:
                    risk_flag = risk_flag or "low_resolution"
                    risk_note = risk_note or f"short_edge={short_edge} < {args.min_short_edge}"
            except Exception as exc:
                risk_flag = risk_flag or "download_failed"
                risk_note = risk_note or str(exc)

        row = ManifestRow(
            record_id=record_id,
            source_type=candidate.source_type,
            source_platform=candidate.source_platform,
            source_url=candidate.source_url,
            normalized_source_url=normalized,
            source_image_url=candidate.source_image_url,
            fetched_at=fetched_at,
            query=candidate.query or args.query or "",
            title=candidate.title,
            author=candidate.author,
            license_type=candidate.license_type,
            license_url=candidate.license_url,
            image_path=local_path,
            width=width,
            height=height,
            short_edge=short_edge,
            scene_setting=infer_scene_setting(candidate),
            complexity_level="unknown",
            risk_flag=risk_flag,
            notes="; ".join(x for x in [candidate.notes, risk_note] if x),
        )
        rows.append(row)
        seen_sources.add(normalized)
        if risk_flag:
            skipped += 1
        else:
            kept += 1

        if len(rows) >= args.flush_every:
            append_rows(manifest_csv, manifest_jsonl, rows)
            rows.clear()
        if args.sleep:
            time.sleep(args.sleep)

    append_rows(manifest_csv, manifest_jsonl, rows)
    print(f"done provider={args.provider} kept={kept} flagged={skipped} duplicates_skipped={duplicate_skipped} manifest={manifest_csv}")
    return 0


def validate(args: argparse.Namespace) -> int:
    manifest = Path(args.manifest)
    output_dir = Path(args.output_dir) if args.output_dir else manifest.parent
    if not manifest.exists():
        raise SystemExit(f"manifest not found: {manifest}")

    total = 0
    effective = 0
    duplicate = 0
    lowres = 0
    missing_url = 0
    risky = 0
    seen = set()
    report_rows = []

    with manifest.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            normalized = row.get("normalized_source_url", "")
            risk = row.get("risk_flag", "")
            source_type = row.get("source_type", "")
            license_type = row.get("license_type", "")
            short_edge = parse_int(row.get("short_edge"))
            image_path = row.get("image_path", "")

            issues = []
            if source_type == "web" and not row.get("source_url"):
                missing_url += 1
                issues.append("missing_source_url")
            if normalized in seen:
                duplicate += 1
                issues.append("duplicate_source_url")
            seen.add(normalized)
            if short_edge < MIN_SHORT_EDGE:
                lowres += 1
                issues.append("low_resolution")
            if risk:
                risky += 1
                issues.append(risk)
            if license_type == "restricted":
                issues.append("restricted_license")
            if image_path and not (output_dir / image_path).exists():
                issues.append("missing_local_image")
            if not issues:
                effective += 1
            report_rows.append({**row, "validation_issues": "|".join(issues)})

    report_path = output_dir / "validation_report.csv"
    if report_rows:
        with report_path.open("w", newline="", encoding="utf-8") as f:
            fields = list(report_rows[0].keys())
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(report_rows)

    summary = {
        "total": total,
        "effective_before_human_visual_qa": effective,
        "flagged_or_risky": risky,
        "duplicates": duplicate,
        "missing_web_source_url": missing_url,
        "low_resolution": lowres,
        "report": str(report_path),
        "note": "Human QA is still required for table/surface + objects, blur/watermark, scene_setting, and complexity_level.",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    collect_parser = sub.add_parser("collect", help="collect candidate images")
    collect_parser.add_argument("--provider", required=True, choices=["wikimedia", "openverse", "duckduckgo_web", "pxhere_web", "foodiesfeed_web", "libreshot_web", "freeimages_uk_web", "picjumbo_web", "isorepublic_web", "negativespace_web", "picography_web", "freestocks_web", "startupstockphotos_web", "skitterphoto_web", "flickr", "flickr_web", "unsplash", "pexels", "pixabay", "shopify_burst", "urls"])
    collect_parser.add_argument("--query", default="", help="search query for API providers")
    collect_parser.add_argument("--url-list", default="", help="text file of source URLs for provider=urls")
    collect_parser.add_argument("--limit", type=int, default=50)
    collect_parser.add_argument("--output-dir", required=True)
    collect_parser.add_argument("--exclude-manifest", action="append", default=[], help="manifest CSV whose source URLs should be skipped")
    collect_parser.add_argument("--min-short-edge", type=int, default=MIN_SHORT_EDGE)
    collect_parser.add_argument("--flush-every", type=int, default=25)
    collect_parser.add_argument("--sleep", type=float, default=0.2, help="seconds between candidates")
    collect_parser.add_argument("--keep-risky", action="store_true", help="also download candidates with obvious risk flags")
    collect_parser.add_argument("--user-agent", default="")
    collect_parser.set_defaults(func=collect)

    validate_parser = sub.add_parser("validate", help="validate an existing manifest")
    validate_parser.add_argument("--manifest", required=True)
    validate_parser.add_argument("--output-dir", default="")
    validate_parser.set_defaults(func=validate)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
