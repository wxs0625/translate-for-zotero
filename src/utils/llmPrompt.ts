import { getPref } from "./prefs";
import { TranslateTask } from "./task";

type PromptTransformOptions = {
  appendSourceTextIfMissing?: boolean;
};

function applyPromptPlaceholders(
  prompt: string,
  langFrom: string,
  langTo: string,
): string {
  return prompt
    .replaceAll("${langFrom}", langFrom)
    .replaceAll("${langTo}", langTo);
}

function createCompleteTranslationInstruction(
  langFrom: string,
  langTo: string,
): string {
  return [
    `Translate the complete selected text from ${langFrom} to ${langTo}.`,
    "Do not summarize, shorten, omit, or stop after the first sentence/paragraph.",
    "Preserve citations, figure references, units, chemical formulas, and symbols.",
    "The output must contain only the full translation of every sentence in the selected text.",
  ].join("\n");
}

function createFinalOutputGuard(): string {
  return [
    "Final output rules:",
    "- Output only the translation text; do not add explanations, comments, labels, wrappers, or metadata.",
    "- Do not output paragraph-end marker words, delimiter words, custom separator tokens, XML/HTML-like paragraph tags, or any artificial paragraph markers.",
    "- Paragraph restoration is handled by the client. If paragraph breaks are needed, use only normal blank lines, never marker text.",
    "- Continue until the entire selected text is translated.",
  ].join("\n");
}

export function transformPromptWithContext(
  prefKey: string,
  langFrom: string,
  langTo: string,
  sourceText: string,
  data: Required<TranslateTask>,
  options: PromptTransformOptions = {},
): string {
  const { appendSourceTextIfMissing = true } = options;
  const prompt = (getPref(prefKey) as string) || "";
  const sourcePayload = sourceText;
  let contextPrompt = "";

  if (getPref("attachPaperContext") && data.itemId) {
    const item = Zotero.Items.get(data.itemId);
    const topItem = item ? Zotero.Items.getTopLevel([item])[0] : null;
    if (topItem) {
      let contextInfo = "";
      const title = topItem.getField("title") as string;
      const abstract = topItem.getField("abstractNote") as string;

      if (title) {
        contextInfo += `Paper Title: ${title}`;
      }
      if (abstract) {
        contextInfo += title
          ? `\n\nPaper Abstract: ${abstract}`
          : `Paper Abstract: ${abstract}`;
      }

      if (contextInfo) {
        contextPrompt =
          `Use the following paper metadata only as reference context for terminology and domain understanding.\n` +
          `Do not translate, summarize, quote, paraphrase, or include any part of this metadata in the output.\n` +
          `The final output must contain only the translation of the selected text.\n` +
          `<paper_context>\n${contextInfo}\n</paper_context>\n\n`;
      }
    }
  }

  const promptWithPlaceholders =
    contextPrompt +
    createCompleteTranslationInstruction(langFrom, langTo) +
    "\n\n" +
    applyPromptPlaceholders(prompt, langFrom, langTo) +
    "\n\n" +
    createFinalOutputGuard();
  const hasSourcePlaceholder = prompt.includes("${sourceText}");

  return hasSourcePlaceholder
    ? promptWithPlaceholders.replaceAll("${sourceText}", sourcePayload)
    : appendSourceTextIfMissing
      ? `${promptWithPlaceholders}\n\n${sourcePayload}`
      : promptWithPlaceholders;
}

/**
 * Split the prompt template into a system instruction and a user content.
 * Supports templates both with and without ${sourceText}.
 */
export function buildPromptParts(
  prefKey: string,
  langFrom: string,
  langTo: string,
  sourceText: string,
  data: Required<TranslateTask>,
): { system: string; user: string } {
  const prompt = (getPref(prefKey) as string) || "";
  const marker = "${sourceText}";
  const markerIndex = prompt.indexOf(marker);
  const before = markerIndex >= 0 ? prompt.slice(0, markerIndex) : prompt;
  const after =
    markerIndex >= 0 ? prompt.slice(markerIndex + marker.length) : "";

  let instruction = `${before.trimEnd()} ${after.trimStart()}`
    .replaceAll("${langFrom}", langFrom)
    .replaceAll("${langTo}", langTo)
    .trim();

  if (getPref("attachPaperContext") && data.itemId) {
    const item = Zotero.Items.get(data.itemId);
    const topItem = item ? Zotero.Items.getTopLevel([item])[0] : null;
    if (topItem) {
      let contextInfo = "";
      const title = topItem.getField("title") as string;
      const abstract = topItem.getField("abstractNote") as string;

      if (title) {
        contextInfo += `Paper Title: ${title}`;
      }
      if (abstract) {
        contextInfo += title
          ? `\n\nPaper Abstract: ${abstract}`
          : `Paper Abstract: ${abstract}`;
      }

      if (contextInfo) {
        instruction += `\n\nContext from the academic paper:\n${contextInfo}`;
      }
    }
  }

  return { system: instruction, user: sourceText };
}
