// src/utils/telegramFormatter.ts

/** Telegram消息格式化器 */
export class TelegramFormatter {
  /** 将Markdown转换为HTML */
  static markdownToHtml(md: string, options?: { collapseSafe?: boolean }): string {
    const collapseSafe = options?.collapseSafe === true;
    const src = (md || "")
      .replace(/<\s*\/?\s*cite\s*>|<\s*cite\s*\/\s*>/gi, "")
      .replace(/&lt;\s*\/?\s*cite\s*&gt;|&lt;\s*cite\s*\/\s*&gt;/gi, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    const lines = src.split("\n");
    const blocks: string[] = [];
    let i = 0;

    const isBlank = (l: string) => l.trim() === "";
    const isHr = (l: string) => /^(\s*)(---|\*\*\*)\s*$/.test(l);
    const isListLine = (l: string) =>
      /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);

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

      // 空行 -> 结束当前段落
      if (isBlank(line)) {
        flushParagraph(paraBuf);
        i++;
        continue;
      }

      // 水平线
      if (isHr(line)) {
        flushParagraph(paraBuf);
        blocks.push("────────────────");
        i++;
        continue;
      }

      // 代码块 ```...```
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

      // 引用块（包括多层 >）
      if (line.trimStart().startsWith(">")) {
        flushParagraph(paraBuf);
        const qBuf: string[] = [];
        while (i < lines.length && lines[i].trimStart().startsWith(">")) {
          // 去掉最外层的一个 ">"，保留内部 ">" 用于多层引用
          qBuf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        let quoteRaw = qBuf.join("\n").trimEnd();
        // 规范化引用内部的列表标记（> * / >> * 等）
        quoteRaw = this.normalizeQuoteListMarkers(quoteRaw);

        if (collapseSafe) {
          blocks.push(this.renderQuoteAsPlainText(quoteRaw));
        } else {
          blocks.push(this.renderQuoteAsHtml(quoteRaw));
        }
        continue;
      }

      // 顶层标题
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flushParagraph(paraBuf);
        const title = h[2].trim();
        blocks.push(`<b>${this.parseInline(title)}</b>`);
        i++;
        continue;
      }

      // 列表（统一处理有序 + 无序，并保留缩进用于嵌套）
      if (isListLine(line)) {
        flushParagraph(paraBuf);

        const listLines: string[] = [];

        while (i < lines.length && isListLine(lines[i])) {
          const cur = lines[i];

          // 无序项: 缩进 + "• " + 内容
          const mBullet = cur.match(/^(\s*)[-*+]\s+(.+)$/);
          if (mBullet) {
            const indent = mBullet[1] ?? "";
            const content = mBullet[2] ?? "";
            listLines.push(`${indent}• ${content}`);
            i++;
            continue;
          }

          // 有序项: 保留原来的数字（不重排），缩进也保留
          const mOrdered = cur.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
          if (mOrdered) {
            const indent = mOrdered[1] ?? "";
            const num = mOrdered[2] ?? "";
            const content = mOrdered[3] ?? "";
            listLines.push(`${indent}${num}. ${content}`);
            i++;
            continue;
          }

          // 理论上不会进来，兜底
          listLines.push(cur);
          i++;
        }

        // 整个列表块交给 parseInline，让缩进和行内格式统一处理
        blocks.push(this.parseInline(listLines.join("\n")));
        continue;
      }

      // 普通段落
      paraBuf.push(line);
      i++;
    }

    flushParagraph(paraBuf);
    return blocks.join("\n\n");
  }

  /**
   * 引用折叠模式下的纯文本渲染：
   * - 前缀「┃ 」重复表示引用深度
   * - 支持多层 ">"（>> / >>>）
   * - 支持引用内部的标题语法（# / ## / ### 等）
   */
  private static renderQuoteAsPlainText(quoteRaw: string): string {
    const lines = quoteRaw.split("\n").map((l) => l.trimEnd());
    const htmlLines = lines.map((originalLine) => {
      let line = originalLine;
      let depth = 1; // 外层引用至少 1 层

      // 计算多层 ">" 深度，同时去掉所有前导空格 + ">" + 一个可选空格
      let i = 0;
      let extraDepth = 0;
      while (i < line.length) {
        const ch = line[i];
        if (ch === " ") {
          i++;
          continue;
        }
        if (ch === ">") {
          extraDepth++;
          i++;
          if (line[i] === " ") i++; // 吃掉一个空格
          continue;
        }
        break;
      }
      depth += extraDepth;
      line = line.slice(i);

      // 去掉可能残留的前导空格，方便匹配 "#"
      line = line.replace(/^\s+/, "");

      // 支持引用内部的标题：# / ## / ### ...
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      let rendered: string;
      if (h) {
        const title = h[2].trim();
        rendered = `<b>${this.parseInline(title)}</b>`;
      } else {
        rendered = this.parseInline(line);
      }

      return `${"┃ ".repeat(depth)}${rendered}`;
    });
    return htmlLines.join("\n");
  }

  /**
   * 普通 HTML 引用渲染：
   * - 最外层用 <blockquote>
   * - 内部每一行用 <br> 分隔
   * - 多层 ">" 用「┃ 」前缀模拟（从第二层开始）
   * - 支持引用内部标题语法（# / ## / ### 等）
   */
  private static renderQuoteAsHtml(quoteRaw: string): string {
    const lines = quoteRaw.split("\n").map((l) => l.trimEnd());
    const htmlLines = lines.map((originalLine) => {
      let line = originalLine;
      let depth = 1;

      // 同样先解析多层 ">"
      let i = 0;
      let extraDepth = 0;
      while (i < line.length) {
        const ch = line[i];
        if (ch === " ") {
          i++;
          continue;
        }
        if (ch === ">") {
          extraDepth++;
          i++;
          if (line[i] === " ") i++;
          continue;
        }
        break;
      }
      depth += extraDepth;
      line = line.slice(i);
      line = line.replace(/^\s+/, "");

      const h = line.match(/^(#{1,6})\s+(.+)$/);
      let rendered: string;
      if (h) {
        const title = h[2].trim();
        rendered = `<b>${this.parseInline(title)}</b>`;
      } else {
        rendered = this.parseInline(line);
      }

      // 第一层引用不加「┃」，第二层及以上用「┃ 」模拟嵌套
      const prefix = depth > 1 ? "┃ ".repeat(depth - 1) : "";
      return `${prefix}${rendered}`;
    });

    return `<blockquote>${htmlLines.join("\n")}</blockquote>`;
  }

  /** 规范化引用内部的列表标记（把 - / * / + 转成 •，支持 > * / >> * 等） */
  private static normalizeQuoteListMarkers(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        // 匹配：可选空格 + 若干 ">" + 可选空格 + 列表标记 [-*+] + 空格 + 内容
        const m = line.match(/^(\s*>*)(\s*)[-*+]\s+(.+)$/);
        if (!m) return line;
        const arrows = m[1] ?? "";
        const spacesAfterArrows = m[2] ?? "";
        const body = m[3] ?? "";
        // 保留 ">" 和其后的空格，只把列表标记统一成 "•"
        return `${arrows}${spacesAfterArrows}• ${body}`;
      })
      .join("\n");
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

    // [label](url)
    text = text.replace(
      /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      (_m, label, url) => {
        const safe = this.safeUrl(url);
        if (!safe) return label;
        const labelHtml = this.parseInlineFromEscaped(label);
        return `<a href="${safe}">${labelHtml}</a>`;
      }
    );

    // 裸链接
    text = text.replace(
      /(^|[\s(])((https?:\/\/)[^\s<>()]+)(?=$|[\s).,!?])/g,
      (_m, p1, url) => {
        const safe = this.safeUrl(url);
        if (!safe) return `${p1}${url}`;
        return `${p1}<a href="${safe}">${url}</a>`;
      }
    );

    // ||spoiler||
    text = text.replace(/\|\|([^\n]+?)\|\|/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<span class="tg-spoiler">${innerHtml}</span>`;
    });

    // ~~strike~~
    text = text.replace(/~~([^\n]+?)~~/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<s>${innerHtml}</s>`;
    });

    // __underline__
    text = text.replace(/__([^\n]+?)__/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<u>${innerHtml}</u>`;
    });

    // **bold**
    text = text.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `<b>${innerHtml}</b>`;
    });

    // *italic*（避免匹配 **）
    text = text.replace(/(^|[^*])\*([^\n*]+?)\*(?!\*)/g, (_m, p1, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `${p1}<i>${innerHtml}</i>`;
    });

    // _italic_（避免匹配 __）
    text = text.replace(/(^|[^_])_([^\n_]+?)_(?!_)/g, (_m, p1, inner) => {
      const innerHtml = this.parseInlineFromEscaped(inner);
      return `${p1}<i>${innerHtml}</i>`;
    });

    // 还原行内 code 占位符
    text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");

    // 最多允许两个连续换行
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

    text = text.replace(
      /~~([^\n]+?)~~/g,
      (_m, inner) => `<s>${this.parseInlineFromEscaped(inner)}</s>`
    );

    text = text.replace(
      /__([^\n]+?)__/g,
      (_m, inner) => `<u>${this.parseInlineFromEscaped(inner)}</u>`
    );

    text = text.replace(
      /\*\*([^\n]+?)\*\*/g,
      (_m, inner) => `<b>${this.parseInlineFromEscaped(inner)}</b>`
    );

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