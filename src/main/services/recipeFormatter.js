export function normalizeMarkdownRecipe(markdown) {
  const text = String(markdown ?? "").trim();
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

