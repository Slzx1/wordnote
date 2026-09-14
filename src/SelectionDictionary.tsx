import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Check,
  Copy,
  Languages,
  LoaderCircle,
  RotateCcw,
  Settings2,
  Volume2,
  X,
} from "lucide-react";
import { api, send } from "./types";
import type { Speech } from "./speech";
import { IconButton } from "./components";
import "./dictionary.css";

interface SelectedText {
  text: string;
  context: string;
  x: number;
  top: number;
  bottom: number;
}
interface Definition {
  text: string;
  kind: "local" | "model" | "unavailable";
  source?: string;
  source_url?: string;
  headword?: string;
  translation?: string;
  phonetic?: string;
  definition?: string;
  lemma?: string;
  lemma_translation?: string;
  usage?: string;
  cached?: boolean;
  message?: string;
  local?: Definition;
  examples?: { en: string; zh: string }[];
}

export function SelectionDictionary({
  speech,
  openSettings,
  scopeKey,
}: {
  speech: Speech;
  openSettings: () => void;
  scopeKey: string;
}) {
  const [selected, setSelected] = useState<SelectedText | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<Definition | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ left: 10, top: 10 });
  const element = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<SelectedText | null>(null);
  const expandedRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const dismissed = useRef("");
  const contextual = useRef(false);
  selectedRef.current = selected;
  expandedRef.current = expanded;

  const dismiss = useCallback(() => {
    dismissed.current = window.getSelection()?.toString().trim() || "";
    request.current?.abort();
    sequence.current++;
    setSelected(null);
    setExpanded(false);
    setResult(null);
    setError("");
    setLoading(false);
  }, []);
  useEffect(() => {
    dismiss();
  }, [scopeKey, dismiss]);

  useEffect(() => {
    let timer = 0;
    let pointerSelecting = false;
    const inspect = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      if (!text || selection?.isCollapsed) {
        dismissed.current = "";
        if (!expandedRef.current) setSelected(null);
        return;
      }
      if (
        pointerSelecting ||
        text === dismissed.current ||
        !/[a-zA-Z]/.test(text)
      )
        return;
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      const start =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const end =
        range.endContainer.nodeType === Node.ELEMENT_NODE
          ? (range.endContainer as Element)
          : range.endContainer.parentElement;
      const excluded =
        'input,textarea,select,[contenteditable="true"],[data-selection-dictionary]';
      if (!start || !end || start.closest(excluded) || end.closest(excluded))
        return;
      const rects = [...range.getClientRects()].filter(
        (r) => r.width > 0 && r.height > 0,
      );
      const rect =
        rects.find((r) => r.bottom > 0 && r.top < innerHeight) ||
        range.getBoundingClientRect();
      if (!rect.width || rect.bottom < 0 || rect.top > innerHeight) return;
      const question = start.closest<HTMLElement>(".question");
      const context =
        question && question.contains(end)
          ? question.dataset.lookupContext || ""
          : "";
      if (
        selectedRef.current?.text === text &&
        selectedRef.current.context === context
      )
        return;
      request.current?.abort();
      sequence.current++;
      speech.stop();
      setResult(null);
      setError("");
      setExpanded(false);
      setLoading(false);
      setCopied(false);
      setSelected({
        text,
        context,
        x: rect.left + rect.width / 2,
        top: rect.top,
        bottom: rect.bottom,
      });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = window.setTimeout(inspect, 80);
    };
    const down = (event: PointerEvent) => {
      if (element.current?.contains(event.target as Node)) return;
      pointerSelecting = true;
      if (expandedRef.current) dismiss();
    };
    const up = () => {
      pointerSelecting = false;
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedRef.current) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (event.shiftKey || event.key.startsWith("Arrow")) schedule();
    };
    const contextMenu = (event: MouseEvent) => {
      if (element.current?.contains(event.target as Node)) return;
      const text = window.getSelection()?.toString().trim();
      if (
        text &&
        /[a-zA-Z]/.test(text) &&
        !(event.target as Element).closest(
          'input,textarea,[contenteditable="true"]',
        )
      ) {
        event.preventDefault();
        dismissed.current = "";
        pointerSelecting = false;
        inspect();
      }
    };
    const scroll = (event: Event) => {
      if (!element.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", contextMenu);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("contextmenu", contextMenu);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [dismiss, speech.stop]);

  useLayoutEffect(() => {
    if (!selected || !element.current) return;
    const place = () => {
      const box = element.current!.getBoundingClientRect();
      const left = Math.min(
        Math.max(10, selected.x - box.width / 2),
        innerWidth - box.width - 10,
      );
      let top = selected.bottom + 8;
      if (top + box.height > innerHeight - 10)
        top = Math.max(10, selected.top - box.height - 8);
      setPosition({
        left,
        top: Math.min(top, Math.max(10, innerHeight - box.height - 10)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [selected, expanded]);

  async function lookup(inContext = false) {
    if (!selected) return;
    setExpanded(true);
    setError("");
    setLoading(true);
    setResult(null);
    contextual.current = inContext;
    if (selected.text.length > 2000) {
      setLoading(false);
      setError("每次最多查询 2000 个字符，请缩小选区。");
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const token = ++sequence.current;
    try {
      const value = await api<Definition>("/dictionary/lookup", {
        ...send("POST", {
          text: selected.text,
          context: selected.context.slice(0, 5000),
          contextual: inContext,
        }),
        signal: controller.signal,
      });
      if (token === sequence.current) setResult(value);
    } catch (err) {
      if (token === sequence.current && (err as Error).name !== "AbortError")
        setError((err as Error).message);
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }
  async function copy() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.text);
      setCopied(true);
    } catch {
      setExpanded(true);
      setError("无法访问剪贴板，可以直接复制当前选区。");
    }
  }
  if (!selected) return null;
  const meaning = result?.kind === "unavailable" ? result.local : result;
  return createPortal(
    <div
      ref={element}
      data-selection-dictionary
      className={
        "selection-dictionary " + (expanded ? "dictionary-expanded" : "")
      }
      style={position}
      role={expanded ? "dialog" : "menu"}
      aria-label={expanded ? "英汉词典" : "划词菜单"}
      onMouseDown={(e) => {
        if ((e.target as Element).closest("button")) e.preventDefault();
      }}
    >
      {!expanded ? (
        <div className="selection-actions">
          <button role="menuitem" onClick={() => void lookup()}>
            <Languages size={16} />
            查词 / 翻译
          </button>
          <IconButton
            label="朗读所选文字"
            onClick={() =>
              speech.speak(selected.text, "dictionary-selection", true)
            }
          >
            <Volume2 size={16} />
          </IconButton>
          <IconButton
            label={copied ? "已复制选中文字" : "复制选中文字"}
            onClick={() => void copy()}
          >
            {copied ? <Check size={16} /> : <Copy size={15} />}
          </IconButton>
          <IconButton label="关闭划词菜单" onClick={dismiss}>
            <X size={15} />
          </IconButton>
        </div>
      ) : (
        <>
          <header className="dictionary-header">
            <span>
              <BookOpen size={15} />
              英汉词典
            </span>
            <IconButton label="关闭词典" onClick={dismiss}>
              <X size={17} />
            </IconButton>
          </header>
          <div className="dictionary-body" aria-live="polite">
            <div className="dictionary-term">
              <h3>{selected.text}</h3>
              <IconButton
                label="朗读所选文字"
                onClick={() =>
                  speech.speak(selected.text, "dictionary-selection", true)
                }
              >
                <Volume2 size={17} />
              </IconButton>
            </div>
            {loading && (
              <div className="dictionary-loading">
                <LoaderCircle className="spin" size={17} />
                正在查询
              </div>
            )}
            {error && (
              <div className="dictionary-error">
                <p>{error}</p>
                <button
                  className="text-link"
                  onClick={() => void lookup(contextual.current)}
                >
                  <RotateCcw size={14} />
                  重试
                </button>
              </div>
            )}
            {meaning && (
              <>
                {meaning.phonetic && (
                  <p className="dictionary-phonetic">/{meaning.phonetic}/</p>
                )}
                {meaning.lemma && meaning.lemma !== meaning.headword && (
                  <p className="dictionary-lemma">原形：{meaning.lemma}</p>
                )}
                <p className="dictionary-translation">{meaning.translation}</p>
                {meaning.lemma_translation && (
                  <p className="dictionary-translation lemma-definition">
                    {meaning.lemma}：{meaning.lemma_translation}
                  </p>
                )}
                {meaning.usage && (
                  <p className="dictionary-usage">{meaning.usage}</p>
                )}
                {meaning.examples?.map((example, i) => (
                  <div className="dictionary-example" key={i}>
                    <p>{example.en}</p>
                    <p>{example.zh}</p>
                  </div>
                ))}
                {meaning.definition && (
                  <details>
                    <summary>英文释义</summary>
                    <p className="dictionary-english">{meaning.definition}</p>
                  </details>
                )}
              </>
            )}
            {result?.kind === "unavailable" && (
              <div className="dictionary-unavailable">
                <p>
                  {!meaning && "离线词典未收录这个完整表达。"}
                  {result.message}
                </p>
                <button
                  className="button secondary"
                  onClick={() => {
                    dismiss();
                    openSettings();
                  }}
                >
                  <Settings2 size={14} />
                  配置 DeepSeek
                </button>
              </div>
            )}
          </div>
          {result && (
            <footer className="dictionary-footer">
              <span>
                {meaning?.source || "离线词典"}
                {result.cached ? " · 已缓存" : ""}
              </span>
              {result.kind === "local" && (
                <button className="text-link" onClick={() => void lookup(true)}>
                  <Languages size={13} />
                  语境释义
                </button>
              )}
            </footer>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
