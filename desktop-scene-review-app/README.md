# 桌面场景图片筛选导出工具

React + Ant Design 前端，Express 后端。默认以本地 SQLite 为准，不再自动导入旧 `manifest.csv`。

## 启动

```bash
npm install
npm run dev
```

前端地址：`http://localhost:5173`

后端地址：`http://127.0.0.1:8787`

## 功能

- 图片网格预览和勾选
- 按关键词、来源、场景、风险标记筛选
- 导出前选择 Excel 字段，支持“导出选中”和按当前筛选结果“全部导出”
- 导出的 Excel 支持缩略图、来源 URL、图片 URL、场景环境、做题人和 manifest 原始字段
- 来源库分级：按 S/A/B/C 标注图片网站适合的题型、内容和注意事项
- 前端直接采集：选择网站、关键词和数量后，后端调用已有 provider 抓取并写入 SQLite
- 采集任务管理：最近任务里可终止 queued/running 状态的采集任务
- 采集数量不设上限；长任务建议配合“终止”按钮管理
- 国内公开网页直采：通过公开搜索结果进入豆瓣、LOFTER、知乎、简书、堆糖、图虫、站酷、美篇、搜狐、网易、什么值得买、下厨房等原始页面抓取候选图
- 采集提示词：保留可复制提示词，方便把当前网站/关键词/数量交给 Codex 执行更复杂的人工筛选流程
- 列表删除：可删除选中记录；默认只从 SQLite 列表删除，不删除硬盘图片文件
- 数据库管理：一键清空图片记录、下载完整备份、导出去重键、导入其他设备的去重键
- 远端自动去重：配置 GitHub 仓库里的去重 JSON 后，采集前自动拉取 GitHub 去重库，采集入库后自动推送本机去重键

## 数据位置

- 本地默认数据库：`./data/review.sqlite`
- 新安装或清空后列表为空；只有前端采集、后续手动导入或接口写入的数据会显示。
- 页面默认显示数据库里 `未导出` 的记录；点击“导出 Excel”成功后，对应记录会写入 `exported_at`，之后默认不再显示。
- SQLite 会按 `normalized_source_url`、`source_image_url` 防止候选列表内重复；只有导出成功的记录才会写入独立 `dedupe_keys`，用于跨批次/多设备长期去重。
- 前端采集的新图片会存放在：`../data/app_collections/`
- 网页里点“导出 Excel”后，文件由浏览器下载保存；导出状态保存在本地数据库。
- 之前已经批量生成的 Excel：`../outputs/桌面场景图片标注表_张磊_分批_第七轮/`
- 完整备份和去重键备份从页面“数据库”抽屉下载；把去重键 JSON 导入另一台设备即可做多设备去重。

## 远端自动去重

页面“数据库”抽屉里可以开启“远端自动去重”。远端去重库直接放在 GitHub 仓库里，例如：

- GitHub 仓库：默认读取当前 Git `origin`，本项目当前为 `zhanglei10281852-gif/image`
- 分支：`main`
- 去重库 JSON 路径：`dedupe_keys.json`
- GitHub Token：需要该仓库 Contents 读写权限

开启并保存后：

1. 开始采集前，本机会先通过 GitHub Contents API 读取 `dedupe_keys.json`，把远端去重键导入本机。
2. 如果拉取失败，本次采集不会启动，避免重复数据进入本机。
3. 导出成功后，本机会先合并 GitHub 和本机去重键，再提交更新到同一个 JSON 文件。

远端去重只同步来源 URL / 图片 URL 去重键，不同步图片文件、Excel 文件或完整记录。

如果需要覆盖默认仓库，可在启动后端时设置：

```bash
GITHUB_DEDUPE_REPO=owner/repo npm run dev:server
```

## 关于前端采集

页面里的“来源库/采集”可以直接启动后端采集任务。建议每次先抓 10-50 条，确认质量后再扩大。采集完成后会自动同步进 SQLite，并按 `normalized_source_url` 和 `source_image_url` 去重。

新采集任务默认不再保存图片文件到本地，只读取远程原图 URL 来校验尺寸，并在前端直接用 `source_image_url` 展示。旧任务已经下载到本地的图片仍可继续显示；如果某些站点防盗链导致远程图无法显示，再单独切回下载或增加图片代理。

需要 API Key 的来源默认不显示，避免误点后失败；如果启动后端前配置了对应环境变量，来源会自动出现在下拉框并允许调用：

```bash
PEXELS_API_KEY=你的key npm run dev:server
PIXABAY_API_KEY=你的key npm run dev:server
UNSPLASH_ACCESS_KEY=你的key npm run dev:server
```

当前可直采图库/网页包括 Wikimedia Commons、Flickr CC、Openverse、Skitterphoto、Shopify Burst、Freestocks、Picjumbo、ISO Republic、PxHere、FreeImages UK、NegativeSpace、Startup Stock Photos、Good Stock Photos、ShotStash、Foodiesfeed、Picography、LibreShot、国内公开图文网页发现等。

关键词建议：国内公开网页源优先中文关键词，建议使用“场景词 + 物体词 + 生活化词”，例如 `书桌 日常 桌面`、`餐桌 摆盘 家常`、`厨房 台面 食材`。海外图库优先英文关键词，例如 `desk coffee laptop`、`dining table breakfast`、`kitchen counter ingredients`。

来源库里会标注“中文搜索”或“英文关键词”。淘宝、京东等电商评价图属于高风险来源：通常涉及平台条款、登录权限和用户内容授权，除非有授权或自有店铺后台导出，不建议直接爬取。

## 可选配置

```bash
MANIFEST_PATH=/absolute/path/to/manifest.csv DB_PATH=/absolute/path/to/review.sqlite EXPORT_AUTHOR=张磊 PORT=8787 npm run dev
```
