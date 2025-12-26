const HARD_STOP_CHARS = new Set([
  '"',
  "'",
  "“",
  "”",
  "‘",
  "’",
  ")",
  "）",
  "]",
  "】",
  "}",
  ">",
  "》",
  "〉",
  "」",
  "』",
  "，",
  "。",
  "、",
  "；",
  "！",
  "？",
]);

const TRAILING_TRIM_CHARS = new Set([
  ...HARD_STOP_CHARS,
  ",",
  ".",
  ";",
  "!",
  "?",
  ":",
]);

function trimTrailingPunctuation(text) {
  let out = String(text ?? "");
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!TRAILING_TRIM_CHARS.has(last)) break;
    out = out.slice(0, -1);
  }
  return out;
}

export function extractFirstHttpsUrl(input) {
  const text = String(input ?? "");
  const idx = text.indexOf("https://");
  if (idx === -1) return null;

  const tail = text.slice(idx);
  let end = tail.length;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (/\s/.test(ch) || HARD_STOP_CHARS.has(ch)) {
      end = i;
      break;
    }
  }

  const candidate = trimTrailingPunctuation(tail.slice(0, end));
  if (!candidate.startsWith("https://")) return null;
  if (candidate.length <= "https://".length) return null;
  return candidate;
}

