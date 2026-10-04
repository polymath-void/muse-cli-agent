/**
 * src/gateway/readability.ts — zero-dep HTML→text/markdown extraction.
 * Strips script/style/nav/footer/iframe/noscript, extracts <title> + main
 * content, truncates to 8000 chars with a continuation hint.
 */
import { redactSecrets } from "../kernel/redactor.js";

export const MAX_CHARS = 8000;

export interface ExtractedPage {
  title: string;
  markdown: string;
  truncated: boolean;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(nav|footer|header|aside|iframe|noscript|form|button)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function htmlToMarkdown(html: string): string {
  let s = html;
  // Headings
  s = s.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, l, t) => `\n${"#".repeat(Number(l))} ${cleanInline(t)}\n`);
  // Links
  s = s.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, t) => `[${cleanInline(t)}](${String(href).slice(0, 300)})`);
  // List items / paragraphs / breaks
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, t) => `\n- ${cleanInline(t)}`);
  s = s.replace(/<(p|div|section|article|tr)[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(h[1-6]|ul|ol|table|pre|blockquote)[^>]*>/gi, "\n");
  // Drop remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Entities
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l) => l.length > 0).join("\n");
  return s;
}

function cleanInline(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Pick main content: <main>/<article> if present, else <body>, else whole doc. */
function mainHtml(cleaned: string): string {
  const m = /<(main|article)[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(cleaned);
  if (m) return m[2];
  const b = /<body[^>]*>([\s\S]*?)<\/body\s*>/i.exec(cleaned);
  if (b) return b[1];
  return cleaned;
}

export function extractReadable(html: string, selector?: string): ExtractedPage {
  const title = (/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  let cleaned = stripTags(html);
  let scope = mainHtml(cleaned);
  if (selector) {
    // Minimal selector support: tag, .class, #id (no external CSS engine).
    const sel = selector.trim();
    let re: RegExp | null = null;
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sel)) {
      re = new RegExp(`<${sel}[^>]*>([\\s\\S]*?)<\\/${sel}\\s*>`, "i");
    } else if (sel.startsWith(".")) {
      const cls = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(`<[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i");
    } else if (sel.startsWith("#")) {
      const id = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(`<[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i");
    }
    if (re) {
      const m = re.exec(cleaned);
      if (m) scope = m[1];
    }
  }
  let md = redactSecrets(htmlToMarkdown(scope));
  let truncated = false;
  if (md.length > MAX_CHARS) {
    md = md.slice(0, MAX_CHARS) + `\n\n...[truncated, use --selector to narrow]`;
    truncated = true;
  }
  return { title, markdown: md, truncated };
}
