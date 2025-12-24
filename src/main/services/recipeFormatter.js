export function normalizeMarkdownRecipe(markdown) {
  const text = String(markdown ?? "").trim();
  if (!text) return "";

  const hasCn = /(^|\n)##\s*中文\s*($|\n)/.test(text);
  const hasEn = /(^|\n)##\s*English\s*($|\n)/i.test(text);
  if (hasCn && hasEn) return text.endsWith("\n") ? text : `${text}\n`;

  const fallback = [
    "# Recipe",
    "",
    "## 中文",
    text,
    "",
    "## English",
    "_Assumption: the original output was not in the required bilingual format._",
    "",
    text,
  ].join("\n");
  return fallback.endsWith("\n") ? fallback : `${fallback}\n`;
}

