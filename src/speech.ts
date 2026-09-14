import { useCallback, useEffect, useRef, useState } from "react";
import { api, send } from "./types";

export interface Voice {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  native?: SpeechSynthesisVoice;
  system?: boolean;
}

export function useSpeech(onError: (message: string) => void) {
  const [browserVoices, setBrowserVoices] = useState<Voice[]>([]);
  const [systemVoices, setSystemVoices] = useState<Voice[]>([]);
  const voices = [...browserVoices, ...systemVoices];
  const [voiceURI, setVoiceURI] = useState(
    () => localStorage.getItem("wordnote.voice") || "",
  );
  const [rate, setRate] = useState(() => {
    const value = Number(localStorage.getItem("wordnote.rate") || "1");
    return Number.isFinite(value) ? Math.min(1.5, Math.max(0.6, value)) : 1;
  });
  const [playing, setPlaying] = useState("");
  const [preparing, setPreparing] = useState(false);
  const current = useRef("");
  const sequence = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef("");
  const pending = useRef<AbortController | null>(null);
  const supported = "speechSynthesis" in window;
  const stop = useCallback(() => {
    sequence.current += 1;
    pending.current?.abort();
    pending.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = null;
    }
    if (audioUrl.current) {
      URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = "";
    }
    if (supported) speechSynthesis.cancel();
    current.current = "";
    setPlaying("");
    setPreparing(false);
  }, [supported]);
  useEffect(() => {
    if (!supported) return;
    const update = () =>
      setBrowserVoices(
        speechSynthesis
          .getVoices()
          .filter((v) => /^en(?:[-_]|$)/i.test(v.lang))
          .map((v) => ({
            name: v.name,
            lang: v.lang,
            voiceURI: v.voiceURI,
            localService: v.localService,
            native: v,
          })),
      );
    update();
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => {
      speechSynthesis.removeEventListener("voiceschanged", update);
      speechSynthesis.cancel();
    };
  }, [supported]);
  useEffect(() => {
    let mounted = true;
    void api<{ name: string; lang: string }[]>("/speech/voices")
      .then((list) => {
        if (mounted)
          setSystemVoices(
            list.map((v) => ({
              ...v,
              voiceURI: "windows:" + v.name,
              localService: true,
              system: true,
            })),
          );
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(
    () => () => {
      pending.current?.abort();
      audio.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    },
    [],
  );
  useEffect(() => {
    localStorage.setItem("wordnote.voice", voiceURI);
  }, [voiceURI]);
  useEffect(() => {
    localStorage.setItem("wordnote.rate", String(rate));
  }, [rate]);
  const selectedVoice =
    voices.find((v) => v.voiceURI === voiceURI) ||
    voices.find((v) => v.lang === "en-US") ||
    voices[0];
  const speak = useCallback(
    (text: string, id: string, allowSelection = false) => {
      if (!allowSelection && window.getSelection()?.toString()) return;
      if (current.current === id) {
        stop();
        return;
      }
      stop();
      if (!selectedVoice) {
        onError("未找到英语音色，请在系统语音设置中安装英语语音后重新打开网页");
        return;
      }
      const token = sequence.current;
      current.current = id;
      setPlaying(id);
      const clear = () => {
        if (token === sequence.current) {
          current.current = "";
          setPlaying("");
          setPreparing(false);
        }
      };
      if (selectedVoice.system) {
        setPreparing(true);
        const controller = new AbortController();
        pending.current = controller;
        void (async () => {
          try {
            const response = await fetch("/api/speech", {
              ...send("POST", { text, voice: selectedVoice.name, rate }),
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
            });
            if (!response.ok) throw new Error("系统语音生成失败");
            const blob = await response.blob();
            if (token !== sequence.current) return;
            const url = URL.createObjectURL(blob);
            audioUrl.current = url;
            const player = new Audio(url);
            audio.current = player;
            player.onended = () => {
              clear();
              URL.revokeObjectURL(url);
            };
            player.onerror = () => {
              clear();
              if (token === sequence.current) onError("音频播放失败，请重试");
            };
            await player.play();
            if (token === sequence.current) setPreparing(false);
          } catch (error) {
            clear();
            if (
              token === sequence.current &&
              (error as Error).name !== "AbortError"
            )
              onError("系统语音播放失败，请重试或更换音色");
          }
        })();
        return;
      }
      if (!supported) {
        clear();
        onError("此浏览器不支持语音朗读，请使用 Edge 或 Chrome");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = selectedVoice.native || null;
      utterance.lang = selectedVoice.lang;
      utterance.rate = rate;
      utterance.onend = clear;
      utterance.onerror = (event) => {
        clear();
        if (
          token === sequence.current &&
          !["canceled", "interrupted"].includes(event.error)
        )
          onError("朗读失败，请更换英语音色或检查系统语音设置");
      };
      speechSynthesis.speak(utterance);
    },
    [onError, rate, selectedVoice, stop, supported],
  );
  return {
    voices,
    voiceURI,
    setVoiceURI,
    selectedVoice,
    rate,
    setRate,
    playing,
    preparing,
    speak,
    stop,
    supported,
  };
}
export type Speech = ReturnType<typeof useSpeech>;
