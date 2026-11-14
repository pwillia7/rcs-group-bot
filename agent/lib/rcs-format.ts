/**
 * RCS/SMS bubbles render plain text only, so Markdown shows up as literal
 * asterisks and pipes. Models (especially on fallback) don't always follow the
 * "no Markdown" instruction, so normalize every reply here before sending.
 */
export function toRcsText(input: string): string {
  let s = input.replace(/\r\n/g, "\n");

  // Fenced code blocks → their contents
  s = s.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_m, code: string) => code.trimEnd());

  // Tables → "a — b — c" lines (drop separator rows)
  s = s
    .split("\n")
    .flatMap((line) => {
      const t = line.trim();
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t)) return [];
      if (t.startsWith("|") && t.endsWith("|")) {
        return [
          t
            .slice(1, -1)
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean)
            .join(" — "),
        ];
      }
      return [line];
    })
    .join("\n");

  s = s
    // Headings → plain line
    .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, "$1")
    // Blockquotes
    .replace(/^\s{0,3}>\s?/gm, "")
    // Horizontal rules
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
    // Images ![alt](url) → url
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, "$2")
    // Links [text](url) → "text (url)", or just url when they match
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) =>
      text.trim() === url || url.endsWith(text.trim()) ? url : `${text} (${url})`,
    )
    // Bold / italic / strikethrough
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    // Inline code
    .replace(/`([^`\n]+)`/g, "$1")
    // Bullets: "* x" / "+ x" → "- x"
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    // Collapse extra blank lines
    .replace(/\n{3,}/g, "\n\n");

  return s.trim();
}
