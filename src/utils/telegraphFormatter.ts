// src/utils/telegraphFormatter.ts
/**
 * Telegraph supports a restricted DOM-like node format.
 * Tags (official whitelist):
 * a, aside, b, blockquote, br, code, em, figcaption, figure, h3, h4, hr, i, iframe, img, li, ol, p, pre, s, strong, u, ul, video
 *
 * Attrs allowed: href, src
 */

type TelegraphAttrs = Partial<Record<"href" | "src", string>>;

export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: TelegraphAttrs;
      children?: TelegraphNode[];
    };

type Block =
  | { type: "hr" }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; text: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "paragraph"; lines: string[] };

type ListItem = {
  // raw lines belonging to this list item (already stripped of marker)
  lines: string[];
  // nested blocks parsed from continuation lines (including nested lists)
  children: Block[];
};

type ListContext = {
  ordered: boolean;
  indent: number; // indent level (spaces) at which marker started
  items: ListItem[];
};

const TAGS = {
  p: "p",
  br: "br",
  hr: "hr",
  pre: "pre",
  code: "code",
  blockquote: "blockquote",
  ul: "ul",
  ol: "ol",
  li: "li",
  a: "a",
  img: "img",
  figure: "figure",
  figcaption: "figcaption",
  strong: "strong",
  em: "em",
  s: "s",
  u: "u",
  h3: "h3",
  h4: "h4",
} as const;

const repeatNbsp = (n: number) => "\u00A0".repeat(Math.max(0, n));

const normalizeNewlines = (markdown: string) =>
  (markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const countLeadingSpaces = (s: string): number => {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  return i;
};

const isBlank = (l: string) => l.trim() === "";

const isHr = (l: string) => /^(\s*)(---|\*\*\*)\s*$/.test(l);

const isFenceStart = (l: string) => /^\s*```/.test(l);

const stripFence = (l: string) => l.replace(/^\s*```[^\n]*$/, "");

const isAtxHeading = (l: string) => /^\s*#{1,6}\s+/.test(l);

const parseAtxHeading = (l: string): { level: number; text: string } | null => {
  const m = l.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
};

const isBlockquoteLine = (l: string) => /^\s*>/.test(l);

const stripBlockquoteMarker = (l: string) => l.replace(/^\s*>\s?/, "");

const matchListMarker = (
  line: string
): { ordered: boolean; indent: number; markerLen: number; content: string } | null => {
  const indent = countLeadingSpaces(line);
  const rest = line.slice(indent);

  // unordered: -, +, *
  const mu = rest.match(/^([-+*])\s+(.+)$/);
  if (mu) {
    const markerLen = mu[1].length + 1; // marker + one space (conceptually)
    return { ordered: false, indent, markerLen, content: mu[2] };
  }

  // ordered: 1. or 1)
  const mo = rest.match(/^(\d{1,9})([.)])\s+(.+)$/);
  if (mo) {
    const markerLen = mo[1].length + mo[2].length + 1;
    return { ordered: true, indent, markerLen, content: mo[3] };
  }

  return null;
};

const sanitizeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {}
  return "";
};

/**
 * Inline parser: reasonably close to CommonMark for the essentials:
 * - links: [label](url)
 * - images: ![alt](url)
 * - code span: `code`
 * - strong: **text**
 * - emphasis: *text*
 * - strikethrough: ~~text~~ (GFM-ish; useful)
 * - underline: __text__ (non-CommonMark; optional but supported by Telegraph)
 * - hard line breaks handled by block layer using <br>
 */
export class TelegraphFormatter {
  static toNodes(markdown: string): TelegraphNode[] {
    const src = normalizeNewlines(markdown);
    const lines = src.split("\n");

    const blocks = this.parseBlocks(lines, 0, lines.length, 0);
    return this.blocksToNodes(blocks);
  }

  // -------------------------
  // Block parsing (near-CommonMark)
  // -------------------------

  private static parseBlocks(
    lines: string[],
    start: number,
    end: number,
    baseIndent: number
  ): Block[] {
    const blocks: Block[] = [];
    let i = start;

    const flushParagraph = (buf: string[]) => {
      const trimmed = this.trimBlankEdges(buf);
      if (trimmed.length) blocks.push({ type: "paragraph", lines: trimmed });
    };

    let paragraphBuf: string[] = [];

    while (i < end) {
      const raw = lines[i] ?? "";
      const line = this.stripBaseIndent(raw, baseIndent);

      if (isBlank(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        i++;
        continue;
      }

      // fenced code block
      if (isFenceStart(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];

        i++; // consume opening fence
        const codeLines: string[] = [];
        while (i < end) {
          const l2 = this.stripBaseIndent(lines[i] ?? "", baseIndent);
          if (isFenceStart(l2)) {
            i++; // consume closing fence
            break;
          }
          // keep exact content (do not strip indent further)
          codeLines.push(l2.replace(/\s+$/, ""));
          i++;
        }
        blocks.push({ type: "code", text: codeLines.join("\n") });
        continue;
      }

      // indented code block (4 spaces) — apply only when it clearly matches
      // (CommonMark has nuanced rules; this is a pragmatic approximation)
      if (countLeadingSpaces(line) >= 4) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];

        const codeLines: string[] = [];
        while (i < end) {
          const l2 = this.stripBaseIndent(lines[i] ?? "", baseIndent);
          if (isBlank(l2)) {
            // blank lines belong to code block until break on next non-indented line
            codeLines.push("");
            i++;
            continue;
          }
          if (countLeadingSpaces(l2) < 4) break;
          codeLines.push(l2.slice(4).replace(/\s+$/, ""));
          i++;
        }
        blocks.push({ type: "code", text: codeLines.join("\n") });
        continue;
      }

      // hr
      if (isHr(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        blocks.push({ type: "hr" });
        i++;
        continue;
      }

      // heading
      if (isAtxHeading(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        const h = parseAtxHeading(line);
        if (h) blocks.push({ type: "heading", level: h.level, text: h.text });
        else paragraphBuf.push(line);
        i++;
        continue;
      }

      // blockquote (can be nested via recursion)
      if (isBlockquoteLine(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];

        const qLines: string[] = [];
        while (i < end) {
          const l2 = this.stripBaseIndent(lines[i] ?? "", baseIndent);
          if (isBlank(l2)) {
            // blank allowed inside quote; keep as separator
            qLines.push("");
            i++;
            continue;
          }
          if (!isBlockquoteLine(l2)) break;
          qLines.push(stripBlockquoteMarker(l2));
          i++;
        }
        blocks.push({ type: "blockquote", lines: qLines });
        continue;
      }

      // list (supports nesting)
      const lm = matchListMarker(line);
      if (lm) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];

        const { block, nextIndex } = this.parseList(lines, i, end, baseIndent);
        blocks.push(block);
        i = nextIndex;
        continue;
      }

      // otherwise: paragraph line
      paragraphBuf.push(line);
      i++;
    }

    flushParagraph(paragraphBuf);
    return blocks;
  }

  private static parseList(
    lines: string[],
    start: number,
    end: number,
    baseIndent: number
  ): { block: Block; nextIndex: number } {
    let i = start;

    const firstLineRaw = this.stripBaseIndent(lines[i] ?? "", baseIndent);
    const firstMarker = matchListMarker(firstLineRaw);
    if (!firstMarker) {
      // fallback to paragraph
      return { block: { type: "paragraph", lines: [firstLineRaw] }, nextIndex: i + 1 };
    }

    const root: ListContext = {
      ordered: firstMarker.ordered,
      indent: firstMarker.indent,
      items: [],
    };
    const stack: ListContext[] = [root];

    const pushNewItem = (ctx: ListContext, initialContent: string) => {
      ctx.items.push({
        lines: [initialContent],
        children: [],
      });
    };

    const currentCtx = () => stack[stack.length - 1];
    const currentItem = () => {
      const ctx = currentCtx();
      return ctx.items[ctx.items.length - 1];
    };

    // parse line-by-line
    while (i < end) {
      const raw = this.stripBaseIndent(lines[i] ?? "", baseIndent);
      if (isBlank(raw)) {
        // blank line: keep as paragraph break within current list item
        if (currentCtx().items.length) currentItem().lines.push("");
        i++;
        continue;
      }

      // stop list if we hit a non-list block at indent <= root.indent
      const asIsMarker = matchListMarker(raw);
      const indent = countLeadingSpaces(raw);

      // fenced code, heading, hr, blockquote at root level terminates list if indent <= root.indent
      const isTerminatingBlock =
        (isFenceStart(raw) || isHr(raw) || isAtxHeading(raw) || isBlockquoteLine(raw)) && indent <= root.indent;

      if (isTerminatingBlock) break;

      // Determine if this line starts a list item (possibly nested)
      if (asIsMarker) {
        // manage nesting by indent
        const { ordered, indent: itemIndent, content } = asIsMarker;

        // unwind stack to appropriate level
        while (stack.length > 1 && itemIndent < currentCtx().indent) stack.pop();

        // same level
        if (itemIndent === currentCtx().indent) {
          // if list type mismatched, we still treat as same list for pragmatism
          pushNewItem(currentCtx(), content);
          i++;
          continue;
        }

        // nested list
        if (itemIndent > currentCtx().indent) {
          const parentItem = currentItem();
          // create new nested list context
          const nested: ListContext = { ordered, indent: itemIndent, items: [] };
          stack.push(nested);
          // attach nested list later (after we parse) via children blocks
          // we represent it as a placeholder block now; will overwrite at finalize
          parentItem.children.push({
            type: "list",
            ordered: nested.ordered,
            items: nested.items,
          });
          pushNewItem(nested, content);
          i++;
          continue;
        }
      }

      // continuation line: belongs to current list item
      if (!currentCtx().items.length) {
        // should not happen, but be defensive
        pushNewItem(currentCtx(), raw.trim());
      } else {
        // CommonMark: a continuation line is usually indented >= (marker indent + 2..4).
        // We keep a pragmatic rule:
        // - If line indent > current list indent, strip that indent and keep as part of item
        // - Else, treat as paragraph continuation in item
        const ctxIndent = currentCtx().indent;
        const lIndent = countLeadingSpaces(raw);
        if (lIndent > ctxIndent) {
          currentItem().lines.push(raw.slice(Math.min(lIndent, ctxIndent + 2)));
        } else {
          currentItem().lines.push(raw.trimStart());
        }
      }

      // If we encounter a non-list line at indent <= root.indent and it looks like a new block, terminate
      const maybeNewRootBlock =
        indent <= root.indent &&
        (isFenceStart(raw) || isHr(raw) || isAtxHeading(raw) || isBlockquoteLine(raw));
      if (maybeNewRootBlock) break;

      i++;
    }

    // finalize list items: parse each item.lines into blocks, then merge with already-collected children blocks
    const finalizeListContext = (ctx: ListContext) => {
      for (const item of ctx.items) {
        // Parse item lines as blocks with base indent 0 (we already stripped markers/continuations)
        const itemBlocks = this.parseBlocks(item.lines, 0, item.lines.length, 0);

        // Merge: itemBlocks first, then any nested list blocks captured in item.children
        // But nested lists should appear at correct position; we attached them at parse-time.
        // To keep ordering sensible, if we already appended nested list blocks in item.children,
        // we append them after parsing itemBlocks.
        //
        // For closer CommonMark, you could interleave based on where the nested list started;
        // this implementation is “near CommonMark” but stable.
        item.children = [...itemBlocks, ...item.children];
      }
    };

    // finalize all contexts bottom-up (stack only holds references; root has all nested items)
    finalizeListContext(root);

    return {
      block: { type: "list", ordered: root.ordered, items: root.items },
      nextIndex: i,
    };
  }

  private static stripBaseIndent(line: string, baseIndent: number): string {
    if (baseIndent <= 0) return line;
    const lead = countLeadingSpaces(line);
    if (lead <= 0) return line;
    const toStrip = Math.min(lead, baseIndent);
    return line.slice(toStrip);
  }

  private static trimBlankEdges(lines: string[]): string[] {
    let s = 0;
    let e = lines.length;
    while (s < e && isBlank(lines[s] ?? "")) s++;
    while (e > s && isBlank(lines[e - 1] ?? "")) e--;
    return lines.slice(s, e);
  }

  // -------------------------
  // Convert blocks -> Telegraph nodes
  // -------------------------

  private static blocksToNodes(blocks: Block[]): TelegraphNode[] {
    const out: TelegraphNode[] = [];
    for (const b of blocks) {
      if (b.type === "hr") {
        out.push({ tag: TAGS.hr });
        continue;
      }

      if (b.type === "heading") {
        const mapped = this.mapHeadingTag(b.level);
        out.push({ tag: mapped, children: this.parseInline(b.text) });
        continue;
      }

      if (b.type === "code") {
        out.push({ tag: TAGS.pre, children: [{ tag: TAGS.code, children: [b.text] }] });
        continue;
      }

      if (b.type === "blockquote") {
        const innerBlocks = this.parseBlocks(b.lines, 0, b.lines.length, 0);
        out.push({ tag: TAGS.blockquote, children: this.blocksToNodes(innerBlocks) });
        continue;
      }

      if (b.type === "list") {
        out.push(this.listToNode(b));
        continue;
      }

      if (b.type === "paragraph") {
        const pTextLines = b.lines.map((l) => this.preserveIndentLine(l));
        out.push({ tag: TAGS.p, children: this.inlineWithHardBreaks(pTextLines) });
        continue;
      }
    }
    return out;
  }

  private static mapHeadingTag(level: number): string {
    // Telegraph supports h3/h4 only
    if (level <= 2) return TAGS.h3;
    if (level <= 4) return TAGS.h4;
    // degrade
    return TAGS.h4;
  }

  private static listToNode(b: Extract<Block, { type: "list" }>): TelegraphNode {
    const tag = b.ordered ? TAGS.ol : TAGS.ul;
    return {
      tag,
      children: b.items.map((it) => {
        // Convert item children blocks to nodes; if empty, fall back to inline text
        const childNodes = it.children.length
          ? this.blocksToNodes(it.children)
          : [{ tag: TAGS.p, children: this.inlineWithHardBreaks([this.preserveIndentLine((it.lines[0] ?? "").trim())]) }];

        // CommonMark: list item can contain multiple blocks; Telegraph <li> can contain mixed children.
        return { tag: TAGS.li, children: childNodes };
      }),
    };
  }

  private static preserveIndentLine(line: string): string {
    // Keep leading spaces as NBSP to avoid collapsing (visual fidelity)
    const m = line.match(/^( {1,})(.*)$/);
    if (!m) return line;
    return repeatNbsp(m[1].length) + (m[2] ?? "");
  }

  private static inlineWithHardBreaks(lines: string[]): TelegraphNode[] {
    // CommonMark: softbreak vs hardbreak differs; for Telegraph readability we treat newline as <br>
    const nodes: TelegraphNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      nodes.push(...this.parseInline(lines[i]));
      if (i !== lines.length - 1) nodes.push({ tag: TAGS.br });
    }
    return this.compactText(nodes);
  }

  // -------------------------
  // Inline parsing
  // -------------------------

  private static parseInline(text: string): TelegraphNode[] {
    if (!text) return [];

    // We parse by repeatedly finding the earliest construct among supported ones.
    // Priority: image > link > code > strong > strike > underline > emphasis
    const out: TelegraphNode[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const slice = text.slice(cursor);

      const next = this.findNextInlineToken(slice);
      if (!next) {
        out.push(slice);
        break;
      }

      if (next.start > 0) out.push(slice.slice(0, next.start));

      const consumed = slice.slice(next.start, next.end);

      switch (next.kind) {
        case "image": {
          const img = this.parseImage(consumed);
          if (!img) out.push(consumed);
          else {
            const safe = sanitizeUrl(img.url);
            if (!safe) {
              out.push(img.alt || "");
            } else if (img.alt.trim()) {
              out.push({
                tag: TAGS.figure,
                children: [
                  { tag: TAGS.img, attrs: { src: safe } },
                  { tag: TAGS.figcaption, children: this.parseInline(img.alt.trim()) },
                ],
              });
            } else {
              out.push({ tag: TAGS.img, attrs: { src: safe } });
            }
          }
          break;
        }

        case "link": {
          const ln = this.parseLink(consumed);
          if (!ln) out.push(consumed);
          else {
            const safe = sanitizeUrl(ln.url);
            if (!safe) out.push(...this.parseInline(ln.label));
            else out.push({ tag: TAGS.a, attrs: { href: safe }, children: this.parseInline(ln.label) });
          }
          break;
        }

        case "code": {
          const inner = consumed.slice(1, -1);
          out.push({ tag: TAGS.code, children: [inner] });
          break;
        }

        case "strong": {
          const inner = consumed.slice(2, -2);
          out.push({ tag: TAGS.strong, children: this.parseInline(inner) });
          break;
        }

        case "strike": {
          const inner = consumed.slice(2, -2);
          out.push({ tag: TAGS.s, children: this.parseInline(inner) });
          break;
        }

        case "underline": {
          const inner = consumed.slice(2, -2);
          out.push({ tag: TAGS.u, children: this.parseInline(inner) });
          break;
        }

        case "em": {
          const inner = consumed.slice(1, -1);
          out.push({ tag: TAGS.em, children: this.parseInline(inner) });
          break;
        }
      }

      cursor += next.start + (next.end - next.start);
    }

    return this.compactText(out);
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

  private static findNextInlineToken(
    s: string
  ): { kind: "image" | "link" | "code" | "strong" | "strike" | "underline" | "em"; start: number; end: number } | null {
    const candidates: Array<{
      kind: "image" | "link" | "code" | "strong" | "strike" | "underline" | "em";
      start: number;
      end: number;
    }> = [];

    const pushIfValid = (kind: any, start: number, end: number) => {
      if (start >= 0 && end > start) candidates.push({ kind, start, end });
    };

    // image: ![alt](url)
    {
      const idx = s.indexOf("![");
      if (idx >= 0) {
        const end = this.findBracketParenEnd(s, idx + 1); // position at '['
        if (end > idx) pushIfValid("image", idx, end);
      }
    }

    // link: [label](url)
    {
      const idx = s.indexOf("[");
      if (idx >= 0) {
        const end = this.findBracketParenEnd(s, idx);
        if (end > idx) pushIfValid("link", idx, end);
      }
    }

    // code: `code`
    {
      const idx = s.indexOf("`");
      if (idx >= 0) {
        const end = s.indexOf("`", idx + 1);
        if (end > idx + 1) pushIfValid("code", idx, end + 1);
      }
    }

    // strong: **text**
    {
      const idx = s.indexOf("**");
      if (idx >= 0) {
        const end = s.indexOf("**", idx + 2);
        if (end > idx + 2) pushIfValid("strong", idx, end + 2);
      }
    }

    // strike: ~~text~~
    {
      const idx = s.indexOf("~~");
      if (idx >= 0) {
        const end = s.indexOf("~~", idx + 2);
        if (end > idx + 2) pushIfValid("strike", idx, end + 2);
      }
    }

    // underline: __text__
    {
      const idx = s.indexOf("__");
      if (idx >= 0) {
        const end = s.indexOf("__", idx + 2);
        if (end > idx + 2) pushIfValid("underline", idx, end + 2);
      }
    }

    // emphasis: *text* (avoid **)
    {
      let bestStart = -1;
      let bestEnd = -1;
      for (let i = 0; i < s.length; i++) {
        if (s[i] !== "*") continue;
        if (s[i + 1] === "*") continue; // strong
        const j = s.indexOf("*", i + 1);
        if (j > i + 1) {
          bestStart = i;
          bestEnd = j + 1;
          break;
        }
      }
      if (bestStart >= 0) pushIfValid("em", bestStart, bestEnd);
    }

    if (!candidates.length) return null;

    // choose earliest start; tie-breaker: longer match first (prevents partial captures)
    candidates.sort((a, b) => (a.start - b.start) || (b.end - b.start) - (a.end - a.start));
    return candidates[0];
  }

  private static findBracketParenEnd(s: string, bracketStart: number): number {
    // bracketStart points to '[' of [label](url) OR for image we pass position of '[' (after '!')
    if (s[bracketStart] !== "[") return -1;
    const closeBracket = s.indexOf("]", bracketStart + 1);
    if (closeBracket < 0) return -1;
    if (s[closeBracket + 1] !== "(") return -1;

    // find matching ')', allowing a minimal balance for parentheses in URL
    let depth = 0;
    for (let i = closeBracket + 2; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) return i + 1;
        depth--;
      }
    }
    return -1;
  }

  private static parseLink(consumed: string): { label: string; url: string } | null {
    // [label](url)
    const m = consumed.match(/^\[([\s\S]*?)\]\(([\s\S]*?)\)$/);
    if (!m) return null;
    return { label: m[1], url: m[2] };
  }

  private static parseImage(consumed: string): { alt: string; url: string } | null {
    // ![alt](url)
    const m = consumed.match(/^!\[([\s\S]*?)\]\(([\s\S]*?)\)$/);
    if (!m) return null;
    return { alt: m[1] ?? "", url: m[2] ?? "" };
  }
}
