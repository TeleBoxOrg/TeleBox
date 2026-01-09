// src/utils/telegramFormatter.ts
/** Telegram消息格式化器 */
export class TelegramFormatter {
  /** 将Markdown转换为HTML */
  static markdownToHtml(md: string, options?: { collapseSafe?: boolean }): string {
    const collapseSafe = options?.collapseSafe === true;
    const src = (md || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = src.split("\n");
    const blocks: string[] = [];
    let i = 0;

    const isBlank = (l: string) => l.trim() === "";
    const isHr = (l: string) => /^(\s*)(---|\*\*\*)\s*$/.test(l);

    const flushParagraph = (buf: string[]) => {
      if (buf.length === 0) return;
      const text = buf.join("\n").trimEnd();
      if (!text.trim()) return;
      blocks.push(this.parseInline(text));
      buf.length = 0;
    };

    let paraBuf: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      if (isBlank(line)) {
        flushParagraph(paraBuf);
        i++;
        continue;
      }

      if (isHr(line)) {
        flushParagraph(paraBuf);
        blocks.push("────────────────");
        i++;
        continue;
      }

      if (line.startsWith("```")) {
        flushParagraph(paraBuf);
        i++;
        const codeBuf: string[] = [];
        while (i < lines.length && !lines[i].startsWith("```")) {
          codeBuf.push(lines[i]);
          i++;
        }
        if (i < lines.length && lines[i].startsWith("```")) i++;
        const codeText = codeBuf.join("\n");
        blocks.push(`<pre><code>${this.escapeHtml(codeText)}</code></pre>`);
        continue;
      }

      if (line.trimStart().startsWith(">")) {
        flushParagraph(paraBuf);
        const qBuf: string[] = [];
        while (i < lines.length && lines[i].trimStart().startsWith(">")) {
          qBuf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        const quoteRaw = qBuf.join("\n").trimEnd();
        if (collapseSafe) {
          blocks.push(this.renderQuoteAsPlainText(quoteRaw));
        } else {
          blocks.push(`<blockquote>${this.parseInline(quoteRaw)}</blockquote>`);
        }
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flushParagraph(paraBuf);
        const title = h[2].trim();
        blocks.push(`<b>${this.parseInline(title)}</b>`);
        i++;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph(paraBuf);
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i++;
        }
        blocks.push(items.map((it) => `• ${this.parseInline(it.trim())}`).join("\n"));
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushParagraph(paraBuf);
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
          i++;
        }
        blocks.push(
          items.map((it, idx) => `${idx + 1}. ${this.parseInline(it.trim())}`).join("\n")
        );
        continue;
      }

      paraBuf.push(line);
      i++;
    }

    flushParagraph(paraBuf);
    return blocks.join("\n\n");
  }

  private static renderQuoteAsPlainText(quoteRaw: string): string {
    const lines = quoteRaw.split("\n").map((l) => l.trimEnd());
    const htmlLines = lines.map((l) => {
      const rendered = this.parseInline(l);
      return `┃ ${rendered}`;
    });
    return htmlLines.join("\n");
  }

  private static parseInline(raw: string): string {
    const withIndentToken = this.applyIndentTokenPerLine(raw);
    let text = this.escapeHtml(withIndentToken);
    text = this.expandIndentTokensToNbsp(text);

    const codeSpans: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      const idx = codeSpans.push(`<code>${code}</code>`) - 1;
      return `\u0000IC${idx}\u0000`;
    });

    text = text.replace(
      /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      (_m, label, url) => {
        const safe = this.safeUrl(url);
        if (!safe) return label;
        const labelHtml = this.parseInlineFromEscaped(label);
        return `<a href="${safe}">${labelHtml}</a>`;
      }
    );

    text = text.replace(
      /(^|[\s(])((https?:\/\/)[^\s<>()]+)(?=$|[\s).,!?])/g,
      (_m, p1, url) => {
        const safe = this.safeUrl(url);
        if (!safe) return `${p1}${url}`;
        return `${p1}<a href="${safe}">${url}</a>`;
      }
    );

    text = text.replace(/\|\|([^\n]+?)\|\|/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<span class="tg-spoiler">${innerHtml}</span>`;
    });

    text = text.replace(/~~([^\n]+?)~~/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<s>${innerHtml}</s>`;
    });

    text = text.replace(/__([^\n]+?)__/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<u>${innerHtml}</u>`;
    });

    text = text.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<b>${innerHtml}</b>`;
    });

    text = text.replace(/(^|[^*])\*([^\n*]+?)\*(?!\*)/g, (_m, p1, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `${p1}<i>${innerHtml}</i>`;
    });

    text = text.replace(/(^|[^_])_([^\n_]+?)_(?!_)/g, (_m, p1, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `${p1}<i>${innerHtml}</i>`;
    });

    text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");
    text = text.replace(/\n{3,}/g, "\n\n");

    return text;
  }

  private static parseInlineFromEscaped(escaped: string): string {
    let text = escaped;
    const codeSpans: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      const idx = codeSpans.push(`<code>${code}</code>`) - 1;
      return `\u0000IC${idx}\u0000`;
    });
    text = text.replace(
      /\|\|([^\n]+?)\|\|/g,
      (_m, inner) => `<span class="tg-spoiler">${this.parseInlineFromEscaped(inner)}</span>`
    );
    text = text.replace(/~~([^\n]+?)~~/g, (_m, inner) => `<s>${this.parseInlineFromEscaped(inner)}</s>`);
    text = text.replace(/__([^\n]+?)__/g, (_m, inner) => `<u>${this.parseInlineFromEscaped(inner)}</u>`);
    text = text.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => `<b>${this.parseInlineFromEscaped(inner)}</b>`);
    text = text.replace(
      /(^|[^*])\*([^\n*]+?)\*(?!\*)/g,
      (_m, p1, inner) => `${p1}<i>${this.parseInlineFromEscaped(inner)}</i>`
    );
    text = text.replace(
      /(^|[^_])_([^\n_]+?)_(?!_)/g,
      (_m, p1, inner) => `${p1}<i>${this.parseInlineFromEscaped(inner)}</i>`
    );
    text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");
    return text;
  }

  private static applyIndentTokenPerLine(text: string): string {
    const INDENT_TOKEN_PREFIX = "\u0000IND";
    const INDENT_TOKEN_SUFFIX = "\u0000";
    return text
      .split("\n")
      .map((line) => {
        const m = line.match(/^( {2,})(.*)$/);
        if (!m) return line;
        const n = m[1].length;
        return `${INDENT_TOKEN_PREFIX}${n}${INDENT_TOKEN_SUFFIX}${m[2]}`;
      })
      .join("\n");
  }

  private static expandIndentTokensToNbsp(escaped: string): string {
    const INDENT_TOKEN_PREFIX = "\u0000IND";
    const INDENT_TOKEN_SUFFIX = "\u0000";
    return escaped.replace(
      new RegExp(`${INDENT_TOKEN_PREFIX}(\\d+)${INDENT_TOKEN_SUFFIX}`, "g"),
      (_m, nStr) => {
        const n = Math.max(0, Number(nStr) || 0);
        return "&nbsp;".repeat(n);
      }
    );
  }

  private static escapeHtml(s: string): string {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private static safeUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch {}
    return "";
  }
}