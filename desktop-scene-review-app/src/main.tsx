import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  ConfigProvider,
  Drawer,
  Empty,
  Flex,
  Image,
  Input,
  InputNumber,
  Layout,
  Modal,
  Pagination,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
  message
} from "antd";
import {
  ClearOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FilterOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined
} from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import "./styles.css";

const { Header, Content } = Layout;
const { Text, Link } = Typography;

type FieldDef = {
  key: string;
  label: string;
  group: string;
};

type SceneOption = {
  value: string;
  label: string;
};

type Meta = {
  manifestPath: string;
  databasePath: string;
  total: number;
  unexported: number;
  exported: number;
  dedupeKeys: number;
  fields: FieldDef[];
  defaultFields: string[];
  platforms: string[];
  scenes: SceneOption[];
};

type RecordItem = {
  id: string;
  record_id: string;
  row_number: number;
  image_api_url: string;
  image_exists: boolean;
  source_platform: string;
  source_url: string;
  source_image_url: string;
  title: string;
  query: string;
  author: string;
  license_type: string;
  width: string;
  height: string;
  short_edge: string;
  scene_setting: string;
  scene_cn: string;
  complexity_level: string;
  risk_flag: string;
  exported_at: string;
};

type RecordsResponse = {
  total: number;
  page: number;
  pageSize: number;
  records: RecordItem[];
};

type SourceItem = {
  id: string;
  name: string;
  url: string;
  tier: string;
  license: string;
  provider: string;
  crawlStatus: string;
  requiresApiKey: boolean;
  directCrawl: boolean;
  disabledReason: string;
  bestFor: string[];
  taskTypes: string[];
  promptKeywords: string[];
  supportsChineseSearch?: boolean;
  keywordAdvice?: string;
  caution: string;
};

type SourceCatalogResponse = {
  sources: SourceItem[];
  counts?: {
    total: number;
    noKey: number;
    direct: number;
    directNoKey: number;
    promptOnly: number;
  };
  tiers: { value: string; label: string; description: string }[];
  taskTypes: string[];
};

type CrawlJob = {
  job_id: string;
  status: string;
  provider: string;
  query: string;
  limit_count: number;
  started_at: string;
  finished_at: string;
  kept: number;
  flagged: number;
  duplicates_skipped: number;
  progress_processed: number;
  imported: number;
  skipped_duplicates: number;
  last_progress_at: string;
  error: string;
  log: string;
};

type RemoteDedupeConfig = {
  enabled: boolean;
  provider: string;
  repo: string;
  branch: string;
  filePath: string;
  token: string;
  lastPulledAt: string;
  lastPushedAt: string;
  lastError: string;
};

const PAGE_SIZE = 60;

function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<string>();
  const [scene, setScene] = useState<string>();
  const [risk, setRisk] = useState("noRisk");
  const [exportStatus, setExportStatus] = useState("unexported");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fieldDrawerOpen, setFieldDrawerOpen] = useState(false);
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false);
  const [adminDrawerOpen, setAdminDrawerOpen] = useState(false);
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [sourceCatalog, setSourceCatalog] = useState<SourceCatalogResponse | null>(null);
  const [crawlProviders, setCrawlProviders] = useState<string[]>([]);
  const [crawlQuery, setCrawlQuery] = useState("desk coffee laptop");
  const [crawlLimit, setCrawlLimit] = useState<number | null>(20);
  const [crawlStarting, setCrawlStarting] = useState(false);
  const [crawlJobs, setCrawlJobs] = useState<CrawlJob[]>([]);
  const [cancelingJobId, setCancelingJobId] = useState<string>();
  const [adminBusy, setAdminBusy] = useState(false);
  const [remoteDedupe, setRemoteDedupe] = useState<RemoteDedupeConfig>({
    enabled: false,
    provider: "github",
    repo: "",
    branch: "main",
    filePath: "dedupe_keys.json",
    token: "",
    lastPulledAt: "",
    lastPushedAt: "",
    lastError: ""
  });
  const [messageApi, contextHolder] = message.useMessage();
  const [modalApi, modalContextHolder] = Modal.useModal();
  const dedupeInputRef = useRef<HTMLInputElement>(null);
  const listAnchorRef = useRef<HTMLDivElement>(null);
  const jobStatusRef = useRef<Map<string, string>>(new Map());
  const jobImportedRef = useRef<Map<string, number>>(new Map());
  const jobPollReadyRef = useRef(false);

  useEffect(() => {
    fetch("/api/meta")
      .then((res) => res.json())
      .then((data: Meta) => {
        setMeta(data);
        setSelectedFields(data.defaultFields);
      })
      .catch((error) => messageApi.error(error.message || "加载配置失败"));
  }, [messageApi, refreshKey]);

  useEffect(() => {
    fetch("/api/source-catalog")
      .then((res) => res.json())
      .then((data: SourceCatalogResponse) => {
        setSourceCatalog(data);
        const firstDirect = data.sources.find((source) => source.directCrawl);
        if (firstDirect) setCrawlProviders([firstDirect.provider]);
      })
      .catch((error) => messageApi.error(error.message || "加载来源库失败"));
  }, [messageApi]);

  useEffect(() => {
    loadCrawlJobs();
    const timer = window.setInterval(loadCrawlJobs, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    loadRemoteDedupe();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      risk,
      exportStatus
    });
    if (query.trim()) params.set("q", query.trim());
    if (platform) params.set("platform", platform);
    if (scene) params.set("scene", scene);

    fetch(`/api/records?${params.toString()}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: RecordsResponse) => {
        setRecords(data.records);
        setTotal(data.total);
      })
      .catch((error) => {
        if (error.name !== "AbortError") messageApi.error(error.message || "加载图片失败");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [exportStatus, messageApi, page, pageSize, platform, query, refreshKey, risk, scene]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allPageSelected = records.length > 0 && records.every((record) => selectedSet.has(record.id));
  const selectedFieldDefs = useMemo(
    () => (meta?.fields || []).filter((field) => selectedFields.includes(field.key)),
    [meta?.fields, selectedFields]
  );

  const scrollRecordsToTop = () => {
    window.requestAnimationFrame(() => {
      listAnchorRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  };

  const groupedFields = useMemo(() => {
    const groups = new Map<string, FieldDef[]>();
    for (const field of meta?.fields || []) {
      const list = groups.get(field.group) || [];
      list.push(field);
      groups.set(field.group, list);
    }
    return [...groups.entries()];
  }, [meta?.fields]);

  const directCrawlSources = useMemo(
    () => (sourceCatalog?.sources || []).filter((source) => source.directCrawl),
    [sourceCatalog?.sources]
  );

  const selectedSources = useMemo(
    () => (sourceCatalog?.sources || []).filter((item) => crawlProviders.includes(item.provider)),
    [crawlProviders, sourceCatalog?.sources]
  );

  const crawlPrompt = useMemo(() => {
    const names = selectedSources.map((source) => source.name).join("、") || "未选择";
    const providers = crawlProviders.join(", ") || "未选择";
    return `请按以下参数采集图片数据：\n\n网站：${names}\nprovider：${providers}\n关键词：${crawlQuery || "未填写"}\n目标数量：${crawlLimit || "未填写"}（每个网站各采集该数量）\n\n要求：\n1. 必须是真实照片，拒绝 AI、3D 渲染、插画、白底商品主图。\n2. 必须保留原始来源页 URL 和原图 URL，不使用搜索缩略图。\n3. 入库前按 normalized_source_url 和 source_image_url 去重。\n4. 字段保留 source_url、source_image_url、scene_setting、license、尺寸、risk_flag、notes。\n5. 新数据写入 SQLite，默认未导出列表显示；用户选择后再导出 Excel。`;
  }, [crawlLimit, crawlProviders, crawlQuery, selectedSources]);

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    messageApi.success("已复制");
  };

  const loadCrawlJobs = async () => {
    try {
      const res = await fetch("/api/crawl/jobs");
      const data = await res.json();
      const jobs: CrawlJob[] = data.jobs || [];
      setCrawlJobs(jobs);

      const previous = jobStatusRef.current;
      const previousImported = jobImportedRef.current;
      const finishedJobs = jobs.filter((job) => {
        const oldStatus = previous.get(job.job_id);
        return (
          jobPollReadyRef.current &&
          oldStatus &&
          oldStatus !== job.status &&
          ["completed", "failed"].includes(job.status)
        );
      });
      const importedIncreased = jobs.some((job) => {
        const currentImported = Number(job.imported || 0);
        const oldImported = previousImported.get(job.job_id) || 0;
        return jobPollReadyRef.current && currentImported > oldImported;
      });
      jobStatusRef.current = new Map(jobs.map((job) => [job.job_id, job.status]));
      jobImportedRef.current = new Map(jobs.map((job) => [job.job_id, Number(job.imported || 0)]));
      jobPollReadyRef.current = true;

      if (importedIncreased) {
        setSelectedIds([]);
        setRefreshKey((value) => value + 1);
      }

      if (finishedJobs.length) {
        const imported = finishedJobs.reduce((sum, job) => sum + Number(job.imported || 0), 0);
        setSelectedIds([]);
        setPage(1);
        setRefreshKey((value) => value + 1);
        if (imported > 0) {
          messageApi.success(`采集完成，已入库 ${imported} 条，列表已刷新`);
        } else if (finishedJobs.some((job) => job.status === "failed")) {
          messageApi.warning("采集任务结束但有失败项，列表已刷新");
        }
      }
    } catch {
      // 轮询失败不打扰筛图流程。
    }
  };

  const loadRemoteDedupe = async () => {
    try {
      const res = await fetch("/api/admin/remote-dedupe");
      const data = await res.json();
      if (res.ok && data.config) setRemoteDedupe(data.config);
    } catch {
      // 不阻塞主流程。
    }
  };

  const startCrawl = async () => {
    if (!crawlProviders.length) {
      messageApi.warning("请选择至少一个支持直接采集的网站");
      return;
    }
    if (!crawlQuery.trim()) {
      messageApi.warning("请输入关键词");
      return;
    }
    const limitValue = Number(crawlLimit);
    if (!Number.isFinite(limitValue) || limitValue <= 0) {
      messageApi.warning("请输入大于 0 的采集数量");
      return;
    }
    setCrawlStarting(true);
    try {
      const res = await fetch("/api/crawl/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: crawlProviders, query: crawlQuery.trim(), limit: Math.floor(limitValue) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "启动采集失败");
      messageApi.success(`已启动 ${data.jobIds?.length || crawlProviders.length} 个采集任务`);
      await loadCrawlJobs();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "启动采集失败");
    } finally {
      setCrawlStarting(false);
    }
  };

  const cancelCrawl = async (jobId: string) => {
    setCancelingJobId(jobId);
    try {
      const res = await fetch(`/api/crawl/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "终止采集失败");
      messageApi.success("已发送终止指令");
      await loadCrawlJobs();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "终止采集失败");
    } finally {
      setCancelingJobId(undefined);
    }
  };

  const deleteRecords = async (ids: string[]) => {
    const res = await fetch("/api/records", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedIds: ids })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "删除失败");
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
    setRefreshKey((value) => value + 1);
    messageApi.success(`已删除 ${data.deleted || 0} 条`);
  };

  const deleteSelected = () => {
    if (!selectedIds.length) {
      messageApi.warning("请先选择记录");
      return;
    }
    modalApi.confirm({
      title: "删除选中记录？",
      content: `将从本地 SQLite 列表删除 ${selectedIds.length} 条记录，不会删除硬盘图片文件。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        await deleteRecords(selectedIds);
      }
    });
  };

  const downloadJson = async (url: string, filename: string) => {
    setAdminBusy(true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "下载失败");
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      messageApi.success("已下载");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setAdminBusy(false);
    }
  };

  const clearRecords = (clearDedupeKeys = false) => {
    modalApi.confirm({
      title: clearDedupeKeys ? "清空图片记录和去重库？" : "清空全部图片记录？",
      content: clearDedupeKeys
        ? "会清空 SQLite 里的图片记录和跨设备去重键，不会删除硬盘图片文件。"
        : "会清空 SQLite 里的图片记录，保留跨设备去重键，不会删除硬盘图片文件。",
      okText: "确认清空",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        setAdminBusy(true);
        try {
          const res = await fetch("/api/admin/clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clearDedupeKeys })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || "清空失败");
          setSelectedIds([]);
          setPage(1);
          setRefreshKey((value) => value + 1);
          messageApi.success(
            `已清空 ${data.recordsDeleted || 0} 条记录${clearDedupeKeys ? `，去重键 ${data.dedupeDeleted || 0} 个` : ""}`
          );
        } catch (error) {
          messageApi.error(error instanceof Error ? error.message : "清空失败");
        } finally {
          setAdminBusy(false);
        }
      }
    });
  };

  const importDedupeFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAdminBusy(true);
    try {
      const payload = JSON.parse(await file.text());
      const res = await fetch("/api/admin/dedupe/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "导入失败");
      setRefreshKey((value) => value + 1);
      messageApi.success(`已导入 ${data.imported || 0} 个去重键，跳过 ${data.skipped || 0} 个`);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导入失败，请确认是 JSON 文件");
    } finally {
      setAdminBusy(false);
    }
  };

  const saveRemoteDedupe = async () => {
    if (remoteDedupe.enabled && !remoteDedupe.repo.trim()) {
      messageApi.warning("开启远端自动去重前，请先填写 GitHub 仓库");
      return;
    }
    if (remoteDedupe.enabled && !remoteDedupe.token.trim()) {
      messageApi.warning("开启自动推送需要填写 GitHub Token");
      return;
    }
    setAdminBusy(true);
    try {
      const res = await fetch("/api/admin/remote-dedupe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(remoteDedupe)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存远端去重配置失败");
      setRemoteDedupe(data.config);
      messageApi.success(remoteDedupe.enabled ? "远端自动去重已开启" : "远端自动去重已关闭");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "保存远端去重配置失败");
    } finally {
      setAdminBusy(false);
    }
  };

  const runRemoteDedupeAction = async (action: "pull" | "push") => {
    setAdminBusy(true);
    try {
      const res = await fetch(`/api/admin/remote-dedupe/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "远端去重同步失败");
      if (data.config) setRemoteDedupe(data.config);
      setRefreshKey((value) => value + 1);
      messageApi.success(
        action === "pull"
          ? `已拉取 GitHub 去重键：新增 ${data.imported || 0}，跳过 ${data.skipped || 0}`
          : `已推送 GitHub 去重键：写回 ${data.pushed || data.seen || 0} 个`
      );
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "远端去重同步失败");
      await loadRemoteDedupe();
    } finally {
      setAdminBusy(false);
    }
  };

  const toggleRecord = (recordId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(recordId);
      else next.delete(recordId);
      return [...next];
    });
  };

  const togglePage = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const record of records) {
        if (checked) next.add(record.id);
        else next.delete(record.id);
      }
      return [...next];
    });
  };

  const resetFilters = () => {
    setQuery("");
    setPlatform(undefined);
    setScene(undefined);
    setRisk("noRisk");
    setExportStatus("unexported");
    setPage(1);
  };

  const exportExcel = async (exportAll = false) => {
    if (!exportAll && !selectedIds.length) {
      messageApi.warning("请先选择图片");
      return;
    }
    if (exportAll && !total) {
      messageApi.warning("当前筛选结果没有可导出的图片");
      return;
    }
    if (!selectedFields.length) {
      messageApi.warning("请至少选择一个字段");
      return;
    }

    setExporting(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedIds: exportAll ? [] : selectedIds,
          exportAll,
          fields: selectedFields,
          filters: {
            q: query.trim(),
            platform,
            scene,
            risk,
            exportStatus
          }
        })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "导出失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `桌面场景图片标注表_张磊_${exportAll ? "全部" : "自选"}_${exportAll ? total : selectedIds.length}条.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      messageApi.success(exportAll ? "全部 Excel 已生成，已从未导出列表移除" : "Excel 已生成，已从未导出列表移除");
      setSelectedIds([]);
      setPage(1);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          borderRadius: 8,
          colorPrimary: "#1677ff",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif'
        }
      }}
    >
      {contextHolder}
      {modalContextHolder}
      <Layout className="app-shell">
        <Header className="app-header">
          <Flex align="center" justify="space-between" gap={16}>
            <Space size={12}>
              <FileExcelOutlined className="brand-icon" />
              <div>
                <div className="app-title">桌面场景图片筛选导出</div>
                <Text type="secondary" className="manifest-path">
                  {meta?.databasePath || meta?.manifestPath || "review.sqlite"}
                </Text>
              </div>
            </Space>
            <Space wrap>
              <Button icon={<DatabaseOutlined />} onClick={() => setSourceDrawerOpen(true)}>
                来源库/采集
              </Button>
              <Button icon={<ClearOutlined />} onClick={() => setAdminDrawerOpen(true)}>
                数据库
              </Button>
              <Button icon={<SettingOutlined />} onClick={() => setFieldDrawerOpen(true)}>
                字段
              </Button>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                loading={exporting}
                onClick={() => exportExcel(false)}
              >
                导出选中
              </Button>
              <Button
                icon={<DownloadOutlined />}
                loading={exporting}
                onClick={() => exportExcel(true)}
              >
                全部导出（无需勾选）
              </Button>
            </Space>
          </Flex>
        </Header>

        <Content className="app-content">
          <section className="summary-band">
            <Row gutter={[12, 12]}>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="总记录" value={meta?.total || 0} />
              </Col>
              <Col xs={12} sm={8} md={5}>
                <Statistic title="未导出" value={meta?.unexported || 0} />
              </Col>
              <Col xs={12} sm={8} md={5}>
                <Statistic title="已导出" value={meta?.exported || 0} />
              </Col>
              <Col xs={12} sm={8} md={5}>
                <Statistic title="当前结果" value={total} />
              </Col>
              <Col xs={12} sm={8} md={5}>
                <Statistic title="已选图片" value={selectedIds.length} />
              </Col>
              <Col xs={12} sm={8} md={5}>
                <Statistic title="去重键" value={meta?.dedupeKeys || 0} />
              </Col>
            </Row>
          </section>

          <section className="toolbar-band">
            <Flex gap={10} wrap align="center">
              <Input.Search
                allowClear
                className="search-input"
                placeholder="标题 / URL / 来源 / 备注"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onSearch={() => setPage(1)}
              />
              <Select
                allowClear
                className="filter-select"
                placeholder="来源"
                value={platform}
                options={(meta?.platforms || []).map((item) => ({ value: item, label: item }))}
                onChange={(value) => {
                  setPlatform(value);
                  setPage(1);
                }}
              />
              <Select
                allowClear
                className="filter-select"
                placeholder="场景"
                value={scene}
                options={meta?.scenes || []}
                onChange={(value) => {
                  setScene(value);
                  setPage(1);
                }}
              />
              <Select
                className="filter-select"
                value={exportStatus}
                options={[
                  { value: "unexported", label: "未导出" },
                  { value: "all", label: "全部" },
                  { value: "exported", label: "已导出" }
                ]}
                onChange={(value) => {
                  setExportStatus(value);
                  setPage(1);
                }}
              />
              <Select
                className="filter-select"
                value={risk}
                options={[
                  { value: "noRisk", label: "无风险" },
                  { value: "all", label: "全部" },
                  { value: "onlyRisk", label: "仅风险" }
                ]}
                onChange={(value) => {
                  setRisk(value);
                  setPage(1);
                }}
              />
              <Button icon={<FilterOutlined />} onClick={resetFilters}>
                重置
              </Button>
              <Checkbox checked={allPageSelected} onChange={(event) => togglePage(event.target.checked)}>
                当前页
              </Checkbox>
              <Button icon={<ClearOutlined />} onClick={() => setSelectedIds([])}>
                清空选择
              </Button>
              <Button danger icon={<DeleteOutlined />} onClick={deleteSelected}>
                删除选中
              </Button>
            </Flex>
          </section>

          <div ref={listAnchorRef} className="list-scroll-anchor" />

          <Spin spinning={loading}>
            {records.length ? (
              <Row gutter={[14, 14]} className="image-grid">
                {records.map((record) => (
                  <Col xs={24} sm={12} lg={8} xl={6} xxl={4} key={record.id}>
                    <Card
                      className={selectedSet.has(record.id) ? "image-card selected" : "image-card"}
                      styles={{ body: { padding: 10 } }}
                      cover={
                        <div className={Number(record.height) > Number(record.width) * 1.2 ? "image-frame portrait" : "image-frame"}>
                          <Image
                            src={record.image_api_url}
                            alt={record.title || record.record_id}
                            className="record-image"
                            preview={{ mask: "预览" }}
                          />
                          <Checkbox
                            className="card-check"
                            checked={selectedSet.has(record.id)}
                            onChange={(event) => toggleRecord(record.id, event.target.checked)}
                          />
                        </div>
                      }
                    >
                      <Space direction="vertical" size={7} className="card-meta">
                        <Flex align="center" justify="space-between" gap={8} className="card-title-row">
                          <Text strong ellipsis={{ tooltip: record.title }}>
                            {record.title || record.id}
                          </Text>
                          <Badge status={record.risk_flag ? "error" : "success"} />
                        </Flex>
                        <Space size={[4, 4]} wrap className="card-tags">
                          <Tag color="blue">{record.source_platform || "unknown"}</Tag>
                          <Tag>{record.scene_cn || record.scene_setting || "未标注"}</Tag>
                          <Tag>{record.complexity_level || "L2"}</Tag>
                          {record.exported_at ? <Tag color="green">已导出</Tag> : <Tag>未导出</Tag>}
                        </Space>
                        <Text type="secondary" className="card-line">
                          {record.width} x {record.height} · 短边 {record.short_edge}
                        </Text>
                        <Flex justify="space-between" gap={8} align="center" className="card-footer-row">
                          <Link href={record.source_url} target="_blank">
                            来源
                          </Link>
                          <Space size={4}>
                            <Text type="secondary">#{record.row_number}</Text>
                            <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => deleteRecords([record.id])} />
                          </Space>
                        </Flex>
                      </Space>
                    </Card>
                  </Col>
                ))}
              </Row>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有记录" />
            )}
          </Spin>

          <Flex justify="center" className="pager-wrap">
            <Pagination
              current={page}
              total={total}
              pageSize={pageSize}
              showSizeChanger
              pageSizeOptions={[30, 60, 100, 150]}
              onChange={(nextPage, nextPageSize) => {
                setPage(nextPage);
                setPageSize(nextPageSize);
                scrollRecordsToTop();
              }}
            />
          </Flex>
        </Content>

        <Drawer
          title="导出字段"
          open={fieldDrawerOpen}
          onClose={() => setFieldDrawerOpen(false)}
          width={420}
          extra={
            <Space>
              <Button onClick={() => setSelectedFields(meta?.defaultFields || [])}>默认三项</Button>
              <Button onClick={() => setSelectedFields((meta?.fields || []).map((field) => field.key))}>
                全字段
              </Button>
              <Button onClick={() => setSelectedFields(["source_url", "source_image_url", "scene_cn"])}>
                精简
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size={18} className="field-panel">
            {groupedFields.map(([group, fields]) => (
              <div key={group}>
                <Text strong>{group}</Text>
                <Checkbox.Group
                  className="field-group"
                  value={selectedFields}
                  onChange={(values) => setSelectedFields(values.map(String))}
                >
                  <Row gutter={[8, 8]}>
                    {fields.map((field) => (
                      <Col span={12} key={field.key}>
                        <Checkbox value={field.key}>{field.label}</Checkbox>
                      </Col>
                    ))}
                  </Row>
                </Checkbox.Group>
              </div>
            ))}
            <div className="selected-fields">
              {selectedFieldDefs.map((field) => (
                <Tag key={field.key}>{field.label}</Tag>
              ))}
            </div>
          </Space>
        </Drawer>

        <Drawer
          title="数据库管理"
          open={adminDrawerOpen}
          onClose={() => setAdminDrawerOpen(false)}
          width={460}
        >
          <Space direction="vertical" size={16} className="admin-panel">
            <div className="hint-box">
              当前列表只读取本地 SQLite。默认不会再从旧 manifest 自动塞入 300 条；采集、导入、删除和导出状态都以数据库为准。
            </div>
            <div className="admin-section">
              <Text strong>清空</Text>
              <Text type="secondary" className="admin-help">
                清空记录不会删除硬盘图片文件。建议保留去重库，这样其他设备导入去重键后不会重复采同一批来源。
              </Text>
              <Space wrap>
                <Button danger icon={<ClearOutlined />} loading={adminBusy} onClick={() => clearRecords(false)}>
                  清空图片记录
                </Button>
                <Button danger ghost loading={adminBusy} onClick={() => clearRecords(true)}>
                  清空记录和去重库
                </Button>
              </Space>
            </div>
            <div className="admin-section">
              <Flex justify="space-between" align="center" gap={12}>
                <Text strong>远端自动去重</Text>
                <Switch
                  checked={remoteDedupe.enabled}
                  onChange={(checked) => setRemoteDedupe((current) => ({ ...current, enabled: checked }))}
                />
              </Flex>
              <Text type="secondary" className="admin-help">
                开启后，本机开始采集前会直接拉取 GitHub 上的去重库；采集入库产生新去重键后，会自动推送回 GitHub。
              </Text>
              <Input
                value={remoteDedupe.repo}
                onChange={(event) => setRemoteDedupe((current) => ({ ...current, repo: event.target.value }))}
                placeholder="GitHub 仓库，默认当前仓库 owner/repo"
              />
              <Input
                value={remoteDedupe.branch}
                onChange={(event) => setRemoteDedupe((current) => ({ ...current, branch: event.target.value }))}
                placeholder="分支，例如 main"
              />
              <Input
                value={remoteDedupe.filePath}
                onChange={(event) => setRemoteDedupe((current) => ({ ...current, filePath: event.target.value }))}
                placeholder="去重库 JSON 路径，例如 dedupe_keys.json"
              />
              <Input.Password
                value={remoteDedupe.token}
                onChange={(event) => setRemoteDedupe((current) => ({ ...current, token: event.target.value }))}
                placeholder="GitHub Token，需要仓库 Contents 读写权限"
              />
              <div className="dedupe-guide">
                <Text strong>自动同步规则</Text>
                <ol>
                  <li>点“保存远端配置”后开关才会生效。</li>
                  <li>点击“开始采集”时，系统先从 GitHub JSON 拉取最新去重键，失败则不启动采集。</li>
                  <li>采集完成并写入新数据后，系统自动合并本机和 GitHub 去重键，再提交回仓库。</li>
                </ol>
                <Space size={[6, 6]} wrap>
                  <Tag color={remoteDedupe.enabled ? "green" : "default"}>
                    {remoteDedupe.enabled ? "已开启" : "未开启"}
                  </Tag>
                  <Tag>GitHub</Tag>
                  <Tag>上次拉取：{formatRemoteTime(remoteDedupe.lastPulledAt) || "无"}</Tag>
                  <Tag>上次推送：{formatRemoteTime(remoteDedupe.lastPushedAt) || "无"}</Tag>
                </Space>
                {remoteDedupe.lastError ? <Text type="danger">最近错误：{remoteDedupe.lastError}</Text> : null}
              </div>
              <Space wrap>
                <Button type="primary" loading={adminBusy} onClick={saveRemoteDedupe}>
                  保存远端配置
                </Button>
                <Button loading={adminBusy} onClick={() => runRemoteDedupeAction("pull")}>
                  立即拉取 GitHub
                </Button>
                <Button loading={adminBusy} onClick={() => runRemoteDedupeAction("push")}>
                  立即推送 GitHub
                </Button>
              </Space>
            </div>
            <div className="admin-section">
              <Text strong>备份</Text>
              <Text type="secondary" className="admin-help">
                完整备份包含记录、采集任务和去重键；去重键文件适合发到另一台设备导入，用来跨设备去重。
              </Text>
              <div className="dedupe-guide">
                <Text strong>多设备去重怎么用</Text>
                <ol>
                  <li>在已有数据的设备上点“导出去重键”，得到一个 JSON 文件。</li>
                  <li>把 JSON 文件发到另一台设备，在这里点“导入去重键”。</li>
                  <li>之后前端采集入库时，会按来源 URL 和图片 URL 自动跳过已存在的图片。</li>
                </ol>
                <Text type="secondary">
                  只同步去重键，不同步图片文件和 Excel；删除或清空图片记录时建议保留去重库，避免旧图再次出现。
                </Text>
              </div>
              <Space wrap>
                <Button
                  icon={<DownloadOutlined />}
                  loading={adminBusy}
                  onClick={() => downloadJson("/api/admin/backup", `desktop-scene-review-backup-${Date.now()}.json`)}
                >
                  下载完整备份
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  loading={adminBusy}
                  onClick={() => downloadJson("/api/admin/dedupe/export", `desktop-scene-dedupe-keys-${Date.now()}.json`)}
                >
                  导出去重键
                </Button>
                <Button loading={adminBusy} onClick={() => dedupeInputRef.current?.click()}>
                  导入去重键
                </Button>
              </Space>
              <input
                ref={dedupeInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden-input"
                onChange={importDedupeFile}
              />
            </div>
          </Space>
        </Drawer>

        <Drawer
          title="来源库 / 直接采集"
          open={sourceDrawerOpen}
          onClose={() => setSourceDrawerOpen(false)}
          width={760}
          extra={
            <Button icon={<ReloadOutlined />} onClick={loadCrawlJobs}>
              刷新任务
            </Button>
          }
        >
          <Space direction="vertical" size={16} className="source-panel">
            <div className="hint-box">
              采集会在后端后台运行，并写入本地 SQLite。数据库按来源页 URL 和图片 URL 去重；导出过的记录默认不显示。多选网站时共用同一个关键词；数量按单个网站计算。国内公开网页源优先中文关键词，海外图库优先英文关键词；采集数量不设上限，长任务可随时终止。
            </div>
            <Space size={[8, 8]} wrap>
              <Tag color="green">后端可直采免 Key：{sourceCatalog?.counts?.directNoKey ?? directCrawlSources.filter((source) => !source.requiresApiKey).length}</Tag>
              <Tag>可直采总数：{sourceCatalog?.counts?.direct ?? directCrawlSources.length}</Tag>
              <Tag>来源库总数：{sourceCatalog?.counts?.total ?? sourceCatalog?.sources.length ?? 0}</Tag>
            </Space>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <Space direction="vertical" size={10} className="source-control">
                  <Text strong>网站</Text>
                  <Space wrap>
                    <Button size="small" onClick={() => setCrawlProviders(directCrawlSources.map((source) => source.provider))}>
                      一键全选
                    </Button>
                    <Button size="small" onClick={() => setCrawlProviders([])}>
                      清空
                    </Button>
                  </Space>
                  <Select
                    mode="multiple"
                    value={crawlProviders}
                    maxTagCount="responsive"
                    showSearch
                    optionFilterProp="searchText"
                    placeholder="可多选：每个网站各采集一次"
                    options={directCrawlSources.map((source) => ({
                      value: source.provider,
                      title: source.name,
                      searchText: `${source.name} ${source.provider} ${(source.promptKeywords || []).join(" ")}`,
                      label: (
                        <div className="source-option">
                          <Flex justify="space-between" gap={8}>
                            <Text strong>{source.name}</Text>
                            <Text type="secondary">{source.tier}级</Text>
                          </Flex>
                          <Text type="secondary" className="source-option-keywords">
                            {source.supportsChineseSearch ? "中文优先" : "英文优先"} · {(source.promptKeywords || []).slice(0, 3).join(" / ")}
                          </Text>
                        </div>
                      )
                    }))}
                    optionLabelProp="title"
                    onChange={(values) => {
                      setCrawlProviders(values);
                      const source = directCrawlSources.find((item) => item.provider === values[values.length - 1]);
                      if (values.length === 1 && source?.promptKeywords?.[0]) setCrawlQuery(source.promptKeywords[0]);
                    }}
                  />
                  <Text strong>关键词</Text>
                  <Input value={crawlQuery} onChange={(event) => setCrawlQuery(event.target.value)} placeholder="desk coffee laptop" />
                  <Text type="secondary">所有已选网站共用这一个关键词；下面推荐词点选后会替换到同一个输入框。</Text>
                  <Text strong>数量</Text>
                  <InputNumber
                    value={crawlLimit}
                    precision={0}
                    className="crawl-limit-input"
                    onChange={(value) => setCrawlLimit(typeof value === "number" ? value : null)}
                    placeholder="不设上限，填目标数量"
                  />
                  <Button type="primary" icon={<PlayCircleOutlined />} loading={crawlStarting} onClick={startCrawl}>
                    开始采集{crawlProviders.length > 1 ? `（${crawlProviders.length} 个站）` : ""}
                  </Button>
                  <Text type="secondary">
                    采集下拉只显示后端确认可直采的免 Key/已配置来源；下面来源库里“仅提示词”的站不会混入这里。当前可直采免 Key {sourceCatalog?.counts?.directNoKey ?? directCrawlSources.filter((source) => !source.requiresApiKey).length} 个。
                  </Text>
                </Space>
              </Col>
              <Col xs={24} md={12}>
                <Text strong>最近任务</Text>
                <Space direction="vertical" size={8} className="job-list">
                  {crawlJobs.length ? (
                    crawlJobs.map((job) => (
                      <Card size="small" key={job.job_id} className="job-card">
                        <Flex justify="space-between" gap={8}>
                          <Space direction="vertical" size={6} className="job-content">
                            <Space wrap>
                              <Tag color={jobStatusColor(job.status)}>{job.status}</Tag>
                              <Text strong>{job.provider}</Text>
                              <Text type="secondary">{job.query}</Text>
                            </Space>
                            <Progress
                              size="small"
                              percent={jobProgressPercent(job)}
                              status={job.status === "failed" ? "exception" : job.status === "completed" ? "success" : "active"}
                            />
                            <Text type="secondary">
                              已处理 {job.progress_processed || 0}/{job.limit_count} · 保留 {job.kept || 0} · 风险 {job.flagged || 0} ·
                              采集重复 {job.duplicates_skipped || 0} · 入库 {job.imported || 0} · 入库去重 {job.skipped_duplicates || 0}
                            </Text>
                            <Text type="secondary">
                              {job.status === "completed"
                                ? "已完成"
                                : job.last_progress_at
                                  ? `最后进度 ${formatRemoteTime(job.last_progress_at)}`
                                  : "等待采集器返回进度"}
                            </Text>
                            {job.error ? <Text type="danger">{job.error}</Text> : null}
                            {job.log ? <pre className="job-log">{tailLog(job.log)}</pre> : null}
                          </Space>
                          {["queued", "running"].includes(job.status) ? (
                            <Button
                              danger
                              size="small"
                              icon={<StopOutlined />}
                              loading={cancelingJobId === job.job_id}
                              onClick={() => cancelCrawl(job.job_id)}
                            >
                              终止
                            </Button>
                          ) : null}
                        </Flex>
                      </Card>
                    ))
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />
                  )}
                </Space>
              </Col>
            </Row>
            <div>
              <Flex justify="space-between" align="center">
                <Text strong>采集提示词</Text>
                <Button icon={<CopyOutlined />} onClick={() => copyText(crawlPrompt)}>
                  复制
                </Button>
              </Flex>
              <Input.TextArea className="prompt-box" value={crawlPrompt} rows={9} readOnly />
            </div>

            <div>
              <Text strong>分级说明</Text>
              <div className="tier-list">
                {(sourceCatalog?.tiers || []).map((tier) => (
                  <Tag color={tierColor(tier.value)} key={tier.value}>
                    {tier.label}：{tier.description}
                  </Tag>
                ))}
              </div>
            </div>

          </Space>
        </Drawer>
      </Layout>
    </ConfigProvider>
  );
}

function tierColor(tier: string) {
  return { S: "gold", A: "green", B: "blue", C: "default" }[tier] || "default";
}

function jobStatusColor(status: string) {
  return { queued: "default", running: "processing", completed: "success", failed: "error", canceled: "warning" }[status] || "default";
}

function jobProgressPercent(job: CrawlJob) {
  if (job.status === "completed") return 100;
  if (job.status === "failed" || job.status === "canceled") {
    return Math.min(100, Math.round(((job.progress_processed || 0) / Math.max(job.limit_count || 1, 1)) * 100));
  }
  return Math.min(99, Math.round(((job.progress_processed || 0) / Math.max(job.limit_count || 1, 1)) * 100));
}

function tailLog(value: string) {
  return value
    .trim()
    .split(/\r?\n/)
    .slice(-4)
    .join("\n");
}

function formatRemoteTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
