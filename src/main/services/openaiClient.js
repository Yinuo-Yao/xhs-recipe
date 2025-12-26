import OpenAI from "openai";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { retries, baseDelayMs, logger }) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const aborted = err?.name === "AbortError" || String(err?.message ?? "").includes("aborted") || String(err?.message ?? "") === "Request aborted";
      if (aborted) throw err;
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt > retries) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 1500);
      logger.warn("openai retry", { attempt, status, delay });
      await sleep(delay);
    }
  }
}

export function createOpenAIClient({ apiKey, model, logger }) {
  const client = new OpenAI({ apiKey });

  function isUnsupportedParamError(err, needle) {
    const msg = String(err?.message ?? err);
    return msg.includes("Unsupported") && msg.includes(needle);
  }

  function isPossiblyInvalidImageParamError(err) {
    const is400 = (err?.status ?? err?.response?.status) === 400;
    if (!is400) return false;
    const msg = String(err?.message ?? err);
    return msg.includes("image") || msg.includes("image_url") || msg.includes("input_image") || msg.includes("Invalid");
  }

  function coerceText(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => coerceText(v)).filter(Boolean).join("");
    if (value && typeof value === "object") {
      if (typeof value.value === "string") return value.value;
      if (typeof value.text === "string") return value.text;
    }
    return "";
  }

  function extractResponsesText(res) {
    const out = typeof res?.output_text === "string" ? res.output_text : "";
    if (out.trim().length > 0) return out;

    const topText = coerceText(res?.text);
    if (topText.trim()) return topText;

    const outputItems = Array.isArray(res?.output) ? res.output : [];
    const chunks = [];
    for (const item of outputItems) {
      if (item?.type === "output_text") {
        const t = coerceText(item?.text);
        if (t.trim()) chunks.push(t);
        continue;
      }

      const isMessage = item?.type === "message" || item?.type === "output_message";
      if (isMessage) {
        if (Array.isArray(item?.content)) {
          const content = item.content;
          for (const c of content) {
            if (c?.type === "refusal" && typeof c.refusal === "string" && c.refusal.trim()) {
              throw new Error(`OpenAI refusal: ${c.refusal.trim()}`);
            }
            if (c?.type === "output_text") {
              const t = coerceText(c.text);
              if (t.trim()) chunks.push(t);
              continue;
            }
            if (c?.type === "text") {
              const t = coerceText(c.text);
              if (t.trim()) chunks.push(t);
              continue;
            }
          }
          continue;
        }

        const t = coerceText(item?.content);
        if (t.trim()) chunks.push(t);
        continue;
      }

      // Some SDK/model variants return text directly on non-message output items.
      if (item && typeof item === "object") {
        const t =
          coerceText(item?.text) ||
          coerceText(item?.output_text) ||
          coerceText(item?.content) ||
          coerceText(item?.summary) ||
          coerceText(item?.final);
        if (t.trim()) chunks.push(t);
      }
    }

    const joined = chunks.join("\n").trim();
    return joined || out;
  }

  function summarizeResponsesShape(res) {
    const items = Array.isArray(res?.output) ? res.output : [];
    return items
      .map((item) => {
        const ct = Array.isArray(item?.content) ? item.content.map((c) => c?.type).filter(Boolean) : [];
        const contentKind = Array.isArray(item?.content) ? "array" : typeof item?.content;
        return {
          type: item?.type ?? null,
          contentKind,
          contentTypes: ct,
          hasText: Boolean(coerceText(item?.text) || coerceText(item?.output_text) || coerceText(item?.summary) || coerceText(item?.final)),
        };
      })
      .slice(0, 6);
  }

  function summarizeResponsesMeta(res) {
    if (!res || typeof res !== "object") return null;
    return {
      status: res.status ?? null,
      error: res.error ?? null,
      incomplete_details: res.incomplete_details ?? null,
      has_output_text: typeof res.output_text === "string" && res.output_text.trim().length > 0,
      has_text_field: Boolean(coerceText(res.text)),
    };
  }

  async function generateViaResponses({ systemPrompt, userPrompt, imageDataUrls, signal }) {
    const variants = [
      { reasoning: { effort: "low" }, max_output_tokens: 4096 },
      { reasoning: { effort: "low" }, max_output_tokens: 1800 },
      { max_output_tokens: 4096 },
      { max_output_tokens: 1800 },
      {},
    ];

    const imageMappers = [
      // Canonical Responses form (string URL / data URL).
      (u) => ({ type: "input_image", image_url: u }),
      // Compatibility fallback if a server expects an object wrapper.
      (u) => ({ type: "input_image", image_url: { url: u } }),
    ];

    let lastErr = null;
    for (let mapperIdx = 0; mapperIdx < imageMappers.length; mapperIdx += 1) {
      const mapImage = imageMappers[mapperIdx];
      const inputMessage = {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },
          ...(Array.isArray(imageDataUrls) ? imageDataUrls.filter(Boolean).map((u) => mapImage(u)) : []),
        ],
      };

      for (const extra of variants) {
        try {
          const res = await client.responses.create(
            {
              model,
              instructions: systemPrompt,
              input: [inputMessage],
              ...extra,
            },
            signal ? { signal } : undefined
          );
          const out = extractResponsesText(res);
          if (out == null) throw new Error("OpenAI returned no content");
          if (String(out).trim().length === 0) {
            logger.warn("openai responses empty output", {
              model,
              mapperIdx,
              shape: summarizeResponsesShape(res),
              meta: summarizeResponsesMeta(res),
              topLevelKeys: res && typeof res === "object" ? Object.keys(res).slice(0, 25) : null,
            });
            const meta = summarizeResponsesMeta(res);
            if (meta?.status === "incomplete" && meta?.incomplete_details?.reason === "max_output_tokens") {
              lastErr = new Error("OpenAI response incomplete (max_output_tokens) with no visible output");
              continue;
            }
            throw new Error("OpenAI returned blank content");
          }
          return String(out);
        } catch (err) {
          lastErr = err;
          const is400 = (err?.status ?? err?.response?.status) === 400;
          const unsupportedMax = isUnsupportedParamError(err, "max_output_tokens");
          const unsupportedTemp = isUnsupportedParamError(err, "temperature");
          const unsupportedReasoning = isUnsupportedParamError(err, "reasoning") || String(err?.message ?? "").includes("Unknown parameter: 'reasoning'");
          const retryableParam = is400 && (unsupportedMax || unsupportedTemp || unsupportedReasoning || isPossiblyInvalidImageParamError(err));
          if (!retryableParam) throw err;
        }
      }
    }

    throw lastErr ?? new Error("OpenAI request failed");
  }

  async function generateRecipeMarkdown({ systemPrompt, userPrompt, imageDataUrls, signal }) {
    return withRetry(
      async () => {
        if (signal?.aborted) throw new Error("Request aborted");
        // Prefer Responses API for gpt-5* models; fall back to Chat Completions if Responses yields no output.
        if (/^gpt-5/i.test(model)) {
          try {
            return await generateViaResponses({ systemPrompt, userPrompt, imageDataUrls, signal });
          } catch (err) {
            const msg = String(err?.message ?? err);
            if (!msg.includes("blank content") && !msg.includes("no content")) throw err;
            logger.warn("responses returned empty content; falling back to chat.completions", { model });
          }
        }

        const content = [{ type: "text", text: userPrompt }];
        for (const u of Array.isArray(imageDataUrls) ? imageDataUrls : []) {
          if (!u) continue;
          content.push({ type: "image_url", image_url: { url: u, detail: "high" } });
        }

        const basePayload = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content },
          ],
        };

        // Compatibility strategy:
        // - Some models require `max_completion_tokens` instead of `max_tokens`
        // - Some models only support default temperature (omit `temperature`)
        const variants = [
          { temperature: 0.1, max_completion_tokens: 1800 },
          { max_completion_tokens: 1800 },
          { temperature: 0.1, max_tokens: 1800 },
          { max_tokens: 1800 },
          { temperature: 0.1 },
          {},
        ];

        let lastErr = null;
        for (const extra of variants) {
          try {
            const res = await client.chat.completions.create({ ...basePayload, ...extra }, signal ? { signal } : undefined);
            const choice = res?.choices?.[0];
            const msg = choice?.message;
            const refusal = typeof msg?.refusal === "string" ? msg.refusal.trim() : "";
            if (refusal) throw new Error(`OpenAI refusal: ${refusal}`);
            const out = msg?.content;
            const finish = res?.choices?.[0]?.finish_reason ?? null;
            if (finish === "content_filter") {
              throw new Error("OpenAI blocked the response (content_filter). Try a different model or remove sensitive content from caption/images.");
            }
            if (out == null) throw new Error("OpenAI returned no content");
            if (String(out).trim().length === 0) {
              logger.warn("openai chat empty output", {
                model,
                finish_reason: finish,
                messageKeys: msg && typeof msg === "object" ? Object.keys(msg).slice(0, 20) : null,
              });
              throw new Error("OpenAI returned blank content");
            }
            return String(out);
          } catch (err) {
            lastErr = err;
            const unsupportedTokens =
              isUnsupportedParamError(err, "max_tokens") || isUnsupportedParamError(err, "max_completion_tokens");
            const unsupportedTemp = isUnsupportedParamError(err, "temperature");
            const is400 = (err?.status ?? err?.response?.status) === 400;
            if (!is400 || (!unsupportedTokens && !unsupportedTemp)) throw err;
          }
        }
        throw lastErr ?? new Error("OpenAI request failed");
      },
      { retries: 2, baseDelayMs: 800, logger }
    );
  }

  return { generateRecipeMarkdown };
}
