import { getPref } from "../../utils/prefs";
import { TranslateService } from "./base";

const GLOSSARY_SEPARATORS = ["=>", "->", "\t", "=", ":"] as const;
const GLOSSARY_MAX_ITEMS = 200;
const GLOSSARY_TOKEN_PREFIX = "__ZPT_DEEPLCUSTOM_GLOSSARY_";
const GLOSSARY_TOKEN_SUFFIX = "__";

type GlossaryEntry = {
  source: string;
  target: string;
};

function parseGlossaryEntries(rawGlossary: string): GlossaryEntry[] {
  return rawGlossary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"))
    .map((line) => {
      const separator = GLOSSARY_SEPARATORS.find((sep) => line.includes(sep));
      if (!separator) {
        return null;
      }
      const [sourceRaw, ...targetParts] = line.split(separator);
      const source = sourceRaw.trim();
      const target = targetParts.join(separator).trim();
      if (!source || !target) {
        return null;
      }
      return { source, target };
    })
    .filter((entry): entry is GlossaryEntry => Boolean(entry))
    .slice(0, GLOSSARY_MAX_ITEMS);
}

function applyGlossaryToSourceText(
  sourceText: string,
  glossaryEntries: GlossaryEntry[],
) {
  if (glossaryEntries.length === 0) {
    return {
      text: sourceText,
      restore(text: string) {
        return text;
      },
    };
  }

  const sortedEntries = [...glossaryEntries].sort(
    (a, b) => b.source.length - a.source.length,
  );

  let normalizedText = sourceText;
  const matchedTerms: Array<{ token: string; target: string }> = [];
  sortedEntries.forEach((entry, index) => {
    if (!normalizedText.includes(entry.source)) {
      return;
    }

    const token = `${GLOSSARY_TOKEN_PREFIX}${index}${GLOSSARY_TOKEN_SUFFIX}`;
    normalizedText = normalizedText.split(entry.source).join(token);
    matchedTerms.push({ token, target: entry.target });
  });

  return {
    text: normalizedText,
    restore(text: string) {
      let normalizedResult = text;
      matchedTerms.forEach((term) => {
        normalizedResult = normalizedResult.split(term.token).join(term.target);
      });
      return normalizedResult;
    },
  };
}

const translate = <TranslateService["translate"]>async function (data) {
  const glossaryEntries = parseGlossaryEntries(
    ((getPref("deeplcustom.glossary") as string) || "").trim(),
  );
  const glossaryInjectedText = applyGlossaryToSourceText(data.raw, glossaryEntries);

  const url = getPref("deeplcustom.endpoint") as string;
  const reqBody = JSON.stringify({
    text: glossaryInjectedText.text,
    source_lang: data.langfrom.split("-")[0].toUpperCase(),
    target_lang: data.langto.split("-")[0].toUpperCase(),
  });
  const xhr = await Zotero.HTTP.request("POST", url, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    responseType: "json",
    body: reqBody,
  });
  if (xhr?.status !== 200) {
    throw `Request error: ${xhr?.status}`;
  }
  const result = xhr.response.data;
  data.result =
    typeof result === "string" ? glossaryInjectedText.restore(result) : result;
};

export const DeepLCustom: TranslateService = {
  id: "deeplcustom",
  type: "sentence",
  helpUrl:
    "https://github.com/ramonmi/DeepLX-for-Zotero/blob/main/README_zh.md",

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "deeplcustom.endpoint",
        nameKey: "service-deeplcustom-dialog-endPoint",
      })
      .addTextAreaSetting({
        prefKey: "deeplcustom.glossary",
        nameKey: "service-deeplcustom-dialog-glossary",
        placeholder: "source => target (one pair per line)",
      });
  },

  requireExternalConfig: true,
};
