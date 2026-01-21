// src/utils/telegramFormatter.ts

/** Telegram消息格式化器（面向 Bot API parse_mode=HTML） */
export class TelegramFormatter {
  /**
   * 将 Markdown 转换为 Telegram 支持的 HTML（尽量接近 CommonMark，块级语义支持到 3 级）
   * 约束：Telegram HTML 不支持 <br> / <p> / <ul> / <li> 等标签，只能用 \n 换行。
   */
  static markdownToHtml(md: string, options?: { collapseSafe?: boolean }): string {
    const collapseSafe = options?.collapseSafe === true;

    const src = (md || "")
      // 移除可能干扰 Telegram HTML 解析的 cite 标签（你上游已有类似逻辑）
      .replace(/<\s*\/?\s*cite\s*>|<\s*cite\s*\/\s*>/gi, "")
      .replace(/&lt;\s*\/?\s*cite\s*&gt;|&lt;\s*cite\s*\/\s*&gt;/gi, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    const lines = src.split("\n");
    const blocks: string[] = [];
    let i = 0;

    const isBlank = (l: string) => l.trim() === "";
    const isHr = (l: string) => /^(\s*)(---|\*\*\*)\s*$/.test(l);

    const fenceStart = (l: string) => l.trimStart().startsWith("```");
    const fenceInfo = (l: string): string => {
      const t = l.trimStart();
      const info = t.slice(3).trim();
      // CommonMark: ```lang 只取首个 token
      const token = (info.split(/\s+/)[0] || "").trim();
      return token;
    };

    const isAtxHeading = (l: string) => /^\s{0,3}#{1,6}\s+/.test(l);

    const listMarker = (l: string): { kind: "ul" | "ol"; indent: number; num?: number; text: string } | null => {
      // 最多允许 3 空格缩进开始（CommonMark 规则里更复杂，这里做“够用且稳定”的实现）
      // ul: -, +, *
      // ol: 1. / 1)
      const mUl = l.match(/^(\s{0,12})([-*+])\s+(.+)$/);
      if (mUl) {
        return { kind: "ul", indent: mUl[1].length, text: mUl[3] };
      }
      const mOl = l.match(/^(\s{0,12})(\d+)([.)])\s+(.+)$/);
      if (mOl) {
        return { kind: "ol", indent: mOl[1].length, num: Number(mOl[2]), text: mOl[4] };
      }
      return null;
    };

    const isIndentedCode = (l: string) => /^ {4,}\S/.test(l);

    const flushParagraph = (buf: string[]) => {
      if (!buf.length) return;
      const text = buf.join("\n").trimEnd();
      if (!text.trim()) {
        buf.length = 0;
        return;
      }
      // 段落内部允许换行（Telegram 用 \n 即可），行内语义由 parseInlineWithLineBreaks 处理
      blocks.push(this.parseInlineWithLineBreaks(text));
      buf.length = 0;
    };

    let paraBuf: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      // 空行：结束段落
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

      // 围栏代码块 ```lang ... ```
      if (fenceStart(line)) {
        flushParagraph(paraBuf);
        const lang = fenceInfo(line);
        i++;
        const codeBuf: string[] = [];
        while (i < lines.length && !fenceStart(lines[i])) {
          codeBuf.push(lines[i]);
          i++;
        }
        if (i < lines.length && fenceStart(lines[i])) i++; // consume closing ```
        blocks.push(this.renderCodeBlock(codeBuf.join("\n"), lang));
        continue;
      }

      // 缩进代码块（CommonMark: 4 spaces）
      if (isIndentedCode(line)) {
        flushParagraph(paraBuf);
        const codeBuf: string[] = [];
        while (i < lines.length && (isIndentedCode(lines[i]) || isBlank(lines[i]))) {
          // 空行在缩进代码块里允许存在
          const cur = lines[i];
          if (isBlank(cur)) {
            codeBuf.push("");
            i++;
            continue;
          }
          codeBuf.push(cur.replace(/^ {4}/, ""));
          i++;
        }
        blocks.push(this.renderCodeBlock(codeBuf.join("\n"), ""));
        continue;
      }

      // 引用块：连续 > 行（支持多级 >，但 Telegram blockquote 不可嵌套，深度用“┃ ”模拟）
      if (line.trimStart().startsWith(">")) {
        flushParagraph(paraBuf);
        const qBuf: string[] = [];
        while (i < lines.length && lines[i].trimStart().startsWith(">")) {
          qBuf.push(lines[i]);
          i++;
        }
        blocks.push(this.renderBlockquote(qBuf.join("\n"), collapseSafe));
        continue;
      }

      // 标题：支持到 ### 作为“3级语义”的重点（更高的也会降级处理为加粗段）
      if (isAtxHeading(line)) {
        flushParagraph(paraBuf);
        const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        const level = Math.min(6, (m?.[1]?.length ?? 1));
        const title = (m?.[2] ?? line).trim();
        blocks.push(this.renderHeading(title, level));
        i++;
        continue;
      }

      // 列表：支持最多 3 级嵌套 + 列表项续行
      const lm = listMarker(line);
      if (lm) {
        flushParagraph(paraBuf);
        const { blockHtml, nextIndex } = this.parseListBlock(lines, i);
        blocks.push(blockHtml);
        i = nextIndex;
        continue;
      }

      // 普通段落
      paraBuf.push(line);
      i++;
    }

    flushParagraph(paraBuf);

    // Telegram 不支持 <br>，这里用双换行分隔块；块内部保留 \n
    return blocks.join("\n\n");
  }

  // ---------------------------
  // Block renderers
  // ---------------------------

  private static renderHeading(text: string, level: number): string {
    // Telegram 没有 h1/h2/h3，使用 <b> 并通过前缀区分层级（可选）
    // 你要求 3 级语义完整：这里把 1~3 做明显区分，>3 降级为同样样式
    const clean = text.trim();
    const body = this.parseInline(clean);
    if (level === 1) return `<b>${body}</b>`;
    if (level === 2) return `<b>▌${body}</b>`;
    if (level === 3) return `<b>• ${body}</b>`;
    return `<b>${body}</b>`;
  }

  private static renderCodeBlock(code: string, lang: string): string {
    const escaped = this.escapeHtml(code || "");
    const safeLang = (lang || "").trim().toLowerCase();
    // Bot API 支持：<pre>...</pre> 或 <pre><code class="language-xxx">...</code></pre> :contentReference[oaicite:3]{index=3}
    if (safeLang && /^[a-z0-9_+-]+$/i.test(safeLang)) {
      return `<pre><code class="language-${safeLang}">${escaped}</code></pre>`;
    }
    // 用 <pre><code> 统一输出，减少差异
    return `<pre><code>${escaped}</code></pre>`;
  }

  private static renderBlockquote(raw: string, collapseSafe: boolean): string {
    // raw: 多行，每行以一个或多个 > 开头（可能夹杂空格）
    // Telegram：blockquote 不能嵌套 :contentReference[oaicite:4]{index=4}
    // 所以：整体用一个 <blockquote> 包起来；多层 > 用前缀“┃ ”模拟
    const outLines: string[] = [];
    const lines = raw.split("\n");

    for (const originalLine of lines) {
      // 计算深度：允许形如 "  >> >  text"
      let s = originalLine;
      let depth = 0;

      // 去掉起始空格后连续的 >（每个 > 计入一层）
      let j = 0;
      while (j < s.length) {
        const ch = s[j];
        if (ch === " ") {
          j++;
          continue;
        }
        if (ch === ">") {
          depth++;
          j++;
          // CommonMark: > 后可有一个空格
          if (s[j] === " ") j++;
          continue;
        }
        break;
      }
      s = s.slice(j);

      // 引用内部也允许标题语法（#），我们在一行内识别
      const trimmed = s.replace(/\s+$/, "");
      const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      let rendered = "";
      if (heading) {
        const level = Math.min(6, heading[1].length);
        rendered = this.renderHeading(heading[2], level);
      } else {
        rendered = this.parseInline(trimmed);
      }

      const prefix = depth > 1 ? "┃ ".repeat(Math.min(3, depth - 1)) : ""; // 最多模拟 3 级深度
      outLines.push(prefix + rendered);
    }

    const body = outLines.join("\n");

    // collapseSafe: 你上游会把整段包进 <blockquote expandable>，为了安全这里避免再用 blockquote（防止解析/嵌套冲突）
    if (collapseSafe) {
      // 纯文本方案：不输出 <blockquote>，但保留“┃ ”语义
      return body;
    }
    return `<blockquote>${body}</blockquote>`;
  }

  // ---------------------------
  // List parsing (up to 3 levels)
  // ---------------------------

  private static parseListBlock(
    lines: string[],
    startIndex: number
  ): { blockHtml: string; nextIndex: number } {
    type Item = {
      kind: "ul" | "ol";
      indent: number;
      num?: number;
      lines: string[]; // item content lines (may include continuation)
      children: Item[];
    };

    const marker = (l: string) =>
      l.match(/^(\s{0,12})([-*+])\s+(.+)$/) ||
      l.match(/^(\s{0,12})(\d+)([.)])\s+(.+)$/);

    const parseMarker = (l: string): { kind: "ul" | "ol"; indent: number; num?: number; text: string } | null => {
      const mUl = l.match(/^(\s{0,12})([-*+])\s+(.+)$/);
      if (mUl) return { kind: "ul", indent: mUl[1].length, text: mUl[3] };
      const mOl = l.match(/^(\s{0,12})(\d+)([.)])\s+(.+)$/);
      if (mOl) return { kind: "ol", indent: mOl[1].length, num: Number(mOl[2]), text: mOl[4] };
      return null;
    };

    // 读取“连续列表区域”：直到遇到空行或其他块级起始（hr/quote/fence/heading/indented-code）
    const isStop = (idx: number) => {
      const l = lines[idx] ?? "";
      if (l.trim() === "") return true;
      if (/^(\s*)(---|\*\*\*)\s*$/.test(l)) return true;
      if (l.trimStart().startsWith(">")) return true;
      if (l.trimStart().startsWith("```")) return true;
      if (/^\s{0,3}#{1,6}\s+/.test(l)) return true;
      if (/^ {4,}\S/.test(l)) return true;
      return false;
    };

    const region: string[] = [];
    let i = startIndex;
    while (i < lines.length && !isStop(i)) {
      // 允许列表项的续行（缩进）出现，即使该行本身不是 marker，也要带进 region
      region.push(lines[i]);
      i++;
    }

    // 将 region 解析为树（最多 3 级）
    const root: Item = { kind: "ul", indent: -1, lines: [], children: [] };
    const stack: Item[] = [root];

    const pushItem = (it: Item) => {
      // 找到父级：indent 必须更小
      while (stack.length > 1 && stack[stack.length - 1].indent >= it.indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      parent.children.push(it);
      stack.push(it);
    };

    const isContinuation = (line: string, currentIndent: number) => {
      // “列表项续行”：至少比该 item 的 indent 多 2 空格（经验值，足够稳定）
      // 同时不能是新 marker
      if (marker(line)) return false;
      const leading = (line.match(/^(\s*)/)?.[1] ?? "").length;
      return leading >= currentIndent + 2;
    };

    // 顺序扫描 region
    let curItem: Item | null = null;

    for (let r = 0; r < region.length; r++) {
      const l = region[r];
      const m = parseMarker(l);

      if (m) {
        // 新 item
        const it: Item = {
          kind: m.kind,
          indent: m.indent,
          num: m.num,
          lines: [m.text],
          children: [],
        };

        // 仅支持最多 3 级：indent-based depth 粗略控制
        // depth = stack.length-1（root 不算）
        // 如果超过 3，则把它当作上一层的续行（降级）
        const depthIfPushed = stack.length; // push 后的深度 ≈ 当前 stack.length
        if (depthIfPushed > 3) {
          // 降级：当续行拼到当前 item
          if (curItem) curItem.lines.push("  " + m.text);
          else pushItem(it);
        } else {
          pushItem(it);
          curItem = it;
        }
        continue;
      }

      // 非 marker：如果可作为续行，则附加到当前 item
      if (curItem && isContinuation(l, curItem.indent)) {
        curItem.lines.push(l.replace(/^\s+/, "")); // 去掉续行缩进
      } else {
        // 否则作为段落/说明文字并入当前项（CommonMark 也允许较宽松）
        if (curItem) curItem.lines.push(l.trim());
      }
    }

    const renderedLines: string[] = [];
    const render = (items: Item[], depth: number) => {
      for (const it of items) {
        // depth: 1..3
        const d = Math.min(3, Math.max(1, depth));
        const indentNbsp = "&nbsp;".repeat((d - 1) * 2);

        // 主行：把 item 的多行合成一个块（第一行）+ 续行（后续行）
        const first = it.lines[0] ?? "";
        const markerText = it.kind === "ol" ? `${it.num ?? 1}. ` : "• ";
        const firstHtml = indentNbsp + markerText + this.parseInline(first);

        renderedLines.push(firstHtml);

        // 续行：再缩进 2 个空格
        for (let k = 1; k < it.lines.length; k++) {
          const contIndent = "&nbsp;".repeat((d - 1) * 2 + 2);
          renderedLines.push(contIndent + this.parseInline(it.lines[k]));
        }

        if (it.children.length && d < 3) render(it.children, d + 1);
        else if (it.children.length && d >= 3) {
          // 超过 3 级的子项：降级为续行
          for (const child of it.children) {
            const contIndent = "&nbsp;".repeat((d - 1) * 2 + 2);
            const childMarker = child.kind === "ol" ? `${child.num ?? 1}. ` : "• ";
            renderedLines.push(contIndent + childMarker + this.parseInline(child.lines.join(" ")));
          }
        }
      }
    };

    render(root.children, 1);

    // Telegram 列表只能用文本模拟；块内用 \n
    const blockHtml = renderedLines.join("\n");
    return { blockHtml, nextIndex: i };
  }

  // ---------------------------
  // Inline parsing
  // ---------------------------

  private static parseInlineWithLineBreaks(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      // 保留每行的缩进（>=2 空格）
      const preserved = this.applyIndentTokenPerLine(lines[i]);
      out.push(this.parseInline(preserved));
      if (i !== lines.length - 1) out.push("\n");
    }
    return out.join("");
  }

  private static parseInline(raw: string): string {
    if (!raw) return "";

    // 先把每行缩进转换为 token（避免 escape 后丢失）
    const withIndentToken = this.applyIndentTokenPerLine(raw);

    // 先 escape（保证不会注入 Telegram 不支持的 tag）
    let text = this.escapeHtml(withIndentToken);

    // 再把缩进 token 展开成 nbsp
    text = this.expandIndentTokensToNbsp(text);

    // 行内 code：先摘出来，避免内部再被加粗/斜体等处理（Telegram 也限制 code/pre 嵌套）
    const codeSpans: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_m, inner) => {
      const idx = codeSpans.push(`<code>${inner}</code>`) - 1;
      return `\u0000IC${idx}\u0000`;
    });

    // 链接：[label](url)
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      const safe = this.safeUrl(url);
      if (!safe) return label;
      // label 仍处于 escape 后的字符串环境里（可能含格式），这里允许再跑一次“轻量行内”
      const labelHtml = this.parseInlineFromEscaped(label);
      return `<a href="${safe}">${labelHtml}</a>`;
    });

    // 裸链接（避免吞掉末尾标点）
    text = text.replace(/(^|[\s(])((https?:\/\/)[^\s<>()]+)(?=$|[\s).,!?])/g, (_m, p1, url) => {
      const safe = this.safeUrl(url);
      if (!safe) return `${p1}${url}`;
      return `${p1}<a href="${safe}">${url}</a>`;
    });

    // spoiler: ||...||
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

    // 还原 code span
    text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? "");

    // 收敛过多空行（块级由外层控制，这里只做温和处理）
    text = text.replace(/\n{3,}/g, "\n\n");

    return text;
  }

  /**
   * 用于“已 escape 的环境”里的递归行内解析（避免二次 escape），只做有限替换。
   * 注意：不要在这里再次处理链接 url 的 escape；外层已经处理过链接结构。
   */
  private static parseInlineFromEscaped(escaped: string): string {
    let text = escaped;

    const codeSpans: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_m, inner) => {
      const idx = codeSpans.push(`<code>${inner}</code>`) - 1;
      return `\u0000IC${idx}\u0000`;
    });

    text = text.replace(/\|\|([^\n]+?)\|\|/g, (_m, inner) => {
      return `<span class="tg-spoiler">${this.parseInlineFromEscaped(inner)}</span>`;
    });

    text = text.replace(/~~([^\n]+?)~~/g, (_m, inner) => {
      return `<s>${this.parseInlineFromEscaped(inner)}</s>`;
    });

    text = text.replace(/__([^\n]+?)__/g, (_m, inner) => {
      return `<u>${this.parseInlineFromEscaped(inner)}</u>`;
    });

    text = text.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => {
      return `<b>${this.parseInlineFromEscaped(inner)}</b>`;
    });

    text = text.replace(/(^|[^*])\*([^\n*]+?)\*(?!\*)/g, (_m, p1, inner) => {
      return `${p1}<i>${this.parseInlineFromEscaped(inner)}</i>`;
    });

    text = text.replace(/(^|[^_])_([^\n_]+?)_(?!_)/g, (_m, p1, inner) => {
      return `${p1}<i>${this.parseInlineFromEscaped(inner)}</i>`;
    });

    text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? "");
    return text;
  }

  // ---------------------------
  // Indent preservation (>=2 spaces)
  // ---------------------------

  private static applyIndentTokenPerLine(text: string): string {
    const INDENT_TOKEN_PREFIX = "\u0000IND";
    const INDENT_TOKEN_SUFFIX = "\u0000";
    return (text || "")
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
    return (escaped || "").replace(new RegExp(`${INDENT_TOKEN_PREFIX}(\\d+)${INDENT_TOKEN_SUFFIX}`, "g"), (_m, nStr) => {
      const n = Math.max(0, Number(nStr) || 0);
      return "&nbsp;".repeat(n);
    });
  }

  // ---------------------------
  // Safety helpers
  // ---------------------------

  private static escapeHtml(s: string): string {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private static safeUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch {}
    return "";
  }
}
