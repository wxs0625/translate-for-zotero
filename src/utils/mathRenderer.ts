import katex from "katex";

// Unified, robust math rendering helpers
// Uses lookbehind (?<!\) to avoid consuming the preceding character.
// Inline math content excludes $ so that adjacent inline like $x$$y$ matches
// as two separate expressions instead of swallowing the closing $ of the first
// into the content of the second.
// Zotero 7 targets Firefox 115+ which supports lookbehind in RegExp.
const MATH_REGEX =
  /(?<!\\)\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|(?<!\\)\$(?!\$)([^\n$]*?)\$|\\\(([\s\S]*?)\\\)|<sup\b[^>]*>[\s\S]*?<\/sup>|<sub\b[^>]*>[\s\S]*?<\/sub>|\\%|\\textsuperscript\s*\{[^}]*\}|\\textsuperscript\s*\[[^\]]*\]|\\textsuperscript\s*[+\-\u2212\u2010-\u2015]?\d+(?:\.\d+)?|\\textsubscript\s*\{[^}]*\}|\\textsubscript\s*\[[^\]]*\]|\\textsubscript\s*[+\-\u2212\u2010-\u2015]?\d+(?:\.\d+)?|\\approx|\\times|\\cdot|\\(?:mathrm|mathit|mathbf|mathbb|mathsf)\s*\{(?:[^{}]|\{[^{}]*\})*\}(?:\s*[_^]\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9+-]+))*|\\text\s*\{(?:[^{}]|\{[^{}]*\})*\}(?:\s*[_^]\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9+-]+))+|\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|exp|ln|log|sin|cos|tan|cot|sec|csc|lim|max|min|det|gcd|sum|prod|int|oint|partial|nabla|infty|pm|mp|le|leq|ge|geq|neq|equiv|sim|approx|propto|cdot|times|div|mid|parallel|perp|to|rightarrow|leftarrow|Rightarrow|Leftrightarrow|in|notin|forall|exists|ldots|cdots|dots|bar|vec|hat|tilde|overline|underline|sqrt|frac)(?![A-Za-z])(?:\s*(?:[_^]\s*(?:\{[^{}]*\}|[A-Za-z0-9+-]+)|\{[^{}]*\}|\[[^\]]*\]))*|[A-Za-z0-9]+_\{\\mathrm\{[^}]*\}\}|[A-Za-z0-9]+_\\mathrm\{[^}]*\}|[A-Za-z0-9]+_(?:\{(?:[^{}]|\{[^{}]*\})*\}|\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf)\s*\{[^{}]*\}|[A-Za-z0-9]+)|[A-Za-z0-9]+\^(?:\{(?:[^{}]|\{[^{}]*\})*\}|\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf)\s*\{[^{}]*\}|\d+)|\^\{[^}]*\}|_\{[^}]*\}/gi;
const DEFAULT_KATEX_OPTIONS = {
  throwOnError: false,
  errorColor: "#cc0000",
  strict: false,
} as const;

let mathRenderingPrewarmed = false;

/**
 * Warm up KaTeX before the first streamed translation arrives.
 *
 * The very first `katex.renderToString` call pays a one-time initialization
 * cost (symbol tables, parser setup, font metrics) that shows up as a brief
 * UI hitch when the first formula (e.g. `$ψ$`) appears mid-stream. Calling
 * it once at startup moves that cost off the streaming path. Idempotent.
 */
export function prewarmMathRendering(): void {
  if (mathRenderingPrewarmed) {
    return;
  }
  mathRenderingPrewarmed = true;
  try {
    katex.renderToString("x^{2}", {
      ...DEFAULT_KATEX_OPTIONS,
      displayMode: false,
    });
    katex.renderToString("\\frac{a}{b}\\psi", {
      ...DEFAULT_KATEX_OPTIONS,
      displayMode: true,
    });
  } catch {
    // Prewarming is best-effort; never let it break startup.
  }
}

// Insert soft hyphens into Latin words (len >= 4), every character, so line breaks show "-"
export function hyphenateForWrap(text: string): string {
  const SOFT = "\u00AD";
  return text.replace(/[A-Za-z]{4,}/g, (word, offset, full) => {
    if (offset > 0 && (full as string)[offset - 1] === "\\") {
      return word;
    }
    return word.split("").join(SOFT);
  });
}

function stripLatexBoilerplate(text: string): string {
  return String(text)
    .replace(/^\s*\\documentclass(?:\[[^\]]*\])?\{[^}]*\}\s*$/gim, "")
    .replace(/^\s*\\usepackage(?:\[[^\]]*\])?\{[^}]*\}\s*$/gim, "")
    .replace(/^\s*\\begin\{document\}\s*$/gim, "")
    .replace(/^\s*\\end\{document\}\s*$/gim, "")
    .replace(/\\begin\{[^}]*\}\s*/g, "")
    .replace(/\\end\{[^}]*\}\s*/g, "")
    .replace(/\\textdegree\b/g, "°")
    .replace(/\\(?:ce|ch)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, "$1");
}

function normalizeScriptSign(sign: string): string {
  return /[\u2212\u2010-\u2015]/.test(sign) ? "-" : sign;
}

function normalizeDollarScriptContent(content: string): string | null {
  const normalized = String(content)
    .trim()
    .replace(
      /^\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf)\s*\{([^{}]*)\}$/,
      "$1",
    )
    .replace(/[\u2212\u2010-\u2015]/g, "-")
    .replace(/\s+/g, "");
  if (!normalized || normalized.length > 24 || /[\\{}$]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeIonChargeContent(content: string): string | null {
  const normalized = String(content)
    .trim()
    .replace(/\uFF0B/g, "+")
    .replace(/[\u2212\u2010-\u2015]/g, "-")
    .replace(/\s+/g, "");
  return /^(?:\d{0,2}[+-]|[+-]\d{1,2})$/.test(normalized) ? normalized : null;
}

function normalizeChemicalIonCharges(text: string): string {
  return String(text).replace(
    /(^|[^A-Za-z0-9\\])((?:[A-Z][a-z]?|FA|MA))\s*\^\s*\{\s*([^{}]{1,8})\s*\}/g,
    (match, prefix, ion, charge) => {
      const normalized = normalizeIonChargeContent(charge);
      if (!normalized) {
        return match;
      }
      return `${prefix}${ion}\\textsuperscript{${normalized}}`;
    },
  );
}

function normalizeUnitExponents(text: string): string {
  return String(text).replace(
    /(^|[^A-Za-z0-9\\])((?:cm|mm|nm|um|\u00B5m|\u03BCm|m))\s*([+\-\u2212\u2010-\u2015]?)\s*(\d+(?:\.\d+)?)(?=$|[^A-Za-z0-9])/gi,
    (_match, prefix, unit, sign, value) =>
      `${prefix}${unit}\\textsuperscript{${normalizeScriptSign(sign)}${value}}`,
  );
}

function normalizeBracketCitationContent(content: string): string | null {
  const normalized = String(content)
    .replace(/[\u2212\u2010-\u2015]/g, "-")
    .replace(/[，、;]/g, ",")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  return /^\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*$/.test(normalized)
    ? `[${normalized}]`
    : null;
}

function normalizeBracketCitations(text: string): string {
  return String(text).replace(
    /(^|[^A-Za-z0-9\\{])\[([0-9\s,;，、\-\u2212\u2010-\u2015]+)\]/g,
    (match, prefix, content) => {
      const normalized = normalizeBracketCitationContent(content);
      if (!normalized) {
        return match;
      }
      return `${prefix}\\textsuperscript{${normalized}}`;
    },
  );
}

const CHEMICAL_FORMULA_SYMBOLS = new Set([
  "FA",
  "MA",
  "A",
  "B",
  "X",
  "H",
  "He",
  "Li",
  "Be",
  "C",
  "N",
  "O",
  "F",
  "Ne",
  "Na",
  "Mg",
  "Al",
  "Si",
  "P",
  "S",
  "Cl",
  "Ar",
  "K",
  "Ca",
  "Sc",
  "Ti",
  "V",
  "Cr",
  "Mn",
  "Fe",
  "Co",
  "Ni",
  "Cu",
  "Zn",
  "Ga",
  "Ge",
  "As",
  "Se",
  "Br",
  "Kr",
  "Rb",
  "Sr",
  "Y",
  "Zr",
  "Nb",
  "Mo",
  "Tc",
  "Ru",
  "Rh",
  "Pd",
  "Ag",
  "Cd",
  "In",
  "Sn",
  "Sb",
  "Te",
  "I",
  "Xe",
  "Cs",
  "Ba",
  "La",
  "Ce",
  "Pr",
  "Nd",
  "Pm",
  "Sm",
  "Eu",
  "Gd",
  "Tb",
  "Dy",
  "Ho",
  "Er",
  "Tm",
  "Yb",
  "Lu",
  "Hf",
  "Ta",
  "W",
  "Re",
  "Os",
  "Ir",
  "Pt",
  "Au",
  "Hg",
  "Tl",
  "Pb",
  "Bi",
  "Po",
  "At",
  "Rn",
]);

type ChemicalFormulaStats = {
  valid: boolean;
  symbolCount: number;
  scriptCount: number;
  hasGroup: boolean;
};

function matchChemicalFormulaSymbol(
  token: string,
  index: number,
): string | null {
  const two = token.slice(index, index + 2);
  if (CHEMICAL_FORMULA_SYMBOLS.has(two)) {
    return two;
  }
  const one = token.slice(index, index + 1);
  return CHEMICAL_FORMULA_SYMBOLS.has(one) ? one : null;
}

function getChemicalFormulaStats(token: string): ChemicalFormulaStats {
  const value = String(token || "");
  let index = 0;
  let symbolCount = 0;
  let scriptCount = 0;
  let hasGroup = false;
  while (index < value.length) {
    const rest = value.slice(index);
    if (/^[().\u00B7\u22C5]/u.test(rest)) {
      hasGroup = true;
      index += 1;
      continue;
    }
    const scriptMatch =
      /^(?:1\s*[\u2212\u2010-\u2015-]\s*[xyz]|\d+(?:\.\d+)?|[xyz])/u.exec(rest);
    if (scriptMatch) {
      scriptCount += 1;
      index += scriptMatch[0].length;
      continue;
    }
    const symbol = matchChemicalFormulaSymbol(value, index);
    if (!symbol) {
      return { valid: false, symbolCount: 0, scriptCount: 0, hasGroup: false };
    }
    symbolCount += 1;
    index += symbol.length;
  }
  return { valid: symbolCount > 0, symbolCount, scriptCount, hasGroup };
}

function renderChemicalFormulaSubscripts(token: string): string {
  const value = String(token || "");
  let index = 0;
  let result = "";
  while (index < value.length) {
    const rest = value.slice(index);
    const scriptMatch =
      /^(?:1\s*[\u2212\u2010-\u2015-]\s*[xyz]|\d+(?:\.\d+)?|[xyz])/u.exec(rest);
    if (scriptMatch) {
      result += `\\textsubscript{${normalizeFormulaSubscriptContent(scriptMatch[0])}}`;
      index += scriptMatch[0].length;
      continue;
    }
    const symbol = matchChemicalFormulaSymbol(value, index);
    if (symbol) {
      result += symbol;
      index += symbol.length;
      continue;
    }
    result += value[index];
    index += 1;
  }
  return result;
}

function isLikelyChemicalFormulaToken(token: string): boolean {
  if (!/[0-9xyz]/u.test(token) || /^S\d+$/u.test(token) || /^\d/u.test(token)) {
    return false;
  }
  const stats = getChemicalFormulaStats(token);
  if (!stats.valid || !stats.scriptCount) {
    return false;
  }
  return (
    stats.hasGroup ||
    stats.symbolCount > 1 ||
    /^C\d+(?:\.\d+)?$/u.test(token) ||
    /^(?:H|N|O|F|Cl|Br|I)\d+(?:\.\d+)?$/u.test(token)
  );
}

function normalizeFormulaSubscriptContent(text: string): string {
  return String(text)
    .replace(/[\u2212\u2010-\u2015]/g, "-")
    .replace(/\s+/g, "");
}

function isLikelySpacedChemicalFormula(text: string): boolean {
  const value = String(text).trim();
  const stats = getChemicalFormulaStats(value.replace(/\s+/g, ""));
  if (!stats.valid || !stats.scriptCount) {
    return false;
  }
  if (stats.symbolCount > 1 || stats.hasGroup) {
    return true;
  }
  return /^(?:C|H|N|O|F|Cl|Br|I)\s+(?:\d+(?:\.\d+)?|[xyz])$/u.test(value);
}

function normalizeSpacedChemicalFormulaSubscripts(text: string): string {
  return String(text).replace(
    /(^|[^A-Za-z0-9\\])((?:(?:FA|MA|[A-Z][a-z]?|\(|\))\s*(?:1\s*[\u2212\u2010-\u2015-]\s*[xyz]|\d+(?:\.\d+)?|[xyz])?\s*)+)(?=$|[^A-Za-z0-9])/g,
    (match, prefix, formula) => {
      if (!isLikelySpacedChemicalFormula(formula)) {
        return match;
      }
      const normalized = String(formula)
        .trim()
        .replace(
          /((?:FA|MA|[A-Z][a-z]?|\)))\s+(1\s*[\u2212\u2010-\u2015-]\s*[xyz]|\d+(?:\.\d+)?|[xyz])(?=$|[\s)])/g,
          (_scriptMatch, base, script) =>
            `${base}\\textsubscript{${normalizeFormulaSubscriptContent(script)}}`,
        )
        .replace(/\s+/g, "");
      return `${prefix}${normalized}`;
    },
  );
}

function normalizeChemicalFormulaSubscripts(text: string): string {
  return String(text).replace(
    /(^|[^A-Za-z0-9\\])((?:(?:FA|MA|[A-Z][a-z]?|1\s*[\u2212\u2010-\u2015-]\s*[xyz]|[xyz]|\d+(?:\.\d+)?|[().\u00B7\u22C5])+))(?=$|[^A-Za-z0-9])/g,
    (match, prefix, token) => {
      if (!isLikelyChemicalFormulaToken(token)) {
        return match;
      }
      const normalized = renderChemicalFormulaSubscripts(String(token));
      return `${prefix}${normalized}`;
    },
  );
}

function normalizeInlineIonCharges(text: string): string {
  return String(text).replace(
    /(^|[^A-Za-z0-9\\])((?:FA|MA|[A-Z][a-z]?))\s*(\d{0,2})\s*([+\uFF0B\u2212\u2010-\u2015-])(?=$|[^A-Za-z0-9])/g,
    (match, prefix, ion, valence, sign) => {
      const normalizedSign =
        sign === "\uFF0B" ? "+" : normalizeScriptSign(sign);
      const content = `${valence || ""}${normalizedSign}`;
      if (!normalizeIonChargeContent(content)) {
        return match;
      }
      return `${prefix}${ion}\\textsuperscript{${content}}`;
    },
  );
}

function normalizeLatexTextScripts(text: string): string {
  return String(text)
    .replace(
      /\$\s*\\(textsuperscript|textsubscript)\s*\{([^{}]*)\}\s*\$/g,
      (match, command, content) => {
        const normalized = normalizeDollarScriptContent(content);
        if (!normalized) {
          return match;
        }
        return `\\${command}{${normalized}}`;
      },
    )
    .replace(
      /\$\s*([_^])\s*(?:\{\s*)?((?:\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf)\s*\{[^{}]*\})|[+\-\u2212\u2010-\u2015A-Za-z0-9.,]+)\s*(?:\})?\s*\$/g,
      (match, marker, content) => {
        const normalized = normalizeDollarScriptContent(content);
        if (!normalized) {
          return match;
        }
        return marker === "^"
          ? `\\textsuperscript{${normalized}}`
          : `\\textsubscript{${normalized}}`;
      },
    )
    .replace(
      /([A-Za-z][A-Za-z0-9]*)\s*\^\s*\{\s*([+\-\u2212\u2010-\u2015])\s*(\d+(?:\.\d+)?)\s*\}/g,
      (_match, unit, sign, value) =>
        `${unit}\\textsuperscript{${normalizeScriptSign(sign)}${value}}`,
    )
    .replace(
      /([A-Za-z][A-Za-z0-9]*)\s*\^\s*([+\-\u2212\u2010-\u2015])\s*(\d+(?:\.\d+)?)/g,
      (_match, unit, sign, value) =>
        `${unit}\\textsuperscript{${normalizeScriptSign(sign)}${value}}`,
    )
    .replace(
      /\\textsuperscript\s*\{\s*([+\-\u2212\u2010-\u2015])\s*(\d+(?:\.\d+)?)\s*\}/g,
      (_match, sign, value) =>
        `\\textsuperscript{${normalizeScriptSign(sign)}${value}}`,
    )
    .replace(
      /([A-Za-z][A-Za-z0-9]*)\s*\^\s*[\u00AF\u02C9\u0304]/g,
      "$1\\textsuperscript{-}",
    )
    .replace(
      /([A-Za-z][A-Za-z0-9]*)\s*[\u00AF\u02C9\u0304]/g,
      "$1\\textsuperscript{-}",
    )
    .replace(
      /\{\}\s*\^\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?/g,
      "\\textsuperscript{$1}",
    )
    .replace(
      /\{\}\s*_\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?/g,
      "\\textsubscript{$1}",
    )
    .replace(/\^\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?/g, "\\textsuperscript{$1}")
    .replace(/_\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?/g, "\\textsubscript{$1}");
}

export function normalizePlainText(text: string): string {
  return (
    normalizeLatexTextScripts(
      stripMathStyleCommands(stripLatexBoilerplate(text)),
    )
      .replace(/\\\\+(?=\$|[A-Za-z,;:!])/g, "\\")
      .replace(/```latex\s*([\s\S]*?)\s*```/gi, "$1")
      .replace(/\\noindent\s*/g, "")
      .replace(/\uFF04|\uFE69/g, "$")
      .replace(/\\\$/g, "$")
      .replace(/\\r\\n|\\n(?![a-z])|\\r(?![a-z])/g, "\n")
      .replace(/\uFF08/g, "(")
      .replace(/\uFF09/g, ")")
      .replace(
        /\$\s*\^\s*\{?\s*\[([\s\S]*?)\]\s*\}?\s*\$/g,
        "\\textsuperscript{[$1]}",
      )
      .replace(/\$\s*\^\s*\{?\s*\\circ\s*\}?\s*\$/g, "°")
      .replace(/\$\s*\\circ\s*\$/g, "°")
      .replace(
        /\$\s*([^$\n]*?)\\(?:ce|ch)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}([^$\n]*?)\s*\$/g,
        "$1$2$3",
      )
      .replace(/\\&/g, "&")
      .replace(/\\(?:,|;|:|!)/g, " ")
      .replace(/\\(?:quad|qquad)\b/g, " ")
      .replace(/(^|[^\\])~/g, "$1 ")
      .replace(
        /([0-9A-Za-z\u4E00-\u9FFF])~(?=[0-9A-Za-z\u4E00-\u9FFF$])/g,
        "$1 ",
      )
      .replace(
        /\$\s*([\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+(?:\s*[,，、]\s*[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+)+)\s*\$/g,
        "$1",
      )
      .replace(/\$\s*(\d+(?:\s*[,，、]\s*\d+)+)\s*\$/g, (_m, body) => {
        const normalized = normalizeCitationBody(body);
        return normalized ? toSuperscriptDigits(normalized) : String(body);
      })
      .replace(/\$\s*([^$\n]{1,64}?)\s*\$/g, (full, body) => {
        const normalized = normalizeCitationBody(body);
        return normalized ? toSuperscriptDigits(normalized) : full;
      })
      // Only treat explicit LaTeX line-break commands as newline.
      // Do NOT convert every backslash, otherwise normal LaTeX text gets broken lines.
      .replace(/\\\\/g, "\n")
      .replace(/\\(?:newline|par)\b/g, "\n")
      .replace(/\\section\*?\s*\{([\s\S]*?)\}/g, (_match, content) => {
        return String(content).replace(/^\s*\d+\s*/, "");
      })
      .replace(/\\subsection\*?\s*\{([\s\S]*?)\}/g, (_match, content) => {
        return String(content).replace(/^\s*\d+\s*/, "");
      })
      .replace(/\\subsubsection\*?\s*\{([\s\S]*?)\}/g, (_match, content) => {
        return String(content).replace(/^\s*\d+\s*/, "");
      })
      .replace(/\\textbf\s*\{([\s\S]*?)\}/g, "$1")
      .replace(/\\textbf\s*\[([\s\S]*?)\]/g, "$1")
      .replace(/\\textbf\s*([A-Za-z0-9]+)/g, "$1")
      .replace(/\\text(?:super|sub)script\b\s*/g, "")
      .replace(/\\[A-Za-z]+\*?\s*\[[^\]]*\]\s*\{([\s\S]*?)\}/g, "$1")
      .replace(/\\[A-Za-z]+\*?\s*\{([\s\S]*?)\}/g, "$1")
      .replace(/\\[A-Za-z]+\*?\s*\[[^\]]*\]/g, "")
      .replace(/\\[A-Za-z]+\*?/g, "")
      .replace(/\\(?![A-Za-z])/g, "")
      .replace(/−−/g, "−")
  );
}

function normalizeScriptContent(text: string): string {
  if (/^\s*\\circ\s*$/.test(text)) {
    return "\u00B0";
  }
  return text.replace(/[-–—−]{2,}/g, "−");
}

function normalizeKatexInput(text: string): string {
  return String(text)
    .replace(
      /\\textsuperscript\s*\{([^{}]*)\}/g,
      (_match, content) => `^{\\text{${content}}}`,
    )
    .replace(
      /\\textsubscript\s*\{([^{}]*)\}/g,
      (_match, content) => `_{\\text{${content}}}`,
    );
}

function toPlainDigits(text: string): string {
  const superscriptMap: Record<string, string> = {
    "\u2070": "0",
    "\u00B9": "1",
    "\u00B2": "2",
    "\u00B3": "3",
    "\u2074": "4",
    "\u2075": "5",
    "\u2076": "6",
    "\u2077": "7",
    "\u2078": "8",
    "\u2079": "9",
  };
  return text.replace(/[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]/g, (m) => {
    return superscriptMap[m] ?? m;
  });
}

function toSuperscriptDigits(text: string): string {
  const plainMap: Record<string, string> = {
    "0": "\u2070",
    "1": "\u00B9",
    "2": "\u00B2",
    "3": "\u00B3",
    "4": "\u2074",
    "5": "\u2075",
    "6": "\u2076",
    "7": "\u2077",
    "8": "\u2078",
    "9": "\u2079",
  };
  return String(text).replace(/\d/g, (m) => plainMap[m] ?? m);
}

function normalizeCitationBody(text: string): string | null {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  if (/[A-Za-z\\]/.test(trimmed)) {
    return null;
  }
  const plainDigits = toPlainDigits(trimmed);
  const residue = plainDigits.replace(/[0-9\s]/g, "");
  if (residue && /[^,，、.。;；:：·]/.test(residue)) {
    return null;
  }
  const numbers = plainDigits.split(/[^0-9]+/).filter(Boolean);
  if (numbers.length < 2) {
    return null;
  }
  return numbers.join(",");
}

function normalizeCitationPlainDisplay(text: string): string {
  const citationRegex =
    /(?:\\\$|\$|\uFF04|\uFE69)\s*([^\n$]{1,64}?)\s*(?:\\\$|\$|\uFF04|\uFE69)/g;
  return text.replace(citationRegex, (full, body) => {
    const normalized = normalizeCitationBody(body);
    if (!normalized) {
      return full;
    }
    return toSuperscriptDigits(normalized);
  });
}

function stripMathStyleCommands(text: string): string {
  return String(text)
    .replace(/\\boldsymbol\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, "$1")
    .replace(/\\mathbf\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, "$1")
    .replace(/\\bm\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, "$1");
}

function normalizeCitationNumbers(text: string): string {
  const citationRegex =
    /(?<!\\)(?:\\\$|\$|\uFF04|\uFE69)\s*([^\n$]{1,64}?)\s*(?:\\\$|\$|\uFF04|\uFE69)/g;
  return text.replace(citationRegex, (full, body) => {
    const normalized = normalizeCitationBody(body);
    if (!normalized) {
      return full;
    }
    return `\\textsuperscript{${normalized}}`;
  });
}

const ORPHAN_DOLLAR_SENTINEL = "\uE000";

function hasBalancedBraces(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "}") {
      continue;
    }
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function stripTextLikeLatexCommands(text: string): string {
  return String(text).replace(
    /\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf|textbf|ce|ch)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
    "",
  );
}

function isValidInlineMathContent(content: string): boolean {
  const trimmed = String(content || "").trim();
  if (!trimmed || !hasBalancedBraces(content)) {
    return false;
  }
  const outsideCommands = stripTextLikeLatexCommands(content);
  // Real inline math never contains CJK prose or CJK punctuation outside \text{...}.
  if (
    /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u3001-\u3011\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f]/u.test(
      outsideCommands,
    )
  ) {
    return false;
  }
  // Reject multi-sentence English prose or unescaped % followed by English words.
  if (
    /[.?!]\s+[A-Za-z]/.test(outsideCommands) ||
    /(?<!\\)%\s+[A-Za-z]{2,}/.test(outsideCommands)
  ) {
    return false;
  }
  // Reject currency-style plain English phrases with no LaTeX or math operators.
  const plainWords = outsideCommands.match(/[A-Za-z]{2,}/g) || [];
  if (
    !/[\\_^=<>+*/-]/.test(outsideCommands) &&
    (plainWords.length >= 3 ||
      (plainWords.length >= 1 &&
        /^\s*\d/.test(outsideCommands) &&
        /\s/.test(outsideCommands.trim())))
  ) {
    return false;
  }
  return true;
}

function isAdjacentToBareLatex(before: string, after: string): boolean {
  const leftLatex =
    /(?:\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf|ce|ch)\s*\{(?:[^{}]|\{[^{}]*\})*\}(?:\s*[_^]\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9+-]+))*|[A-Za-z0-9]+\s*[_^]\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9]+)|\\[A-Za-z]+(?:\s*\{[^{}]*\})*)\s*$/;
  const rightLatex =
    /^\s*(?:\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf|ce|ch|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|rho|sigma|tau|phi|psi|omega|frac|sqrt)\b|[A-Za-z0-9]+\s*[_^]\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[A-Za-z0-9]+))/;
  return leftLatex.test(before) || rightLatex.test(after);
}

function repairInlineDollarsInLine(line: string): string {
  if (!line.includes("$")) {
    return line;
  }

  const dollars: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "$") {
      continue;
    }
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) {
      continue;
    }
    // Skip $ display-math delimiters
    if (line[i + 1] === "$" || (i > 0 && line[i - 1] === "$")) {
      continue;
    }
    dollars.push(i);
  }

  if (!dollars.length) {
    return line;
  }

  const validPairs = new Set<number>();
  let idx = 0;
  while (idx < dollars.length) {
    if (idx + 1 < dollars.length) {
      const start = dollars[idx];
      const end = dollars[idx + 1];
      const candidate = line.slice(start + 1, end);
      if (isValidInlineMathContent(candidate)) {
        validPairs.add(start);
        validPairs.add(end);
        idx += 2;
        continue;
      }
    }
    idx += 1;
  }

  if (validPairs.size === dollars.length) {
    return line;
  }

  let out = "";
  let cursor = 0;
  for (const pos of dollars) {
    out += line.slice(cursor, pos);
    if (validPairs.has(pos)) {
      out += "$";
    } else {
      const before = line.slice(0, pos);
      const after = line.slice(pos + 1);
      if (isAdjacentToBareLatex(before, after)) {
        // Drop orphan $ attached to bare LaTeX (e.g. \text{N}_2$)
      } else {
        out += ORPHAN_DOLLAR_SENTINEL;
      }
    }
    cursor = pos + 1;
  }
  out += line.slice(cursor);
  return out;
}

export function repairUnmatchedInlineDollars(text: string): string {
  if (!text || !text.includes("$")) {
    return text;
  }
  // Preserve $...$ display blocks untouched
  const displayBlocks: string[] = [];
  const masked = text.replace(/(?<!\\)\$\$[\s\S]*?\$\$/g, (block) => {
    const token = `\uE001DISP_${displayBlocks.length}\uE001`;
    displayBlocks.push(block);
    return token;
  });
  const repaired = masked
    .split("\n")
    .map((line) => repairInlineDollarsInLine(line))
    .join("\n");
  return repaired.replace(/\uE001DISP_(\d+)\uE001/g, (_m, idx) => {
    return displayBlocks[Number(idx)] ?? "";
  });
}

export function containsMath(text: string): boolean {
  if (!text) return false;
  // Fullwidth dollar signs are treated as math/citation delimiters by the
  // render pipeline (\uFF04/\uFE69 -> $), so they must be converted here
  // too; otherwise streaming treats citation text as plain text and the
  // final render changes it to <sup>, shifting already-output layout/font.
  text = repairUnmatchedInlineDollars(
    normalizeLatexTextScripts(String(text).replace(/\uFF04|\uFE69/g, "$")),
  );
  MATH_REGEX.lastIndex = 0;
  const result = MATH_REGEX.test(text);
  MATH_REGEX.lastIndex = 0;
  return result;
}

export function escapeHtml(doc: Document, text: string): string {
  const div = doc.createElement("div");
  const restored = String(text || "").replaceAll(ORPHAN_DOLLAR_SENTINEL, "$");
  div.textContent = hyphenateForWrap(normalizePlainText(restored));
  return div.innerHTML.replace(/\n/g, "<br></br>");
}

function wrapParagraphs(html: string): string {
  return html
    .split("<br></br>")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<div class="zp-paragraph">${part}</div>`)
    .join("");
}

export function renderMathInText(doc: Document, text: string): string {
  if (!text) return "";
  const normalizedText = normalizeLatexTextScripts(
    stripMathStyleCommands(stripLatexBoilerplate(text)),
  )
    .replace(/\\\\+(?=\$|[A-Za-z,;:!])/g, "\\")
    .replace(/```latex\s*([\s\S]*?)\s*```/gi, "$1")
    .replace(/\\noindent\s*/g, "")
    .replace(/\uFF04|\uFE69/g, "$")
    .replace(/\\\$/g, "$")
    .replace(/\\r\\n|\\n(?![a-z])|\\r(?![a-z])/g, "\n")
    .replace(/\uFF08/g, "(")
    .replace(/\uFF09/g, ")")
    .replace(
      /\$\s*\^\s*\{?\s*\[([\s\S]*?)\]\s*\}?\s*\$/g,
      "\\textsuperscript{[$1]}",
    )
    .replace(/\$\s*\^\s*\{?\s*\\circ\s*\}?\s*\$/g, "°")
    .replace(/\$\s*\\circ\s*\$/g, "°")
    .replace(
      /\$\s*([^$\n]*?)\\(?:ce|ch)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}([^$\n]*?)\s*\$/g,
      "$1$2$3",
    )
    .replace(/\\&/g, "&")
    .replace(/\\(?:,|;|:|!)/g, " ")
    .replace(/\\(?:quad|qquad)\b/g, " ")
    .replace(/(^|[^\\])~/g, "$1 ")
    .replace(/([0-9A-Za-z\u4E00-\u9FFF])~(?=[0-9A-Za-z\u4E00-\u9FFF$])/g, "$1 ")
    .replace(/\\text\{--\}/g, "--");
  const citationNormalizedText = repairUnmatchedInlineDollars(normalizedText);
  if (!containsMath(citationNormalizedText)) {
    return wrapParagraphs(escapeHtml(doc, citationNormalizedText));
  }

  MATH_REGEX.lastIndex = 0;

  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MATH_REGEX.exec(citationNormalizedText)) !== null) {
    const [full, dispDollar, dispBracket, inlineDollar, inlineParen] = match;

    const isEscapedPercent = full === "\\%";
    const isTextSuperscript = full.startsWith("\\textsuperscript");
    const isTextSubscript = full.startsWith("\\textsubscript");
    const htmlSuperscript = /^<sup\b[^>]*>([\s\S]*?)<\/sup>$/i.exec(full);
    const htmlSubscript = /^<sub\b[^>]*>([\s\S]*?)<\/sub>$/i.exec(full);
    // With lookbehind (?<!\\) the prefix is zero-width (not consumed),
    // so plain text extends all the way to match.index.
    const plainEnd = match.index;
    if (plainEnd > lastIndex) {
      result += escapeHtml(
        doc,
        citationNormalizedText.slice(lastIndex, plainEnd),
      );
    }

    let displayMode = false;
    let latex = "";
    if (typeof dispDollar !== "undefined") {
      displayMode = true;
      latex = String(dispDollar).trim();
    } else if (typeof dispBracket !== "undefined") {
      displayMode = true;
      latex = String(dispBracket).trim();
    } else if (typeof inlineDollar !== "undefined") {
      displayMode = false;
      const inlineContent = String(inlineDollar).trim();
      const caretBracketSup = /^\^\s*\{?\s*\[([\s\S]*?)\]\s*\}?\s*$/.exec(
        inlineContent,
      );
      const bracketSup = /^\[([\s\S]*)\]$/.exec(inlineContent);
      const numericListSup = normalizeCitationBody(inlineContent);
      if (caretBracketSup) {
        const normalized = normalizeScriptContent(caretBracketSup[1]);
        latex = `{}^{\\text{[${normalized}]}}`;
      } else if (bracketSup) {
        const normalized = normalizeScriptContent(bracketSup[1]);
        latex = `{}^{\\text{[${normalized}]}}`;
      } else if (numericListSup) {
        result += `<sup>${escapeHtml(doc, numericListSup)}</sup>`;
        lastIndex = match.index + full.length;
        continue;
      } else {
        latex = inlineContent;
      }
    } else if (typeof inlineParen !== "undefined") {
      displayMode = false;
      latex = String(inlineParen).trim();
    } else if (htmlSuperscript) {
      result += `<sup>${escapeHtml(doc, normalizeScriptContent(htmlSuperscript[1]))}</sup>`;
      lastIndex = match.index + full.length;
      continue;
    } else if (htmlSubscript) {
      result += `<sub>${escapeHtml(doc, htmlSubscript[1])}</sub>`;
      lastIndex = match.index + full.length;
      continue;
    } else if (isEscapedPercent) {
      displayMode = false;
      latex = "\\%";
    } else if (isTextSuperscript) {
      displayMode = false;
      const braceMatch = /^\\textsuperscript\s*\{([\s\S]*)\}$/.exec(full);
      const bracketMatch = /^\\textsuperscript\s*\[([\s\S]*)\]$/.exec(full);
      const bareMatch =
        /^\\textsuperscript\s*([+\-\u2212\u2010-\u2015]?\d+(?:\.\d+)?)$/.exec(
          full,
        );
      const content =
        (braceMatch && normalizeScriptContent(braceMatch[1])) ||
        (bracketMatch && `[${normalizeScriptContent(bracketMatch[1])}]`) ||
        (bareMatch &&
          normalizeScriptContent(bareMatch[1]).replace(
            /[\u2212\u2010-\u2015]/g,
            "-",
          )) ||
        null;
      latex = content !== null ? `{}^{\\text{${content}}}` : full;
    } else if (isTextSubscript) {
      displayMode = false;
      const braceMatch = /^\\textsubscript\s*\{([\s\S]*)\}$/.exec(full);
      const bracketMatch = /^\\textsubscript\s*\[([\s\S]*)\]$/.exec(full);
      const bareMatch =
        /^\\textsubscript\s*([+\-\u2212\u2010-\u2015]?\d+(?:\.\d+)?)$/.exec(
          full,
        );
      const content =
        (braceMatch && braceMatch[1]) ||
        (bracketMatch && `[${bracketMatch[1]}]`) ||
        (bareMatch &&
          normalizeScriptContent(bareMatch[1]).replace(
            /[\u2212\u2010-\u2015]/g,
            "-",
          )) ||
        null;
      latex = content !== null ? `{}_{\\text{${content}}}` : full;
    }

    if (!latex) {
      const loneSup = /^\^\{([\s\S]*)\}$/.exec(full);
      const loneSub = /^_\{([\s\S]*)\}$/.exec(full);
      if (loneSup) {
        displayMode = false;
        latex = `{}^{\\text{${normalizeScriptContent(loneSup[1])}}}`;
      } else if (loneSub) {
        displayMode = false;
        latex = `{}_{\\text{${normalizeScriptContent(loneSub[1])}}}`;
      } else if (full.startsWith("\\") || /[A-Za-z0-9]+[_^]/.test(full)) {
        displayMode = false;
        latex = full;
      }
    }

    try {
      latex = normalizeKatexInput(latex).replace(/(?<!\\)%/g, "\\%");
      const rendered = katex.renderToString(latex, {
        ...DEFAULT_KATEX_OPTIONS,
        throwOnError: true,
        displayMode,
      });
      result += rendered;
    } catch (e) {
      result += escapeHtml(doc, full);
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < citationNormalizedText.length) {
    result += escapeHtml(doc, citationNormalizedText.slice(lastIndex));
  }

  result = result
    .replace(
      /(?:\\\$|\$|\uFF04|\uFE69)\s*([\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+(?:\s*[,，、]\s*[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+)+)\s*(?:\\\$|\$|\uFF04|\uFE69)/g,
      "$1",
    )
    .replace(
      /(?:\\\$|\$|\uFF04|\uFE69)\s*(\d+(?:\s*[,，、]\s*\d+)+)\s*(?:\\\$|\$|\uFF04|\uFE69)/g,
      (_m, body) => {
        const normalized = normalizeCitationBody(body);
        return normalized ? toSuperscriptDigits(normalized) : String(body);
      },
    );

  return wrapParagraphs(result.replaceAll(ORPHAN_DOLLAR_SENTINEL, "$"));
}

export function renderMathInElement(element: HTMLElement, text: string): void {
  if (!element) return;
  element.innerHTML = renderMathInText(element.ownerDocument, text);
}
