import {
  getActiveReceiveToken,
  isTaskSnapshotStillActive,
  registerActiveRequest,
} from "../../utils";
import { getPref } from "../../utils/prefs";
import { TranslateService } from "./base";

/** Validates an email address for MyMemory de (domain email) parameter. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (value: unknown): value is string =>
  typeof value === "string" && EMAIL_REGEX.test(value);

const MYMEMORY_MAX_CHUNK_CHARS = 450;
const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

function splitParagraphForMyMemory(paragraph: string): string[] {
  const trimmed = paragraph.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= MYMEMORY_MAX_CHUNK_CHARS) {
    return [trimmed];
  }

  const sentences = trimmed
    .split(/(?<=[.?!。！？])\s+(?=[A-Z0-9\u4e00-\u9fff("'[\u201c])/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const pushOversized = (sentence: string) => {
    let remaining = sentence;
    while (remaining.length > MYMEMORY_MAX_CHUNK_CHARS) {
      let cut = remaining.lastIndexOf(" ", MYMEMORY_MAX_CHUNK_CHARS);
      if (cut < MYMEMORY_MAX_CHUNK_CHARS * 0.5) {
        cut = MYMEMORY_MAX_CHUNK_CHARS;
      }
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) {
      current = remaining;
    }
  };

  for (const sentence of sentences) {
    if (sentence.length > MYMEMORY_MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      pushOversized(sentence);
      continue;
    }
    if (
      current &&
      current.length + 1 + sentence.length > MYMEMORY_MAX_CHUNK_CHARS
    ) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function joinParts(parts: string[]): string {
  let out = "";
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const prevEnd = out[out.length - 1];
    const currStart = part[0];
    if (CJK_CHAR_REGEX.test(prevEnd) || CJK_CHAR_REGEX.test(currStart)) {
      out += part;
    } else {
      out += ` ${part}`;
    }
  }
  return out.trim();
}

const translate: TranslateService["translate"] = async (data) => {
  const userEmail = getPref("mymemory.userEmail") as string;
  const isValidEmail = isEmail(userEmail);
  const deParam = isValidEmail ? `&de=${encodeURIComponent(userEmail)}` : "";
  const rawSnapshot = data.raw;
  const receiveToken = getActiveReceiveToken();
  const canCommit = () =>
    isTaskSnapshotStillActive(data, rawSnapshot, receiveToken);

  const toTitleCase = (text: string): string => {
    if (!text || text !== text.toUpperCase()) {
      return text;
    }
    return text.toLowerCase().replace(/(^|\s)\S/g, (ch) => ch.toUpperCase());
  };

  const processTranslation = async (text: string): Promise<string> => {
    const xhr = await Zotero.HTTP.request(
      "POST",
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${data.langfrom}|${data.langto}${deParam}`,
      {
        responseType: "json",
        successCodes: [200, 429, 403],
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          registerActiveRequest(xmlhttp);
        },
      },
    );

    if (xhr.status !== 200) {
      const res = xhr.response as { responseDetails?: string } | undefined;
      const detail = res?.responseDetails || `Request error: ${xhr.status}`;
      const readable = toTitleCase(detail);
      if (xhr.status === 429) {
        throw `${readable}\n\n💡Hint: MyMemory service has a daily quota of 5k characters per IP address. You can raise it to 50k by entering your email in Zotero Settings > Translate > Service > MyMemory > Config (fill in the email field).`;
      }
      throw readable;
    }

    return String(xhr.response?.responseData?.translatedText || "").trim();
  };

  const paragraphs = data.raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) {
    data.result = "";
    return;
  }

  const paragraphChunkGroups = paragraphs.map((p) =>
    splitParagraphForMyMemory(p),
  );
  const translatedGroups: string[][] = paragraphChunkGroups.map((chunks) =>
    new Array<string>(chunks.length).fill(""),
  );

  const flatJobs: Array<{
    paraIndex: number;
    chunkIndex: number;
    text: string;
  }> = [];
  paragraphChunkGroups.forEach((chunks, paraIndex) => {
    chunks.forEach((text, chunkIndex) => {
      flatJobs.push({ paraIndex, chunkIndex, text });
    });
  });

  for (let i = 0; i < flatJobs.length; i++) {
    if (!canCommit()) {
      return;
    }
    const job = flatJobs[i];
    translatedGroups[job.paraIndex][job.chunkIndex] = await processTranslation(
      job.text,
    );
    if (i < flatJobs.length - 1 && canCommit()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!canCommit()) {
    return;
  }

  data.result = translatedGroups
    .map((parts) => joinParts(parts))
    .filter(Boolean)
    .join("\n")
    .trim();
};

export const MyMemory: TranslateService = {
  id: "mymemory",
  type: "sentence",

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "mymemory.userEmail",
        nameKey: "service-mymemory-dialog-userEmail",
      })
      .onSave((dialogData) => {
        const email = dialogData["mymemory.userEmail"];
        if (email && !isEmail(email)) {
          return "Please enter a valid email address (e.g. name@example.com) or leave it empty.";
        }
        return true;
      });
  },
};
