import { aesEcbEncrypt, base64 } from "../../utils/crypto";
import {
  getActiveReceiveToken,
  isTaskSnapshotStillActive,
  registerActiveRequest,
} from "../../utils";
import { getPref, getPrefJSON, setPref } from "../../utils/prefs";
import { TranslateService } from "./base";

const CNKI_MAX_CHUNK_CHARS = 800;
const CNKI_CONCURRENCY = 3;
const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

function splitParagraphIntoChunks(paragraph: string): string[] {
  const trimmed = paragraph.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= CNKI_MAX_CHUNK_CHARS) {
    return [trimmed];
  }

  const sentences = trimmed
    .split(/(?<=[.?!。！？])\s+(?=[A-Z0-9\u4e00-\u9fff("'[\u201c])/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const pushOversizedSentence = (sentence: string) => {
    let remaining = sentence;
    while (remaining.length > CNKI_MAX_CHUNK_CHARS) {
      let cut = remaining.lastIndexOf(" ", CNKI_MAX_CHUNK_CHARS);
      if (cut < CNKI_MAX_CHUNK_CHARS * 0.5) {
        cut = CNKI_MAX_CHUNK_CHARS;
      }
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) {
      current = remaining;
    }
  };

  for (const sentence of sentences) {
    if (sentence.length > CNKI_MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      pushOversizedSentence(sentence);
      continue;
    }

    if (
      current &&
      current.length + 1 + sentence.length > CNKI_MAX_CHUNK_CHARS
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

function joinTranslatedParts(parts: string[]): string {
  let out = "";
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
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

const translate = <TranslateService["translate"]>async function (data) {
  let progressWindow;
  const useSplit = getPref("cnkiUseSplit") as boolean;
  const rawSnapshot = data.raw;
  const receiveToken = getActiveReceiveToken();
  const canCommit = () =>
    isTaskSnapshotStillActive(data, rawSnapshot, receiveToken);

  if (!data.silent) {
    progressWindow = new ztoolkit.ProgressWindow("PDF Translate");
  }

  const cnkiRegexStr = (getPref("cnkiRegex") as string) || "";
  const cnkiRegex = cnkiRegexStr ? new RegExp(cnkiRegexStr, "g") : null;

  const processTranslation = async (
    text: string,
    allowTokenRetry = true,
  ): Promise<string> => {
    const token = await getToken();
    const xhr = await Zotero.HTTP.request(
      "POST",
      "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation",
      {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Token: token,
        },
        body: JSON.stringify({
          words: await getWord(text),
          translateType: null,
        }),
        responseType: "json",
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          registerActiveRequest(xmlhttp);
        },
      },
    );

    if (xhr?.status !== 200) {
      throw `Request error: ${xhr?.status}`;
    }

    const res = xhr.response;
    if (res?.data?.isInputVerificationCode) {
      throw "Your access is temporarily banned by the CNKI service. Please goto https://dict.cnki.net/, translate manually and pass human verification.";
    }

    if (typeof res?.data?.mResult !== "string") {
      if (allowTokenRetry) {
        await getToken(true);
        if (!canCommit()) {
          return "";
        }
        return processTranslation(text, false);
      }
      throw `Service error: ${JSON.stringify(res)}`;
    }

    let tgt = res.data.mResult as string;
    if (cnkiRegex) {
      tgt = tgt.replace(cnkiRegex, "");
    }
    return tgt.trim();
  };

  let sourceText = data.raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!useSplit && sourceText.length > CNKI_MAX_CHUNK_CHARS) {
    progressWindow
      ?.createLine({
        text: `Maximum text length is ${CNKI_MAX_CHUNK_CHARS}, ${sourceText.length} selected. Will only translate first ${CNKI_MAX_CHUNK_CHARS} characters. If you want the plugin to automatically split the translation based on punctuation, you can enable the split switch in the preferences.`,
      })
      .show();
    sourceText = sourceText.slice(0, CNKI_MAX_CHUNK_CHARS);
    data.raw = sourceText;
  }

  const paragraphs = sourceText
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) {
    data.result = "";
    return;
  }

  // Ensure token is ready once before concurrent chunk translation.
  await getToken();
  if (!canCommit()) {
    return;
  }

  const paragraphChunkGroups = paragraphs.map((para) =>
    useSplit ? splitParagraphIntoChunks(para) : [para],
  );
  const flatChunks: Array<{
    paraIndex: number;
    chunkIndex: number;
    text: string;
  }> = [];
  paragraphChunkGroups.forEach((chunks, paraIndex) => {
    chunks.forEach((text, chunkIndex) => {
      flatChunks.push({ paraIndex, chunkIndex, text });
    });
  });

  const translatedGroups: string[][] = paragraphChunkGroups.map((chunks) =>
    new Array<string>(chunks.length).fill(""),
  );

  let nextIdx = 0;
  const workerCount = Math.min(CNKI_CONCURRENCY, flatChunks.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIdx < flatChunks.length) {
        if (!canCommit()) {
          return;
        }
        const job = flatChunks[nextIdx++];
        const translated = await processTranslation(job.text);
        if (!canCommit()) {
          return;
        }
        translatedGroups[job.paraIndex][job.chunkIndex] = translated;
      }
    }),
  );

  if (!canCommit()) {
    return;
  }

  data.result = translatedGroups
    .map((parts) => joinTranslatedParts(parts))
    .filter(Boolean)
    .join("\n")
    .trim();
};

export async function getToken(forceRefresh: boolean = false) {
  let token = "";
  let doRefresh = true;
  try {
    const tokenObj = getPrefJSON("cnkiToken");
    if (
      !forceRefresh &&
      tokenObj?.token &&
      new Date().getTime() - tokenObj.t < 300 * 1000
    ) {
      token = tokenObj.token;
      doRefresh = false;
    }
  } catch (e) {
    ztoolkit.log(e);
  }
  if (doRefresh) {
    const xhr = await Zotero.HTTP.request(
      "GET",
      "https://dict.cnki.net/fyzs-front-api/getToken",
      {
        responseType: "json",
      },
    );
    if (xhr && xhr.response && xhr.response.code === 200 && xhr.response.data) {
      token = xhr.response.data;
      setPref(
        "cnkiToken",
        JSON.stringify({
          t: new Date().getTime(),
          token,
        }),
      );
    }
  }
  return token;
}

export async function getWord(text: string) {
  const encrypted = await aesEcbEncrypt(text, "4e87183cfd3a45fe");
  const base64str = base64(encrypted.buffer);
  return base64str.replace(/\//g, "_").replace(/\+/g, "-");
}

export const Cnki: TranslateService = {
  id: "cnki",
  type: "sentence",

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "cnkiRegex",
        nameKey: "service-cnki-dialog-regex",
      })
      .addCheckboxSetting({
        prefKey: "cnkiUseSplit",
        nameKey: "service-cnki-dialog-split",
      });
  },
};
