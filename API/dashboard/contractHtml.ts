/**
 * contractHtml.ts — turn proposal HTML into formatted PDF content.
 *
 * The template blocks are authored as rich HTML with inline styles and utility
 * classes meant for the status page. A contract should keep the STRUCTURE of
 * that copy (headings, emphasis, lists, tables) while dropping every visual
 * style, so the document reads like an agreement rather than a landing page.
 *
 * Two steps, deliberately separated:
 *   sanitizeContractHtml() — drop styling and unknown tags, keep structure.
 *                            Runs once, at snapshot time, so what gets stored
 *                            is already clean.
 *   htmlToPdfNodes()       — map that clean HTML onto pdfmake content nodes.
 *                            Runs at render time.
 *
 * No DOM is available in Deno, so this carries a small tokenizer. It only has
 * to handle the tag set the proposal editor emits, and it never throws on
 * malformed markup: unclosed tags simply close at the end of their parent.
 */

// ── Entities and emoji ───────────────────────────────────────────────────────

// Built from char codes so the entity table itself never contains a literal
// entity that an editor or formatter could helpfully "decode" for us.
const AMP = String.fromCharCode(38);
const ENTITIES: Array<[needle: string, replacement: string]> = [
  [AMP + "nbsp;", " "],
  [AMP + "lt;", "<"],
  [AMP + "gt;", ">"],
  [AMP + "quot;", '"'],
  [AMP + "#34;", '"'],
  [AMP + "#39;", "'"],
  [AMP + "apos;", "'"],
  [AMP + "hellip;", "..."],
  [AMP + "mdash;", "-"],
  [AMP + "ndash;", "-"],
  // Ampersand last: decoding it first would corrupt the entities above.
  [AMP + "amp;", AMP],
];

export function decodeEntities(s: string): string {
  let out = s;
  for (const [needle, replacement] of ENTITIES) out = out.split(needle).join(replacement);
  return out;
}

/**
 * Drop emoji and other pictographs. Templates use them as visual bullets, which
 * is right for a sales page and wrong for a contract a bank will read. Covers
 * the emoji blocks, dingbats, the variation selector and zero-width joiner used
 * to build compound emoji, and the keycap combining mark, then collapses the
 * space the removal leaves behind.
 */
export function stripEmoji(s: string): string {
  return s
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
      "",
    )
    .replace(/[ \t]{2,}/g, " ");
}

// ── Tag policy ───────────────────────────────────────────────────────────────

/** Structural tags that survive sanitization. Everything else is unwrapped. */
const KEPT_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "blockquote",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "u",
  "table", "thead", "tbody", "tr", "th", "td",
  "details", "summary",
]);

/** Tags whose entire contents are discarded, not just the tag itself. */
const DROPPED_SUBTREES = /<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Self-closing tags that never carry children. */
const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "col"]);

/** Tags that start a new visual block rather than flowing inline. */
const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "hr", "blockquote", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  "details", "summary", "div", "section",
]);

/**
 * Strip styling from proposal HTML while keeping its structure.
 *
 * Removes script/style subtrees, drops every attribute (which takes `style`,
 * `class`, `width` and friends with it), unwraps tags outside the whitelist so
 * their text survives, and strips emoji. The result is small enough to store on
 * the snapshot and safe to parse.
 */
export function sanitizeContractHtml(html: string): string {
  if (!html) return "";
  let s = String(html).replace(DROPPED_SUBTREES, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, rawTag: string) => {
    const tag = rawTag.toLowerCase();
    if (!KEPT_TAGS.has(tag)) {
      // Unwrap: the tag disappears, its text stays. A block-level wrapper
      // leaves a line break behind so paragraphs do not run together.
      return BLOCK_TAGS.has(tag) ? "<br>" : " ";
    }
    if (VOID_TAGS.has(tag)) return `<${tag}>`;
    return match.startsWith("</") ? `</${tag}>` : `<${tag}>`;
  });

  return stripEmoji(s).replace(/[ \t]{2,}/g, " ").trim();
}

// ── Parsing ──────────────────────────────────────────────────────────────────

interface HtmlNode {
  tag: string;
  children: HtmlNode[];
  text?: string;
}

const TOKEN = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+/g;

/** Parse sanitized HTML into a shallow tree. Unclosed tags close with their parent. */
function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "root", children: [] };
  const stack: HtmlNode[] = [root];
  let match: RegExpExecArray | null;

  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(html)) !== null) {
    const [raw, rawTag] = match;

    if (!rawTag) {
      const text = decodeEntities(raw);
      if (text.trim()) stack[stack.length - 1].children.push({ tag: "#text", children: [], text });
      continue;
    }

    const tag = rawTag.toLowerCase();

    if (raw.startsWith("</")) {
      // Close the nearest matching ancestor. An unmatched closer is ignored so
      // stray markup can never unwind the whole stack.
      const idx = stack.map((n) => n.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }

    const node: HtmlNode = { tag, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(tag)) stack.push(node);
  }

  return root;
}

// ── Inline runs ──────────────────────────────────────────────────────────────

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  decoration?: string;
}

/** Collect a node's inline descendants into pdfmake text runs. */
function inlineRuns(nodes: HtmlNode[], inherited: InlineStyle = {}): any[] {
  const runs: any[] = [];

  for (const node of nodes) {
    if (node.tag === "#text") {
      const text = node.text!.replace(/\s+/g, " ");
      if (text.trim()) runs.push({ text, ...inherited });
      continue;
    }
    if (node.tag === "br") {
      runs.push({ text: "\n" });
      continue;
    }

    const style: InlineStyle = { ...inherited };
    if (node.tag === "strong" || node.tag === "b") style.bold = true;
    if (node.tag === "em" || node.tag === "i") style.italics = true;
    if (node.tag === "u") style.decoration = "underline";

    runs.push(...inlineRuns(node.children, style));
  }

  return runs;
}

/** True when a node (or any descendant) starts a new block. */
function hasBlockContent(nodes: HtmlNode[]): boolean {
  return nodes.some((n) => BLOCK_TAGS.has(n.tag) || hasBlockContent(n.children));
}

// ── Rendering to pdfmake ─────────────────────────────────────────────────────

/** Style names the contract stylesheet must define. */
export const HTML_STYLES = {
  h1: "tplH1",
  h2: "tplH2",
  h3: "tplH3",
  body: "templateBody",
  listItem: "tplListItem",
  quote: "tplQuote",
  th: "tplTh",
  td: "tplTd",
} as const;

function pushParagraph(runs: any[], style: string, out: any[]): void {
  if (runs.length === 0) return;
  if (runs.every((r) => !String(r.text ?? "").trim())) return;
  out.push({ text: runs, style });
}

function listItems(node: HtmlNode): any[] {
  return node.children
    .filter((c) => c.tag === "li")
    .map((li) => {
      // A list item holding its own blocks (a nested list, say) renders as a
      // stack so the nesting survives instead of collapsing into one line.
      if (hasBlockContent(li.children)) {
        return { stack: renderNodes(li.children, HTML_STYLES.listItem) };
      }
      return { text: inlineRuns(li.children), style: HTML_STYLES.listItem };
    });
}

function tableNode(node: HtmlNode): any | null {
  const rows: HtmlNode[] = [];
  const collectRows = (n: HtmlNode) => {
    for (const child of n.children) {
      if (child.tag === "tr") rows.push(child);
      else if (child.tag === "thead" || child.tag === "tbody") collectRows(child);
    }
  };
  collectRows(node);
  if (rows.length === 0) return null;

  const body = rows.map((row) =>
    row.children
      .filter((c) => c.tag === "th" || c.tag === "td")
      .map((cell) => ({
        text: inlineRuns(cell.children),
        style: cell.tag === "th" ? HTML_STYLES.th : HTML_STYLES.td,
      }))
  ).filter((cells) => cells.length > 0);
  if (body.length === 0) return null;

  // pdfmake needs every row to declare the same number of columns.
  const columns = Math.max(...body.map((r) => r.length));
  for (const row of body) {
    while (row.length < columns) row.push({ text: [], style: HTML_STYLES.td });
  }

  const headerRows = rows[0].children.some((c) => c.tag === "th") ? 1 : 0;
  return {
    table: { headerRows, widths: Array(columns).fill("*"), body },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => "#e2e8f0",
      paddingLeft: () => 0,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
    margin: [0, 2, 0, 10],
  };
}

const HEADING_STYLE: Record<string, string> = {
  h1: HTML_STYLES.h1,
  h2: HTML_STYLES.h2,
  h3: HTML_STYLES.h3,
  h4: HTML_STYLES.h3,
  h5: HTML_STYLES.h3,
  h6: HTML_STYLES.h3,
  summary: HTML_STYLES.h3,
};

function renderNodes(nodes: HtmlNode[], bodyStyle: string): any[] {
  const out: any[] = [];
  let pending: HtmlNode[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    pushParagraph(inlineRuns(pending), bodyStyle, out);
    pending = [];
  };

  for (const node of nodes) {
    if (!BLOCK_TAGS.has(node.tag)) {
      pending.push(node);
      continue;
    }
    flush();

    if (HEADING_STYLE[node.tag]) {
      pushParagraph(inlineRuns(node.children), HEADING_STYLE[node.tag], out);
    } else if (node.tag === "ul" || node.tag === "ol") {
      const items = listItems(node);
      if (items.length > 0) {
        out.push({ [node.tag]: items, margin: [0, 0, 0, 8] });
      }
    } else if (node.tag === "table") {
      const table = tableNode(node);
      if (table) out.push(table);
    } else if (node.tag === "hr") {
      out.push({
        canvas: [{ type: "line", x1: 0, y1: 4, x2: 499, y2: 4, lineWidth: 0.5, lineColor: "#e2e8f0" }],
        margin: [0, 4, 0, 10],
      });
    } else if (node.tag === "blockquote") {
      pushParagraph(inlineRuns(node.children), HTML_STYLES.quote, out);
    } else if (hasBlockContent(node.children)) {
      // div / details / li wrappers: recurse so inner blocks keep their shape.
      out.push(...renderNodes(node.children, bodyStyle));
    } else {
      pushParagraph(inlineRuns(node.children), bodyStyle, out);
    }
  }

  flush();
  return out;
}

/**
 * Convert sanitized proposal HTML into pdfmake content nodes.
 *
 * Returns an empty array for empty or text-free markup, so a caller can treat
 * "no nodes" as "nothing to render" without a separate emptiness check.
 */
export function htmlToPdfNodes(html: string, bodyStyle: string = HTML_STYLES.body): any[] {
  if (!html || !html.trim()) return [];
  return renderNodes(parseHtml(html).children, bodyStyle);
}