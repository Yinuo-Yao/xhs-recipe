const LANGUAGE_SPECS = {
  en: {
    label: "English",
    headings: {
      title: "# Title",
      ingredients: "## Ingredients",
      steps: "## Steps",
      quantities: "## Quantities/Measurements",
      tools: "## Tools/Appliances",
    },
  },
  "zh-Hans": {
    label: "Chinese (Simplified)",
    headings: {
      title: "# 标题",
      ingredients: "## 食材",
      steps: "## 步骤",
      quantities: "## 用量/计量",
      tools: "## 工具/器具",
    },
  },
};

function resolveLanguageSpec(outputLanguage) {
  const key = outputLanguage === "en" ? "en" : "zh-Hans";
  return LANGUAGE_SPECS[key];
}

export function buildSystemPrompt({ outputLanguage }) {
  const spec = resolveLanguageSpec(outputLanguage);
  const h = spec.headings;

  const rulesEn = `
You are an information extraction tool for recipes.

Task:
- Transcribe and summarize ONLY what is explicitly present in the provided Xiaohongshu caption text and the attached image(s).
- If image(s) contain visible text, treat that text as authoritative.

Hard rules:
- Do NOT invent. Do NOT infer missing steps. Do NOT add common knowledge.
- Do NOT add ingredients, steps, times, temperatures, substitutions, or tips unless explicitly present.
- Preserve original characters exactly (do not rewrite units or normalize quantities).
- If information is missing, leave the relevant section empty (do not add a "missing info" section).
- Do NOT add any source tags like "[caption]" or "[image]" anywhere in the output.

Language:
- Write the output strictly in ${spec.label}.
- Do NOT include translations and do NOT use bilingual headings.

Output:
- Output VALID Markdown only.
- Use the following headings in this exact order (include all headings even if empty):
${h.title}
${h.ingredients}
${h.steps}
${h.quantities}
${h.tools}

Never output an empty response:
- Always output the headings above, even if no recipe content is found.
- If you cannot find ANY recipe-related information, leave all sections empty except keep the headings.
`.trim();

  if (outputLanguage === "en") return rulesEn;

  return `
你是一个用于食谱信息抽取的工具。

任务：
- 只转写/整理「小红书文案」与「图片内容（包括图片里的可见文字）」中明确出现的信息。
- 如果图片里有可见文字，以图片文字为权威来源。

严格规则：
- 不要编造；不要补全缺失步骤；不要凭常识推断。
- 不要添加原文/原图未出现的食材、步骤、时间、温度、替代方案或小贴士。
- 保持原始字符（不要改写单位，不要规范化用量）。
- 若信息缺失，对应小节内容留空（不要添加「缺失信息」小节）。
- 输出中不要出现任何来源标注（例如“[caption]”“[image]”）。

语言：
- 输出必须严格使用${spec.label}。
- 不要翻译，不要双语，不要重复标题。

输出：
- 只输出有效的 Markdown。
- 必须按以下顺序输出并保留全部标题（即使内容为空）：
${h.title}
${h.ingredients}
${h.steps}
${h.quantities}
${h.tools}

不要输出空内容：
- 即使找不到任何食谱信息，也必须输出上述标题。
- 若完全找不到任何可提取的食谱相关信息，各小节保持空即可（只保留标题）。
`.trim();
}

export function buildUserPrompt({ sourceUrl, caption }) {
  return `
Source URL:
${String(sourceUrl ?? "")}

Caption:
${String(caption ?? "")}
`.trim();
}
