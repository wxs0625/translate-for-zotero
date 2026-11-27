import {
  buildThinkingParams,
  getPref,
  getString,
  getThinkingLevelOptions,
  normalizeLLMEndpoint,
  stripThinkingTags,
  transformPromptWithContext,
  isTaskSnapshotStillActive,
  registerActiveRequest,
  getActiveReceiveToken,
  setPref,
  CUSTOM_GPT_MAX_COUNT,
} from "../../utils";
import { TranslateService } from "./base";
import { modelSupportsTemperature } from "./claude";

type CustomGPTID = `customgpt${number}`;
type ID = "chatgpt" | CustomGPTID | "azuregpt";

type GPTPrefPrefix = "chatGPT" | `customGPT${number}` | "azureGPT";

const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const TOKEN_LIMIT_PARAM_KEYS = [
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
];

// Same default prompt as in addon/prefs.js, used for Custom GPT services
// created beyond the ones predefined there.
const DEFAULT_CUSTOM_GPT_PROMPT =
  "As an academic expert with specialized knowledge in various fields, please provide a proficient and precise translation from ${langFrom} to ${langTo} of the academic text enclosed in 🔤. It is crucial to maintaining the original phrase or sentence and ensure accuracy while utilizing the appropriate language. The text is as follows:  🔤 ${sourceText} 🔤  Please provide the translated result without any additional explanation and remove 🔤.";

/**
 * Ensure the prefs of a Custom GPT service exist. Services beyond the
 * predefined customGPT1..20 in prefs.js get runtime defaults here.
 */
function ensureCustomGPTDefaults(prefPrefix: string) {
  const defaults: Record<string, string | boolean> = {
    apiFormat: "openai",
    endPoint: "",
    model: "",
    temperature: "1.0",
    prompt: DEFAULT_CUSTOM_GPT_PROMPT,
    stream: true,
    thinkingLevel: "default",
    customParams: "",
    customHeaders: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (getPref(`${prefPrefix}.${key}`) === undefined) {
      setPref(`${prefPrefix}.${key}`, value);
    }
  }
}

function getCustomParams(
  prefix: string,
  extraFilterKeys: string[] = [],
): Record<string, any> {
  const storedCustomParams =
    (getPref(`${prefix}.customParams`) as string) || "{}";
  try {
    const customParams = JSON.parse(storedCustomParams);
    // Filter out parameters that are already defined (for both Chat Completions and Responses API)
    const standardParams = [
      "model",
      "messages",
      "input",
      "temperature",
      "stream",
      "audio",
      "modalities",
      "voice",
      "tts",
      "ttsVoiceInfo",
      "tts_voice_info",
      "sessionContext",
      "session_context",
      ...extraFilterKeys,
    ];
    return Object.fromEntries(
      Object.entries(customParams).filter(
        ([key]) => !standardParams.includes(key),
      ),
    );
  } catch (e) {
    return {};
  }
}

// Headers set by the plugin itself; custom headers with these names are ignored.
const STANDARD_REQUEST_HEADERS = [
  "content-type",
  "authorization",
  "api-key",
  "x-api-key",
  "anthropic-version",
];

function getCustomHeaders(prefix: string): Record<string, string> {
  const storedCustomHeaders =
    (getPref(`${prefix}.customHeaders`) as string) || "{}";
  try {
    const customHeaders = JSON.parse(storedCustomHeaders);
    return Object.fromEntries(
      Object.entries(customHeaders)
        .filter(
          ([key]) => !STANDARD_REQUEST_HEADERS.includes(key.toLowerCase()),
        )
        .map(([key, value]) => [key, String(value)]),
    );
  } catch (e) {
    return {};
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimTrailingLineBreaks(text: string): string {
  return normalizeLineEndings(stripThinkingTags(text)).replace(/\n+$/g, "");
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

function extractSseDataPayloads(block: string): string[] {
  const dataLines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s*/, ""))
    .filter(Boolean);
  if (dataLines.length <= 1) {
    return dataLines;
  }
  if (
    dataLines.every((line) => line === "[DONE]" || !!parseJsonPayload(line))
  ) {
    return dataLines;
  }
  return [dataLines.join("\n").trim()].filter(Boolean);
}

function splitCompleteSseRemainder(remainder: string): {
  events: string[];
  remainder: string;
} {
  const events: string[] = [];
  const pendingLines: string[] = [];
  for (const line of remainder.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!trimmed.startsWith("data:")) {
      pendingLines.push(line);
      continue;
    }
    const payload = trimmed.replace(/^data:\s*/, "");
    if (payload === "[DONE]" || parseJsonPayload(payload)) {
      events.push(payload);
    } else {
      pendingLines.push(line);
    }
  }
  return { events, remainder: pendingLines.join("\n") };
}

function parseSseEvents(chunk: string): {
  events: string[];
  remainder: string;
} {
  const normalized = normalizeLineEndings(chunk);
  const blocks = normalized.split("\n\n");
  const rawRemainder = blocks.pop() || "";
  const events = blocks.flatMap(extractSseDataPayloads).filter(Boolean);
  const partial = splitCompleteSseRemainder(rawRemainder);
  return {
    events: events.concat(partial.events),
    remainder: partial.remainder,
  };
}

function detectStreamFormat(chunk: string): boolean | null {
  const normalized = normalizeLineEndings(chunk);
  if (/(^|\n)\s*data\s*:/i.test(normalized)) {
    return true;
  }
  // Some proxies (for example chatgpt2api) open SSE with a comment such as
  // ": stream-open" before the first data event. Treat this as SSE and keep
  // buffering instead of permanently falling back to JSON-lines mode.
  if (/(^|\n)\s*:/.test(normalized)) {
    return true;
  }
  const trimmed = normalized.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return false;
  }
  return null;
}

interface ParsedResponse {
  content: string;
  fullText?: boolean;
  finished: boolean;
  finishReason?: string | null;
  error?: string;
}

type StreamContentMode = "unknown" | "delta" | "cumulative";

interface StreamContentState {
  mode: StreamContentMode;
}

function appendStreamContent(
  current: string,
  incoming: string,
  fullText = false,
  state: StreamContentState,
): string {
  if (!incoming) {
    return current;
  }
  if (fullText) {
    state.mode = "cumulative";
    return !current || incoming.length >= current.length ? incoming : current;
  }
  if (!current) {
    state.mode = state.mode === "cumulative" ? state.mode : "delta";
    return incoming;
  }
  if (state.mode === "cumulative") {
    if (incoming === current || current.startsWith(incoming)) {
      return current;
    }
    return incoming.startsWith(current) || incoming.length >= current.length
      ? incoming
      : current;
  }
  // Detect proxies that put the accumulated answer in delta.content. Keep
  // ordinary delta chunks, including identical legitimate words, untouched.
  if (incoming.length > current.length && incoming.startsWith(current)) {
    state.mode = "cumulative";
    return incoming;
  }
  state.mode = "delta";
  return `${current}${incoming}`;
}

function extractTextFromContent(value: any): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return part?.text || part?.content || part?.input_text || "";
    })
    .filter(Boolean)
    .join("");
}

function parseStreamError(obj: any): string {
  const error = obj?.error;
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || error.detail || JSON.stringify(error);
}

/**
 * Detect if the endpoint URL is for OpenAI Responses API
 */
function isResponsesApiEndpoint(url: string): boolean {
  return url.endsWith("/responses") || url.includes("/responses?");
}

/**
 * Parse streaming response for OpenAI Responses API
 * Event format: { "type": "response.output_text.delta", "delta": "text", ... }
 */
function parseResponsesApiStreamResponse(obj: any): ParsedResponse {
  const eventType = obj.type || "";
  const error = parseStreamError(obj);
  if (error || eventType === "error" || eventType === "response.failed") {
    return {
      content: "",
      finished: true,
      finishReason: error ? `error: ${error}` : eventType,
      error,
    };
  }

  // Text delta event - this is the main event for streaming text
  // Format: { "type": "response.output_text.delta", "delta": "In", ... }
  if (eventType === "response.output_text.delta") {
    return {
      content: obj.delta || "",
      finished: false,
      finishReason: null,
    };
  }

  // Completion events
  if (
    eventType === "response.completed" ||
    eventType === "response.done" ||
    eventType === "response.failed" ||
    eventType === "response.incomplete"
  ) {
    return {
      content: "",
      finished: true,
      finishReason: eventType,
    };
  }

  // Other events we don't need to extract content from:
  // response.created, response.in_progress, response.output_item.added,
  // response.content_part.added, response.output_text.done, etc.
  return { content: "", finished: false, finishReason: null };
}

/**
 * Parse non-streaming response for OpenAI Responses API
 * Response format: { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
 */
function parseResponsesApiNonStreamResponse(obj: any): string {
  if (obj.output && Array.isArray(obj.output)) {
    for (const item of obj.output) {
      if (item.type === "message" && item.content) {
        for (const content of item.content) {
          if (content.type === "output_text") {
            return content.text || "";
          }
        }
      }
    }
  }
  return "";
}

function parseStreamResponse(obj: any): ParsedResponse {
  const error = parseStreamError(obj);
  if (error) {
    return {
      content: "",
      finished: true,
      finishReason: `error: ${error}`,
      error,
    };
  }

  // Handle Anthropic format (stream events carry a type field)
  if (typeof obj.type === "string" && !obj.choices && !obj.candidates) {
    if (obj.type === "content_block_delta") {
      return {
        content: obj.delta?.text || "",
        finished: false,
        finishReason: null,
      };
    }
    if (obj.type === "message_stop") {
      return { content: "", finished: true, finishReason: "stop" };
    }
    if (obj.type === "message_delta" && obj.delta?.stop_reason) {
      return {
        content: "",
        finished: true,
        finishReason: obj.delta.stop_reason,
      };
    }
    return { content: "", finished: false, finishReason: null };
  }

  // Handle OpenAI format (choices array with delta)
  if (obj.choices && obj.choices[0]) {
    const choice = obj.choices[0];
    const delta = choice.delta || {};
    const message = choice.message || {};
    const hasDeltaContent =
      delta.content !== undefined && delta.content !== null;
    const hasMessageContent =
      message.content !== undefined && message.content !== null;
    const hasChoiceText = choice.text !== undefined && choice.text !== null;
    const content = hasDeltaContent
      ? extractTextFromContent(delta.content)
      : hasMessageContent
        ? extractTextFromContent(message.content)
        : hasChoiceText
          ? extractTextFromContent(choice.text)
          : "";
    return {
      content,
      fullText: hasMessageContent && !hasDeltaContent,
      finished:
        choice.finish_reason !== undefined && choice.finish_reason !== null,
      finishReason: choice.finish_reason ?? null,
    };
  }
  // Handle Gemini native chunks that may be forwarded by Gemini proxies.
  else if (Array.isArray(obj.candidates)) {
    let content = "";
    for (const candidate of obj.candidates) {
      const parts = Array.isArray(candidate?.content?.parts)
        ? candidate.content.parts
        : [];
      for (const part of parts) {
        if (!part?.thought && typeof part?.text === "string") {
          content += part.text;
        }
      }
    }
    return {
      content,
      finished: obj.candidates.some(
        (candidate: any) => !!candidate.finishReason,
      ),
      finishReason:
        obj.candidates.find((candidate: any) => !!candidate.finishReason)
          ?.finishReason ?? null,
    };
  }
  // Handle Ollama native format (direct message)
  else if (obj.message) {
    return {
      content: obj.message.content || "",
      finished: obj.done === true,
      finishReason: obj.done_reason ?? (obj.done === true ? "done" : null),
    };
  }
  return { content: "", finished: false, finishReason: null };
}

function parseNonStreamResponse(obj: any): string {
  // Handle Anthropic format (content blocks; thinking blocks are skipped)
  if (Array.isArray(obj.content)) {
    const textBlock = obj.content.find(
      (block: { type?: string; text?: string }) => block.type === "text",
    );
    return textBlock?.text || "";
  }
  // Handle OpenAI format (choices array)
  if (obj.choices && obj.choices[0]) {
    return (
      extractTextFromContent(obj.choices[0].message?.content) ||
      extractTextFromContent(obj.choices[0].text) ||
      ""
    );
  }
  // Handle Ollama native format (direct message)
  else if (obj.message && obj.message.content) {
    return obj.message.content;
  }
  return "";
}

function parseCompleteStreamText(
  responseText: string,
  useResponsesApi: boolean,
): { result: string; finishReason: string | null } {
  const normalized = normalizeLineEndings(responseText || "");
  const looksLikeSse = normalized.includes("data:");
  const events = looksLikeSse
    ? parseSseEvents(normalized).events
    : normalized
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

  let result = "";
  const contentState: StreamContentState = { mode: "unknown" };
  let finishReason: string | null = null;
  let streamError = "";
  for (const event of events) {
    if (!event || event === "[DONE]") {
      continue;
    }
    try {
      const obj = JSON.parse(event);
      if (
        useResponsesApi &&
        obj?.type === "response.output_text.done" &&
        typeof obj.text === "string" &&
        obj.text.length >= result.length
      ) {
        result = obj.text;
        continue;
      }
      const {
        content,
        fullText,
        finished,
        finishReason: parsedFinishReason,
      } = useResponsesApi
        ? parseResponsesApiStreamResponse(obj)
        : parseStreamResponse(obj);
      result = appendStreamContent(result, content, fullText, contentState);
      if (parsedFinishReason?.startsWith("error:")) {
        streamError = parsedFinishReason;
      }
      if (finished) {
        finishReason = parsedFinishReason || finishReason;
      }
    } catch {
      continue;
    }
  }
  return { result, finishReason: streamError || finishReason };
}

function getXhrResponseText(xhr: XMLHttpRequest): string {
  const responseText = (xhr as any)?.responseText;
  if (typeof responseText === "string") {
    return responseText;
  }
  const response = (xhr as any)?.response;
  return typeof response === "string" ? response : "";
}

function parseCompleteResponseText(
  responseText: string,
  useResponsesApi: boolean,
  streamMode: boolean,
): string {
  if (!responseText) {
    return "";
  }
  if (streamMode) {
    return trimTrailingLineBreaks(
      parseCompleteStreamText(responseText, useResponsesApi).result.replace(
        /^\n\n/,
        "",
      ),
    );
  }
  try {
    const responseObj = JSON.parse(responseText);
    const resultContent = useResponsesApi
      ? parseResponsesApiNonStreamResponse(responseObj)
      : parseNonStreamResponse(responseObj);
    return trimTrailingLineBreaks(resultContent.replace(/^\n\n/, ""));
  } catch {
    return "";
  }
}

const gptTranslate = async function (
  apiURL: string,
  model: string,
  temperature: number,
  prefix: string,
  data: Parameters<TranslateService["translate"]>[0],
  stream?: boolean,
  apiFormat?: string,
  thinkingLevel?: string,
) {
  function transformContent(
    langFrom: string,
    langTo: string,
    sourceText: string,
  ) {
    return transformPromptWithContext(
      `${prefix}.prompt`,
      langFrom,
      langTo,
      sourceText,
      data,
    );
  }

  const streamMode = stream !== false;
  const useAnthropicApi = apiFormat === "anthropic";
  const useResponsesApi = !useAnthropicApi && isResponsesApiEndpoint(apiURL);
  const rawSnapshot = data.raw;
  const receiveToken = getActiveReceiveToken();
  const canCommit = () =>
    isTaskSnapshotStillActive(data, rawSnapshot, receiveToken);

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });

  // Show a loading state before the first response chunk arrives.
  data.result = getString("status-translating");
  refreshHandler();

  /**
   * The requestObserver callback, under streaming mode
   * @param xmlhttp
   */
  const streamCallback = (
    xmlhttp: XMLHttpRequest,
    committedPrefix = "",
    onFinal?: (text: string) => void,
  ) => {
    let preLength = 0;
    let result = "";
    const contentState: StreamContentState = { mode: "unknown" };
    let lastEmittedResult = "";
    let buffer = ""; // Buffer to store incomplete JSON fragments
    let isSseStream: boolean | null = useResponsesApi ? true : null;
    let finishReason: string | null = null;
    let streamError = "";
    let rawStreamResponse = "";
    let lastProgressResponse = "";
    let progressResponseMode: "unknown" | "cumulative" | "chunked" = "unknown";
    const pendingEvents: string[] = [];
    let refreshFrame: number | null = null;
    let eventFlushFrame: number | null = null;

    const view = Zotero.getMainWindow?.();
    const scheduleFrame = (callback: () => void): number => {
      const raf = view?.requestAnimationFrame?.bind(view);
      if (raf) {
        return raf(callback) as unknown as number;
      }
      const setTimer = view?.setTimeout?.bind(view) ?? setTimeout;
      return setTimer(callback, 0) as unknown as number;
    };
    const cancelFrame = (frame: number | null) => {
      if (frame === null) {
        return;
      }
      if (typeof view?.cancelAnimationFrame === "function") {
        view.cancelAnimationFrame(frame);
        return;
      }
      const clearTimer = view?.clearTimeout?.bind(view) ?? clearTimeout;
      clearTimer(frame);
    };
    const stopQueuedWork = () => {
      cancelFrame(refreshFrame);
      cancelFrame(eventFlushFrame);
      refreshFrame = null;
      eventFlushFrame = null;
      pendingEvents.length = 0;
    };

    const queueRefresh = () => {
      if (refreshFrame !== null) {
        return;
      }
      refreshFrame = scheduleFrame(() => {
        refreshFrame = null;
        if (!canCommit()) {
          return;
        }
        refreshHandler();
      });
    };

    const emitResult = (force = false) => {
      if (!canCommit()) {
        ztoolkit.log("GPT stream skipped refresh because task is inactive", {
          taskId: data.id,
          activeTaskId: addon.data.translate.activeTaskId,
        });
        return;
      }
      const nextResult = trimTrailingLineBreaks(result.replace(/^\n\n/, ""));
      if (!force && nextResult === lastEmittedResult) {
        return;
      }
      if (!canCommit()) {
        ztoolkit.log(
          "GPT stream skipped refresh because task became inactive",
          {
            taskId: data.id,
            activeTaskId: addon.data.translate.activeTaskId,
          },
        );
        return;
      }
      data.result = `${committedPrefix}${nextResult}`;
      lastEmittedResult = nextResult;
      if (force) {
        cancelFrame(refreshFrame);
        refreshFrame = null;
        refreshHandler();
      } else {
        queueRefresh();
      }
    };

    const commitCompleteProgressResponse = (responseText: string): boolean => {
      const trimmed = responseText.trim();
      if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
        return false;
      }
      const completeResult = parseCompleteResponseText(
        responseText,
        useResponsesApi,
        false,
      );
      if (!completeResult || completeResult.length <= result.length) {
        return false;
      }
      result = completeResult;
      emitResult(false);
      return true;
    };

    const consumeStreamEvent = (
      event: string,
      isFinal: boolean,
      isLast: boolean,
    ) => {
      const data = event;
      if (!data.trim()) return;
      if (data.trim() === "[DONE]") return;

      try {
        const obj = JSON.parse(data);
        const {
          content,
          fullText,
          finished,
          finishReason: parsedFinishReason,
          error,
        } = useResponsesApi
          ? parseResponsesApiStreamResponse(obj)
          : parseStreamResponse(obj);

        result = appendStreamContent(result, content, fullText, contentState);
        if (error) {
          streamError = error;
        }
        if (finished) {
          finishReason = parsedFinishReason || finishReason;
        }
      } catch {
        if (!isFinal && isLast && !isSseStream) {
          buffer = data;
        } else if (isFinal && isSseStream) {
          buffer = "";
        }
      }
    };

    const flushPendingEvents = (force = false) => {
      if (force) {
        cancelFrame(eventFlushFrame);
      }
      eventFlushFrame = null;
      if (!canCommit()) {
        pendingEvents.length = 0;
        return;
      }
      const events = pendingEvents.splice(0);
      for (let i = 0; i < events.length; i++) {
        consumeStreamEvent(events[i], force, i === events.length - 1);
      }
      emitResult(force);
      if (pendingEvents.length) {
        queueEventFlush();
      }
    };

    const queueEventFlush = () => {
      if (eventFlushFrame !== null) {
        return;
      }
      eventFlushFrame = scheduleFrame(() => {
        eventFlushFrame = null;
        flushPendingEvents(false);
      });
    };

    const readProgressChunk = (xhr: XMLHttpRequest): string => {
      const currentResponse = getXhrResponseText(xhr);
      if (!currentResponse) {
        return "";
      }
      if (progressResponseMode === "chunked") {
        rawStreamResponse += currentResponse;
        lastProgressResponse = currentResponse;
        return currentResponse;
      }
      if (
        progressResponseMode === "cumulative" ||
        currentResponse.startsWith(lastProgressResponse)
      ) {
        const chunk = currentResponse.slice(lastProgressResponse.length);
        progressResponseMode = "cumulative";
        lastProgressResponse = currentResponse;
        rawStreamResponse = currentResponse;
        return chunk;
      }
      progressResponseMode = "chunked";
      rawStreamResponse += currentResponse;
      lastProgressResponse = currentResponse;
      return currentResponse;
    };

    const consumeChunk = (chunk: string, isFinal: boolean) => {
      if (isSseStream === null) {
        isSseStream = detectStreamFormat(buffer + chunk);
        if (isSseStream === null) {
          buffer += chunk;
          return;
        }
      }

      if (!chunk && !buffer) {
        return;
      }

      const fullResponse = buffer + chunk;
      let dataArray: string[] = [];

      if (isSseStream) {
        const { events, remainder } = parseSseEvents(fullResponse);
        dataArray = events;
        buffer = remainder;
      } else {
        dataArray = normalizeLineEndings(fullResponse)
          .split("\n")
          .filter((line: string) => line.trim());
        buffer = "";
      }

      if (isFinal) {
        for (let i = 0; i < dataArray.length; i++) {
          consumeStreamEvent(dataArray[i], true, i === dataArray.length - 1);
        }
      } else if (dataArray.length) {
        for (const event of dataArray) {
          pendingEvents.push(event);
        }
        queueEventFlush();
      }

      if (isFinal && isSseStream && buffer.trim()) {
        const trailingEvent = buffer
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s*/, ""))
          .join("\n")
          .trim();
        buffer = "";
        if (trailingEvent && trailingEvent !== "[DONE]") {
          try {
            const obj = JSON.parse(trailingEvent);
            const {
              content,
              fullText,
              finished,
              finishReason: parsedFinishReason,
              error,
            } = useResponsesApi
              ? parseResponsesApiStreamResponse(obj)
              : parseStreamResponse(obj);
            result = appendStreamContent(
              result,
              content,
              fullText,
              contentState,
            );
            if (error) {
              streamError = error;
            }
            if (finished) {
              finishReason = parsedFinishReason || finishReason;
            }
          } catch {
            // ignore malformed trailing event
          }
        }
      }
    };
    xmlhttp.onprogress = (e: any) => {
      if (!canCommit()) {
        stopQueuedWork();
        ztoolkit.log("GPT stream ignored chunk because task is inactive", {
          taskId: data.id,
          activeTaskId: addon.data.translate.activeTaskId,
          responseLength: e.target.response.length,
          previousLength: preLength,
        });
        return;
      }
      if (e.target.timeout) {
        e.target.timeout = 0;
      }
      const newResponse = readProgressChunk(e.target as XMLHttpRequest);
      consumeChunk(newResponse, false);
      commitCompleteProgressResponse(
        getXhrResponseText(e.target as XMLHttpRequest),
      );

      preLength = getXhrResponseText(e.target as XMLHttpRequest).length;

      if (!pendingEvents.length) {
        emitResult(false);
      }
    };

    xmlhttp.onreadystatechange = () => {
      if (xmlhttp.readyState >= 2 && xmlhttp.timeout) {
        xmlhttp.timeout = 0;
      }
    };

    xmlhttp.onloadend = () => {
      if (!canCommit()) {
        stopQueuedWork();
        return;
      }
      const responseText = getXhrResponseText(xmlhttp);
      const trailingResponse =
        progressResponseMode === "cumulative"
          ? responseText.slice(preLength)
          : "";
      // Progress events are parsed on animation frames. Drain events that
      // arrived earlier before consuming the final response tail, otherwise a
      // tail received between two frames can be committed ahead of it.
      flushPendingEvents(true);
      consumeChunk(trailingResponse, true);
      preLength = responseText.length;
      const completeResponse = rawStreamResponse || responseText;
      const replayed = parseCompleteStreamText(
        completeResponse,
        useResponsesApi,
      );
      if (replayed.result.length >= result.length) {
        result = replayed.result;
        finishReason = replayed.finishReason || finishReason;
      }
      const finalResult = trimTrailingLineBreaks(result.replace(/^\n\n/, ""));
      if (finalResult) {
        result = streamError
          ? `${finalResult}\n\n${getString("service-errorPrefix")} GPT stream error: ${streamError}`
          : finalResult;
        emitResult(true);
        onFinal?.(trimTrailingLineBreaks(result.replace(/^\n\n/, "")));
      }
      if (
        finishReason &&
        !["stop", "done", "response.completed", "response.done"].includes(
          finishReason,
        )
      ) {
        ztoolkit.log("GPT stream finished before natural stop", finishReason);
      }
      stopQueuedWork();
    };
  };

  /**
   * The requestObserver callback, under non-streaming mode
   * @param xmlhttp
   */
  const nonStreamCallback = (
    xmlhttp: XMLHttpRequest,
    committedPrefix = "",
    onFinal?: (text: string) => void,
  ) => {
    // Non-streaming logic: Handle the complete response at once
    xmlhttp.onload = () => {
      if (!canCommit()) {
        return;
      }
      // console.debug("GPT response received");
      try {
        const responseObj = JSON.parse(xmlhttp.responseText);
        const resultContent = useResponsesApi
          ? parseResponsesApiNonStreamResponse(responseObj)
          : parseNonStreamResponse(responseObj);
        const finalResult = trimTrailingLineBreaks(
          resultContent.replace(/^\n\n/, ""),
        );
        data.result = `${committedPrefix}${finalResult}`;
        onFinal?.(finalResult);
      } catch (error) {
        // throw `Failed to parse response: ${error}`;
        return;
      }

      // Trigger UI updates after receiving the full response
      refreshHandler();
    };
  };

  const buildRequestBody = (sourceText: string) => {
    const thinkingParams = useAnthropicApi
      ? {}
      : buildThinkingParams(apiURL, model, thinkingLevel ?? "default");
    const customParams = getCustomParams(prefix, Object.keys(thinkingParams));
    const hasCustomTokenLimit = TOKEN_LIMIT_PARAM_KEYS.some(
      (key) => customParams[key] !== undefined,
    );
    const tokenLimitParams = hasCustomTokenLimit
      ? {}
      : useResponsesApi
        ? { max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS }
        : { max_tokens: DEFAULT_MAX_OUTPUT_TOKENS };

    if (useAnthropicApi) {
      return {
        model: model,
        messages: [
          {
            role: "user",
            content: transformContent(data.langfrom, data.langto, sourceText),
          },
        ],
        ...(modelSupportsTemperature(model) && !Number.isNaN(temperature)
          ? { temperature }
          : {}),
        stream: streamMode,
        ...tokenLimitParams,
        ...customParams,
      };
    }

    return useResponsesApi
      ? {
          model: model,
          input: transformContent(data.langfrom, data.langto, sourceText),
          temperature: temperature,
          stream: streamMode,
          ...thinkingParams,
          ...tokenLimitParams,
          ...customParams,
        }
      : {
          model: model,
          messages: [
            {
              role: "user",
              content: transformContent(data.langfrom, data.langto, sourceText),
            },
          ],
          temperature: temperature,
          stream: streamMode,
          ...thinkingParams,
          ...tokenLimitParams,
          ...customParams,
        };
  };

  const requestOnce = async (sourceText: string, committedPrefix = "") => {
    let finalSegment = "";
    const requestHeaders = {
      Accept: streamMode ? "text/event-stream" : "application/json",
      ...(useAnthropicApi
        ? {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": data.secret,
          }
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.secret}`,
            "api-key": data.secret,
          }),
      ...getCustomHeaders(prefix),
    };
    const xhr = await Zotero.HTTP.request("POST", apiURL, {
      headers: requestHeaders,
      body: JSON.stringify(buildRequestBody(sourceText)),
      responseType: "text",
      requestObserver: (xmlhttp: XMLHttpRequest) => {
        registerActiveRequest(xmlhttp);
        if (streamMode) {
          streamCallback(xmlhttp, committedPrefix, (text) => {
            finalSegment = text;
          });
        } else {
          nonStreamCallback(xmlhttp, committedPrefix, (text) => {
            finalSegment = text;
          });
        }
      },
    });
    if (xhr?.status !== 200) {
      throw `Request error: ${xhr?.status}`;
    }
    const replayedFinalSegment = parseCompleteResponseText(
      getXhrResponseText(xhr),
      useResponsesApi,
      streamMode,
    );
    if (replayedFinalSegment.length >= finalSegment.length) {
      finalSegment = replayedFinalSegment;
    }
    if (finalSegment && canCommit()) {
      data.result = `${committedPrefix}${trimTrailingLineBreaks(finalSegment)}`;
      refreshHandler();
    }
    return finalSegment;
  };

  const committedResult = await requestOnce(data.raw);
  if (committedResult && canCommit()) {
    data.result = trimTrailingLineBreaks(committedResult);
    refreshHandler();
  }
  // data.result = xhr.response.choices[0].message.content.substr(2);
};

function createGPTService(id: ID): TranslateService {
  const checkSecret = id === "azuregpt" || id === "chatgpt";

  // For compatibility reasons, in older versions, the preference key was `chatGPT`, rather than matching the ID.
  // Additionally, customGPT was not initialized in prefs.js.
  const prefPrefix = id.replace("gpt", "GPT") as GPTPrefPrefix;

  return {
    id,
    type: "sentence",
    helpUrl:
      id === "azuregpt"
        ? "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference#chat-completions"
        : "https://gist.github.com/GrayXu/f1b72353b4b0493d51d47f0f7498b67b",

    ...(checkSecret && {
      defaultSecret: "",
      secretValidator(secret: string) {
        if (id === "chatgpt") {
          const status = /^sk-[A-Za-z0-9_-]{32,}$/.test(secret);
          const empty = secret.length === 0;
          return {
            secret,
            status,
            info: empty
              ? "The secret is not set."
              : status
                ? "Click the button to check connectivity."
                : "The secret key format is invalid.",
          };
        }

        if (id === "azuregpt") {
          const flag = Boolean(secret);
          return {
            secret,
            status: flag,
            info: flag ? "" : "The secret is not set.",
          };
        }

        const status = secret.length > 0;
        return {
          secret,
          status,
          info: status
            ? "Click the button to check connectivity."
            : "The secret key format is invalid.",
        };
      },
    }),

    async translate(data) {
      switch (id) {
        case "azuregpt": {
          const endPoint = getPref("azureGPT.endPoint") as string;
          const apiVersion = getPref("azureGPT.apiVersion");
          const model = getPref("azureGPT.model") as string;
          const temperature = parseFloat(
            getPref("azureGPT.temperature") as string,
          );
          const stream = getPref("azureGPT.stream") !== false;
          const thinkingLevel = getPref("azureGPT.thinkingLevel") as string;

          const apiURL = new URL(endPoint);
          apiURL.pathname = `/openai/deployments/${model}/chat/completions`;
          apiURL.search = `api-version=${apiVersion}`;

          return await gptTranslate(
            apiURL.href,
            model,
            temperature,
            "azureGPT",
            data,
            stream,
            undefined,
            thinkingLevel,
          );
        }

        case "chatgpt": {
          const apiURL = normalizeLLMEndpoint(
            getPref(`${prefPrefix}.endPoint`) as string,
          );
          const model = getPref(`${prefPrefix}.model`) as string;
          const temperature = parseFloat(
            getPref(`${prefPrefix}.temperature`) as string,
          );
          const stream = getPref(`${prefPrefix}.stream`) !== false;
          const thinkingLevel = getPref(
            `${prefPrefix}.thinkingLevel`,
          ) as string;

          return await gptTranslate(
            apiURL,
            model,
            temperature,
            prefPrefix,
            data,
            stream,
            undefined,
            thinkingLevel,
          );
        }

        default: {
          // Custom GPT services (customgpt<N>). Ensure runtime defaults
          // exist for services beyond the predefined customGPT1..20.
          if (id.startsWith("customgpt")) {
            ensureCustomGPTDefaults(prefPrefix);
            const apiFormat =
              (getPref(`${prefPrefix}.apiFormat`) as string) || "openai";
            const apiURL = normalizeLLMEndpoint(
              getPref(`${prefPrefix}.endPoint`) as string,
              apiFormat,
            );
            const model = getPref(`${prefPrefix}.model`) as string;
            const temperature = parseFloat(
              getPref(`${prefPrefix}.temperature`) as string,
            );
            const stream = getPref(`${prefPrefix}.stream`) !== false;
            const thinkingLevel = getPref(
              `${prefPrefix}.thinkingLevel`,
            ) as string;

            return await gptTranslate(
              apiURL,
              model,
              temperature,
              prefPrefix,
              data,
              stream,
              apiFormat,
              thinkingLevel,
            );
          }
          break;
        }
      }
    },

    config(settings) {
      // Ensure runtime defaults exist for Custom GPT services beyond the
      // predefined customGPT1..20, so the config dialog has values to edit.
      if (id.startsWith("customgpt")) {
        ensureCustomGPTDefaults(prefPrefix);
      }
      const servicePrefix = id === "azuregpt" ? "azuregpt" : "chatgpt";

      settings
        .addTextSetting({
          prefKey: `${prefPrefix}.endPoint`,
          nameKey: `service-${servicePrefix}-dialog-endPoint`,
        })
        .addTextSetting({
          prefKey: `${prefPrefix}.model`,
          nameKey: `service-${servicePrefix}-dialog-model`,
        })
        .addNumberSetting({
          prefKey: `${prefPrefix}.temperature`,
          nameKey: `service-${servicePrefix}-dialog-temperature`,
          min: 0,
          max: 2,
          step: 0.1,
        });

      if (
        id === "azuregpt" &&
        prefPrefix === "azureGPT" &&
        servicePrefix === "azuregpt"
      ) {
        settings.addTextSetting({
          prefKey: `${prefPrefix}.apiVersion`,
          nameKey: `service-${servicePrefix}-dialog-apiVersion`,
          hidden: id !== "azuregpt",
        });
      }

      if (id.startsWith("customgpt")) {
        settings
          .addSelectSetting({
            prefKey: `${prefPrefix as `customGPT${number}`}.apiFormat`,
            nameKey: "service-chatgpt-dialog-apiFormat",
            options: [
              {
                value: "openai",
                label: getString("service-dialog-api-format-openai"),
              },
              {
                value: "anthropic",
                label: getString("service-dialog-api-format-anthropic"),
              },
            ],
          })
          .addStaticRow("", {
            tag: "div",
            namespace: "html",
            styles: {
              color: "var(--fill-secondary)",
              fontSize: "0.9em",
              maxWidth: "400px",
            },
            properties: {
              textContent: getString("service-gpt-dialog-apiFormat-hint"),
            },
          });
      }

      settings
        .addTextAreaSetting({
          prefKey: `${prefPrefix}.prompt`,
          nameKey: `service-${servicePrefix}-dialog-prompt`,
          placeholder: getString(`service-${servicePrefix}-dialog-prompt`),
        })
        .addStaticRow("", {
          tag: "div",
          namespace: "html",
          styles: {
            color: "var(--fill-secondary)",
            fontSize: "0.9em",
            maxWidth: "400px",
          },
          properties: {
            textContent: getString("service-gpt-dialog-prompt-hint", {
              args: {
                variables: "${langFrom}, ${langTo}, ${sourceText}",
                required: "${sourceText}",
              },
            }),
          },
        })
        .addCheckboxSetting({
          prefKey: `${prefPrefix}.stream`,
          nameKey: `service-${servicePrefix}-dialog-stream`,
        })
        .addSelectSetting({
          prefKey: `${prefPrefix}.thinkingLevel`,
          nameKey: `service-${servicePrefix}-dialog-thinkingLevel`,
          options: getThinkingLevelOptions(),
        })
        .addStaticRow("", {
          tag: "div",
          namespace: "html",
          styles: {
            color: "var(--fill-secondary)",
            fontSize: "0.9em",
            maxWidth: "400px",
          },
          properties: {
            textContent: getString("service-gpt-dialog-thinkingLevel-hint"),
          },
        })
        .addCustomParamsSetting({
          prefKey: `${prefPrefix}.customParams`,
          nameKey: `service-${servicePrefix}-dialog-custom-request`,
          desc: getString(
            `service-${servicePrefix}-dialog-custom-request-description`,
          ),
        })
        .addCustomHeadersSetting({
          prefKey: `${prefPrefix}.customHeaders`,
          nameKey: `service-${servicePrefix}-dialog-custom-headers`,
        });
    },
  };
}

export const ChatGPT = createGPTService("chatgpt");
export const azureGPT = createGPTService("azuregpt");

/**
 * Generate the full pool of Custom GPT services up to the maximum count.
 * The number of services actually exposed to the user is controlled by the
 * `customGPTCount` pref and filtered at read-time in TranslationServices.
 */
export const customGPTServices: TranslateService[] = Array.from(
  { length: CUSTOM_GPT_MAX_COUNT },
  (_, index) => createGPTService(`customgpt${index + 1}` as ID),
);
