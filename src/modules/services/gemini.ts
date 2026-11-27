import {
  getPref,
  getString,
  getThinkingLevelOptions,
  stripThinkingTags,
  transformPromptWithContext,
  isTaskSnapshotStillActive,
  getActiveReceiveToken,
  registerActiveRequest,
} from "../../utils";
import { TranslateService } from "./base";
import type { TranslateTask } from "../../utils/task";

const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 65536;

type ParsedText = {
  text: string;
  fullText?: boolean;
};

function extractGeminiText(payload: any): string {
  const candidates = Array.isArray(payload?.candidates)
    ? payload.candidates
    : [];
  let text = "";
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : [];
    for (const part of parts) {
      if (!part?.thought && typeof part?.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

function extractPartsText(payload: any): string {
  const parts = Array.isArray(payload?.parts)
    ? payload.parts
    : Array.isArray(payload?.content?.parts)
      ? payload.content.parts
      : [];
  let text = "";
  for (const part of parts) {
    if (!part?.thought && typeof part?.text === "string") {
      text += part.text;
    }
  }
  return text;
}

function extractAnyResponseText(payload: any): ParsedText {
  if (!payload) {
    return { text: "" };
  }
  if (Array.isArray(payload)) {
    let text = "";
    let fullText = false;
    for (const item of payload) {
      const parsed = extractAnyResponseText(item);
      text += parsed.text;
      fullText = fullText || !!parsed.fullText;
    }
    return { text, fullText };
  }

  if (
    typeof payload?.type === "string" &&
    payload.type === "response.output_text.done" &&
    typeof payload.text === "string"
  ) {
    return { text: payload.text, fullText: true };
  }
  if (
    typeof payload?.type === "string" &&
    payload.type === "response.output_text.delta" &&
    typeof payload.delta === "string"
  ) {
    return { text: payload.delta };
  }

  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  if (choices.length) {
    let text = "";
    let hasFullMessage = false;
    for (const choice of choices) {
      if (typeof choice?.delta?.content === "string") {
        text += choice.delta.content;
      }
      if (typeof choice?.message?.content === "string") {
        text += choice.message.content;
        hasFullMessage = true;
      }
    }
    return { text, fullText: hasFullMessage };
  }

  if (
    payload?.type === "content_block_delta" &&
    typeof payload?.delta?.text === "string"
  ) {
    return { text: payload.delta.text };
  }

  const geminiText = extractGeminiText(payload);
  if (geminiText) {
    return { text: geminiText };
  }

  const partsText = extractPartsText(payload);
  if (partsText) {
    return { text: partsText };
  }

  if (payload?.response && typeof payload.response !== "string") {
    const parsed = extractAnyResponseText(payload.response);
    if (parsed.text) {
      return parsed;
    }
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  if (output.length) {
    let text = "";
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (!part?.thought && typeof part?.text === "string") {
          text += part.text;
        }
      }
    }
    return { text, fullText: true };
  }

  if (typeof payload?.text === "string") {
    return { text: payload.text };
  }
  if (typeof payload?.content === "string") {
    return { text: payload.content };
  }
  if (typeof payload?.response === "string") {
    return { text: payload.response };
  }

  return { text: "" };
}

function parseJsonPayload(payloadText: string): any | undefined {
  const trimmed = payloadText.trim();
  if (!trimmed || trimmed === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksLikeJsonPayload(payloadText: string): boolean {
  const trimmed = payloadText.trim();
  return (
    trimmed === "[DONE]" || trimmed.startsWith("{") || trimmed.startsWith("[")
  );
}

function collectLooseJsonPayloads(responseText: string): string[] {
  const text = String(responseText || "");
  const payloads: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start < 0) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        payloads.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return payloads;
}

function collectStreamPayloads(
  responseText: string,
  includePartial = false,
): string[] {
  const normalized = String(responseText || "").replace(/\r\n/g, "\n");
  const payloads: string[] = [];
  const events = normalized.split(/\n\n+/);
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (
      !includePartial &&
      i === events.length - 1 &&
      !normalized.endsWith("\n\n")
    ) {
      break;
    }
    const dataLines = event
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (dataLines.length) {
      if (dataLines.length === 1) {
        payloads.push(dataLines[0]);
      } else if (dataLines.every(looksLikeJsonPayload)) {
        payloads.push(...dataLines);
      } else {
        payloads.push(dataLines.join("\n"));
      }
      continue;
    }
    const trimmed = event.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      if (includePartial) {
        const jsonLines = event
          .split("\n")
          .map((line) => line.trim())
          .filter(looksLikeJsonPayload);
        if (jsonLines.length > 1) {
          payloads.push(...jsonLines);
          continue;
        }
        if (!parseJsonPayload(trimmed)) {
          const loosePayloads = collectLooseJsonPayloads(trimmed);
          if (loosePayloads.length) {
            payloads.push(...loosePayloads);
            continue;
          }
        }
      }
      payloads.push(trimmed);
    }
  }

  if (!payloads.length) {
    const trimmed = normalized.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      payloads.push(trimmed);
    }
  }
  if (!payloads.length && includePartial) {
    payloads.push(...collectLooseJsonPayloads(normalized));
  }
  return payloads;
}

function parseGeminiStreamText(
  responseText: string,
  includePartial = false,
): string {
  const payloads = collectStreamPayloads(responseText, includePartial);
  let text = "";
  for (const payloadText of payloads) {
    const payload = parseJsonPayload(payloadText);
    if (!payload) {
      continue;
    }
    const parsed = extractAnyResponseText(payload);
    if (!parsed.text) {
      continue;
    }
    if (parsed.fullText && parsed.text.length >= text.length) {
      text = parsed.text;
    } else if (text && parsed.text.startsWith(text)) {
      text = parsed.text;
    } else {
      text += parsed.text;
    }
  }
  return text;
}

const translate = <TranslateService["translate"]>async function (data) {
  const apiURL = getPref("gemini.endPoint") as string;
  const configuredMaxOutputTokens =
    parseInt(
      (getPref("gemini.maxOutputTokens") as string) ||
        String(DEFAULT_GEMINI_MAX_OUTPUT_TOKENS),
      10,
    ) || DEFAULT_GEMINI_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = Math.max(
    1,
    Math.max(DEFAULT_GEMINI_MAX_OUTPUT_TOKENS, configuredMaxOutputTokens),
  );
  const thinkingLevel = getPref("gemini.thinkingLevel") as string;

  function getThinkingConfig() {
    const modelMatch = /models\/([^/?#]+)/.exec(apiURL);
    const isGemini3 = /^gemini-3/.test(modelMatch?.[1] || "");
    if (thinkingLevel === "off") {
      return isGemini3 ? { thinkingLevel: "minimal" } : { thinkingBudget: 0 };
    }
    if (
      thinkingLevel === "low" ||
      thinkingLevel === "medium" ||
      thinkingLevel === "high"
    ) {
      const budgets = { low: 1024, medium: 8192, high: 24576 };
      return isGemini3
        ? { thinkingLevel: thinkingLevel }
        : { thinkingBudget: budgets[thinkingLevel] };
    }
    return undefined;
  }

  function transformContent(
    langFrom: string,
    langTo: string,
    sourceText: string,
  ) {
    return transformPromptWithContext(
      "gemini.prompt",
      langFrom,
      langTo,
      sourceText,
      data,
    );
  }

  function getGenContentAPI(data: Required<TranslateTask>) {
    const stream = true;
    if (stream) {
      return apiURL + `:streamGenerateContent?alt=sse&key=${data.secret}`;
    } else {
      return apiURL + `:generateContent?key=${data.secret}`;
    }
  }

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });
  const rawSnapshot = data.raw;
  const receiveToken = getActiveReceiveToken();
  const canCommit = () =>
    isTaskSnapshotStillActive(data, rawSnapshot, receiveToken);

  data.result = "";

  const xhr = await Zotero.HTTP.request("POST", getGenContentAPI(data), {
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: transformContent(data.langfrom, data.langto, data.raw),
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens,
        ...(getThinkingConfig() ? { thinkingConfig: getThinkingConfig() } : {}),
      },
    }),
    responseType: "text",
    requestObserver: (xmlhttp: XMLHttpRequest) => {
      registerActiveRequest(xmlhttp);
      let result = "";
      let lastEmittedResult = "";
      let latestResponse = "";
      let parseFrame: number | null = null;
      const cancelParseFrame = () => {
        if (parseFrame === null) {
          return;
        }
        clearTimeout(parseFrame);
        parseFrame = null;
      };
      const emitLatestResponse = () => {
        parseFrame = null;
        if (!canCommit()) {
          return;
        }
        const parsedResult = stripThinkingTags(
          parseGeminiStreamText(latestResponse, true),
        );
        if (parsedResult.length >= result.length) {
          result = parsedResult;
        }
        if (result !== lastEmittedResult) {
          data.result = result;
          lastEmittedResult = result;
          refreshHandler();
        }
      };
      const queueLatestResponse = () => {
        if (parseFrame !== null) {
          return;
        }
        parseFrame = setTimeout(emitLatestResponse, 0) as unknown as number;
      };

      xmlhttp.onprogress = (e: any) => {
        if (!canCommit()) {
          cancelParseFrame();
          return;
        }
        latestResponse = e.target.response || "";

        // Clear timeouts caused by stream transfers
        if (e.target.timeout) {
          e.target.timeout = 0;
        }
        queueLatestResponse();
      };

      xmlhttp.onloadend = () => {
        cancelParseFrame();
        if (!canCommit()) {
          return;
        }
        latestResponse = xmlhttp.response || latestResponse;
        const replayed = stripThinkingTags(
          parseGeminiStreamText(latestResponse, true),
        );
        if (replayed.length >= result.length) {
          result = replayed;
        }
        const finalResult = result;
        if (finalResult !== lastEmittedResult) {
          data.result = finalResult;
          refreshHandler();
        }
      };
    },
  });
  if (xhr?.status !== 200) {
    throw `Request error: ${xhr?.status}`;
  }
  // data.result = xhr.response.choices[0].message.content.substr(2);
};

export const Gemini: TranslateService = {
  id: "gemini",
  type: "sentence",
  helpUrl: "https://ai.google.dev/gemini-api/docs",

  defaultSecret: "",
  secretValidator(secret: string) {
    const flag = Boolean(secret);
    return {
      secret,
      status: flag,
      info: flag ? "" : "The secret is not set.",
    };
  },

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "gemini.endPoint",
        nameKey: "service-gemini-dialog-endPoint",
      })
      .addTextAreaSetting({
        prefKey: "gemini.prompt",
        nameKey: "service-gemini-dialog-prompt",
      })
      .addNumberSetting({
        prefKey: "gemini.maxOutputTokens",
        nameKey: "service-gemini-dialog-maxOutputTokens",
        min: 1,
        max: 65536,
        step: 1,
      })
      .addCheckboxSetting({
        prefKey: "gemini.stream",
        nameKey: "service-gemini-dialog-stream",
      })
      .addSelectSetting({
        prefKey: "gemini.thinkingLevel",
        nameKey: "service-gemini-dialog-thinkingLevel",
        options: getThinkingLevelOptions(),
      });
  },
};
