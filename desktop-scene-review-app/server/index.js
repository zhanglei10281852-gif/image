import cors from "cors";
import express from "express";
import ExcelJS from "exceljs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(APP_ROOT, "..");
const MANIFEST_PATH =
  process.env.MANIFEST_PATH ||
  path.join(WORKSPACE_ROOT, "data/desktop_scenes_batch7_continuous_newsites/manifest.csv");
const DB_PATH = process.env.DB_PATH || path.join(APP_ROOT, "data/review.sqlite");
const COLLECTION_ROOT = process.env.COLLECTION_ROOT || path.join(WORKSPACE_ROOT, "data/app_collections");
const CRAWLER_PATH = path.join(WORKSPACE_ROOT, "desktop-scene-crawler/scripts/desktop_scene_crawler.py");
const PYTHON_PATH = fs.existsSync(path.join(WORKSPACE_ROOT, ".venv/bin/python"))
  ? path.join(WORKSPACE_ROOT, ".venv/bin/python")
  : "python3";
const AUTHOR = process.env.EXPORT_AUTHOR || "张磊";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_GITHUB_DEDUPE_REPO = process.env.GITHUB_DEDUPE_REPO || detectDefaultGitHubRepo();
const db = openDatabase();
const activeJobs = new Map();

const SCENE_LABELS = {
  indoor: "室内",
  outdoor: "室外",
  semi_outdoor: "半户外",
  unknown: ""
};

const FIELD_DEFS = [
  { key: "auto_number", label: "自动编号", width: 12, group: "交付字段" },
  { key: "thumbnail", label: "缩略图", width: 18, group: "交付字段" },
  { key: "source_url", label: "来源URL", width: 46, group: "交付字段", hyperlink: true },
  { key: "source_image_url", label: "图片URL", width: 54, group: "交付字段", hyperlink: true },
  { key: "scene_cn", label: "场景环境", width: 12, group: "交付字段" },
  { key: "created_at", label: "创建时间", width: 20, group: "交付字段" },
  { key: "operator", label: "做题人", width: 12, group: "交付字段" },
  { key: "duplicate_flag", label: "重复标记", width: 12, group: "交付字段" },
  { key: "record_id", label: "record_id", width: 22, group: "Manifest字段" },
  { key: "source_type", label: "source_type", width: 14, group: "Manifest字段" },
  { key: "source_platform", label: "source_platform", width: 18, group: "Manifest字段" },
  { key: "normalized_source_url", label: "normalized_source_url", width: 44, group: "Manifest字段" },
  { key: "fetched_at", label: "fetched_at", width: 24, group: "Manifest字段" },
  { key: "query", label: "query", width: 28, group: "Manifest字段" },
  { key: "title", label: "title", width: 44, group: "Manifest字段" },
  { key: "author", label: "author", width: 22, group: "Manifest字段" },
  { key: "license_type", label: "license_type", width: 18, group: "Manifest字段" },
  { key: "license_url", label: "license_url", width: 44, group: "Manifest字段", hyperlink: true },
  { key: "image_path", label: "image_path", width: 26, group: "Manifest字段" },
  { key: "width", label: "width", width: 10, group: "Manifest字段", numeric: true },
  { key: "height", label: "height", width: 10, group: "Manifest字段", numeric: true },
  { key: "short_edge", label: "short_edge", width: 12, group: "Manifest字段", numeric: true },
  { key: "scene_setting", label: "scene_setting", width: 16, group: "Manifest字段" },
  { key: "complexity_level", label: "complexity_level", width: 18, group: "Manifest字段" },
  { key: "risk_flag", label: "risk_flag", width: 18, group: "Manifest字段" },
  { key: "notes", label: "notes", width: 48, group: "Manifest字段" }
];

const DEFAULT_FIELDS = ["source_url", "source_image_url", "scene_cn"];
const SOURCE_CATALOG = [
  {
    id: "wikimedia",
    name: "Wikimedia Commons",
    url: "https://commons.wikimedia.org/",
    tier: "S",
    license: "free licenses / public domain, per file",
    provider: "wikimedia",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["实体物品", "地点/建筑", "历史/文物", "工作台/工具", "自然真实场景"],
    taskTypes: ["通用真实图片", "局部场景", "物体识别", "场景分类"],
    promptKeywords: ["site:commons.wikimedia.org File:", "table", "workbench", "countertop", "object"],
    supportsChineseSearch: false,
    caution: "逐条保留 File 页 URL、作者、license；不同文件许可不同。"
  },
  {
    id: "flickr_cc",
    name: "Flickr Creative Commons",
    url: "https://www.flickr.com/creativecommons/",
    tier: "S",
    license: "Creative Commons, per photo",
    provider: "flickr_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["生活随手拍", "真实人物环境", "街景/户外", "桌面/餐桌", "长尾细分场景"],
    taskTypes: ["真实生活场景", "物体复刻", "室内外分类", "人机交互场景"],
    promptKeywords: ["creative commons", "desk setup", "dining table", "workbench", "candid"],
    supportsChineseSearch: false,
    caution: "只收 CC/可用许可页；保留 photo permalink；避开 AI/render/二创图。"
  },
  {
    id: "openverse",
    name: "Openverse",
    url: "https://openverse.org/",
    tier: "A",
    license: "open licenses / public domain aggregator",
    provider: "openverse",
    crawlStatus: "需 API Token",
    requiresApiKey: true,
    apiKeyEnv: "OPENVERSE_ACCESS_TOKEN",
    bestFor: ["开放许可发现", "跨站聚合检索", "素材初筛"],
    taskTypes: ["多来源扩展", "开放许可图片", "低重复候选发现"],
    promptKeywords: ["openly licensed", "photo", "commercial use", "tabletop"],
    supportsChineseSearch: false,
    caution: "Openverse API 当前需要授权；未配置 OPENVERSE_ACCESS_TOKEN 时不参与前端直采。聚合站许可可能不准，必须点回原始来源页复核。"
  },
  {
    id: "skitterphoto",
    name: "Skitterphoto",
    url: "https://skitterphoto.com/",
    tier: "A",
    license: "public domain / CC0-like",
    provider: "skitterphoto_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["食物/餐桌", "物体近景", "户外小场景", "技术/办公少量补充"],
    taskTypes: ["桌面物体", "食物器具", "局部场景"],
    promptKeywords: ["food", "coffee", "dining", "technology", "workbench"],
    supportsChineseSearch: false,
    caution: "搜索结果混杂，需要联系表人工筛图。"
  },
  {
    id: "shopify_burst",
    name: "Shopify Burst",
    url: "https://www.shopify.com/stock-photos",
    tier: "A",
    license: "royalty-free / Burst license",
    provider: "shopify_burst",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["办公桌", "电商生活方式", "餐饮", "商业/创业场景"],
    taskTypes: ["产品场景", "办公/商业场景", "餐桌/生活方式"],
    promptKeywords: ["desk coffee laptop", "restaurant table", "coffee table book"],
    supportsChineseSearch: false,
    caution: "网页有时较慢；小批量抓取并保留作品页。"
  },
  {
    id: "pexels",
    name: "Pexels",
    url: "https://www.pexels.com/",
    tier: "A",
    license: "Pexels license",
    provider: "pexels",
    crawlStatus: "需 API Key",
    requiresApiKey: true,
    apiKeyEnv: "PEXELS_API_KEY",
    bestFor: ["高质量通用照片", "室内设计", "人物/生活方式", "视频扩展"],
    taskTypes: ["高质量视觉评测", "通用照片采集", "视频帧任务"],
    promptKeywords: ["home office", "dining table", "kitchen counter", "workspace"],
    supportsChineseSearch: false,
    caution: "建议走官方 API；避免把搜索缩略图当原图。"
  },
  {
    id: "pixabay",
    name: "Pixabay",
    url: "https://pixabay.com/",
    tier: "A",
    license: "Pixabay Content License",
    provider: "pixabay",
    crawlStatus: "需 API Key",
    requiresApiKey: true,
    apiKeyEnv: "PIXABAY_API_KEY",
    bestFor: ["通用物体", "自然/户外", "插图要单独过滤", "视频/音频扩展"],
    taskTypes: ["通用图片", "物体类别", "自然场景"],
    promptKeywords: ["photo", "real", "table", "counter", "workspace"],
    supportsChineseSearch: false,
    caution: "结果里可能有插画/矢量/AI风格，必须强过滤真实照片。"
  },
  {
    id: "unsplash",
    name: "Unsplash",
    url: "https://unsplash.com/",
    tier: "B",
    license: "Unsplash license",
    provider: "unsplash",
    crawlStatus: "需 API Key",
    requiresApiKey: true,
    apiKeyEnv: "UNSPLASH_ACCESS_KEY",
    bestFor: ["高质量摄影", "生活方式", "场景氛围", "营销类图"],
    taskTypes: ["视觉质量高的场景图", "生活方式图片"],
    promptKeywords: ["workspace", "coffee table", "kitchen counter", "candid"],
    supportsChineseSearch: false,
    caution: "许可限制不允许复制出类似图库服务；用于大规模库需谨慎。"
  },
  {
    id: "freestocks",
    name: "Freestocks",
    url: "https://freestocks.org/",
    tier: "B",
    license: "free stock license",
    provider: "freestocks_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["书本/杯子", "办公桌", "生活小物", "节日物品"],
    taskTypes: ["桌面物体", "局部生活场景"],
    promptKeywords: ["coffee notebook", "desk lamp books", "tablet desk"],
    supportsChineseSearch: false,
    caution: "容易出现手拿杯、动物、白底小物，需人工筛。"
  },
  {
    id: "picjumbo",
    name: "Picjumbo",
    url: "https://picjumbo.com/",
    tier: "B",
    license: "picjumbo free / premium mixed",
    provider: "picjumbo_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["餐饮", "商业生活方式", "办公", "节日场景"],
    taskTypes: ["餐桌/食物", "商业场景", "营销图筛选"],
    promptKeywords: ["breakfast table", "restaurant table", "laptop keyboard desk"],
    supportsChineseSearch: false,
    caution: "有推广页和 premium 混入，必须保留免费作品页并过滤宣传页。"
  },
  {
    id: "isorepublic",
    name: "ISO Republic",
    url: "https://isorepublic.com/",
    tier: "B",
    license: "ISO Republic free license",
    provider: "isorepublic_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["办公", "餐饮", "城市/自然", "局部物体"],
    taskTypes: ["通用照片", "局部场景补充"],
    promptKeywords: ["laptop desk", "restaurant table", "breakfast"],
    supportsChineseSearch: false,
    caution: "关键词要窄，否则会混入风景/纯背景。"
  },
  {
    id: "pxhere",
    name: "PxHere",
    url: "https://pxhere.com/",
    tier: "B",
    license: "CC0",
    provider: "pxhere_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["通用照片", "物体/场景补充", "桌面/台面", "户外场景"],
    taskTypes: ["通用真实照片", "桌面/台面局部场景", "长尾物体/特殊类别"],
    promptKeywords: ["coffee cup table", "laptop desk", "kitchen counter", "dining table"],
    supportsChineseSearch: false,
    caution: "已有 provider；历史重复较多，适合用新关键词补漏。"
  },
  {
    id: "freeimages_uk",
    name: "FreeImages UK",
    url: "https://www.freeimages.co.uk/",
    tier: "B",
    license: "FreeImages UK terms",
    provider: "freeimages_uk_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["餐厅/厨房", "办公", "食物", "家居局部"],
    taskTypes: ["桌面/台面局部场景", "食物/餐桌/厨房", "办公/电脑/学习桌"],
    promptKeywords: ["dining room table", "kitchen table", "office desk", "food table"],
    supportsChineseSearch: false,
    caution: "图库分类页命中为主，产量中等；需过滤尺寸不足、纯物体和不含桌面的图片。"
  },
  {
    id: "free_images",
    name: "Free-Images.com",
    url: "https://free-images.com/",
    tier: "B",
    license: "public domain / upstream varies",
    provider: "free_images_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["办公桌", "笔记本电脑", "餐桌/咖啡", "厨房台面", "长尾公开图片"],
    taskTypes: ["桌面/台面局部场景", "办公/电脑/学习桌", "通用真实照片"],
    promptKeywords: ["desk laptop", "coffee desk", "dining table", "kitchen counter"],
    supportsChineseSearch: false,
    caution: "可直采展示页和 original 图片 URL；页面常带 Wikimedia/Flickr 上游链接，入库后仍需人工筛掉不含桌面承载面的图。"
  },
  {
    id: "wordpress_photos",
    name: "WordPress Photo Directory",
    url: "https://wordpress.org/photos/",
    tier: "B",
    license: "CC0",
    provider: "wordpress_photos_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["开放 CC0 照片", "桌面/办公补充", "通用真实照片", "长尾物体"],
    taskTypes: ["桌面/台面局部场景", "通用真实照片", "补充采集"],
    promptKeywords: ["desk", "table", "coffee", "workspace"],
    supportsChineseSearch: false,
    caution: "可直采 photo 详情页和 pd.w.org 原图；结果覆盖广，需人工过滤无桌面承载面、纯风景和不相关图。"
  },
  {
    id: "nappy",
    name: "Nappy",
    url: "https://www.nappy.co/",
    tier: "C",
    license: "Nappy free license",
    provider: "nappy_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["真实生活方式", "居家办公", "人物+桌面", "多样化场景"],
    taskTypes: ["办公/电脑/学习桌", "商品生活方式场景", "通用真实照片"],
    promptKeywords: ["desk", "work from home", "laptop", "coffee"],
    supportsChineseSearch: false,
    caution: "可直采公开 photo 页；结果常含人物，需要人工筛掉无桌面、人物主体过强或评价任务不需要的图。"
  },
  {
    id: "negativespace",
    name: "NegativeSpace",
    url: "https://negativespace.co/",
    tier: "B",
    license: "CC0",
    provider: "negativespace_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["办公桌", "咖啡/餐桌", "生活方式", "商品场景"],
    taskTypes: ["办公/电脑/学习桌", "桌面/台面局部场景", "商品生活方式场景"],
    promptKeywords: ["desk laptop coffee", "workspace table", "coffee table", "kitchen counter"],
    supportsChineseSearch: false,
    caution: "英文关键词效果更好；图片偏素材感，需人工筛掉摆拍过强或无桌面主体的图。"
  },
  {
    id: "startupstockphotos",
    name: "Startup Stock Photos",
    url: "https://startupstockphotos.com/",
    tier: "B",
    license: "free stock terms",
    provider: "startupstockphotos_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["办公桌", "笔记本电脑", "创业/会议", "工位局部"],
    taskTypes: ["办公/电脑/学习桌", "桌面/台面局部场景"],
    promptKeywords: ["desk laptop", "startup desk", "meeting table", "workspace"],
    supportsChineseSearch: false,
    caution: "强办公属性，适合补电脑/键盘/笔记本类；不适合餐桌和家居多样性。"
  },
  {
    id: "goodstock",
    name: "Good Stock Photos",
    url: "https://goodstock.photos/",
    tier: "B",
    license: "free personal/commercial use",
    provider: "goodstock_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["室内家居", "桌面/咖啡", "生活方式", "局部物体"],
    taskTypes: ["商品生活方式场景", "桌面/台面局部场景", "通用真实照片"],
    promptKeywords: ["coffee table", "cup table", "desk", "kitchen"],
    supportsChineseSearch: false,
    caution: "WordPress 结构清晰，已接入搜索页和作品页原图；仍需筛掉过强摆拍、纯背景或无桌面承载面的图。"
  },
  {
    id: "realisticshots",
    name: "Realistic Shots",
    url: "https://realisticshots.com/",
    tier: "C",
    license: "CC0",
    provider: "realisticshots_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["通用摄影", "城市/自然", "少量生活方式"],
    taskTypes: ["通用真实照片", "补充采集"],
    promptKeywords: ["desk", "coffee", "table", "workspace"],
    supportsChineseSearch: false,
    caution: "Tumblr 标签页可直采；产量有限，适合补办公/桌面少量长尾图。"
  },
  {
    id: "shotstash",
    name: "ShotStash",
    url: "https://shotstash.com/",
    tier: "B",
    license: "free / CC0-style",
    provider: "shotstash_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["生活方式", "办公", "食物", "通用素材"],
    taskTypes: ["商品生活方式场景", "办公/电脑/学习桌", "食物/餐桌/厨房"],
    promptKeywords: ["coffee table", "desk", "food table", "workspace"],
    supportsChineseSearch: false,
    caution: "已接入搜索页和作品页原图；需过滤推广页、纯背景图和不含桌面承载面的素材。"
  },
  {
    id: "stocksnap",
    name: "StockSnap",
    url: "https://stocksnap.io/",
    tier: "B",
    license: "StockSnap free license",
    provider: "manual_stocksnap",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["办公桌", "咖啡/餐桌", "商业生活方式", "通用照片"],
    taskTypes: ["桌面/台面局部场景", "办公/电脑/学习桌", "商品生活方式场景"],
    promptKeywords: ["desk laptop", "coffee table", "dining table", "kitchen counter"],
    supportsChineseSearch: false,
    caution: "适合人工发现来源页；直接 provider 未接入前不进入采集下拉。"
  },
  {
    id: "kaboompics",
    name: "Kaboompics",
    url: "https://kaboompics.com/",
    tier: "B",
    license: "Kaboompics license",
    provider: "manual_kaboompics",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["室内生活方式", "办公桌", "餐桌/咖啡", "家居物体"],
    taskTypes: ["桌面/台面局部场景", "商品生活方式场景", "室内局部场景"],
    promptKeywords: ["desk", "coffee", "table", "home office"],
    supportsChineseSearch: false,
    caution: "图片质量高但许可需按作品页复核；当前作为提示词来源。"
  },
  {
    id: "lifeofpix",
    name: "Life of Pix",
    url: "https://www.lifeofpix.com/",
    tier: "C",
    license: "Life of Pix free license",
    provider: "manual_lifeofpix",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["通用摄影", "少量办公/生活方式", "补漏"],
    taskTypes: ["通用真实照片", "补充采集"],
    promptKeywords: ["desk", "coffee", "workspace", "table"],
    supportsChineseSearch: false,
    caution: "站点响应和搜索稳定性一般，先作为人工/提示词来源。"
  },
  {
    id: "reshot",
    name: "Reshot",
    url: "https://www.reshot.com/",
    tier: "C",
    license: "Reshot license",
    provider: "manual_reshot",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["补充素材", "图标/插画需排除", "少量照片发现"],
    taskTypes: ["补充采集", "通用真实照片"],
    promptKeywords: ["photo desk", "photo table", "workspace photo"],
    supportsChineseSearch: false,
    caution: "站内有图标/插画内容，必须只保留真实照片来源页。"
  },
  {
    id: "publicdomainpictures",
    name: "Public Domain Pictures",
    url: "https://www.publicdomainpictures.net/",
    tier: "C",
    license: "public domain / per image",
    provider: "manual_publicdomainpictures",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["通用照片", "食物/餐桌", "家居局部", "户外桌面补充"],
    taskTypes: ["通用真实照片", "桌面/台面局部场景", "补充采集"],
    promptKeywords: ["desk", "coffee table", "dining table", "kitchen"],
    supportsChineseSearch: false,
    caution: "产量大但噪声也大；保留图片详情页，过滤插画、AI感图、纯背景和低分辨率图。"
  },
  {
    id: "goodfreephotos",
    name: "Good Free Photos",
    url: "https://www.goodfreephotos.com/",
    tier: "C",
    license: "public domain / per site",
    provider: "manual_goodfreephotos",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["旅行/户外", "餐桌少量补充", "通用物体"],
    taskTypes: ["通用真实照片", "户外/露台/野餐", "补充采集"],
    promptKeywords: ["table", "coffee", "desk", "restaurant"],
    supportsChineseSearch: false,
    caution: "更适合补漏，桌面命中率不高；需要人工确认承载面和桌上物体。"
  },
  {
    id: "barnimages",
    name: "Barnimages",
    url: "https://barnimages.com/",
    tier: "B",
    license: "Barnimages free license",
    provider: "barnimages_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["生活方式", "室内局部", "办公/咖啡", "产品环境图"],
    taskTypes: ["桌面/台面局部场景", "商品生活方式场景", "通用真实照片"],
    promptKeywords: ["desk", "coffee", "table", "workspace"],
    supportsChineseSearch: false,
    caution: "可直采作品页原始上传图；搜索结果含赞助图，需要继续人工筛掉广告感过强或无桌面的图。"
  },
  {
    id: "focastock",
    name: "FOCA Stock",
    url: "https://www.focastock.com/",
    tier: "B",
    license: "FOCA free license",
    provider: "focastock_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["办公/桌面", "餐饮/咖啡", "城市生活方式", "通用补充"],
    taskTypes: ["桌面/台面局部场景", "办公/电脑/学习桌", "餐桌/生活方式"],
    promptKeywords: ["desk", "table", "laptop", "coffee", "workspace"],
    supportsChineseSearch: false,
    caution: "搜索相关性一般，适合和其他站点并行补充；保留作品页 URL 和 cdn.focastock.com 原图 URL。"
  },
  {
    id: "splitshire",
    name: "SplitShire",
    url: "https://www.splitshire.com/",
    tier: "C",
    license: "SplitShire free license",
    provider: "manual_splitshire",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["办公/生活方式", "食物饮品", "通用摄影"],
    taskTypes: ["通用真实照片", "桌面/台面局部场景", "补充采集"],
    promptKeywords: ["desk", "coffee", "laptop", "food"],
    supportsChineseSearch: false,
    caution: "更新少、命中量有限，只适合补充。"
  },
  {
    id: "jeshoots",
    name: "JESHOOTS",
    url: "https://jeshoots.com/",
    tier: "B",
    license: "JESHOOTS free license",
    provider: "manual_jeshoots",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["办公桌", "科技产品场景", "食物/厨房", "生活方式"],
    taskTypes: ["办公/电脑/学习桌", "桌面/台面局部场景", "商品生活方式场景"],
    promptKeywords: ["workspace", "laptop desk", "coffee table", "kitchen"],
    supportsChineseSearch: false,
    caution: "适合人工发现；注意区分免费作品页和推广内容。"
  },
  {
    id: "magdeleine",
    name: "Magdeleine",
    url: "https://magdeleine.co/",
    tier: "C",
    license: "CC0 / CC BY, per photo",
    provider: "magdeleine_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["策展型照片", "室内局部少量补充", "自然光场景"],
    taskTypes: ["通用真实照片", "补充采集"],
    promptKeywords: ["desk", "table", "coffee", "interior"],
    supportsChineseSearch: false,
    caution: "直采 food/objects 等分类并按关键词过滤；每张许可不同，必须保留作品页和 license；产量不高。"
  },
  {
    id: "designerpics",
    name: "DesignerPics",
    url: "https://www.designerspics.com/",
    tier: "C",
    license: "free stock license",
    provider: "manual_designerpics",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["办公/科技", "食物少量补充", "通用物体"],
    taskTypes: ["办公/电脑/学习桌", "补充采集"],
    promptKeywords: ["desk", "laptop", "coffee", "table"],
    supportsChineseSearch: false,
    caution: "老站点，页面结构可能变化；先人工使用。"
  },
  {
    id: "newoldstock",
    name: "New Old Stock",
    url: "https://nos.twnsnd.co/",
    tier: "C",
    license: "public archive photos / per source",
    provider: "manual_newoldstock",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["历史照片", "老办公室/餐桌少量补充", "风格扩展"],
    taskTypes: ["通用真实照片", "补充采集"],
    promptKeywords: ["desk", "table", "office", "restaurant"],
    supportsChineseSearch: false,
    caution: "偏历史档案照片，不适合作主源；需确认原始档案来源和许可。"
  },
  {
    id: "rawpixel_public_domain",
    name: "Rawpixel Public Domain",
    url: "https://www.rawpixel.com/category/53/public-domain",
    tier: "C",
    license: "public domain collection / per item",
    provider: "manual_rawpixel_public_domain",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["公版素材", "历史/静物补充", "少量桌面物体"],
    taskTypes: ["通用真实照片", "补充采集"],
    promptKeywords: ["desk public domain", "table public domain", "still life"],
    supportsChineseSearch: false,
    caution: "站内包含插画/扫描图/设计素材，必须只留真实照片；可能需要人工下载流程。"
  },
  {
    id: "depositphotos_free",
    name: "Depositphotos Free Files",
    url: "https://depositphotos.com/free-files.html",
    tier: "C",
    license: "free files / account terms",
    provider: "manual_depositphotos_free",
    crawlStatus: "提示词/待集成",
    requiresApiKey: false,
    bestFor: ["商业生活方式少量补充", "办公/餐饮", "产品场景"],
    taskTypes: ["商品生活方式场景", "补充采集"],
    promptKeywords: ["desk", "dining table", "coffee", "workspace"],
    supportsChineseSearch: false,
    caution: "可能需要账号或下载条款限制；不要直爬，适合人工合规补充。"
  },
  {
    id: "foodiesfeed",
    name: "Foodiesfeed",
    url: "https://www.foodiesfeed.com/",
    tier: "B",
    license: "free food photo license",
    provider: "foodiesfeed_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["食物", "餐具", "餐桌", "厨房台面"],
    taskTypes: ["食物识别", "餐桌物体", "烹饪场景"],
    promptKeywords: ["breakfast table", "restaurant plate", "coffee cup"],
    supportsChineseSearch: false,
    caution: "只适合食物/餐饮类，别拿来补办公/通用场景。"
  },
  {
    id: "picography",
    name: "Picography",
    url: "https://picography.co/",
    tier: "C",
    license: "Picography terms",
    provider: "picography_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["少量物体补充", "桌面局部", "办公配件"],
    taskTypes: ["低量补充", "特定物体近景"],
    promptKeywords: ["tablet desk", "plant desk", "coffee table"],
    supportsChineseSearch: false,
    caution: "产量低，常见纯物体/白底/宏观特写，不宜作为主源。"
  },
  {
    id: "douban_web",
    name: "豆瓣公开图文",
    url: "https://www.douban.com/",
    tier: "B",
    license: "public web pages / license review needed",
    provider: "douban_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["中文生活图文", "书桌/工位", "餐桌/咖啡", "家居局部"],
    taskTypes: ["中文真实场景", "桌面/台面局部场景", "生活随手拍"],
    promptKeywords: ["书桌 日常", "餐桌 咖啡", "桌面 收纳", "厨房 台面"],
    supportsChineseSearch: true,
    caution: "通过 DuckDuckGo 站内发现公开页面，再进入豆瓣原页面取图；许可多为 unknown，需人工复核。"
  },
  {
    id: "zhihu_web",
    name: "知乎公开图文",
    url: "https://www.zhihu.com/",
    tier: "C",
    license: "public web pages / license review needed",
    provider: "zhihu_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["中文经验帖", "桌面改造", "家居/厨房", "办公学习"],
    taskTypes: ["中文真实场景", "桌面/台面局部场景", "补充采集"],
    promptKeywords: ["书桌 改造", "餐桌 布置", "厨房 台面", "工位 桌面"],
    supportsChineseSearch: true,
    caution: "知乎页面反爬和登录提示较多，可能产量不稳定；只保留公开来源页和页面大图。"
  },
  {
    id: "smzdm_web",
    name: "什么值得买公开晒单",
    url: "https://www.smzdm.com/",
    tier: "B",
    license: "public web pages / license review needed",
    provider: "smzdm_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["真实晒单", "桌面好物", "厨房/餐桌", "办公装备"],
    taskTypes: ["商品生活方式场景", "中文真实场景", "桌面/台面局部场景"],
    promptKeywords: ["桌面 晒单", "书桌 装备", "厨房 台面", "餐桌 好物"],
    supportsChineseSearch: true,
    caution: "适合找真实买家式场景，但授权风险需人工复核；保留公开文章页 URL。"
  },
  {
    id: "xiachufang_web",
    name: "下厨房公开菜谱/作品",
    url: "https://www.xiachufang.com/",
    tier: "B",
    license: "public web pages / license review needed",
    provider: "xiachufang_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["餐桌", "厨房台面", "食材/餐具", "早餐场景"],
    taskTypes: ["食物/餐桌/厨房", "桌面/台面局部场景", "中文真实场景"],
    promptKeywords: ["早餐 餐桌", "厨房 台面 食材", "餐具 摆盘", "咖啡 桌面"],
    supportsChineseSearch: true,
    caution: "食品图命中高，但要人工筛掉只有盘子特写、无承载面或水印明显的图。"
  },
  {
    id: "sohu_web",
    name: "搜狐公开图文",
    url: "https://www.sohu.com/",
    tier: "C",
    license: "public web pages / license review needed",
    provider: "sohu_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["中文家居文章", "餐桌/厨房", "办公学习", "生活方式补充"],
    taskTypes: ["中文真实场景", "桌面/台面局部场景", "补充采集"],
    promptKeywords: ["餐桌 布置", "厨房 台面", "书桌 收纳", "咖啡 桌面"],
    supportsChineseSearch: true,
    caution: "公开网页源，噪声比图库大；需人工确认不是广告图、白底商品图或纯装修大全景。"
  },
  {
    id: "cn_public_web",
    name: "国内公开图文网页发现",
    url: "https://duckduckgo.com/",
    tier: "B",
    license: "public web pages / license review needed",
    provider: "duckduckgo_web",
    crawlStatus: "已集成",
    requiresApiKey: false,
    bestFor: ["中文生活图文", "餐桌/厨房", "书桌/工位", "家居改造", "公开博客图文"],
    taskTypes: ["中文真实场景", "桌面/台面局部场景", "商品生活方式场景", "食物/餐桌/厨房"],
    promptKeywords: ["书桌 日常 桌面", "餐桌 摆盘 家常", "厨房 台面 食材", "咖啡 桌面 随手拍", "工位 桌面 办公"],
    supportsChineseSearch: true,
    keywordAdvice: "优先中文关键词。建议用“场景词 + 物体词 + 生活化词”，例如：书桌 日常 桌面、餐桌 摆盘 家常、厨房 台面 食材。不要只搜“桌子”。",
    caution: "通过公开搜索结果进入原始页面抓取 og:image 或页面大图；当前只允许豆瓣、LOFTER、知乎、简书、堆糖、图虫、站酷、美篇、搜狐、网易、什么值得买、下厨房、澎湃、头条、B站等公开网页。许可多为 unknown，需人工复核。"
  },
  {
    id: "xhs_public",
    name: "小红书/中文公开帖",
    url: "https://www.xiaohongshu.com/",
    tier: "B",
    license: "user generated / restricted review needed",
    provider: "manual_cn_social",
    crawlStatus: "人工/待集成",
    requiresApiKey: false,
    bestFor: ["中文生活随手拍", "桌面好物", "家居/餐桌", "真实评价式图片"],
    taskTypes: ["中文真实场景", "商品生活方式场景", "桌面/台面局部场景"],
    promptKeywords: ["书桌日常", "餐桌摆盘", "桌面好物", "工位改造"],
    supportsChineseSearch: true,
    caution: "只用公开帖；保留帖子 URL；注意用户内容授权和隐私。"
  },
  {
    id: "ecommerce_reviews",
    name: "淘宝/京东等电商评价图",
    url: "https://www.taobao.com/",
    tier: "C",
    license: "platform/user generated / high risk",
    provider: "manual_ecommerce_review",
    crawlStatus: "不建议直爬",
    requiresApiKey: false,
    bestFor: ["真实买家秀", "商品使用场景", "中文评价图"],
    taskTypes: ["商品生活方式场景", "真实评价图"],
    promptKeywords: ["买家秀", "晒单", "评价图", "追评"],
    supportsChineseSearch: true,
    caution: "淘宝/京东评价图通常受平台条款、登录权限和用户内容授权限制；除非有授权或自有店铺后台导出，否则不建议作为爬取来源。"
  }
];

const SUPPORTED_DIRECT_CRAWL_PROVIDERS = new Set([
  "wikimedia",
  "openverse",
  "duckduckgo_web",
  "douban_web",
  "zhihu_web",
  "smzdm_web",
  "xiachufang_web",
  "sohu_web",
  "pxhere_web",
  "foodiesfeed_web",
  "freeimages_uk_web",
  "free_images_web",
  "picjumbo_web",
  "isorepublic_web",
  "negativespace_web",
  "picography_web",
  "freestocks_web",
  "startupstockphotos_web",
  "goodstock_web",
  "shotstash_web",
  "barnimages_web",
  "realisticshots_web",
  "wordpress_photos_web",
  "nappy_web",
  "focastock_web",
  "magdeleine_web",
  "skitterphoto_web",
  "flickr",
  "flickr_web",
  "unsplash",
  "pexels",
  "pixabay",
  "shopify_burst",
  "urls"
]);

function apiKeyConfigured(source) {
  return !source.requiresApiKey || Boolean(source.apiKeyEnv && process.env[source.apiKeyEnv]);
}

function directCrawlInfo(source) {
  if (source.requiresApiKey && !apiKeyConfigured(source)) {
    return { directCrawl: false, disabledReason: `需要 API Key：${source.apiKeyEnv || "未配置"}` };
  }
  if (!SUPPORTED_DIRECT_CRAWL_PROVIDERS.has(source.provider)) {
    return { directCrawl: false, disabledReason: "仅保留提示词/人工采集，不支持直接爬取" };
  }
  return {
    directCrawl: true,
    disabledReason: "",
    apiKeyConfigured: source.requiresApiKey ? apiKeyConfigured(source) : undefined
  };
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return new DatabaseSync(DB_PATH);
}

function detectDefaultGitHubRepo() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const httpsMatch = remote.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    return httpsMatch ? `${httpsMatch[1]}/${httpsMatch[2]}` : "";
  } catch {
    return "";
  }
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      record_id TEXT PRIMARY KEY,
      row_number INTEGER NOT NULL,
      source_type TEXT,
      source_platform TEXT,
      source_url TEXT,
      normalized_source_url TEXT,
      source_image_url TEXT,
      fetched_at TEXT,
      query TEXT,
      title TEXT,
      author TEXT,
      license_type TEXT,
      license_url TEXT,
      image_path TEXT,
      width INTEGER,
      height INTEGER,
      short_edge INTEGER,
      scene_setting TEXT,
      complexity_level TEXT,
      risk_flag TEXT,
      notes TEXT,
      payload TEXT NOT NULL,
      manifest_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exported_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_records_exported_at ON records(exported_at);
    CREATE INDEX IF NOT EXISTS idx_records_platform ON records(source_platform);
    CREATE INDEX IF NOT EXISTS idx_records_scene ON records(scene_setting);
    CREATE INDEX IF NOT EXISTS idx_records_risk ON records(risk_flag);

    CREATE TABLE IF NOT EXISTS crawl_jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      query TEXT NOT NULL,
      limit_count INTEGER NOT NULL,
      output_dir TEXT NOT NULL,
      manifest_path TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      kept INTEGER DEFAULT 0,
      flagged INTEGER DEFAULT 0,
      duplicates_skipped INTEGER DEFAULT 0,
      progress_processed INTEGER DEFAULT 0,
      imported INTEGER DEFAULT 0,
      skipped_duplicates INTEGER DEFAULT 0,
      last_progress_at TEXT,
      error TEXT,
      log TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_started_at ON crawl_jobs(started_at);

    CREATE TABLE IF NOT EXISTS dedupe_keys (
      key_type TEXT NOT NULL,
      key_value TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (key_type, key_value)
    );
    CREATE INDEX IF NOT EXISTS idx_dedupe_keys_created_at ON dedupe_keys(created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn("records", "deleted_at", "TEXT");
  ensureColumn("crawl_jobs", "progress_processed", "INTEGER DEFAULT 0");
  ensureColumn("crawl_jobs", "last_progress_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records(deleted_at);");
  normalizeExistingSceneSettings();
  dedupeDatabaseRows();
  migrateDedupeKeysToExportedOnly();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_records_normalized_source_url
      ON records(normalized_source_url)
      WHERE normalized_source_url IS NOT NULL AND normalized_source_url != '';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_records_source_image_url
      ON records(source_image_url)
      WHERE source_image_url IS NOT NULL AND source_image_url != '';
  `);
}

function ensureColumn(tableName, columnName, columnType) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}

function dedupeDatabaseRows() {
  db.exec(`
    DELETE FROM records
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM records
      GROUP BY CASE
        WHEN normalized_source_url IS NOT NULL AND normalized_source_url != '' THEN 'source:' || normalized_source_url
        ELSE 'record:' || record_id
      END
    );
    DELETE FROM records
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM records
      GROUP BY CASE
        WHEN source_image_url IS NOT NULL AND source_image_url != '' THEN 'image:' || source_image_url
        ELSE 'record:' || record_id
      END
    );
  `);
}

function normalizeSceneSetting(value) {
  const normalized = String(value || "").trim();
  return !normalized || normalized === "unknown" ? "indoor" : normalized;
}

function normalizeExistingSceneSettings() {
  db.prepare("UPDATE records SET scene_setting = 'indoor' WHERE scene_setting IS NULL OR TRIM(scene_setting) = '' OR scene_setting = 'unknown'").run();
}

function readManifestRows(manifestPath = MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }

  const content = fs.readFileSync(manifestPath, "utf8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true
  });
  return rows;
}

function syncManifestToDatabase() {
  initDatabase();
  const rows = readManifestRows();
  return importRowsToDatabase(rows, path.dirname(MANIFEST_PATH), "");
}

function importRowsToDatabase(rows, sourceBaseDir, imagePathPrefix) {
  initDatabase();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO records (
      record_id, row_number, source_type, source_platform, source_url, normalized_source_url,
      source_image_url, fetched_at, query, title, author, license_type, license_url, image_path,
      width, height, short_edge, scene_setting, complexity_level, risk_flag, notes,
      payload, manifest_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      row_number=excluded.row_number,
      source_type=excluded.source_type,
      source_platform=excluded.source_platform,
      source_url=excluded.source_url,
      normalized_source_url=excluded.normalized_source_url,
      source_image_url=excluded.source_image_url,
      fetched_at=excluded.fetched_at,
      query=excluded.query,
      title=excluded.title,
      author=excluded.author,
      license_type=excluded.license_type,
      license_url=excluded.license_url,
      image_path=excluded.image_path,
      width=excluded.width,
      height=excluded.height,
      short_edge=excluded.short_edge,
      scene_setting=excluded.scene_setting,
      complexity_level=excluded.complexity_level,
      risk_flag=excluded.risk_flag,
      notes=excluded.notes,
      payload=excluded.payload,
      manifest_seen_at=excluded.manifest_seen_at,
      updated_at=excluded.updated_at
  `);
  const duplicateLookup = db.prepare(`
    SELECT record_id FROM records
    WHERE record_id != ?
      AND (
        (normalized_source_url = ? AND ? != '')
        OR (source_image_url = ? AND ? != '')
      )
    LIMIT 1
  `);
  const existingRecordLookup = db.prepare("SELECT record_id FROM records WHERE record_id = ? LIMIT 1");
  const dedupeLookup = db.prepare(`
    SELECT key_type, key_value FROM dedupe_keys
    WHERE (key_type = 'source_url' AND key_value = ? AND ? != '')
       OR (key_type = 'image_url' AND key_value = ? AND ? != '')
    LIMIT 1
  `);

  db.exec("BEGIN");
  let imported = 0;
  let skippedDuplicates = 0;
  let existingRecords = 0;
  try {
    rows.forEach((row, index) => {
      const recordId = row.record_id || `${index + 1}`;
      if (imagePathPrefix) {
        const shortEdge = parseInteger(row.short_edge) || 0;
        if (row.risk_flag || shortEdge < 512) {
          skippedDuplicates += 1;
          return;
        }
      }
      const preparedRow = prepareImportedRow(row, sourceBaseDir, imagePathPrefix);
      const normalizedSourceUrl = dedupeValue(preparedRow.normalized_source_url || preparedRow.source_url || "");
      const sourceImageUrl = dedupeValue(preparedRow.source_image_url || "");
      const existingRecord = imagePathPrefix ? existingRecordLookup.get(recordId) : null;
      const duplicate = duplicateLookup.get(
        recordId,
        normalizedSourceUrl,
        normalizedSourceUrl,
        sourceImageUrl,
        sourceImageUrl
      );
      const dedupeDuplicate = dedupeLookup.get(normalizedSourceUrl, normalizedSourceUrl, sourceImageUrl, sourceImageUrl);
      if (existingRecord) {
        existingRecords += 1;
        return;
      }
      if (duplicate || dedupeDuplicate) {
        skippedDuplicates += 1;
        return;
      }
      const rowNumber =
        Number(preparedRow.row_number || 0) ||
        (!imagePathPrefix
          ? index + 1
          : Number(db.prepare("SELECT COALESCE(MAX(row_number), 0) + 1 AS next_row_number FROM records").get().next_row_number));
      insert.run(
        recordId,
        rowNumber,
        preparedRow.source_type || "",
        preparedRow.source_platform || "",
        preparedRow.source_url || "",
        preparedRow.normalized_source_url || "",
        preparedRow.source_image_url || "",
        preparedRow.fetched_at || "",
        preparedRow.query || "",
        preparedRow.title || "",
        preparedRow.author || "",
        preparedRow.license_type || "",
        preparedRow.license_url || "",
        preparedRow.image_path || "",
        parseInteger(preparedRow.width),
        parseInteger(preparedRow.height),
        parseInteger(preparedRow.short_edge),
        normalizeSceneSetting(preparedRow.scene_setting),
        preparedRow.complexity_level || "",
        preparedRow.risk_flag || "",
        preparedRow.notes || "",
        JSON.stringify(preparedRow),
        now,
        now
      );
      imported += 1;
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { seen: rows.length, imported, skippedDuplicates, existingRecords };
}

function dedupeValue(value) {
  return String(value || "").trim();
}

function upsertDedupeKeys(record, source = "records") {
  const now = new Date().toISOString();
  const insertKey = db.prepare(
    "INSERT OR IGNORE INTO dedupe_keys (key_type, key_value, source, created_at) VALUES (?, ?, ?, ?)"
  );
  const sourceUrl = dedupeValue(record.normalized_source_url || record.source_url || "");
  const imageUrl = dedupeValue(record.source_image_url || "");
  if (sourceUrl) insertKey.run("source_url", sourceUrl, source, now);
  if (imageUrl) insertKey.run("image_url", imageUrl, source, now);
}

function backfillExportedDedupeKeys() {
  const rows = db
    .prepare(
      "SELECT record_id, normalized_source_url, source_url, source_image_url FROM records WHERE exported_at IS NOT NULL"
    )
    .all();
  rows.forEach((row) => upsertDedupeKeys(row, `exported:${row.record_id}`));
  return rows.length;
}

function migrateDedupeKeysToExportedOnly() {
  if (getSetting("dedupe_exported_only_migrated_v1", false)) {
    backfillExportedDedupeKeys();
    return;
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM dedupe_keys").run();
    backfillExportedDedupeKeys();
    setSetting("dedupe_exported_only_migrated_v1", true);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function prepareImportedRow(row, sourceBaseDir, imagePathPrefix) {
  if (!imagePathPrefix || !row.image_path) return row;
  const sourcePath = path.resolve(sourceBaseDir, row.image_path);
  const relativePath = path.posix.join(imagePathPrefix, row.image_path.replaceAll(path.sep, "/"));
  const destPath = path.resolve(WORKSPACE_ROOT, relativePath);
  if (fs.existsSync(sourcePath) && !fs.existsSync(destPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  }
  return { ...row, image_path: relativePath };
}

function parseInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowFromDatabase(row) {
  const payload = JSON.parse(row.payload || "{}");
  const imagePath = payload.image_path || row.image_path || "";
  const absoluteImagePath = resolveImagePath(imagePath);
  const imageExists = imagePath ? fs.existsSync(absoluteImagePath) : false;
  const sourceImageUrl = row.source_image_url || payload.source_image_url || "";
  const sceneSetting = normalizeSceneSetting(row.scene_setting || payload.scene_setting);

  return {
    ...payload,
    record_id: row.record_id,
    source_type: row.source_type || payload.source_type || "",
    source_platform: row.source_platform || payload.source_platform || "",
    source_url: row.source_url || payload.source_url || "",
    normalized_source_url: row.normalized_source_url || payload.normalized_source_url || "",
    source_image_url: sourceImageUrl,
    fetched_at: row.fetched_at || payload.fetched_at || "",
    query: row.query || payload.query || "",
    title: row.title || payload.title || "",
    author: row.author || payload.author || "",
    license_type: row.license_type || payload.license_type || "",
    license_url: row.license_url || payload.license_url || "",
    image_path: imagePath,
    width: String(row.width ?? payload.width ?? ""),
    height: String(row.height ?? payload.height ?? ""),
    short_edge: String(row.short_edge ?? payload.short_edge ?? ""),
    scene_setting: sceneSetting,
    complexity_level: row.complexity_level || payload.complexity_level || "",
    risk_flag: row.risk_flag || payload.risk_flag || "",
    notes: row.notes || payload.notes || "",
    id: row.record_id,
    row_number: row.row_number,
    exported_at: row.exported_at || "",
    deleted_at: row.deleted_at || "",
    image_exists: imageExists,
    image_api_url: imageExists ? `/api/image/${encodeURIComponent(row.record_id)}` : sourceImageUrl,
    scene_cn: sceneLabel(sceneSetting),
    created_at: formatShanghai(row.fetched_at || payload.fetched_at),
    operator: AUTHOR,
    duplicate_flag: "不重复"
  };
}

function resolveImagePath(imagePath) {
  if (!imagePath) return "";
  const workspacePath = path.resolve(WORKSPACE_ROOT, imagePath);
  if (fs.existsSync(workspacePath)) return workspacePath;
  return path.resolve(path.dirname(MANIFEST_PATH), imagePath);
}

function readRecordsFromDatabase() {
  const rows = db.prepare("SELECT * FROM records WHERE deleted_at IS NULL ORDER BY row_number ASC").all();
  return rows.map(rowFromDatabase);
}

function getRecordById(recordId) {
  const row = db.prepare("SELECT * FROM records WHERE record_id = ?").get(recordId);
  return row ? rowFromDatabase(row) : null;
}

function markRecordsExported(recordIds) {
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE records SET exported_at = ? WHERE record_id = ?");
  const select = db.prepare("SELECT record_id, normalized_source_url, source_url, source_image_url FROM records WHERE record_id = ?");
  db.exec("BEGIN");
  try {
    recordIds.forEach((id) => {
      update.run(now, id);
      const row = select.get(id);
      if (row) upsertDedupeKeys(row, `exported:${id}`);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return now;
}

function deleteRecords(recordIds) {
  const now = new Date().toISOString();
  const remove = db.prepare("UPDATE records SET deleted_at = ? WHERE record_id = ?");
  db.exec("BEGIN");
  try {
    recordIds.forEach((id) => remove.run(now, id));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function databaseStats() {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN exported_at IS NULL THEN 1 ELSE 0 END) AS unexported, SUM(CASE WHEN exported_at IS NOT NULL THEN 1 ELSE 0 END) AS exported FROM records WHERE deleted_at IS NULL"
    )
    .get();
  const dedupe = db.prepare("SELECT COUNT(*) AS total FROM dedupe_keys").get();
  return {
    total: Number(row.total || 0),
    unexported: Number(row.unexported || 0),
    exported: Number(row.exported || 0),
    dedupeKeys: Number(dedupe.total || 0)
  };
}

function clearDatabase({ clearDedupeKeys = false, clearJobs = false } = {}) {
  db.exec("BEGIN");
  try {
    const recordsDeleted = db.prepare("DELETE FROM records").run().changes;
    const jobsDeleted = clearJobs ? db.prepare("DELETE FROM crawl_jobs").run().changes : 0;
    const dedupeDeleted = clearDedupeKeys ? db.prepare("DELETE FROM dedupe_keys").run().changes : 0;
    db.exec("COMMIT");
    return { recordsDeleted, jobsDeleted, dedupeDeleted };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function exportBackupPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: "desktop-scene-review-app",
    databasePath: DB_PATH,
    records: db.prepare("SELECT * FROM records ORDER BY row_number ASC").all(),
    crawlJobs: db.prepare("SELECT * FROM crawl_jobs ORDER BY started_at ASC").all(),
    dedupeKeys: db.prepare("SELECT * FROM dedupe_keys ORDER BY created_at ASC").all()
  };
}

function exportDedupePayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: "desktop-scene-review-app",
    keys: db.prepare("SELECT key_type, key_value, source, created_at FROM dedupe_keys ORDER BY created_at ASC").all()
  };
}

function importDedupeKeys(payload) {
  const keys = Array.isArray(payload?.keys)
    ? payload.keys
    : Array.isArray(payload?.dedupeKeys)
      ? payload.dedupeKeys
      : [];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO dedupe_keys (key_type, key_value, source, created_at) VALUES (?, ?, ?, ?)"
  );
  let imported = 0;
  let skipped = 0;
  db.exec("BEGIN");
  try {
    keys.forEach((key) => {
      const keyType = String(key.key_type || key.type || "").trim();
      const keyValue = dedupeValue(key.key_value || key.value || "");
      if (!["source_url", "image_url"].includes(keyType) || !keyValue) {
        skipped += 1;
        return;
      }
      const result = insert.run(
        keyType,
        keyValue,
        String(key.source || "imported"),
        key.created_at || new Date().toISOString()
      );
      if (result.changes) imported += 1;
      else skipped += 1;
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { seen: keys.length, imported, skipped };
}

function getSetting(key, fallbackValue = null) {
  const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(key);
  if (!row) return fallbackValue;
  try {
    return JSON.parse(row.setting_value);
  } catch {
    return fallbackValue;
  }
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET
       setting_value=excluded.setting_value,
       updated_at=excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

function getRemoteDedupeConfig() {
  const config = getSetting("remote_dedupe", {});
  return {
    enabled: Boolean(config.enabled),
    provider: "github",
    repo: String(config.repo || DEFAULT_GITHUB_DEDUPE_REPO || "").trim(),
    branch: String(config.branch || "main").trim() || "main",
    filePath: String(config.filePath || "dedupe_keys.json").trim() || "dedupe_keys.json",
    token: String(config.token || "").trim(),
    lastPulledAt: config.lastPulledAt || "",
    lastPushedAt: config.lastPushedAt || "",
    lastError: config.lastError || ""
  };
}

function saveRemoteDedupeConfig(configPatch) {
  const current = getRemoteDedupeConfig();
  const next = {
    ...current,
    ...configPatch,
    provider: "github",
    repo: String(configPatch.repo ?? current.repo ?? "").trim(),
    branch: String(configPatch.branch ?? current.branch ?? "main").trim() || "main",
    filePath: String(configPatch.filePath ?? current.filePath ?? "dedupe_keys.json").trim() || "dedupe_keys.json",
    token: String(configPatch.token ?? current.token ?? "").trim()
  };
  setSetting("remote_dedupe", next);
  return next;
}

function publicRemoteConfig(config) {
  return { ...config, token: config.token ? "******" : "" };
}

function parseGitHubRepo(value) {
  const match = String(value || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error("GitHub 仓库格式应为 owner/repo");
  return { owner: match[1], repo: match[2] };
}

function githubHeaders(config) {
  const headers = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "desktop-scene-review-app",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return headers;
}

function githubContentsUrl(config) {
  const { owner, repo } = parseGitHubRepo(config.repo);
  const cleanPath = config.filePath.replace(/^\/+/, "");
  const encodedPath = cleanPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

async function readGitHubDedupeFile(config) {
  const response = await fetch(`${githubContentsUrl(config)}?ref=${encodeURIComponent(config.branch)}`, {
    headers: githubHeaders(config)
  });
  if (response.status === 404) {
    return { payload: { version: 1, keys: [] }, sha: null, exists: false };
  }
  if (!response.ok) throw new Error(`读取 GitHub 去重库失败：HTTP ${response.status}`);
  const data = await response.json();
  const content = Buffer.from(String(data.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  return {
    payload: content ? JSON.parse(content) : { version: 1, keys: [] },
    sha: data.sha,
    exists: true
  };
}

async function writeGitHubDedupeFile(config, payload, sha) {
  if (!config.token) throw new Error("推送 GitHub 去重库需要填写 Token");
  const response = await fetch(githubContentsUrl(config), {
    method: "PUT",
    headers: githubHeaders(config),
    body: JSON.stringify({
      message: `Update dedupe keys ${new Date().toISOString()}`,
      branch: config.branch,
      sha: sha || undefined,
      content: Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString("base64")
    })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`写入 GitHub 去重库失败：HTTP ${response.status}${body.message ? ` ${body.message}` : ""}`);
  }
  return response.json();
}

function validateRemoteDedupeConfig(config, { requireToken = false } = {}) {
  if (!config.repo) throw new Error("请填写 GitHub 仓库，格式为 owner/repo");
  parseGitHubRepo(config.repo);
  if (!config.branch) throw new Error("请填写 GitHub 分支");
  if (!config.filePath) throw new Error("请填写去重库 JSON 路径");
  if (requireToken && !config.token) throw new Error("开启自动推送需要填写 GitHub Token");
}

async function pullRemoteDedupe({ force = false } = {}) {
  const config = getRemoteDedupeConfig();
  if (!force && !config.enabled) return { skipped: true, reason: "remote dedupe disabled", config };
  validateRemoteDedupeConfig(config);

  const remoteFile = await readGitHubDedupeFile(config);
  const result = importDedupeKeys(remoteFile.payload);
  const nextConfig = saveRemoteDedupeConfig({ lastPulledAt: new Date().toISOString(), lastError: "" });
  return { ...result, exists: remoteFile.exists, config: nextConfig };
}

async function pushRemoteDedupe({ force = false, retry = true } = {}) {
  const config = getRemoteDedupeConfig();
  if (!force && !config.enabled) return { skipped: true, reason: "remote dedupe disabled", config };
  validateRemoteDedupeConfig(config, { requireToken: true });

  const remoteFile = await readGitHubDedupeFile(config);
  importDedupeKeys(remoteFile.payload);
  const payload = exportDedupePayload();
  try {
    await writeGitHubDedupeFile(config, payload, remoteFile.sha);
  } catch (error) {
    if (!retry || !String(error.message).includes("HTTP 409")) throw error;
    const latest = await readGitHubDedupeFile(config);
    importDedupeKeys(latest.payload);
    await writeGitHubDedupeFile(config, exportDedupePayload(), latest.sha);
  }
  const nextConfig = saveRemoteDedupeConfig({ lastPushedAt: new Date().toISOString(), lastError: "" });
  return { seen: payload.keys.length, pushed: payload.keys.length, skipped: 0, config: nextConfig };
}

async function syncRemoteDedupeAfterExport(exportedCount) {
  const config = getRemoteDedupeConfig();
  if (!config.enabled || exportedCount <= 0) return;
  try {
    const result = await pushRemoteDedupe();
    return `remote dedupe pushed exported=${exportedCount} pushed=${result.pushed || 0}\n`;
  } catch (error) {
    const message = `remote dedupe push failed: ${error.message}\n`;
    saveRemoteDedupeConfig({ lastError: error.message });
    return message;
  }
}

function createCrawlJob({ provider, query, limitCount }) {
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const outputDir = path.join(COLLECTION_ROOT, jobId);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO crawl_jobs (job_id, status, provider, query, limit_count, output_dir, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(jobId, "queued", provider, query, limitCount, outputDir, now);
  return { jobId, outputDir };
}

function updateJob(jobId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE crawl_jobs SET ${assignments} WHERE job_id = ?`).run(...keys.map((key) => patch[key]), jobId);
}

function appendJobLog(jobId, text) {
  if (!text) return;
  db.prepare("UPDATE crawl_jobs SET log = COALESCE(log, '') || ? WHERE job_id = ?").run(text, jobId);
}

function parseCrawlerSummary(log) {
  const match = log.match(/done provider=\S+ processed=(\d+) kept=(\d+) flagged=(\d+) duplicates_skipped=(\d+) manifest=(\S+)/);
  if (!match) return {};
  return {
    progress_processed: Number(match[1]),
    kept: Number(match[2]),
    flagged: Number(match[3]),
    duplicates_skipped: Number(match[4]),
    manifest_path: match[5]
  };
}

function applyCrawlerProgress(jobId, text) {
  const matches = [...text.matchAll(/progress provider=\S+ processed=(\d+) kept=(\d+) flagged=(\d+) duplicates_skipped=(\d+) manifest=(\S+)/g)];
  if (!matches.length) return "";
  const match = matches[matches.length - 1];
  updateJob(jobId, {
    progress_processed: Number(match[1]),
    kept: Number(match[2]),
    flagged: Number(match[3]),
    duplicates_skipped: Number(match[4]),
    manifest_path: match[5],
    last_progress_at: new Date().toISOString()
  });
  return match[5];
}

function importRunningCrawlManifest(jobId, outputDir, manifestPath, { force = false } = {}) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return;
  const active = activeJobs.get(jobId);
  if ((!active && !force) || active?.importRunning) return;
  const now = Date.now();
  if (!force && active?.lastImportAt && now - active.lastImportAt < 2000) return;

  if (active) {
    active.importRunning = true;
    active.lastImportAt = now;
  }
  try {
    const rows = readManifestRows(manifestPath);
    const result = importRowsToDatabase(rows, outputDir, path.posix.join("data/app_collections", jobId));
    if (result.imported) {
      const current = db
        .prepare("SELECT imported, skipped_duplicates FROM crawl_jobs WHERE job_id = ?")
        .get(jobId) || { imported: 0, skipped_duplicates: 0 };
      updateJob(jobId, {
        imported: Number(current.imported || 0) + Number(result.imported || 0)
      });
      appendJobLog(jobId, `incremental import imported=${result.imported}\n`);
    }
  } catch (error) {
    appendJobLog(jobId, `incremental import skipped: ${error.message}\n`);
  } finally {
    if (active) active.importRunning = false;
  }
}

function startCrawlJob(jobId, outputDir, provider, query, limitCount) {
  if (activeJobs.has(jobId)) return;
  fs.mkdirSync(outputDir, { recursive: true });
  updateJob(jobId, { status: "running" });

  const args = [
    CRAWLER_PATH,
    "collect",
    "--provider",
    provider,
    "--query",
    query,
    "--limit",
    String(limitCount),
    "--output-dir",
    outputDir,
    "--sleep",
    "0.01",
    "--progress-every",
    "2",
    "--skip-image-download",
    "--exclude-manifest",
    MANIFEST_PATH
  ];

  const child = spawn(PYTHON_PATH, args, { cwd: WORKSPACE_ROOT });
  activeJobs.set(jobId, { child, lastImportAt: 0, importRunning: false });
  let log = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    log += text;
    appendJobLog(jobId, text);
    const manifestPath = applyCrawlerProgress(jobId, text);
    importRunningCrawlManifest(jobId, outputDir, manifestPath);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    log += text;
    appendJobLog(jobId, text);
    const manifestPath = applyCrawlerProgress(jobId, text);
    importRunningCrawlManifest(jobId, outputDir, manifestPath);
  });
  child.on("error", (error) => {
    activeJobs.delete(jobId);
    const current = db.prepare("SELECT status FROM crawl_jobs WHERE job_id = ?").get(jobId);
    if (current?.status === "canceled") return;
    updateJob(jobId, { status: "failed", finished_at: new Date().toISOString(), error: error.message });
  });
  child.on("close", async (code) => {
    activeJobs.delete(jobId);
    const current = db.prepare("SELECT status FROM crawl_jobs WHERE job_id = ?").get(jobId);
    if (current?.status === "canceled") {
      const manifestPath = db.prepare("SELECT manifest_path FROM crawl_jobs WHERE job_id = ?").get(jobId)?.manifest_path || path.join(outputDir, "manifest.csv");
      importRunningCrawlManifest(jobId, outputDir, manifestPath, { force: true });
      appendJobLog(jobId, "crawl canceled by user\n");
      return;
    }
    const summary = parseCrawlerSummary(log);
    const manifestPath = summary.manifest_path || path.join(outputDir, "manifest.csv");
    const currentCounts =
      db.prepare("SELECT imported, skipped_duplicates FROM crawl_jobs WHERE job_id = ?").get(jobId) || {
        imported: 0,
        skipped_duplicates: 0
      };
    let imported = Number(currentCounts.imported || 0);
    let skippedDuplicates = Number(currentCounts.skipped_duplicates || 0);
    let error = "";

    if (code === 0) {
      try {
        const rows = fs.existsSync(manifestPath) ? readManifestRows(manifestPath) : [];
        const result = importRowsToDatabase(rows, outputDir, path.posix.join("data/app_collections", jobId));
        imported += result.imported;
        skippedDuplicates += result.skippedDuplicates;
      } catch (importError) {
        error = importError.message;
      }
    } else {
      error = `crawler exited with code ${code}`;
    }

    updateJob(jobId, {
      status: code === 0 && !error ? "completed" : "failed",
      finished_at: new Date().toISOString(),
      kept: summary.kept || 0,
      flagged: summary.flagged || 0,
      duplicates_skipped: summary.duplicates_skipped || 0,
      progress_processed: summary.progress_processed || 0,
      imported,
      skipped_duplicates: skippedDuplicates,
      manifest_path: manifestPath,
      error
    });
  });
}

function listJobs() {
  return db.prepare(`
    SELECT * FROM crawl_jobs
    ORDER BY
      CASE WHEN status IN ('queued', 'running') THEN 0 ELSE 1 END,
      started_at DESC
    LIMIT 200
  `).all();
}

function cancelCrawlJob(jobId) {
  const job = db.prepare("SELECT * FROM crawl_jobs WHERE job_id = ?").get(jobId);
  if (!job) {
    return { ok: false, status: 404, message: "任务不存在" };
  }
  if (["completed", "failed", "canceled"].includes(job.status)) {
    return { ok: false, status: 400, message: `任务已结束：${job.status}` };
  }

  const active = activeJobs.get(jobId);
  const manifestPath = job.manifest_path || path.join(job.output_dir, "manifest.csv");
  importRunningCrawlManifest(jobId, job.output_dir, manifestPath, { force: true });
  updateJob(jobId, {
    status: "canceled",
    finished_at: new Date().toISOString(),
    error: "canceled by user"
  });
  appendJobLog(jobId, "cancel requested by user\n");
  if (active?.child) {
    active.child.kill("SIGTERM");
  }
  activeJobs.delete(jobId);
  return { ok: true, canceled: true };
}

function sceneLabel(value) {
  const scene = normalizeSceneSetting(value);
  return SCENE_LABELS[scene] ?? scene;
}

function formatShanghai(isoValue) {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return isoValue;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function imagePathForRecord(record) {
  if (!record?.image_path) return "";
  return resolveImagePath(record.image_path);
}

function getValue(record, fieldKey, autoNumber) {
  if (fieldKey === "auto_number") return autoNumber;
  if (fieldKey === "thumbnail") return "";
  if (fieldKey === "scene_cn") return record.scene_cn;
  if (fieldKey === "created_at") return record.created_at;
  if (fieldKey === "operator") return AUTHOR;
  if (fieldKey === "duplicate_flag") return "不重复";
  if (["width", "height", "short_edge"].includes(fieldKey)) {
    const value = Number(record[fieldKey]);
    return Number.isFinite(value) ? value : "";
  }
  return record[fieldKey] ?? "";
}

function filterRows(rows, query) {
  const q = String(query.q || "").trim().toLowerCase();
  const platform = String(query.platform || "").trim();
  const scene = String(query.scene || "").trim();
  const risk = String(query.risk || "all");
  const exportStatus = String(query.exportStatus || "unexported");

  return rows.filter((row) => {
    if (exportStatus === "unexported" && row.exported_at) return false;
    if (exportStatus === "exported" && !row.exported_at) return false;
    if (platform && row.source_platform !== platform) return false;
    if (scene && row.scene_setting !== scene) return false;
    if (risk === "onlyRisk" && !row.risk_flag) return false;
    if (risk === "noRisk" && row.risk_flag) return false;
    if (!q) return true;
    const haystack = [
      row.record_id,
      row.source_platform,
      row.source_url,
      row.source_image_url,
      row.query,
      row.title,
      row.author,
      row.license_type,
      row.exported_at,
      row.notes
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

async function buildExcel(records, fieldKeys) {
  const defs = fieldKeys.map((key) => FIELD_DEFS.find((field) => field.key === key)).filter(Boolean);
  if (!defs.length) throw new Error("至少选择一个字段");

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "desktop-scene-review-app";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("桌面场景标注", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  sheet.columns = defs.map((field) => ({
    header: field.label,
    key: field.key,
    width: field.width
  }));

  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FF1F2328" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F7F9" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = thinBorder();
  });

  records.forEach((record, index) => {
    const values = {};
    defs.forEach((field) => {
      const value = getValue(record, field.key, index + 1);
      values[field.key] = field.hyperlink && value ? { text: String(value), hyperlink: String(value) } : value;
    });
    const row = sheet.addRow(values);
    row.height = fieldKeys.includes("thumbnail") ? 70 : 28;
    row.eachCell((cell, colNumber) => {
      const field = defs[colNumber - 1];
      cell.font = field?.hyperlink
        ? { name: "Arial", size: 11, color: { argb: "FF0969DA" }, underline: true }
        : { name: "Arial", size: 11, color: { argb: "FF1F2328" } };
      cell.alignment = { vertical: "middle", horizontal: field?.numeric ? "right" : "left", wrapText: false };
      cell.border = thinBorder();
    });
  });

  const thumbnailCol = defs.findIndex((field) => field.key === "thumbnail");
  if (thumbnailCol >= 0) {
    records.forEach((record, index) => {
      const filePath = imagePathForRecord(record);
      if (!filePath || !fs.existsSync(filePath)) return;
      const ext = path.extname(filePath).toLowerCase().replace(".", "");
      if (!["jpeg", "jpg", "png"].includes(ext)) return;
      const imageId = workbook.addImage({
        buffer: fs.readFileSync(filePath),
        extension: ext === "jpg" ? "jpeg" : ext
      });
      sheet.addImage(imageId, {
        tl: { col: thumbnailCol + 0.15, row: index + 1.15 },
        ext: { width: 118, height: 82 },
        editAs: "oneCell"
      });
    });
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(records.length + 1, 1), column: defs.length }
  };

  return workbook.xlsx.writeBuffer();
}

function thinBorder() {
  return {
    top: { style: "thin", color: { argb: "FFDADDE1" } },
    left: { style: "thin", color: { argb: "FFDADDE1" } },
    bottom: { style: "thin", color: { argb: "FFDADDE1" } },
    right: { style: "thin", color: { argb: "FFDADDE1" } }
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/api/meta", (_req, res) => {
  try {
    initDatabase();
    const rows = readRecordsFromDatabase();
    const platforms = [...new Set(rows.map((row) => row.source_platform).filter(Boolean))].sort();
    const stats = databaseStats();
    res.json({
      manifestPath: MANIFEST_PATH,
      databasePath: DB_PATH,
      total: stats.total,
      unexported: stats.unexported,
      exported: stats.exported,
      dedupeKeys: stats.dedupeKeys,
      fields: FIELD_DEFS,
      defaultFields: DEFAULT_FIELDS,
      platforms,
      scenes: [
        { value: "indoor", label: "室内" },
        { value: "outdoor", label: "室外" },
        { value: "semi_outdoor", label: "半户外" }
      ]
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/source-catalog", (_req, res) => {
  const sources = SOURCE_CATALOG
    .filter((source) => !source.requiresApiKey || apiKeyConfigured(source))
    .map((source) => ({ ...source, ...directCrawlInfo(source) }));
  const counts = {
    total: sources.length,
    noKey: sources.filter((source) => !source.requiresApiKey).length,
    direct: sources.filter((source) => source.directCrawl).length,
    directNoKey: sources.filter((source) => source.directCrawl && !source.requiresApiKey).length,
    promptOnly: sources.filter((source) => !source.directCrawl).length
  };
  res.json({
    sources,
    counts,
    tiers: [
      { value: "S", label: "S 级", description: "最适合长期主源：可追溯、许可清晰、真实照片比例高" },
      { value: "A", label: "A 级", description: "适合稳定扩展：质量高或覆盖广；需要 API Key 的来源未配置时会隐藏" },
      { value: "B", label: "B 级", description: "适合专项补充：题型明确时很好用，需更强过滤" },
      { value: "C", label: "C 级", description: "只做补漏：产量低或噪声高" }
    ],
    taskTypes: [
      "桌面/台面局部场景",
      "食物/餐桌/厨房",
      "办公/电脑/学习桌",
      "户外/露台/野餐",
      "商品生活方式场景",
      "通用真实照片",
      "长尾物体/特殊类别"
    ]
  });
});

app.get("/api/admin/backup", (_req, res) => {
  try {
    initDatabase();
    const filename = encodeURIComponent(`desktop-scene-review-backup-${Date.now()}.json`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.send(JSON.stringify(exportBackupPayload(), null, 2));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/admin/clear", (req, res) => {
  try {
    initDatabase();
    const result = clearDatabase({
      clearDedupeKeys: Boolean(req.body.clearDedupeKeys),
      clearJobs: Boolean(req.body.clearJobs)
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/admin/dedupe/export", (_req, res) => {
  try {
    initDatabase();
    const filename = encodeURIComponent(`desktop-scene-dedupe-keys-${Date.now()}.json`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.send(JSON.stringify(exportDedupePayload(), null, 2));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/admin/dedupe/import", (req, res) => {
  try {
    initDatabase();
    const result = importDedupeKeys(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/admin/remote-dedupe", (_req, res) => {
  try {
    initDatabase();
    const config = getRemoteDedupeConfig();
    res.json({ config: publicRemoteConfig(config) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/admin/remote-dedupe", (req, res) => {
  try {
    initDatabase();
    const current = getRemoteDedupeConfig();
    const tokenInput = String(req.body.token ?? "").trim();
    const token = tokenInput === "******" ? current.token : tokenInput;
    const enabled = Boolean(req.body.enabled);
    const candidate = {
      enabled,
      repo: req.body.repo,
      branch: req.body.branch,
      filePath: req.body.filePath,
      token,
      lastError: ""
    };
    if (enabled) validateRemoteDedupeConfig({ ...current, ...candidate }, { requireToken: true });
    const config = saveRemoteDedupeConfig(candidate);
    res.json({ config: publicRemoteConfig(config) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post("/api/admin/remote-dedupe/pull", async (_req, res) => {
  try {
    initDatabase();
    const result = await pullRemoteDedupe({ force: true });
    res.json({ ...result, config: publicRemoteConfig(result.config) });
  } catch (error) {
    saveRemoteDedupeConfig({ lastError: error.message });
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/admin/remote-dedupe/push", async (_req, res) => {
  try {
    initDatabase();
    const result = await pushRemoteDedupe({ force: true });
    res.json({ ...result, config: publicRemoteConfig(result.config) });
  } catch (error) {
    saveRemoteDedupeConfig({ lastError: error.message });
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/crawl/jobs", (_req, res) => {
  try {
    res.json({ jobs: listJobs() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/crawl/jobs/:jobId", (req, res) => {
  try {
    const job = db.prepare("SELECT * FROM crawl_jobs WHERE job_id = ?").get(req.params.jobId);
    if (!job) {
      res.status(404).json({ message: "任务不存在" });
      return;
    }
    res.json({ job });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/crawl/jobs/:jobId/cancel", (req, res) => {
  try {
    initDatabase();
    const result = cancelCrawlJob(req.params.jobId);
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/crawl/start", async (req, res) => {
  try {
    initDatabase();
    const providersInput = Array.isArray(req.body.providers) ? req.body.providers : [req.body.provider];
    const providers = [...new Set(providersInput.map((item) => String(item || "").trim()).filter(Boolean))];
    const query = String(req.body.query || "").trim();
    const rawLimit = Number(req.body.limit || 20);
    const limitCount = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;
    if (!providers.length) {
      res.status(400).json({ message: "请选择已支持的来源 provider" });
      return;
    }
    if (!query) {
      res.status(400).json({ message: "请输入关键词" });
      return;
    }

    const sources = [];
    for (const provider of providers) {
      const source = SOURCE_CATALOG.find((item) => item.provider === provider);
      if (!source) {
        res.status(400).json({ message: `请选择已支持的来源 provider：${provider}` });
        return;
      }
      if (source.requiresApiKey && !apiKeyConfigured(source)) {
        res.status(400).json({ message: `${source.name} 需要 API Key：${source.apiKeyEnv || "未配置"}` });
        return;
      }
      const crawlInfo = directCrawlInfo(source);
      if (!crawlInfo.directCrawl) {
        res.status(400).json({ message: `${source.name} 不支持前端直接采集：${crawlInfo.disabledReason}。请使用提示词或换一个已集成网站。` });
        return;
      }
      sources.push(source);
    }

    const remoteConfig = getRemoteDedupeConfig();
    if (remoteConfig.enabled) {
      await pullRemoteDedupe({ force: true });
    }
    const jobs = sources.map((source) => {
      const { jobId, outputDir } = createCrawlJob({ provider: source.provider, query, limitCount });
      startCrawlJob(jobId, outputDir, source.provider, query, limitCount);
      return { jobId, provider: source.provider, name: source.name };
    });
    res.json({ jobIds: jobs.map((job) => job.jobId), jobs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/records", (req, res) => {
  try {
    initDatabase();
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 60), 1), 300);
    const rows = filterRows(readRecordsFromDatabase(), req.query);
    const start = (page - 1) * pageSize;
    res.json({
      total: rows.length,
      page,
      pageSize,
      records: rows.slice(start, start + pageSize)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/image/:recordId", (req, res) => {
  try {
    const record = getRecordById(req.params.recordId);
    const filePath = imagePathForRecord(record);
    if (!record || !filePath || !fs.existsSync(filePath)) {
      res.status(404).send("image not found");
      return;
    }
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.delete("/api/records", (req, res) => {
  try {
    const selectedIds = Array.isArray(req.body.selectedIds) ? req.body.selectedIds.map(String) : [];
    if (!selectedIds.length) {
      res.status(400).json({ message: "请先选择要删除的记录" });
      return;
    }
    deleteRecords(selectedIds);
    res.json({ deleted: selectedIds.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/records/delete-all", (req, res) => {
  try {
    const rows = filterRows(readRecordsFromDatabase(), req.body.filters || {});
    const recordIds = rows.map((row) => row.id);
    deleteRecords(recordIds);
    res.json({ deleted: recordIds.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/export", async (req, res) => {
  try {
    initDatabase();
    const selectedIds = Array.isArray(req.body.selectedIds) ? req.body.selectedIds.map(String) : [];
    const fieldKeys = Array.isArray(req.body.fields) ? req.body.fields.map(String) : DEFAULT_FIELDS;
    const exportAll = Boolean(req.body.exportAll);
    if (!exportAll && !selectedIds.length) {
      res.status(400).json({ message: "请先选择图片" });
      return;
    }

    const allRows = readRecordsFromDatabase();
    const rowMap = new Map(allRows.map((row) => [row.id, row]));
    const records = exportAll
      ? filterRows(allRows, req.body.filters || {})
      : selectedIds.map((id) => rowMap.get(id)).filter(Boolean);
    if (!records.length) {
      res.status(400).json({ message: "未找到可导出的记录" });
      return;
    }

    const buffer = await buildExcel(records, fieldKeys);
    markRecordsExported(records.map((record) => record.id));
    await syncRemoteDedupeAfterExport(records.length);
    const filename = encodeURIComponent(`桌面场景图片标注表_${AUTHOR}_${exportAll ? "全部" : "自选"}_${records.length}条.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  initDatabase();
  console.log(`desktop-scene-review server: http://127.0.0.1:${PORT}`);
  console.log(`database: ${DB_PATH}`);
  console.log("manifest auto-sync: disabled");
});
