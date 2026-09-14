import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  Headphones,
  LoaderCircle,
  Menu,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  UploadCloud,
  X,
  ArrowUpRight,
  CircleCheck,
  AlertCircle,
  Trash2,
} from "lucide-react";
import {
  api,
  ApiError,
  busyJob,
  send,
  type DocumentDetail,
  type DocumentSummary,
  type Question,
  type Settings,
} from "./types";
import {
  EditModal,
  HistoryModal,
  IconButton,
  Modal,
  QuestionView,
  SettingsModal,
  SourceModal,
  SpeechBar,
} from "./components";
import { useSpeech } from "./speech";
import { SelectionDictionary } from "./SelectionDictionary";

type Dialog =
  | { kind: "settings" | "export" | "regenerate" }
  | { kind: "edit" | "source" | "history" | "candidate"; q: Question }
  | { kind: "duplicate"; id: string; file: File }
  | {
      kind: "delete";
      document: Pick<DocumentSummary, "id" | "title" | "total">;
    }
  | null;

export default function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [settings, setSettings] = useState<Settings>({
    configured: false,
    model: "deepseek-flash",
  });
  const [loading, setLoading] = useState(true),
    [uploading, setUploading] = useState(false),
    [actionBusy, setActionBusy] = useState(false);
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [active, setActive] = useState(0);
  const [sidebar, setSidebar] = useState(false),
    [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState(""),
    [loadError, setLoadError] = useState("");
  const [deleting, setDeleting] = useState(false),
    [deleteError, setDeleteError] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null),
    selectedRef = useRef(""),
    dragDepth = useRef(0),
    loadSequence = useRef(0),
    listSequence = useRef(0),
    deletingRef = useRef(false);
  const notify = useCallback((message: string) => setToast(message), []);
  const speech = useSpeech(notify);
  const close = useCallback(() => setDialog(null), []);
  const closeDelete = useCallback(() => {
    if (!deletingRef.current) setDialog(null);
  }, []);
  selectedRef.current = selected;

  const loadDocument = useCallback(async (id: string, restore = false) => {
    const seq = ++loadSequence.current;
    const detail = await api<DocumentDetail>(`/documents/${id}`);
    if (selectedRef.current !== id || seq !== loadSequence.current) return;
    setDoc(detail);
    setLoadError("");
    if (restore) {
      setActive(detail.bookmark);
      if (detail.bookmark > 0)
        window.setTimeout(() => {
          if (selectedRef.current === id)
            document
              .getElementById("q-" + detail.bookmark)
              ?.scrollIntoView({ block: "start" });
        }, 100);
    }
  }, []);
  const initialize = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [list, cfg] = await Promise.all([
        api<DocumentSummary[]>("/documents"),
        api<Settings>("/settings"),
      ]);
      setDocuments(list);
      setSettings(cfg);
      const last = localStorage.getItem("wordnote.document");
      setSelected(list.find((d) => d.id === last)?.id || list[0]?.id || "");
    } catch (e) {
      setLoadError("无法连接本机服务，请确认启动窗口仍在运行。");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    if (!selected) {
      setDoc(null);
      if (!loading) localStorage.removeItem("wordnote.document");
      return;
    }
    localStorage.setItem("wordnote.document", selected);
    setDoc(null);
    setSearch("");
    setFilter("all");
    setActive(0);
    setSidebar(false);
    speech.stop();
    void loadDocument(selected, true).catch((e) => {
      if (selectedRef.current === selected) setLoadError(e.message);
    });
    window.scrollTo({ top: 0 });
  }, [selected, loadDocument, speech.stop]);
  const refresh = useCallback(async () => {
    const seq = ++listSequence.current;
    const [list] = await Promise.all([
      api<DocumentSummary[]>("/documents"),
      selectedRef.current
        ? loadDocument(selectedRef.current)
        : Promise.resolve(),
    ]);
    if (seq === listSequence.current) setDocuments(list);
  }, [loadDocument]);
  const running = busyJob(doc?.job);
  useEffect(() => {
    if (!running || !selected) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => notify(e.message));
    }, 1800);
    return () => clearInterval(timer);
  }, [running, selected, refresh, notify]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 8000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const visible = useMemo(
    () =>
      (doc?.questions || []).filter((q) => {
        if (
          filter === "review" &&
          !q.review &&
          !q.issues.length &&
          !q.candidate
        )
          return false;
        if (
          filter === "pending" &&
          q.note &&
          q.status !== "error" &&
          !q.missing_explanations?.length
        )
          return false;
        const text = [
          q.number,
          q.sentence,
          ...Object.values(q.options),
          ...(q.note?.options.flatMap((o) => [
            o.meaning,
            o.reason,
            ...o.collocations.map((p) => p.text),
          ]) || []),
        ]
          .join(" ")
          .toLowerCase();
        return text.includes(search.trim().toLowerCase());
      }),
    [doc, filter, search],
  );
  const visibleKey = visible.map((q) => q.id).join(",");
  useEffect(() => {
    if (!doc) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visibleEntries[0])
          setActive(
            Number((visibleEntries[0].target as HTMLElement).dataset.ordinal),
          );
      },
      { rootMargin: "-100px 0px -55% 0px", threshold: 0 },
    );
    document
      .querySelectorAll(".question")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [doc?.id, visibleKey]);
  useEffect(() => {
    if (!doc || selected !== doc.id) return;
    const timer = setTimeout(() => {
      void api(
        `/documents/${doc.id}/bookmark`,
        send("PUT", { ordinal: active }),
      ).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [active, doc?.id, selected]);

  async function upload(file: File, duplicate = false) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      notify("请选择 PDF 文件");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      notify("单份 PDF 最大为 25 MB");
      return;
    }
    setUploading(true);
    close();
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await api<{ id: string }>(
        "/documents" + (duplicate ? "?duplicate=true" : ""),
        { method: "POST", body: form },
      );
      const list = await api<DocumentSummary[]>("/documents");
      setDocuments(list);
      setSelected(result.id);
      notify("PDF 已导入");
    } catch (e) {
      if (e instanceof ApiError && e.data.duplicate_id)
        setDialog({ kind: "duplicate", id: String(e.data.duplicate_id), file });
      else notify((e as Error).message);
    } finally {
      setUploading(false);
      if (uploadInput.current) uploadInput.current.value = "";
    }
  }
  const drop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (uploading || dialog) return;
    const file = e.dataTransfer.files[0];
    if (file) void upload(file);
  };
  async function generate(ids?: string[]) {
    if (!doc) return;
    if (!settings.configured) {
      setDialog({ kind: "settings" });
      return;
    }
    setActionBusy(true);
    close();
    try {
      await api(
        `/documents/${doc.id}/generate`,
        send("POST", { question_ids: ids || null }),
      );
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  }
  async function stop() {
    if (!doc) return;
    try {
      await api(`/documents/${doc.id}/stop`, { method: "POST" });
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function deleteDocument() {
    if (dialog?.kind !== "delete" || deletingRef.current) return;
    const target = dialog.document;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await api<{ ok: boolean; warning: string }>(
        `/documents/${target.id}`,
        { method: "DELETE" },
      );
      listSequence.current++;
      const remaining = documents.filter((item) => item.id !== target.id);
      setDocuments(remaining);
      if (selectedRef.current === target.id) {
        loadSequence.current++;
        speech.stop();
        const index = documents.findIndex((item) => item.id === target.id);
        const next = remaining[Math.min(index, remaining.length - 1)]?.id || "";
        selectedRef.current = next;
        setSelected(next);
        setDoc(null);
        setLoadError("");
        setSearch("");
        setFilter("all");
        setActive(0);
      }
      close();
      notify(result.warning || "资料已删除");
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }
  async function review(q: Question) {
    try {
      await api(
        `/questions/${q.id}/review`,
        send("PUT", { review: !q.review }),
      );
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function exportMd() {
    if (!doc) return;
    try {
      const response = await fetch(`/api/documents/${doc.id}/markdown`);
      if (!response.ok) throw new Error("导出失败，请重试");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = doc.title.replace(/[<>:"/\\|?*]/g, "-") + ".md";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      close();
      notify("Markdown 已导出");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function jump(ordinal: number) {
    if (!visible.some((q) => q.ordinal === ordinal)) {
      setFilter("all");
      setSearch("");
    }
    setActive(ordinal);
    setSidebar(false);
    setTimeout(
      () =>
        document
          .getElementById("q-" + ordinal)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      30,
    );
  }
  const questions = doc?.questions || [];
  const done = questions.filter((q) => q.note).length;
  const reviewCount = questions.filter(
    (q) => q.review || q.issues.length || q.candidate,
  ).length;
  const pending = questions.filter(
    (q) => !q.note || q.status === "error" || q.missing_explanations?.length,
  ).length;
  const current = questions.find((q) => q.ordinal === active) || questions[0];
  const fileIndex =
    Math.max(
      0,
      documents.findIndex((d) => d.id === selected),
    ) + 1;
  const selectedSummary = documents.find((d) => d.id === selected);

  return (
    <div
      className="app-shell"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
    >
      <input
        className="file-input"
        type="file"
        accept="application/pdf,.pdf"
        ref={uploadInput}
        aria-label="选择 PDF 文件"
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0]);
        }}
      />
      {sidebar && (
        <div className="sidebar-backdrop" onClick={() => setSidebar(false)} />
      )}
      <aside className={"sidebar " + (sidebar ? "sidebar-open" : "")}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <span className="brand-mark">
            <BookOpen size={22} strokeWidth={1.8} />
          </span>
          <span className="brand-name">
            词间<span>WORDNOTE</span>
          </span>
        </a>
        <div className="library-heading">
          <span>我的资料</span>
          <span className="count-label">{documents.length}</span>
        </div>
        <button
          className="upload-button"
          onClick={() => uploadInput.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Plus size={18} />
          )}{" "}
          {uploading ? "正在解析 PDF" : "导入 PDF"}
        </button>
        <nav className="document-list" aria-label="文档列表">
          {documents.map((d, i) => (
            <button
              key={d.id}
              className={
                "document-item " + (d.id === selected ? "document-active" : "")
              }
              onClick={() => setSelected(d.id)}
            >
              <span className="document-symbol">
                <FileText size={18} />
              </span>
              <span className="document-info">
                <span className="document-title">{d.title}</span>
                <span className="document-subtitle">
                  {d.total} 道题<span>·</span>
                  {d.completed === d.total && d.total > 0
                    ? "笔记已就绪"
                    : `${d.completed} 道已完成`}
                </span>
              </span>
              {d.id === selected && <span className="selected-dot" />}
              <span className="sr-only">文档 {i + 1}</span>
            </button>
          ))}
        </nav>
        {selectedSummary && (
          <div className="sidebar-document-detail">
            <div className="section-label">当前资料</div>
            <div className="sidebar-file-info">
              <FileText size={15} />
              <span>PDF 文档</span>
              <span>{selectedSummary.pages} 页</span>
            </div>
            <div className="storage-line">
              <span className="status-dot is-green" />
              已保存到本机
            </div>
          </div>
        )}
        <div className="sidebar-bottom">
          <button
            className="sidebar-settings"
            onClick={() => setDialog({ kind: "settings" })}
          >
            <Settings2 size={17} />
            <span>学习设置</span>
            <ChevronRight size={15} />
          </button>
          <div className="local-badge">
            <span className="local-avatar">L</span>
            <div>
              <b>本机空间</b>
              <span>个人资料库</span>
            </div>
            <span className="status-dot is-green" />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              className="mobile-menu"
              label="打开资料导航"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </IconButton>
            <FolderOpen size={16} />
            <span>我的资料</span>
            <ChevronRight size={14} />
            <span className="breadcrumb-current">
              {doc
                ? `词汇练习 ${String(fileIndex).padStart(2, "0")}`
                : "学习空间"}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="saved-label">
              <span className="status-dot is-green" />
              本地保存
            </span>
            <IconButton
              label="朗读与模型设置"
              onClick={() => setDialog({ kind: "settings" })}
            >
              <Settings2 size={18} />
            </IconButton>
          </div>
        </header>
        {loadError ? (
          <div className="empty-state">
            <AlertCircle size={34} />
            <h2>暂时无法读取资料</h2>
            <p>{loadError}</p>
            <button
              className="button primary"
              onClick={() =>
                void (selected
                  ? loadDocument(selected).catch((e) => setLoadError(e.message))
                  : initialize())
              }
            >
              重新连接
            </button>
          </div>
        ) : loading || (selected && !doc) ? (
          <div className="empty-state">
            <LoaderCircle size={30} className="spin" />
            <p>正在打开学习资料</p>
          </div>
        ) : !doc ? (
          <div className="empty-state">
            <div className="empty-icon">
              <BookOpen size={42} />
            </div>
            <h1>英语词汇学习助手</h1>
            <button
              className="button primary"
              onClick={() => uploadInput.current?.click()}
            >
              <FilePlus2 size={18} />
              导入词汇练习
            </button>
            <p>PDF · 最大 25 MB</p>
          </div>
        ) : (
          <>
            <div className="workspace-content">
              <div className="document-header">
                <div className="document-eyebrow">
                  <span className="eyebrow-line" />
                  VOCABULARY NOTES
                  <span className="eyebrow-index">
                    {String(fileIndex).padStart(2, "0")}
                  </span>
                </div>
                <div className="document-title-row">
                  <h1>{doc.title}</h1>
                  <div className="document-actions">
                    <button
                      className="button secondary export-button"
                      aria-label="导出笔记"
                      title="导出笔记"
                      onClick={() => {
                        if (pending || reviewCount)
                          setDialog({ kind: "export" });
                        else void exportMd();
                      }}
                    >
                      <Download size={16} />
                      <span>导出笔记</span>
                    </button>
                    <IconButton
                      label="删除资料"
                      className="delete-document-button"
                      disabled={actionBusy || uploading || deleting}
                      onClick={() => {
                        setDeleteError("");
                        setDialog({
                          kind: "delete",
                          document: {
                            id: doc.id,
                            title: doc.title,
                            total: questions.length,
                          },
                        });
                      }}
                    >
                      <Trash2 size={17} />
                    </IconButton>
                  </div>
                </div>
                <div className="document-metadata">
                  <span>{questions.length} 道题</span>
                  <span className="tiny-dot" />
                  <span>
                    {questions.reduce(
                      (sum, q) => sum + Object.keys(q.options).length,
                      0,
                    )}{" "}
                    个选项
                  </span>
                  <span className="tiny-dot" />
                  <span>{doc.pages} 页原文</span>
                  <span className="metadata-divider" />
                  <span className="generated-status">
                    <CircleCheck size={14} />
                    {done === questions.length && done > 0
                      ? "笔记已就绪"
                      : `${done} 道笔记已完成`}
                  </span>
                </div>
              </div>
              {doc.warnings.map((w, i) => (
                <div className="error-banner" key={i}>
                  {w}
                </div>
              ))}
              {doc.job && (
                <div className={"job-banner " + (running ? "job-active" : "")}>
                  <div>
                    {running ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : doc.job.failed || doc.job.error ? (
                      <AlertCircle size={17} />
                    ) : (
                      <Check size={17} />
                    )}
                    <span>
                      {running
                        ? doc.job.stop
                          ? "正在停止，保存当前结果"
                          : "正在生成笔记"
                        : {
                            completed: "本次生成已完成",
                            stopped: "生成已停止",
                            interrupted: "生成已中断",
                            partial: "部分题目生成失败",
                          }[doc.job.status] || "生成任务"}
                    </span>
                    <span className="subtle">
                      {doc.job.completed} / {doc.job.total}
                    </span>
                  </div>
                  {doc.job.error && <span>{doc.job.error}</span>}
                  {running && (
                    <button
                      className="text-link"
                      onClick={() => void stop()}
                      disabled={!!doc.job.stop}
                    >
                      <Square size={13} />
                      停止
                    </button>
                  )}
                </div>
              )}
              <div className="study-toolbar">
                <div
                  className="study-tabs"
                  role="tablist"
                  aria-label="笔记筛选"
                >
                  {[
                    ["all", "全部题目", questions.length],
                    ["review", "待核对", reviewCount],
                    ["pending", "待完成", pending],
                  ].map(([key, label, count]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={filter === key}
                      onClick={() => setFilter(String(key))}
                      className={filter === key ? "tab-active" : ""}
                    >
                      {label}
                      <span>{count}</span>
                    </button>
                  ))}
                </div>
                <div className="study-toolbar-actions">
                  <label className="search-field">
                    <Search size={16} />
                    <input
                      type="search"
                      aria-label="搜索单词、搭配或题目"
                      placeholder="搜索单词、搭配…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        aria-label="清除搜索"
                        onClick={() => setSearch("")}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <button
                    className="button primary generate-button"
                    disabled={running || actionBusy || !questions.length}
                    onClick={() => {
                      if (!settings.configured) setDialog({ kind: "settings" });
                      else if (!pending) setDialog({ kind: "regenerate" });
                      else void generate();
                    }}
                  >
                    {actionBusy ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Sparkles size={15} />
                    )}
                    <span>{pending ? "生成笔记" : "重新生成"}</span>
                  </button>
                </div>
              </div>
              <div className="study-layout">
                <div className="notes-column">
                  {visible.length ? (
                    visible.map((q) => (
                      <QuestionView
                        key={q.id}
                        q={q}
                        speech={speech}
                        running={running}
                        edit={() => setDialog({ kind: "edit", q })}
                        source={() => setDialog({ kind: "source", q })}
                        history={() => setDialog({ kind: "history", q })}
                        candidate={() => setDialog({ kind: "candidate", q })}
                        regenerate={() => void generate([q.id])}
                        review={() => void review(q)}
                      />
                    ))
                  ) : (
                    <div className="empty-filter">
                      <Search size={28} />
                      <h3>
                        {search
                          ? "没有匹配的题目"
                          : filter === "review"
                            ? "待核对题目已清空"
                            : filter === "pending"
                              ? "所有笔记已完成"
                              : "尚未识别到题目"}
                      </h3>
                      {(search || filter !== "all") && (
                        <button
                          className="button secondary"
                          onClick={() => {
                            setSearch("");
                            setFilter("all");
                          }}
                        >
                          查看全部题目
                        </button>
                      )}
                    </div>
                  )}
                  {visible.length > 0 && (
                    <div className="document-end">
                      <span />
                      <BookOpen size={17} />
                      <span />
                      <p>本份笔记共 {questions.length} 题</p>
                      <button
                        className="text-link"
                        onClick={() =>
                          window.scrollTo({ top: 0, behavior: "smooth" })
                        }
                      >
                        回到顶部
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
                <aside className="study-rail">
                  <div className="rail-heading">
                    <span>题目导航</span>
                    <span>
                      {current?.number || 0} / {questions.length}
                    </span>
                  </div>
                  <div className="question-grid">
                    {questions.map((q) => (
                      <button
                        key={q.id}
                        onClick={() => jump(q.ordinal)}
                        aria-label={`跳转第 ${q.number} 题`}
                        aria-current={
                          active === q.ordinal ? "location" : undefined
                        }
                        className={
                          (active === q.ordinal ? "nav-active " : "") +
                          (q.status === "error" || q.issues.length
                            ? "nav-error"
                            : q.note
                              ? "nav-done"
                              : "")
                        }
                      >
                        {String(q.number).padStart(2, "0")}
                        {q.candidate && <span />}
                      </button>
                    ))}
                  </div>
                  <div className="nav-legend">
                    <span>
                      <i className="legend-done" />
                      已有笔记
                    </span>
                    <span>
                      <i className="legend-current" />
                      当前位置
                    </span>
                  </div>
                  <div className="rail-section">
                    <div className="rail-heading">
                      <span>原始文档</span>
                      <span>PDF</span>
                    </div>
                    <button
                      className="pdf-preview-button"
                      onClick={() => {
                        if (current) setDialog({ kind: "source", q: current });
                      }}
                      disabled={!current}
                    >
                      <img
                        src={`/api/documents/${doc.id}/preview/${current?.page || 1}`}
                        alt={`${doc.title} 原文缩略图`}
                      />
                      <span>
                        第 {current?.page || 1} 页<ArrowUpRight size={14} />
                      </span>
                    </button>
                  </div>
                  <div className="rail-section voice-summary">
                    <div className="rail-heading">
                      <span>朗读</span>
                      <Headphones size={15} />
                    </div>
                    <button onClick={() => setDialog({ kind: "settings" })}>
                      <span>
                        {speech.selectedVoice
                          ? speech.selectedVoice.lang === "en-US"
                            ? "美式英语"
                            : speech.selectedVoice.lang === "en-GB"
                              ? "英式英语"
                              : speech.selectedVoice.lang
                          : "选择英语音色"}
                      </span>
                      <ChevronDown size={14} />
                    </button>
                    <div className="voice-rate">
                      <span>语速</span>
                      <span>{speech.rate.toFixed(1)}×</span>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </>
        )}
      </main>
      {dragging && !dialog && (
        <div className="drop-overlay">
          <UploadCloud size={48} />
          <h2>导入 PDF</h2>
          <p>词汇选择题 · 最大 25 MB</p>
        </div>
      )}
      {uploading && (
        <div className="upload-progress" role="status">
          <LoaderCircle className="spin" size={18} />
          正在提取题干和选项
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <IconButton label="关闭提示" onClick={() => setToast("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {speech.playing && <SpeechBar speech={speech} />}
      {dialog?.kind === "settings" && (
        <SettingsModal
          settings={settings}
          speech={speech}
          close={close}
          saved={setSettings}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditModal q={dialog.q} close={close} saved={refresh} />
      )}
      {dialog?.kind === "source" && doc && (
        <SourceModal
          q={dialog.q}
          pages={doc.pages}
          close={close}
          saved={refresh}
        />
      )}
      {(dialog?.kind === "history" || dialog?.kind === "candidate") && (
        <HistoryModal
          q={dialog.q}
          candidateOnly={dialog.kind === "candidate"}
          close={close}
          saved={refresh}
        />
      )}
      {dialog?.kind === "duplicate" && (
        <Modal title="这份资料已在资料库中" close={close}>
          <div className="modal-body">
            <p className="dialog-copy">{dialog.file.name}</p>
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              onClick={() => void upload(dialog.file, true)}
            >
              <Plus size={16} />
              创建副本
            </button>
            <button
              className="button primary"
              onClick={() => {
                setSelected(dialog.id);
                close();
              }}
            >
              <FolderOpen size={16} />
              打开已有资料
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === "export" && (
        <Modal title="导出 Markdown 笔记" close={close}>
          <div className="modal-body">
            <p className="dialog-copy">{doc?.title}</p>
            <div className="export-status">
              <span>{done} 道已有笔记</span>
              <span>{pending} 道待完成</span>
              <span>{reviewCount} 道待核对</span>
            </div>
            <p className="field-note">
              导出包含当前采用的版本，以及未完成和待核对标记。
            </p>
          </div>
          <footer className="modal-footer">
            <button className="button secondary" onClick={close}>
              取消
            </button>
            <button className="button primary" onClick={() => void exportMd()}>
              <Download size={16} />
              导出当前版本
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === "delete" && (
        <Modal title="删除这份资料？" close={closeDelete}>
          <div className="modal-body delete-document-body">
            <p className="delete-document-title">{dialog.document.title}</p>
            <p className="dialog-copy">
              将删除应用中这份资料的 PDF 副本、{dialog.document.total}{" "}
              道题目、笔记、修订历史和生成记录，无法撤销。
            </p>
            <p className="field-note">
              电脑上的原文件及已导出的 Markdown 不受影响。
            </p>
            {running && (
              <p className="warning-text">
                生成任务尚未结束，请先停止生成并等待当前请求结束。
              </p>
            )}
            {deleteError && (
              <p className="error-banner" role="alert">
                {deleteError}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              onClick={closeDelete}
              disabled={deleting}
            >
              取消
            </button>
            {running ? (
              <button
                className="button secondary"
                onClick={() => void stop()}
                disabled={!!doc?.job?.stop}
              >
                <Square size={15} />
                {doc?.job?.stop ? "正在停止" : "停止生成"}
              </button>
            ) : (
              <button
                className="button danger"
                onClick={() => void deleteDocument()}
                disabled={deleting}
              >
                {deleting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Trash2 size={16} />
                )}
                {deleting ? "正在删除" : "确认删除"}
              </button>
            )}
          </footer>
        </Modal>
      )}
      {dialog?.kind === "regenerate" && (
        <Modal title="重新生成整份笔记" close={close}>
          <div className="modal-body">
            <p className="dialog-copy">
              将向 DeepSeek 提交{" "}
              {questions.filter((q) => !q.issues.length).length}{" "}
              道题，按接口用量计费。人工修改过的题目会保留当前版本，并生成候选版本供比较。
            </p>
          </div>
          <footer className="modal-footer">
            <button className="button secondary" onClick={close}>
              取消
            </button>
            <button
              className="button primary"
              onClick={() =>
                void generate(
                  questions.filter((q) => !q.issues.length).map((q) => q.id),
                )
              }
            >
              <Sparkles size={16} />
              开始生成
            </button>
          </footer>
        </Modal>
      )}
      <SelectionDictionary
        speech={speech}
        openSettings={() => setDialog({ kind: "settings" })}
        scopeKey={`${selected}:${dialog?.kind || ""}:${filter}:${search}`}
      />
    </div>
  );
}
