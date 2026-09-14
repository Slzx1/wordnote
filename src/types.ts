export type Letter = "A" | "B" | "C" | "D";
export const letters: Letter[] = ["A", "B", "C", "D"];
export interface Phrase {
  text: string;
  speak: string;
}
export interface Explanation {
  label: Letter;
  pos: string;
  meaning: string;
  collocations: Phrase[];
  reason: string;
}
export interface Note {
  answer: Letter;
  options: Explanation[];
  uncertainty: string;
}
export interface Question {
  id: string;
  document_id: string;
  ordinal: number;
  number: number;
  page: number;
  sentence: string;
  options: Record<Letter, string>;
  issues: string[];
  original: { sentence: string; options: Record<Letter, string>; raw: string };
  status: string;
  note: Note | null;
  candidate: Note | null;
  source: string;
  manual: number;
  review: number;
  error: string;
  version: number;
  parts: [string, string, string];
  missing_explanations: string[];
}
export interface Job {
  id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  error: string;
  stop: number;
}
export interface DocumentSummary {
  id: string;
  title: string;
  filename: string;
  pages: number;
  warnings: string[];
  bookmark: number;
  total: number;
  completed: number;
  review_count: number;
}
export interface DocumentDetail extends DocumentSummary {
  questions: Question[];
  job: Job | null;
}
export interface Settings {
  configured: boolean;
  model: string;
}
export interface Revision {
  id: number;
  kind: string;
  source: string;
  created_at: string;
  payload: Note | Record<string, unknown>;
  context: { sentence: string; options: Question["options"] } | null;
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) {
    super(
      typeof data.detail === "string"
        ? data.detail
        : "输入内容不符合要求，请检查后重试",
    );
    this.status = status;
    this.data = data;
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api" + path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok)
    throw new ApiError(
      response.status,
      await response.json().catch(() => ({ detail: "服务暂不可用" })),
    );
  return response.json();
}
export const send = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
export const busyQuestion = (q: Question) =>
  ["queued", "generating"].includes(q.status);
export const busyJob = (job?: Job | null) =>
  !!job && ["queued", "running"].includes(job.status);
