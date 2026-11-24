import { getPrefJSON, setPref } from "../../utils/prefs";
import {
  getActiveReceiveToken,
  isTaskSnapshotStillActive,
  registerActiveRequest,
} from "../../utils";
import { TranslateService } from "./base";

const BING_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const BING_TOKEN_KEY = "bingToken";
const DEFAULT_TOKEN_EXP_MS = 30 * 60 * 1000;
const MAX_CHUNK_CHARS = 3800;

type BingSession = {
  baseUrl: string;
  ig: string;
  iid: string;
  key: string;
  token: string;
  exp: number;
  count: number;
};

let cachedSession: BingSession | null = null;

function mapBingLang(lang?: string): string {
  const value = String(lang || "").trim();
  if (!value) {
    return "auto-detect";
  }
  const lower = value.toLowerCase();
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-sg") {
    return "zh-Hans";
  }
  if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo") {
    return "zh-Hant";
  }
  if (lower === "fr-ca" || lower === "pt-pt") {
    return value;
  }
  if (lower.startsWith("pt-")) {
    return "pt";
  }
  if (lower === "sr-cyrl" || lower === "sr-latn") {
    return value;
  }
  return value.split("-")[0];
}

function splitTextForBing(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) {
    return [];
  }

  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (para.length > MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const sentences = para.split(/(?<=[.?!。！？])\s+/u);
      let piece = "";
      for (const sentence of sentences) {
        if (!sentence) continue;
        if (piece && piece.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
          chunks.push(piece);
          piece = sentence;
        } else {
          piece = piece ? `${piece} ${sentence}` : sentence;
        }
      }
      if (piece) {
        chunks.push(piece);
      }
      continue;
    }

    const sep = current ? "\n\n" : "";
    if (
      current &&
      current.length + sep.length + para.length > MAX_CHUNK_CHARS
    ) {
      chunks.push(current);
      current = para;
    } else {
      current = `${current}${sep}${para}`;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function getBingSession(forceRefresh = false): Promise<BingSession> {
  const now = Date.now();
  if (!forceRefresh && cachedSession && now < cachedSession.exp) {
    return cachedSession;
  }

  if (!forceRefresh) {
    try {
      const saved = getPrefJSON(BING_TOKEN_KEY) as Partial<BingSession> | null;
      if (
        saved &&
        saved.baseUrl &&
        saved.ig &&
        saved.key &&
        saved.token &&
        typeof saved.exp === "number" &&
        now < saved.exp
      ) {
        cachedSession = {
          baseUrl: saved.baseUrl,
          ig: saved.ig,
          iid: saved.iid || "translator.5023",
          key: String(saved.key),
          token: saved.token,
          exp: saved.exp,
          count: Number(saved.count) || 1,
        };
        return cachedSession;
      }
    } catch (e) {
      ztoolkit.log(e);
    }
  }

  const xhr = await Zotero.HTTP.request(
    "GET",
    "https://www.bing.com/translator",
    {
      headers: {
        "User-Agent": BING_USER_AGENT,
      },
      responseType: "text",
    },
  );
  if (xhr?.status !== 200 || !xhr.responseText) {
    throw `Request error: ${xhr?.status || "empty response"}`;
  }

  const html = xhr.responseText;
  let baseUrl = "https://www.bing.com";
  try {
    if (xhr.responseURL) {
      baseUrl = new URL(xhr.responseURL).origin;
    }
  } catch {
    // keep default
  }

  const ig = html.match(/IG:"([^"]+)"/)?.[1];
  const iid = html.match(/data-iid="([^"]+)"/)?.[1] || "translator.5023";
  const paramsMatch = html.match(
    /var params_AbusePreventionHelper = \[(\d+),"([^"]+)",(\d+)\]/,
  );
  if (!ig || !paramsMatch) {
    throw "Service error: Failed to parse Bing translator session token";
  }

  const [, key, token, expDurationStr] = paramsMatch;
  const expDuration = Math.min(
    Number(expDurationStr) || DEFAULT_TOKEN_EXP_MS,
    DEFAULT_TOKEN_EXP_MS,
  );
  cachedSession = {
    baseUrl,
    ig,
    iid,
    key,
    token,
    exp: now + Math.max(60 * 1000, expDuration - 60 * 1000),
    count: 1,
  };
  setPref(BING_TOKEN_KEY, JSON.stringify(cachedSession));
  return cachedSession;
}

async function requestBingTranslate(
  session: BingSession,
  fromLang: string,
  toLang: string,
  text: string,
) {
  const count = session.count++;
  const body = new URLSearchParams({
    fromLang,
    to: toLang,
    text,
    token: session.token,
    key: session.key,
  }).toString();

  const xhr = await Zotero.HTTP.request(
    "POST",
    `${session.baseUrl}/ttranslatev3?isVertical=1&&IG=${encodeURIComponent(session.ig)}&IID=${encodeURIComponent(session.iid)}.${count}`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": BING_USER_AGENT,
        Referer: `${session.baseUrl}/translator`,
        Origin: session.baseUrl,
      },
      body,
      responseType: "json",
      requestObserver: (xmlhttp: XMLHttpRequest) => {
        registerActiveRequest(xmlhttp);
      },
    },
  );
  if (xhr?.status !== 200) {
    throw `Request error: ${xhr?.status}`;
  }
  return xhr.response;
}

const translate: TranslateService["translate"] = async (data) => {
  const rawSnapshot = data.raw;
  const receiveToken = getActiveReceiveToken();
  const canCommit = () =>
    isTaskSnapshotStillActive(data, rawSnapshot, receiveToken);

  const fromLang = mapBingLang(data.langfrom);
  const toLang = mapBingLang(data.langto);
  const chunks = splitTextForBing(data.raw);
  if (!chunks.length) {
    data.result = "";
    return;
  }

  let session = await getBingSession();
  const translatedChunks: string[] = [];

  for (const chunk of chunks) {
    if (!canCommit()) {
      return;
    }
    let response = await requestBingTranslate(session, fromLang, toLang, chunk);
    if (
      response &&
      !Array.isArray(response) &&
      typeof response.statusCode === "number"
    ) {
      session = await getBingSession(true);
      if (!canCommit()) {
        return;
      }
      response = await requestBingTranslate(session, fromLang, toLang, chunk);
    }

    const translated = response?.[0]?.translations?.[0]?.text;
    if (typeof translated !== "string") {
      throw `Service error: ${JSON.stringify(response)}`;
    }
    translatedChunks.push(
      translated
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim(),
    );
  }

  if (!canCommit()) {
    return;
  }
  data.result = translatedChunks.join("\n").trim();
};

export const Bing: TranslateService = {
  id: "bing",
  type: "sentence",

  translate,
};
