import { getString } from "./locale";

export function slice(str: string, len: number) {
  return str.length > len ? `${str.slice(0, len - 3)}...` : str;
}

export function fill(
  str: string,
  len: number,
  options: { char: string; position: "start" | "end" } = {
    char: " ",
    position: "end",
  },
) {
  if (str.length >= len) {
    return str;
  }
  return str[options.position === "start" ? "padStart" : "padEnd"](
    len - str.length,
    options.char,
  );
}

/**
 * Strip empty lines and thinking tags from text
 * @param text Text to process
 * @param enabled Whether stripping is enabled
 * @returns Processed text
 */
export function stripEmptyLines(text: string, enabled: boolean): string {
  if (!text || !enabled) return text;

  // Strip <think>...</think> tags and their content
  const processedText = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Leave blank lines for error messages
  const errorPrefix = getString("service-errorPrefix");
  if (processedText.includes(errorPrefix)) {
    return processedText;
  } else {
    // Normalize line endings to \n
    const normalizedText = processedText
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    // Remove empty lines while preserving paragraphs and line breaks
    const result = normalizedText.split("\n").filter((line) => line.trim().length > 0).join("\n");

    return result;
  }
}
