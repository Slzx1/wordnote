import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  History,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Volume2,
  X,
  Flag,
  Square,
  Save,
} from "lucide-react";
import {
  api,
  send,
  letters,
  busyQuestion,
  type Note,
  type Question,
  type Revision,
  type Settings,
} from "./types";
import type { Speech } from "./speech";

export function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={"icon-button " + className}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  close,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current
      ?.querySelector<HTMLElement>("input,button,select,textarea")
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const elements = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]),input,select,textarea,a[href]",
          ) || []),
        ].filter((el) => el.offsetParent !== null);
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={"modal " + (wide ? "modal-wide" : "")}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="关闭窗口" onClick={close}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}

export function SettingsModal({
  settings,
  speech,
  close,
  saved,
}: {
  settings: Settings;
  speech: Speech;
  close: () => void;
  saved: (s: Settings) => void;
}) {
  const [model, setModel] = useState(settings.model),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    try {
      saved(
        await api<Settings>(
          "/settings",
          send("PUT", {
            model,
            ...(key.trim() ? { api_key: key.trim() } : {}),
          }),
        ),
      );
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="学习设置" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-body settings-body">
          <div className="section-label">
            笔记生成{" "}
            <span
              className={
                "status-dot " + (settings.configured ? "is-green" : "")
              }
            />
            <span className="subtle">
              {settings.configured ? "已配置" : "未配置"}
            </span>
          </div>
          <label>
            模型
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              spellCheck={false}
            />
          </label>
          <label>
            DeepSeek API Key
            <input
              type="password"
              autoComplete="new-password"
              placeholder={
                settings.configured ? "已保存，留空保留现有密钥" : "sk-…"
              }
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p className="field-note">
            密钥保存在本机。生成时题目文本将发送至 DeepSeek。
          </p>
          <div className="settings-divider" />
          <div className="section-label">英语朗读</div>
          <label>
            音色
            <select
              value={speech.selectedVoice?.voiceURI || ""}
              onChange={(e) => {
                speech.stop();
                speech.setVoiceURI(e.target.value);
              }}
            >
              {!speech.voices.length && (
                <option value="">没有可用的英语音色</option>
              )}
              {speech.voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} · {v.lang}
                  {v.localService ? " · 本机" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            语速 <span className="rate-value">{speech.rate.toFixed(1)}×</span>
            <input
              type="range"
              min="0.6"
              max="1.5"
              step="0.1"
              value={speech.rate}
              onChange={(e) => {
                speech.stop();
                speech.setRate(Number(e.target.value));
              }}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              speech.speak("A little progress, every day.", "voice-preview")
            }
          >
            <Volume2 size={16} />
            试听音色
          </button>
          {!speech.voices.length && (
            <p className="field-note warning-text">
              请在 Windows 语音设置中添加英语音色，或使用支持英语语音的浏览器。
            </p>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            保存设置
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function QuestionView({
  q,
  speech,
  edit,
  source,
  regenerate,
  review,
  history,
  candidate,
  running,
}: {
  q: Question;
  speech: Speech;
  edit: () => void;
  source: () => void;
  regenerate: () => void;
  review: () => void;
  history: () => void;
  candidate: () => void;
  running: boolean;
}) {
  const note = q.note;
  const speaking = speech.playing === q.id + "-sentence";
  return (
    <section
      className={"question " + (speaking ? "speaking-question" : "")}
      id={"q-" + q.ordinal}
      data-ordinal={q.ordinal}
      data-lookup-context={q.parts.join("")}
    >
      <div className="question-meta">
        <div className="question-meta-left">
          <span className="question-number">
            {String(q.number).padStart(2, "0")}
          </span>
          {note ? (
            <span className="answer-meta">
              <Check size={14} />
              答案 {note.answer}
            </span>
          ) : (
            <span className="pending-meta">
              {q.status === "invalid"
                ? "解析待修正"
                : q.status === "generating"
                  ? "正在生成"
                  : q.status === "queued"
                    ? "等待生成"
                    : q.status === "error"
                      ? "生成失败"
                      : "待生成"}
            </span>
          )}
          {!!q.review && <span className="review-label">待核对</span>}
          {busyQuestion(q) && <LoaderCircle size={14} className="spin" />}
        </div>
        <div className="question-tools">
          <IconButton
            label={`朗读第 ${q.number} 题原句`}
            onClick={() => speech.speak(q.parts.join(""), q.id + "-sentence")}
            disabled={!note}
          >
            <Volume2 size={16} />
          </IconButton>
          <IconButton label={`查看第 ${q.number} 题原文`} onClick={source}>
            <FileText size={16} />
          </IconButton>
          <IconButton
            label={`编辑第 ${q.number} 题笔记`}
            onClick={edit}
            disabled={!note || busyQuestion(q)}
          >
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label={`重新生成第 ${q.number} 题`}
            onClick={regenerate}
            disabled={!!q.issues.length || running}
          >
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label={`第 ${q.number} 题修订历史`} onClick={history}>
            <History size={16} />
          </IconButton>
          <IconButton
            label={
              q.review
                ? `确认第 ${q.number} 题已核对`
                : `标记第 ${q.number} 题待核对`
            }
            onClick={review}
            className={q.review ? "flagged" : ""}
          >
            {q.review ? <CheckCheck size={16} /> : <Flag size={15} />}
          </IconButton>
        </div>
      </div>
      <div
        className={"sentence " + (speaking ? "is-speaking" : "")}
        onClick={() => {
          if (note) speech.speak(q.parts.join(""), q.id + "-sentence");
        }}
      >
        {q.parts[0]}
        {q.parts[1] && (
          <button
            className={
              "answer-word " +
              (speech.playing === q.id + "-target" ? "is-speaking" : "")
            }
            title="朗读目标词"
            onClick={(e) => {
              e.stopPropagation();
              speech.speak(q.parts[1], q.id + "-target");
            }}
          >
            {q.parts[1]}
          </button>
        )}
        {q.parts[2]}
      </div>
      {q.issues.length > 0 && (
        <div className="inline-alert">
          {q.issues.join("；")}
          <button onClick={source}>
            修正原题
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      {q.error && <div className="inline-alert">{q.error}</div>}
      <div className="options-list">
        {letters.map((label) => {
          const option = note?.options.find((o) => o.label === label);
          const correct = note?.answer === label;
          return (
            <div
              key={label}
              className={"option-row " + (correct ? "correct-option" : "")}
            >
              <span className="option-letter">{label}</span>
              <div className="option-content">
                <div className="option-definition">
                  <button
                    className={
                      "word-button " +
                      (speech.playing === q.id + label ? "is-speaking" : "")
                    }
                    onClick={() => speech.speak(q.options[label], q.id + label)}
                    disabled={!q.options[label]}
                    aria-label={`朗读单词 ${q.options[label] || label}`}
                  >
                    {q.options[label] || "缺失选项"}
                    <Volume2 className="word-speaker" size={13} />
                  </button>
                  {option && (
                    <>
                      <span className="pos">{option.pos}</span>
                      <span className="meaning">{option.meaning}</span>
                    </>
                  )}
                  {correct && <Check className="correct-check" size={15} />}
                </div>
                {option && (
                  <>
                    <div className="collocations">
                      <span className="collocation-label">搭配</span>
                      {option.collocations.map((p, i) => (
                        <button
                          key={i}
                          className={
                            "phrase " +
                            (speech.playing === `${q.id}-${label}-${i}`
                              ? "is-speaking"
                              : "")
                          }
                          onClick={() =>
                            speech.speak(
                              p.speak || p.text,
                              `${q.id}-${label}-${i}`,
                            )
                          }
                          aria-label={`朗读搭配 ${p.text}`}
                        >
                          {p.text}
                        </button>
                      ))}
                    </div>
                    <p
                      className={
                        "reason " +
                        (q.missing_explanations?.includes(label)
                          ? "reason-missing"
                          : "")
                      }
                    >
                      <span className="reason-label">解释</span>
                      {q.missing_explanations?.includes(label)
                        ? "旧版笔记解释待补充"
                        : option.reason}
                    </p>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {note?.uncertainty && (
        <div className="inline-alert">{note.uncertainty}</div>
      )}
      {q.candidate && (
        <button className="candidate-notice" onClick={candidate}>
          <History size={15} />
          新候选版本待采用
          <ChevronRight size={15} />
        </button>
      )}
      <div className="note-provenance">
        <span>第 {q.page} 页</span>
        {q.source && (
          <>
            <span className="tiny-dot" />
            <span>
              {q.source}
              {q.source.startsWith("DeepSeek") ? " · 模型推断" : ""}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function NoteForm({
  value,
  change,
  words,
}: {
  value: Note;
  change: (n: Note) => void;
  words: Question["options"];
}) {
  const update = (index: number, key: string, field: unknown) =>
    change({
      ...value,
      options: value.options.map((o, i) =>
        i === index ? { ...o, [key]: field } : o,
      ),
    });
  return (
    <>
      <label className="answer-select">
        正确答案
        <select
          value={value.answer}
          onChange={(e) =>
            change({ ...value, answer: e.target.value as Note["answer"] })
          }
        >
          {letters.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      {value.options.map((o, i) => (
        <fieldset className="edit-option" key={o.label}>
          <legend>
            {o.label} · {words[o.label]}
          </legend>
          <div className="edit-definition">
            <label>
              词性
              <input
                value={o.pos}
                onChange={(e) => update(i, "pos", e.target.value)}
                required
              />
            </label>
            <label>
              中文释义
              <input
                value={o.meaning}
                onChange={(e) => update(i, "meaning", e.target.value)}
                required
              />
            </label>
          </div>
          <label>
            搭配（每行一条）
            <textarea
              rows={Math.min(5, Math.max(2, o.collocations.length))}
              value={o.collocations.map((p) => p.text).join("\n")}
              onChange={(e) =>
                update(
                  i,
                  "collocations",
                  e.target.value
                    .split("\n")
                    .map((text) => ({ text, speak: "" })),
                )
              }
              required
              spellCheck={false}
            />
          </label>
          <label>
            简要解释（必填）
            <textarea
              rows={2}
              value={o.reason}
              onChange={(e) => update(i, "reason", e.target.value)}
              required
              minLength={8}
            />
          </label>
        </fieldset>
      ))}
      <label>
        待核对说明
        <textarea
          rows={2}
          value={value.uncertainty}
          onChange={(e) => change({ ...value, uncertainty: e.target.value })}
        />
      </label>
    </>
  );
}

export function EditModal({
  q,
  close,
  saved,
}: {
  q: Question;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [note, setNote] = useState<Note>(structuredClone(q.note!));
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    try {
      const clean = {
        ...note,
        options: note.options.map((o) => ({
          ...o,
          collocations: o.collocations.filter((p) => p.text.trim()),
        })),
      };
      await api(
        `/questions/${q.id}/note`,
        send("PUT", { note: clean, version: q.version }),
      );
      await saved();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={`编辑第 ${q.number} 题`}
      subtitle="笔记修订"
      wide
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-body">
          <p className="edit-sentence">{q.parts.join("")}</p>
          <NoteForm value={note} change={setNote} words={q.options} />
          {note.answer !== q.note?.answer && (
            <p className="inline-alert">
              答案已改变，保存后本题将标记为待核对。
            </p>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存修改
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function SourceModal({
  q,
  pages,
  close,
  saved,
}: {
  q: Question;
  pages: number;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [page, setPage] = useState(q.page),
    [editing, setEditing] = useState(!!q.issues.length);
  const [sentence, setSentence] = useState(q.sentence),
    [options, setOptions] = useState({ ...q.options });
  const [number, setNumber] = useState(q.number),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    try {
      await api(
        `/questions/${q.id}/source`,
        send("PUT", { number, sentence, options, version: q.version }),
      );
      await saved();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={`原文 · 第 ${q.number} 题`}
      subtitle={`来源第 ${q.page} 页`}
      wide
      close={close}
    >
      <div className="pdf-toolbar">
        <div className="page-stepper">
          <IconButton
            label="上一页"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={17} />
          </IconButton>
          <span>
            {page} / {pages}
          </span>
          <IconButton
            label="下一页"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={17} />
          </IconButton>
        </div>
        <a
          href={`/api/documents/${q.document_id}/pdf#page=${page}`}
          target="_blank"
          rel="noreferrer"
          className="text-link"
        >
          打开 PDF
          <ExternalLink size={14} />
        </a>
        <button
          className="button secondary small"
          onClick={() => setEditing((v) => !v)}
          disabled={busyQuestion(q)}
        >
          <Pencil size={14} />
          {editing ? "收起修正" : "修正解析"}
        </button>
      </div>
      <div className="modal-body pdf-body">
        <img
          className="pdf-page"
          src={`/api/documents/${q.document_id}/preview/${page}`}
          alt={`PDF 原文第 ${page} 页`}
        />
        {editing && (
          <form
            className="source-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h3>修正解析</h3>
            <p className="field-note">
              修正后将重新生成本题笔记，已有笔记保留在修订历史。
            </p>
            <label>
              题号
              <input
                type="number"
                min={1}
                max={9999}
                value={number}
                onChange={(e) => setNumber(Number(e.target.value))}
                required
              />
            </label>
            <label>
              原始题干
              <textarea
                rows={4}
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                required
                spellCheck={false}
              />
            </label>
            {letters.map((l) => (
              <label key={l}>
                {l} 选项
                <input
                  value={options[l] || ""}
                  onChange={(e) =>
                    setOptions({ ...options, [l]: e.target.value })
                  }
                  required
                />
              </label>
            ))}
            <details>
              <summary>最初提取记录</summary>
              <pre>{q.original.raw}</pre>
            </details>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <button className="button primary" disabled={saving}>
              {saving ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Save size={16} />
              )}
              保存原题修正
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

function ReadNote({ note, words }: { note: Note; words: Question["options"] }) {
  return (
    <div className="read-note">
      <strong>答案 {note.answer}</strong>
      {note.options.map((o) => (
        <div key={o.label}>
          <b>
            {o.label} · {words[o.label]}
          </b>
          <p>
            {o.pos} {o.meaning}
          </p>
          <p className="history-phrases">
            {o.collocations.map((p) => p.text).join(" / ")}
          </p>
          <p>{o.reason}</p>
        </div>
      ))}
      {note.uncertainty && <p className="warning-text">{note.uncertainty}</p>}
    </div>
  );
}

export function HistoryModal({
  q,
  candidateOnly,
  close,
  saved,
}: {
  q: Question;
  candidateOnly: boolean;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]),
    [selected, setSelected] = useState<Revision | null>(null);
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [loading, setLoading] = useState(!candidateOnly);
  useEffect(() => {
    if (!candidateOnly)
      void api<Revision[]>(`/questions/${q.id}/history`)
        .then(setRevisions)
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
  }, [q.id, candidateOnly]);
  async function act(path: string, body: unknown) {
    setSaving(true);
    try {
      await api(`/questions/${q.id}/${path}`, send("POST", body));
      await saved();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const valid = (r: Revision): r is Revision & { payload: Note } =>
    "answer" in r.payload && Array.isArray(r.payload.options);
  return (
    <Modal
      title={
        candidateOnly
          ? `第 ${q.number} 题 · 版本比较`
          : `第 ${q.number} 题 · 修订历史`
      }
      wide
      close={close}
    >
      <div className="modal-body">
        {candidateOnly && q.candidate ? (
          <div className="compare-notes">
            <div>
              <h3>当前版本</h3>
              {q.note && <ReadNote note={q.note} words={q.options} />}
            </div>
            <div>
              <h3>模型候选</h3>
              <ReadNote note={q.candidate} words={q.options} />
            </div>
          </div>
        ) : (
          <>
            {loading && (
              <div className="loading-row">
                <LoaderCircle className="spin" size={18} />
                正在读取历史
              </div>
            )}
            <div className="revision-list">
              {revisions.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className={selected?.id === r.id ? "selected" : ""}
                >
                  <span>{r.source}</span>
                  <time>{new Date(r.created_at).toLocaleString("zh-CN")}</time>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
            {selected &&
              (valid(selected) ? (
                <ReadNote
                  note={selected.payload}
                  words={selected.context?.options || q.original.options}
                />
              ) : (
                <pre className="history-raw">
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              ))}
          </>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-footer">
        {candidateOnly ? (
          <>
            <button
              className="button secondary"
              disabled={saving}
              onClick={() =>
                void act("candidate", { accept: false, version: q.version })
              }
            >
              保留当前版本
            </button>
            <button
              className="button primary"
              disabled={saving}
              onClick={() =>
                void act("candidate", { accept: true, version: q.version })
              }
            >
              <Check size={16} />
              采用候选版本
            </button>
          </>
        ) : (
          <>
            <button className="button secondary" onClick={close}>
              关闭
            </button>
            <button
              className="button primary"
              disabled={
                saving ||
                !selected ||
                !valid(selected) ||
                !!q.issues.length ||
                busyQuestion(q)
              }
              onClick={() => {
                if (selected)
                  void act("restore", {
                    revision_id: selected.id,
                    version: q.version,
                  });
              }}
            >
              <RotateCcw size={16} />
              恢复此版本
            </button>
          </>
        )}
      </footer>
    </Modal>
  );
}

export function SpeechBar({ speech }: { speech: Speech }) {
  return (
    <div className="speech-bar">
      <div className="voice-wave">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span>{speech.preparing ? "正在准备语音" : "正在朗读"}</span>
      <span className="speech-rate">{speech.rate.toFixed(1)}×</span>
      <IconButton label="停止朗读" onClick={speech.stop}>
        <Square size={15} />
      </IconButton>
    </div>
  );
}
