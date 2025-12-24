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

  function extractResponsesText(res) {
    const out = typeof res?.output_text === "string" ? res.output_text : "";
    if (out.trim().length > 0) return out;

    const outputItems = Array.isArray(res?.output) ? res.output : [];
    for (const item of outputItems) {
      if (item?.type !== "message") continue;
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "refusal" && typeof c.refusal === "string" && c.refusal.trim()) {
          throw new Error(`OpenAI refusal: ${c.refusal.trim()}`);
        }
      }
    }

    return out;
  }

  async function generateViaResponses({ systemPrompt, userPrompt, imageDataUrls }) {
    const inputMessage = {
      role: "user",
      content: [
        { type: "input_text", text: userPrompt },
        ...(Array.isArray(imageDataUrls)
          ? imageDataUrls
              .filter(Boolean)
              .map((u) => ({ type: "input_image", image_url: u, detail: "high" }))
          : []),
      ],
    };

    const variants = [{ max_output_tokens: 1800 }, {}];
    let lastErr = null;
    for (const extra of variants) {
      try {
        const res = await client.responses.create({
          model,
          instructions: systemPrompt,
          input: [inputMessage],
          ...extra,
        });
        const out = extractResponsesText(res);
        if (out == null) throw new Error("OpenAI returned no content");
        if (String(out).trim().length === 0) throw new Error("OpenAI returned blank content");
        return String(out);
      } catch (err) {
        lastErr = err;
        const is400 = (err?.status ?? err?.response?.status) === 400;
        const unsupportedMax = isUnsupportedParamError(err, "max_output_tokens");
        if (!is400 || !unsupportedMax) throw err;
      }
    }
    throw lastErr ?? new Error("OpenAI request failed");
  }

  async function generateRecipeMarkdown({ systemPrompt, userPrompt, imageDataUrls }) {
    return withRetry(
      async () => {
        // Prefer Responses API for gpt-5* models to avoid chat-completions parameter incompatibilities.
        if (/^gpt-5/i.test(model)) {
          return await generateViaResponses({ systemPrompt, userPrompt, imageDataUrls });
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
          { temperature: 0.2, max_completion_tokens: 1800 },
          { max_completion_tokens: 1800 },
          { temperature: 0.2, max_tokens: 1800 },
          { max_tokens: 1800 },
          { temperature: 0.2 },
          {},
        ];

        let lastErr = null;
        for (const extra of variants) {
          try {
            const res = await client.chat.completions.create({ ...basePayload, ...extra });
            const out = res?.choices?.[0]?.message?.content;
            if (out == null) throw new Error("OpenAI returned no content");
            if (String(out).trim().length === 0) throw new Error("OpenAI returned blank content");
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
