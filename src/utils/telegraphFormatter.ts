// src/utils/telegraphFormatter.ts
/** Telegraph节点类型 */
export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

/** Telegraph消息格式化器 */
export class TelegraphFormatter {
  /** 将Markdown转换为Telegraph节点 */
  static toNodes(markdown: string): TelegraphNode[] {
    const src = (markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = src.split("\n");
    const blocks: { type: "code" | "blockquote" | "ul" | "ol" | "p" | "hr"; lines: string[] }[] = [];

    const isBlank = (l: string) => l.trim() === "";
    const isHr = (l: string) => /^(\s*)(---|\*\*\*)\s*$/.test(l);

    let i = 0;

    while (i < lines.length) {
      if (isBlank(lines[i])) {
        i++;
        continue;
      }

      if (isHr(lines[i])) {
        blocks.push({ type: "hr", lines: [] });
        i++;
        continue;
      }

      if (lines[i].startsWith("```")) {
        i++;
        const buf: string[] = [];
        while (i < lines.length && !lines[i].startsWith("```")) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length && lines[i].startsWith("```")) i++;
        blocks.push({ type: "code", lines: buf });
        continue;
      }

      if (lines[i].trimStart().startsWith(">")) {
        const buf: string[] = [];
        while (i < lines.length && lines[i].trimStart().startsWith(">")) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        blocks.push({ type: "blockquote", lines: buf });
        continue;
      }

      if (/^\s*[-*+]\s+/.test(lines[i])) {
        const buf: string[] = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i++;
        }
        blocks.push({ type: "ul", lines: buf });
        continue;
      }

      if (/^\s*\d+\.\s+/.test(lines[i])) {
        const buf: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i++;
        }
        blocks.push({ type: "ol", lines: buf });
        continue;
      }

      const buf: string[] = [];
      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        !isHr(lines[i]) &&
        !lines[i].startsWith("```") &&
        !lines[i].trimStart().startsWith(">") &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ type: "p", lines: buf });
    }

    const out: TelegraphNode[] = [];
    for (const b of blocks) {
      if (b.type === "hr") {
        out.push({ tag: "p", children: ["────────────────"] });
        continue;
      }

      if (b.type === "code") {
        const codeText = b.lines.join("\n");
        out.push({ tag: "pre", children: [{ tag: "code", children: [codeText] }] });
        continue;
      }

      if (b.type === "blockquote") {
        const inner = this.paragraphize(b.lines.join("\n"));
        out.push({ tag: "blockquote", children: inner });
        continue;
      }

      if (b.type === "ul" || b.type === "ol") {
        out.push({
          tag: b.type,
          children: b.lines
            .map((li) => li.trim())
            .filter(Boolean)
            .map((li) => ({ tag: "li", children: this.parseInline(li) })),
        });
        continue;
      }

      const text = b.lines.join("\n").trim();
      if (!text) continue;

      const headingMatch = text.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        out.push({
          tag: "p",
          children: [{ tag: "b", children: this.parseInline(headingMatch[1].trim()) }],
        });
        continue;
      }

      out.push({ tag: "p", children: this.parseInlineWithLineBreaks(text) });
    }

    return out;
  }

  private static paragraphize(text: string): TelegraphNode[] {
    const parts = text
      .split(/\n{2,}/g)
      .map((p) => p.trim())
      .filter(Boolean);

    return parts.map((p) => ({ tag: "p", children: this.parseInlineWithLineBreaks(p) }));
  }

  private static parseInlineWithLineBreaks(text: string): TelegraphNode[] {
    const lines = text.split("\n");
    const nodes: TelegraphNode[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = this.preserveIndentTelegraphLine(lines[i]);
      nodes.push(...this.parseInline(line));
      if (i !== lines.length - 1) nodes.push("\n");
    }

    return this.compactText(nodes);
  }

  private static parseInline(text: string): TelegraphNode[] {
    if (!text) return [];

    const link = this.findFirstLink(text);
    if (link) {
      const before = text.slice(0, link.start);
      const after = text.slice(link.end);

      const out: TelegraphNode[] = [];
      out.push(...this.parseInline(before));

      const safe = this.sanitizeUrl(link.url);
      if (safe) out.push({ tag: "a", attrs: { href: safe }, children: this.parseInline(link.label) });
      else out.push(...this.parseInline(link.label));

      out.push(...this.parseInline(after));
      return this.compactText(out);
    }

    const code = this.findFirstEnclosed(text, "`", "`");
    if (code) {
      const before = text.slice(0, code.start);
      const after = text.slice(code.end);

      const out: TelegraphNode[] = [];
      out.push(...this.parseInline(before));
      out.push({ tag: "code", children: [code.inner] });
      out.push(...this.parseInline(after));
      return this.compactText(out);
    }

    const bold = this.findFirstEnclosed(text, "**", "**");
    if (bold) {
      const before = text.slice(0, bold.start);
      const after = text.slice(bold.end);

      const out: TelegraphNode[] = [];
      out.push(...this.parseInline(before));
      out.push({ tag: "b", children: this.parseInline(bold.inner) });
      out.push(...this.parseInline(after));
      return this.compactText(out);
    }

    const italic = this.findFirstItalic(text);
    if (italic) {
      const before = text.slice(0, italic.start);
      const after = text.slice(italic.end);

      const out: TelegraphNode[] = [];
      out.push(...this.parseInline(before));
      out.push({ tag: "i", children: this.parseInline(italic.inner) });
      out.push(...this.parseInline(after));
      return this.compactText(out);
    }

    return [text];
  }

  private static compactText(nodes: TelegraphNode[]): TelegraphNode[] {
    const out: TelegraphNode[] = [];
    for (const n of nodes) {
      if (typeof n === "string") {
        if (!n) continue;
        const last = out[out.length - 1];
        if (typeof last === "string") out[out.length - 1] = last + n;
        else out.push(n);
      } else {
        out.push(n);
      }
    }
    return out;
  }

  private static findFirstLink(text: string): { start: number; end: number; label: string; url: string } | null {
    const re = /\[([^\]]+)\]\(([^)]+)\)/g;
    const m = re.exec(text);
    if (!m || m.index == null) return null;
    return { start: m.index, end: m.index + m[0].length, label: m[1], url: m[2] };
  }

  private static findFirstEnclosed(
    text: string,
    open: string,
    close: string
  ): { start: number; end: number; inner: string } | null {
    const start = text.indexOf(open);
    if (start < 0) return null;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return null;
    return { start, end: end + close.length, inner: text.slice(start + open.length, end) };
  }

  private static findFirstItalic(text: string): { start: number; end: number; inner: string } | null {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "*") continue;
      if (text[i + 1] === "*") continue;
      const start = i;

      for (let j = start + 1; j < text.length; j++) {
        if (text[j] !== "*") continue;
        if (text[j - 1] === "*") continue;
        if (text[j + 1] === "*") continue;

        const inner = text.slice(start + 1, j);
        if (!inner.trim()) break;
        return { start, end: j + 1, inner };
      }
    }
    return null;
  }

  private static preserveIndentTelegraphLine = (line: string): string => {
    const m = line.match(/^( {2,})(.*)$/);
    if (!m) return line;
    const leading = m[1].length;
    return "\u00A0".repeat(leading) + m[2];
  };

  private static sanitizeUrl = (url: string): string => {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch {}
    return "";
  };
}