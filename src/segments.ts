// Pieces of the session worth copying, found in code: whole messages, fenced code blocks, shell
// commands (from shell code blocks and bash tool calls), file paths, URLs, Markdown tables and
// lists, commit messages, and assistant paragraphs.

export type Kind = "user" | "assistant" | "code" | "command" | "path" | "url" | "table" | "list" | "commit" | "paragraph";

export interface Segment {
  id: string;
  kind: Kind;
  /** What gets copied. */
  text: string;
  /** Code block language, when known. */
  lang?: string;
  /** Index of the user turn the piece belongs to (0 = oldest included). */
  turn: number;
  /** Order within the session, oldest first. */
  order: number;
}

/** Kinds whose copy-worthiness Jev judges (structured kinds are copyable by construction). */
export const PROSE_KINDS = new Set<Kind>(["paragraph", "list", "assistant"]);

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "fish", "powershell", "ps1", "cmd"]);
const COMMIT = /^(feat|fix|docs|style|refactor|perf|test|tests|build|ci|chore|revert)(\([^)]+\))?!?: \S/u;
const URL = /\bhttps?:\/\/[^\s<>()`"']+[^\s<>()`"'.,;:!?]/gu;
const PATH = /(?:^|[\s`'"(])((?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}|~\/[\w./@-]+)(?=$|[\s`'"),:;])/gu;

interface Entry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
}

/** Split Markdown into fenced code blocks and the prose between them. */
export function splitFences(markdown: string): Array<{ code: false; text: string } | { code: true; lang: string; text: string }> {
  const parts: Array<{ code: false; text: string } | { code: true; lang: string; text: string }> = [];
  const re = /^(```|~~~)([^\n`]*)\n([\s\S]*?)^\1[ \t]*$/gmu;
  let last = 0;
  for (const match of markdown.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ code: false, text: markdown.slice(last, index) });
    parts.push({ code: true, lang: (match[2] ?? "").trim().split(/\s+/u)[0] ?? "", text: (match[3] ?? "").replace(/\n$/u, "") });
    last = index + match[0].length;
  }
  if (last < markdown.length) parts.push({ code: false, text: markdown.slice(last) });
  return parts;
}

/** Commands in a shell code block: one per line, without prompts, joining `\` continuations. */
export function shellCommands(code: string): string[] {
  const commands: string[] = [];
  let current = "";
  for (const raw of code.split("\n")) {
    const line = raw.replace(/^\s*(?:\$|%|>|PS>)\s+/u, "");
    if (!current && (!line.trim() || line.trim().startsWith("#"))) continue;
    current = current ? `${current}\n${line}` : line;
    if (!/\\\s*$/u.test(line)) {
      commands.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) commands.push(current.trim());
  return commands;
}

function proseSegments(text: string): Array<{ kind: Kind; text: string }> {
  const out: Array<{ kind: Kind; text: string }> = [];
  for (const chunk of text.split(/\n\s*\n/u)) {
    const lines = chunk.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const body = lines.join("\n").trim();
    if (lines.length >= 2 && lines.every((l) => l.trim().startsWith("|"))) out.push({ kind: "table", text: body });
    else if (lines.length >= 2 && lines.every((l) => /^\s*(?:[-*+]|\d+[.)])\s+|^\s{2,}\S/u.test(l))) out.push({ kind: "list", text: body });
    else if (COMMIT.test(lines[0] as string)) out.push({ kind: "commit", text: body });
    else if (!/^#{1,6}\s/u.test(body) && body.length >= 40) out.push({ kind: "paragraph", text: body });
  }
  return out;
}

function inline(text: string): Array<{ kind: Kind; text: string }> {
  const out: Array<{ kind: Kind; text: string }> = [];
  for (const match of text.matchAll(URL)) out.push({ kind: "url", text: match[0] });
  for (const match of text.matchAll(PATH)) {
    const path = match[1] as string;
    if (!/^https?:/u.test(path) && !out.some((o) => o.text.includes(path))) out.push({ kind: "path", text: path });
  }
  return out;
}

/** Every copyable piece of the last `maxTurns` user turns on the branch, oldest first. */
export function extractSegments(entries: readonly unknown[], maxTurns = 30): Segment[] {
  const messages = (entries as Entry[]).filter((e) => e?.type === "message" && e.message);
  const userIndices = messages.flatMap((e, i) => (e.message?.role === "user" ? [i] : []));
  const start = userIndices.length > maxTurns ? (userIndices[userIndices.length - maxTurns] as number) : 0;
  const segments: Segment[] = [];
  const seen = new Set<string>();
  let turn = -1;
  const add = (kind: Kind, text: string, lang?: string) => {
    const trimmed = text.replace(/\s+$/u, "");
    if (!trimmed.trim()) return;
    const key = `${kind === "user" || kind === "assistant" ? kind : "piece"}:${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push({ id: `S${String(segments.length + 1).padStart(3, "0")}`, kind, text: trimmed, ...(lang ? { lang } : {}), turn: Math.max(0, turn), order: segments.length });
  };
  for (const entry of messages.slice(start)) {
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role === "user") {
      turn++;
      add("user", textOf(message.content).trim());
    } else if (message.role === "assistant") {
      const text = textOf(message.content).trim();
      if (text) {
        add("assistant", text);
        for (const part of splitFences(text)) {
          if (part.code) {
            if (SHELL_LANGS.has(part.lang.toLowerCase())) for (const command of shellCommands(part.text)) add("command", command);
            add(COMMIT.test(part.text.split("\n")[0] ?? "") ? "commit" : "code", part.text, part.lang || undefined);
          } else {
            for (const piece of proseSegments(part.text)) add(piece.kind, piece.text);
            for (const piece of inline(part.text)) add(piece.kind, piece.text);
          }
        }
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content as Block[]) {
          if (block?.type !== "toolCall" || block.name !== "bash") continue;
          const command = (block.arguments as { command?: unknown } | undefined)?.command;
          if (typeof command === "string") add("command", command.trim());
        }
      }
    }
  }
  return segments;
}

/** One line for the list. */
export function preview(segment: Segment): string {
  const flat = segment.text.replace(/\s+/gu, " ").trim();
  return segment.kind === "code" && segment.lang ? `${segment.lang}: ${flat}` : flat;
}

/** A stable hash of a segment's content, for caching Jev's judgments within the session. */
export function segmentKey(segment: Segment): string {
  let h = 2166136261;
  const s = `${segment.kind}\u0000${segment.text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
