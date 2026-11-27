import { config } from "../../package.json";
import {
  renderMathInText,
  containsMath,
  repairUnmatchedInlineDollars,
  hyphenateForWrap,
  normalizePlainText,
} from "../utils/mathRenderer";
import { getPref } from "../utils/prefs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SUPERSCRIPT_TO_PLAIN_DIGIT: Record<string, string> = {
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

const PLAIN_TO_SUPERSCRIPT_DIGIT: Record<string, string> = {
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

const STREAM_RENDER_LEADING_NEWLINE_REGEX =
  /^(?:[ \t]*(?:\r\n|\n|\r|\\r\\n|\\n(?![a-z])|\\r(?![a-z])))+/;
const STREAM_RENDER_TRAILING_NEWLINE_REGEX =
  /(?:\r\n|\n|\r|\\r\\n|\\n|\\r)[ \t]*$/;
const STREAM_RENDER_NEWLINE_REGEX =
  /\r\n|\n|\r|\\r\\n|\\n(?![a-z])|\\r(?![a-z])/g;
const STREAM_RENDER_DELAY_MS = 32;
const OUTPUT_COMPLETION_MIN_RATIO = 0.92;
const OUTPUT_APPEND_SAFE_BOUNDARY_REGEX =
  /\\r\\n|\\n|\\r|\r\n|\n|\r|[ \t]+|[\u3400-\u4DBF\u4E00-\u9FFF]|[。！？!?；;，,、：:）)\]】」』”’>]+|(?:\.(?=\s|$))/g;
const STREAM_RENDER_COMMANDS = [
  "textsuperscript",
  "textsubscript",
  "mathrm",
  "mathit",
  "mathbf",
  "mathbb",
  "mathsf",
  "text",
  "approx",
  "times",
  "cdot",
  "noindent",
  "newline",
  "section",
  "subsection",
  "subsubsection",
];

function toPlainDigits(text: string): string {
  return String(text).replace(
    /[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]/g,
    (m) => {
      return SUPERSCRIPT_TO_PLAIN_DIGIT[m] ?? m;
    },
  );
}

function toSuperscriptDigits(text: string): string {
  return String(text).replace(/\d/g, (m) => PLAIN_TO_SUPERSCRIPT_DIGIT[m] ?? m);
}

function normalizeCitationBody(body: string): string | null {
  const trimmed = String(body).trim();
  if (!trimmed) return null;
  if (/[A-Za-z\\]/.test(trimmed)) {
    return null;
  }
  const plainDigits = toPlainDigits(trimmed);
  const residue = plainDigits.replace(/[0-9\s]/g, "");
  if (residue && /[^,，、;]/.test(residue)) {
    return null;
  }
  const numbers = plainDigits.split(/[^0-9]+/).filter(Boolean);
  if (numbers.length < 2) {
    return null;
  }
  return numbers.join(",");
}

function stripCitationMathDelimiters(text: string): string {
  return String(text);
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
  return String(text || "").replace(
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
  return String(text || "").replace(
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
  return String(text || "").replace(
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
  return String(text || "").replace(
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
  return String(text || "").replace(
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
  return String(text || "").replace(
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

type SelectionOffsets = {
  start: number;
  end: number;
  anchor: number;
  focus: number;
};

export class MathTextboxElement extends XULElementBase {
  private _textbox: XULTextBoxElement | null = null;
  private _overlay: HTMLElement | null = null;
  private _value: string = "";
  private _overlayScrollTop = 0;
  private _overlayScrollLeft = 0;
  private _overlayScrollToken = 0;
  private _isSelectingOverlay = false;
  private _hasOverlaySelection = false;
  private _lastSelectionOffsets: SelectionOffsets | null = null;
  private _renderTimer: number | null = null;
  private _renderQueuedValue = "";
  private _lastRenderedValue = "";
  private _lastRenderedHtml = "";
  private _restoringSelection = false;
  private _forcePlainFallback = false;
  private _completionCheckToken = 0;
  private _outputTaskId = "";
  private _outputTaskResetPending = false;
  // ResizeObserver on the source element (editable-text) so that when
  // the user drags the resizer, the overlay's paddingBottom updates in
  // real time to match the new height.
  private _sourceResizeObserver: ResizeObserver | null = null;

  get content() {
    return MozXULElement.parseXULToFragment(`
      <editable-text id="inner-textbox" multiline="true" />
      <linkset>
        <html:link
          rel="stylesheet"
          href="chrome://${config.addonRef}/content/styles/katex.min.css"
        ></html:link>
        <html:link
          rel="stylesheet"
          href="chrome://${config.addonRef}/content/styles/mathTextbox.css"
        ></html:link>
      </linkset>
    `);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.init();
  }

  init(): void {
    this._textbox = this.querySelector("#inner-textbox") as XULTextBoxElement;
    if (!this._textbox) return;
    this._textbox.addEventListener("input", this._onInput);
    this._textbox.addEventListener("focus", this._onFocus);
    this._textbox.addEventListener("blur", this._onBlur);
    this.ownerDocument?.addEventListener("mouseup", this._onDocumentMouseUp);
    this.ownerDocument?.addEventListener(
      "selectionchange",
      this._onDocumentSelectionChange,
    );
  }

  set value(v: string) {
    const nextValue = v ?? "";
    if (nextValue === this._value) {
      if (this._textbox && this._textbox.value !== nextValue) {
        this._textbox.value = nextValue;
      }
      if (
        this.classList.contains("output-area") &&
        this._renderTimer !== null &&
        this._renderQueuedValue === nextValue
      ) {
        this._flushPendingRender();
      }
      return;
    }
    this._forcePlainFallback = false;
    this._value = nextValue;
    if (this._textbox) this._textbox.value = this._value;
    this._updateOverlay();
  }
  get value() {
    if (this.classList.contains("output-area")) {
      return this._value;
    }
    return this._textbox?.value ?? this._value;
  }

  setValueAndRefresh(v: string): void {
    const nextValue = v ?? "";
    const isOutputArea = this.classList.contains("output-area");
    const canAppendOutput =
      isOutputArea &&
      !this._outputTaskResetPending &&
      this._value &&
      nextValue.length > this._value.length &&
      nextValue.startsWith(this._value);
    this._outputTaskResetPending = false;
    this._forcePlainFallback = false;
    this._value = nextValue;
    this._renderQueuedValue = nextValue;
    if (this._textbox) {
      this._textbox.value = nextValue;
    }
    if (canAppendOutput) {
      if (
        isOutputArea ||
        (getPref("enableMathRendering") as boolean) === true
      ) {
        if (isOutputArea) {
          this._scheduleRender();
        } else {
          this._showOverlay();
        }
      } else {
        this._hideOverlay();
      }
      return;
    }
    this._cancelRender();
    this._lastRenderedValue = "";
    this._lastRenderedHtml = "";
    this.refreshOverlay();
  }

  setOutputTask(taskId: string): void {
    const nextTaskId = taskId || "";
    if (nextTaskId === this._outputTaskId) {
      return;
    }
    this._outputTaskId = nextTaskId;
    this._outputTaskResetPending = true;
    this._completionCheckToken += 1;
    this._cancelRender();
    this._renderQueuedValue = "";
    this._lastRenderedValue = "";
    this._lastRenderedHtml = "";
    this._forcePlainFallback = false;
    this._isSelectingOverlay = false;
    this._hasOverlaySelection = false;
    this._lastSelectionOffsets = null;
    this._restoringSelection = false;
  }

  getOutputScrollPosition(): { top: number; left: number } {
    return this._getCurrentScrollPosition();
  }

  setOutputScrollPosition(top = 0, left = 0): void {
    this._overlayScrollTop = top;
    this._overlayScrollLeft = left;
    if (this._overlay) {
      this._restoreOverlayScroll(this._overlay, top, left);
      return;
    }
    this._restoreTextboxScroll(top, left);
  }

  flushOutputRender(expectedValue?: string): void {
    if (!this.classList.contains("output-area")) {
      return;
    }
    const expected = expectedValue ?? this._value;
    if (!expected) {
      return;
    }
    this._cancelRender();
    this._forcePlainFallback = false;
    this._value = expected;
    this._renderQueuedValue = expected;
    if (this._textbox && this._textbox.value !== expected) {
      this._textbox.value = expected;
    }
    // Always do a full re-render on flush to ensure the final output
    // matches renderMathInText on the entire value. During streaming,
    // incremental appends may produce slightly different HTML (e.g.
    // cross-boundary LaTeX commands), so the flush must not skip.
    // _setOverlayHtml updates existing paragraphs in-place to minimize
    // position shifts.
    this._showOverlay(true);
  }

  ensureCompleteOutput(expectedValue: string, finalCheck = false): void {
    if (!this.classList.contains("output-area")) {
      return;
    }
    const expected = expectedValue ?? "";
    if (!expected) {
      return;
    }
    const checkToken = ++this._completionCheckToken;
    this._value = expected;
    if (this._textbox && this._textbox.value !== expected) {
      this._textbox.value = expected;
    }
    const verify = () => {
      if (
        checkToken !== this._completionCheckToken ||
        !this.classList.contains("output-area") ||
        this._value !== expected
      ) {
        return;
      }
      const visibleText = this._overlay
        ? this._getVisibleText(this._overlay)
        : (this._textbox?.value ?? "");
      if (this._visibleTextLooksComplete(visibleText, expected)) {
        return;
      }
      this._showOverlay(false);
    };

    verify();
    const view = this.ownerDocument?.defaultView;
    const raf = view?.requestAnimationFrame?.bind(view);
    if (raf) {
      raf(verify);
    } else {
      setTimeout(verify, 0);
    }
  }

  private _forceRenderOverlay(expected: string): void {
    const scrollPos = this._getCurrentScrollPosition();
    this._cancelRender();
    this._forcePlainFallback = false;
    this._value = expected;
    this._renderQueuedValue = expected;
    if (this._textbox && this._textbox.value !== expected) {
      this._textbox.value = expected;
    }
    const overlay =
      this._overlay ??
      ((this.ownerDocument ?? document).createElementNS(
        HTML_NS,
        "div",
      ) as unknown as HTMLElement);
    const isNewOverlay = this._overlay === null;
    overlay.className = "math-overlay";
    const overlayValue = this._normalizeRenderSource(
      stripCitationMathDelimiters(expected),
    );
    const html = renderMathInText(this.ownerDocument ?? document, overlayValue);
    this._setOverlayHtml(overlay, html, true);
    this._lastRenderedHtml = html;
    this._lastRenderedValue = expected;
    if (isNewOverlay) {
      overlay.addEventListener("scroll", () => {
        this._overlayScrollTop = overlay.scrollTop;
        this._overlayScrollLeft = overlay.scrollLeft;
        this._overlayScrollToken += 1;
      });
      this._overlay = overlay;
      this.appendChild(overlay);
    }
    this._restoreOverlayScroll(overlay, scrollPos.top, scrollPos.left);
    this.toggleAttribute("overlay-visible", true);
  }

  set placeholder(v: string) {
    if (this._textbox) this._textbox.placeholder = v;
  }

  focus(): void {
    this._textbox?.focus();
  }

  refreshOverlay(): void {
    this._syncValueFromTextbox();
    this._cancelRender();
    this._lastRenderedValue = "";
    this._lastRenderedHtml = "";
    const enabled = (getPref("enableMathRendering") as boolean) === true;
    const isOutputArea = this.classList.contains("output-area");
    if (
      (!enabled && !isOutputArea) ||
      !this._value ||
      (!isOutputArea && !containsMath(this._value))
    ) {
      this._hideOverlay();
      return;
    }
    this._showOverlay();
  }

  scrollToTop(): void {
    this._overlayScrollTop = 0;
    this._overlayScrollLeft = 0;
    if (this._textbox) (this._textbox as any).scrollTop = 0;
    if (this._overlay) {
      this._overlay.scrollTop = 0;
      this._overlay.scrollLeft = 0;
    }
    const view = this.ownerDocument?.defaultView;
    const run = () => {
      if (this._textbox) (this._textbox as any).scrollTop = 0;
      if (this._overlay) {
        this._overlay.scrollTop = 0;
        this._overlay.scrollLeft = 0;
      }
    };
    const raf = view?.requestAnimationFrame?.bind(view);
    if (raf) {
      raf(run);
    } else {
      setTimeout(run, 0);
    }
    setTimeout(run, 160);
  }

  private _onInput = (e: Event) => {
    const val = (e.target as HTMLTextAreaElement).value;
    this._value = val;
    // do not redispatch input; bubble from inner editable-text already reaches panel listener
    this._updateOverlay();
  };

  private _onFocus = () => {
    if (this.classList.contains("output-area")) {
      return;
    }
    this._hideOverlay();
  };

  private _onBlur = () => {
    this._updateOverlay();
  };

  private _updateOverlay(): void {
    this._syncValueFromTextbox();
    const enabled = (getPref("enableMathRendering") as boolean) === true;
    const isOutputArea = this.classList.contains("output-area");
    if ((!enabled && !isOutputArea) || !this._value) {
      this._cancelRender();
      this._hideOverlay();
      return;
    }
    if (!isOutputArea && !containsMath(this._value)) {
      this._cancelRender();
      this._hideOverlay();
      return;
    }
    if (isOutputArea) {
      this._scheduleRender();
      return;
    }
    this._showOverlay();
  }

  private _scheduleRender(): void {
    const current = this._value;
    if (!current) {
      this._cancelRender();
      this._hideOverlay();
      return;
    }

    this._renderQueuedValue = current;
    if (current === this._lastRenderedValue) {
      this._cancelRender();
      return;
    }
    if (this._renderTimer !== null) {
      return;
    }

    const view = this.ownerDocument?.defaultView;
    const raf = view?.requestAnimationFrame?.bind(view);
    if (raf) {
      this._renderTimer = raf(() => {
        this._flushPendingRender();
      }) as unknown as number;
      return;
    }
    const setTimer = view?.setTimeout?.bind(view) ?? setTimeout;
    this._renderTimer = setTimer(() => {
      this._flushPendingRender();
    }, STREAM_RENDER_DELAY_MS) as unknown as number;
  }

  private _flushPendingRender(): void {
    this._renderTimer = null;
    const latest = this._syncValueFromTextbox();
    if (!latest) {
      this._hideOverlay();
      return;
    }
    if (latest !== this._lastRenderedValue) {
      this._showOverlay();
    }
  }

  private _cancelRender(): void {
    if (this._renderTimer === null) {
      return;
    }
    const view = this.ownerDocument?.defaultView;
    if (typeof view?.cancelAnimationFrame === "function") {
      view.cancelAnimationFrame(this._renderTimer);
    } else {
      const clearTimer = view?.clearTimeout?.bind(view) ?? clearTimeout;
      clearTimer(this._renderTimer);
    }
    this._renderTimer = null;
  }

  private _syncValueFromTextbox(): string {
    if (this.classList.contains("output-area")) {
      if (this._textbox && this._textbox.value !== this._value) {
        this._textbox.value = this._value;
      }
      return this._value;
    }
    if (this._textbox && this._textbox.value !== this._value) {
      this._value = this._textbox.value ?? "";
    }
    return this._value;
  }

  private _showOverlay(flushOutputTail = false): void {
    this._syncValueFromTextbox();
    const overlay =
      this._overlay ??
      ((this.ownerDocument ?? document).createElementNS(
        HTML_NS,
        "div",
      ) as unknown as HTMLElement);
    const isNewOverlay = this._overlay === null;
    const isOutputArea = this.classList.contains("output-area");
    const prevScrollTop = this._overlayScrollTop;
    const prevScrollLeft = this._overlayScrollLeft;
    const scrollToken = this._overlayScrollToken;
    overlay.className = "math-overlay";
    if (isOutputArea) {
      const sourceElem =
        (this._textbox as unknown as Element | null) ??
        (this as unknown as Element);
      const view = this.ownerDocument?.defaultView;
      // Compute paddingBottom from the SOURCE element's current height.
      // The source element (editable-text) height stays stable during
      // streaming (only the overlay content grows), so this won't cause
      // mid-stream jumps. When the user drags the resizer the source
      // height changes — the ResizeObserver (set up below) fires and
      // calls _showOverlay again to update paddingBottom in real time.
      const computed = view?.getComputedStyle(sourceElem);
      const baseBottom = computed?.paddingBottom
        ? parseFloat(computed.paddingBottom)
        : 6;
      const sourceHeight = sourceElem?.getBoundingClientRect?.().height ?? 0;
      const extraBottom = sourceHeight ? Math.round(sourceHeight / 4) : 0;
      overlay.style.paddingBottom = `${baseBottom + extraBottom}px`;
    } else {
      overlay.style.paddingBottom = "";
    }
    // Only capture/restore selection when there is an active selection.
    // During LLM streaming there is typically no selection, so skip the
    // expensive Range+cloneContents+TreeWalker operations.
    const hasActiveSelection =
      this._hasOverlaySelection || this._isSelectingOverlay;
    const selectionOffsets = hasActiveSelection
      ? this._captureOverlaySelection()
      : null;
    if (selectionOffsets) {
      this._lastSelectionOffsets = selectionOffsets;
    }
    const offsetsToRestore =
      selectionOffsets ||
      (hasActiveSelection ? this._lastSelectionOffsets : null);
    this._forcePlainFallback = false;

    const finishOverlayUpdate = (restoreSelection = true) => {
      if (restoreSelection && offsetsToRestore) {
        this._restoreOverlaySelection(offsetsToRestore);
      }
      if (isNewOverlay) {
        overlay.addEventListener("scroll", () => {
          this._overlayScrollTop = overlay.scrollTop;
          this._overlayScrollLeft = overlay.scrollLeft;
          this._overlayScrollToken += 1;
        });
        overlay.addEventListener("mousedown", () => {
          if (this.classList.contains("output-area")) {
            this._isSelectingOverlay = true;
          }
        });
        overlay.addEventListener("mouseup", () => {
          this._isSelectingOverlay = false;
        });
        overlay.addEventListener("click", () => {
          if (this.classList.contains("output-area")) {
            return;
          }
          this._hideOverlay();
          this._textbox?.focus();
        });
        // Watch the source element for height changes (drag resizer).
        // When height changes, update paddingBottom in real time.
        if (isOutputArea) {
          const sourceElem =
            (this._textbox as unknown as Element | null) ??
            (this as unknown as Element);
          const view = this.ownerDocument?.defaultView;
          const ResizeObserverCtor =
            view?.ResizeObserver || (globalThis as any).ResizeObserver;
          if (ResizeObserverCtor && sourceElem) {
            const ro = new ResizeObserverCtor(() => {
              if (!this._overlay) return;
              const computed = view?.getComputedStyle(sourceElem);
              const baseBottom = computed?.paddingBottom
                ? parseFloat(computed.paddingBottom)
                : 6;
              const h = sourceElem?.getBoundingClientRect?.().height ?? 0;
              const extra = h ? Math.round(h / 4) : 0;
              this._overlay.style.paddingBottom = `${baseBottom + extra}px`;
            });
            this._sourceResizeObserver = ro;
            ro.observe(sourceElem);
          }
        }
        this._overlay = overlay;
        this.appendChild(overlay);
      }
      if (scrollToken === this._overlayScrollToken) {
        this._restoreOverlayScroll(overlay, prevScrollTop, prevScrollLeft);
      }
      this.toggleAttribute("overlay-visible", true);
      // Only run the expensive selection-lost restoration when there
      // is an active selection to restore.
      if (hasActiveSelection) {
        this._restoreSelectionIfLost();
      }
    };

    if (isOutputArea) {
      // When flushing (translation complete), always do a full re-render
      // to ensure the final output matches renderMathInText on the entire
      // value. During streaming, incremental appends may produce slightly
      // different HTML (e.g. cross-boundary LaTeX commands), so the flush
      // must not short-circuit even if _lastRenderedValue === _value.
      if (
        !flushOutputTail &&
        !isNewOverlay &&
        this._lastRenderedValue === this._value
      ) {
        finishOverlayUpdate(false);
        return;
      }

      if (
        !flushOutputTail &&
        !isNewOverlay &&
        this._lastRenderedValue &&
        this._value.startsWith(this._lastRenderedValue) &&
        this._value.length > this._lastRenderedValue.length
      ) {
        const deltaValue = this._value.slice(this._lastRenderedValue.length);
        const stableLength = this._getStableOutputAppendLength(
          deltaValue,
          flushOutputTail,
        );
        if (stableLength > 0) {
          const stableDelta = deltaValue.slice(0, stableLength);
          if (this._appendRenderedOutputDelta(overlay, stableDelta)) {
            this._lastRenderedValue += stableDelta;
            finishOverlayUpdate(false);
            return;
          }
        }
        // When stableLength <= 0 or incremental append failed, fall
        // through to full re-render. During flush, this ensures trailing
        // content (e.g. \n) is rendered instead of being silently
        // dropped because it looks like an incomplete LaTeX command.
      }

      // Determine how much of the value is safe to render. During
      // streaming, the tail may contain an incomplete LaTeX command or
      // unclosed delimiter that should not be rendered yet.
      let stableLength: number;
      if (flushOutputTail) {
        // On flush, always render the full value.
        stableLength = this._value.length;
      } else {
        // Use the full stable render length (which excludes only the
        // unclosed tail) instead of the boundary-scanned append length.
        // The boundary scan stops at \n and other safe boundaries, but
        // a trailing \n normalizes to nothing, so the rendered HTML
        // would be identical to the previous render — causing content
        // after \n to be stuck until the next boundary arrives.
        const renderLength = this._getStableOutputRenderLength(this._value);
        if (
          renderLength > 0 &&
          this._isStableOutputRenderPrefix(this._value.slice(0, renderLength))
        ) {
          stableLength = renderLength;
        } else {
          // Fall back to boundary scanning for values with unbalanced
          // delimiters or other render-unsafe patterns.
          stableLength = this._getStableOutputAppendLength(this._value, false);
        }
      }
      if (stableLength <= 0 && !flushOutputTail) {
        finishOverlayUpdate(false);
        return;
      }
      const renderSourceValue =
        stableLength > 0 ? this._value.slice(0, stableLength) : this._value;
      // Short-circuit: if the render source hasn't changed since the last
      // full re-render, the rendered HTML is also unchanged — skip the
      // expensive renderMathInText call and DOM update entirely. This is
      // the main bottleneck during streaming when the unclosed math tail
      // prevents new content from being rendered: every tick would
      // otherwise re-run renderMathInText (15+ regex passes + KaTeX) on
      // the same truncated value, producing identical HTML.
      if (
        !flushOutputTail &&
        !isNewOverlay &&
        renderSourceValue === this._lastRenderedValue &&
        this._lastRenderedHtml
      ) {
        finishOverlayUpdate(false);
        return;
      }
      const overlayValue = this._normalizeRenderSource(
        stripCitationMathDelimiters(renderSourceValue),
      );
      const html = renderMathInText(
        this.ownerDocument ?? document,
        overlayValue,
      );
      const renderKey = html;
      if (renderKey !== this._lastRenderedHtml) {
        this._setOverlayHtml(overlay, html);
        this._lastRenderedHtml = renderKey;
      }
      this._lastRenderedValue = renderSourceValue;
      finishOverlayUpdate(false);
      return;
    }

    // --- Non-output-area path (input fields, standalone, etc.) ---
    // When isOutputArea is false, render the full value. For non-output
    // areas we don't need incremental append or stability checks.
    const renderSourceValue = this._value;
    const overlayValue = this._normalizeRenderSource(
      stripCitationMathDelimiters(renderSourceValue),
    );
    const html = renderMathInText(this.ownerDocument ?? document, overlayValue);
    const renderKey = html;
    if (!isNewOverlay && renderKey === this._lastRenderedHtml) {
      finishOverlayUpdate(false);
      return;
    }
    this._setOverlayHtml(overlay, html);
    this._lastRenderedHtml = renderKey;
    this._lastRenderedValue = this._value;
    finishOverlayUpdate();
  }

  private _getStableOutputAppendLength(
    deltaValue: string,
    flushOutputTail = false,
  ): number {
    if (!deltaValue) {
      return 0;
    }
    if (flushOutputTail) {
      return this._isStableOutputRenderPrefix(deltaValue)
        ? deltaValue.length
        : 0;
    }
    const stablePrefixLength = this._getStableOutputRenderLength(deltaValue);
    if (stablePrefixLength <= 0) {
      return 0;
    }
    if (
      this._isStableOutputRenderPrefix(
        deltaValue.slice(0, stablePrefixLength),
      ) &&
      this._canAppendOutputPrefixIndependently(
        deltaValue.slice(0, stablePrefixLength),
      )
    ) {
      return stablePrefixLength;
    }

    const candidates: number[] = [];
    OUTPUT_APPEND_SAFE_BOUNDARY_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OUTPUT_APPEND_SAFE_BOUNDARY_REGEX.exec(deltaValue))) {
      const candidate = match.index + match[0].length;
      if (candidate > stablePrefixLength) {
        break;
      }
      candidates.push(candidate);
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (this._isStableOutputRenderPrefix(deltaValue.slice(0, candidate))) {
        return candidate;
      }
    }
    return 0;
  }

  private _canAppendOutputPrefixIndependently(prefix: string): boolean {
    const value = String(prefix || "");
    if (!value) {
      return false;
    }
    OUTPUT_APPEND_SAFE_BOUNDARY_REGEX.lastIndex = 0;
    let lastBoundary = 0;
    let match: RegExpExecArray | null;
    while ((match = OUTPUT_APPEND_SAFE_BOUNDARY_REGEX.exec(value))) {
      lastBoundary = match.index + match[0].length;
    }
    OUTPUT_APPEND_SAFE_BOUNDARY_REGEX.lastIndex = 0;
    if (lastBoundary === value.length) {
      return true;
    }

    // If the entire prefix is plain text with no math/LaTeX, it can
    // always be appended independently — there are no delimiters that
    // could span a boundary.  This covers short Latin/numeric output
    // where OUTPUT_APPEND_SAFE_BOUNDARY_REGEX doesn't match (it only
    // matches CJK chars, whitespace, and specific punctuation), which
    // previously caused every streaming tick to fall through to a
    // full re-render.
    if (!containsMath(value)) {
      return true;
    }

    const tail = value.slice(-480).trimEnd();
    if (!tail || !containsMath(tail)) {
      return false;
    }
    return (
      /(?:<\/(?:sup|sub)>|\\[)]|[$\uFF04\uFE69]|\})$/iu.test(tail) ||
      /\\(?:approx|times|cdot|%)$/u.test(tail)
    );
  }

  private _getStableOutputRenderLength(text: string): number {
    const value = String(text || "");
    const tail = value.slice(-240);
    const localUnclosedIndex = this._findUnclosedRenderTailStart(tail);
    if (localUnclosedIndex < 0) {
      return value.length;
    }
    return Math.max(0, value.length - tail.length + localUnclosedIndex);
  }

  private _findUnclosedRenderTailStart(tail: string): number {
    const patterns: { regex: RegExp; skipPrefix?: boolean }[] = [
      {
        // Generic: any trailing backslash construct may still grow in the
        // next streamed chunk, so it is held back until flush: a lone
        // trailing backslash, an escaped single char (\%, \$, \&), or a
        // command name (complete or not, optionally with an unclosed
        // brace argument). Even sequences that look like literal escapes
        // (\n, \r, \t) are held: the next chunk could extend them into a
        // real command (\neq, \nu, \rho, \text…), and rendering them
        // early shows raw/partial LaTeX that the final full render then
        // normalizes away — shifting the layout/font of already-output
        // text. The cost is only a one-chunk display delay.
        regex: /\\(?:$|[^A-Za-z]|[A-Za-z]*\s*(?:\{[^{}]*)?)$/u,
      },
      { regex: /[_^]\s*(?:\{[^{}]*)?$/u },
      { regex: /<(?:sup|sub)\b[^>]*>(?:(?!<\/(?:sup|sub)>)[\s\S])*$/iu },
      { regex: /<(?:\/?\w+|\/?\w+\s[^>]*)?$/u },
      { regex: /&(?:#\d{0,8}|#x[0-9a-fA-F]{0,8}|[a-zA-Z]{0,12})?$/u },
    ];
    let earliest = -1;
    const dollarIndices: number[] = [];
    for (let i = 0; i < tail.length; i++) {
      // Fullwidth dollar signs (\uFF04/\uFE69) are converted to $ by the
      // render pipeline, so count them as delimiters too.
      if (tail[i] !== "$" && tail[i] !== "\uFF04" && tail[i] !== "\uFE69") {
        continue;
      }
      let slashCount = 0;
      for (let j = i - 1; j >= 0 && tail[j] === "\\"; j--) {
        slashCount += 1;
      }
      if (slashCount % 2 === 0) {
        dollarIndices.push(i);
      }
    }
    if (dollarIndices.length % 2 === 1) {
      const lastDollar = dollarIndices[dollarIndices.length - 1];
      const afterLastDollar = tail.slice(lastDollar + 1);
      // If the trailing unmatched $ is already followed by a newline or CJK prose
      // outside \text{...}, it is an orphan $ rather than an unclosed streamed formula.
      const afterWithoutTextCmd = afterLastDollar.replace(
        /\\(?:text|mathrm|mathit|mathbf|mathbb|mathsf|textbf|ce|ch)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
        "",
      );
      const alreadyProse =
        afterLastDollar.includes("\n") ||
        /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u3001-\u3011\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f]/u.test(
          afterWithoutTextCmd,
        );
      if (!alreadyProse) {
        earliest = lastDollar;
      }
    }
    const slashIndex = tail.lastIndexOf("\\");
    if (slashIndex >= 0) {
      const commandPrefix = tail.slice(slashIndex + 1);
      // Ignore literal escape sequences (\\n, \\r, \\t, etc.) that
      // _normalizeRenderSource will convert to newlines/whitespace —
      // they are not incomplete LaTeX commands.
      const isLiteralEscape = /^(?:r\\n|n|r|t)(?![a-z])/i.test(commandPrefix);
      if (
        !isLiteralEscape &&
        STREAM_RENDER_COMMANDS.some((command) =>
          command.startsWith(commandPrefix),
        )
      ) {
        earliest = earliest < 0 ? slashIndex : Math.min(earliest, slashIndex);
      }
    }
    for (const { regex, skipPrefix } of patterns) {
      const match = regex.exec(tail);
      if (!match) {
        continue;
      }
      const index = Math.max(
        0,
        match.index + (skipPrefix && match[0][0] !== "$" ? 1 : 0),
      );
      earliest = earliest < 0 ? index : Math.min(earliest, index);
    }
    return earliest;
  }

  private _isStableOutputRenderPrefix(prefix: string): boolean {
    if (!this._hasBalancedOutputScriptDelimiters(prefix)) {
      return false;
    }
    const tail = prefix.slice(-180);
    // Any trailing backslash construct — a command being typed (complete
    // or not, optionally with trailing whitespace or an unclosed brace
    // argument), an escaped char, or a lone backslash — may still grow in
    // the next streamed chunk (\n -> \neq, \t -> \text{...}, \r -> \rho),
    // so treat it as incomplete. It renders on the next chunk or at flush;
    // the cost is only a one-chunk display delay, while rendering it early
    // shows raw LaTeX that the final render normalizes away (layout/font
    // jumps of already-output text).
    if (/\\(?:$|[^A-Za-z]|[A-Za-z]*\s*(?:\{[^{}]*)?)$/.test(tail)) {
      return false;
    }
    if (/[_^]\s*(?:\{[^{}]*)?$/.test(tail)) {
      return false;
    }
    if (/(?<!\\)[$\uFF04\uFE69][^$\uFF04\uFE69]*$/.test(tail)) {
      const rawDollars = (prefix.match(/(?<!\\)[$\uFF04\uFE69]/g) || []).length;
      if (rawDollars % 2 === 1) {
        const repairedPrefix = repairUnmatchedInlineDollars(
          prefix.replace(/\uFF04|\uFE69/g, "$"),
        );
        const repairedTail = repairedPrefix.slice(-180);
        if (/(?<!\\)\$[^$]*$/.test(repairedTail)) {
          const dollars = (repairedPrefix.match(/(?<!\\)\$/g) || []).length;
          if (dollars % 2 === 1) {
            return false;
          }
        }
      }
    }
    if (/<(?:\/?\w+|\/?\w+\s[^>]*)?$/.test(tail)) {
      return false;
    }
    if (/&(?:#\d{0,8}|#x[0-9a-fA-F]{0,8}|[a-zA-Z]{0,12})?$/.test(tail)) {
      return false;
    }
    return true;
  }

  private _hasBalancedOutputScriptDelimiters(text: string): boolean {
    const stack: string[] = [];
    const closing: Record<string, string> = { "{": "}", "[": "]" };
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!(char in closing) && char !== "}" && char !== "]") {
        continue;
      }
      let slashCount = 0;
      for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) {
        slashCount += 1;
      }
      if (slashCount % 2 === 1) {
        continue;
      }
      if (char in closing) {
        stack.push(closing[char]);
      } else if (stack.pop() !== char) {
        return false;
      }
    }
    return stack.length === 0;
  }

  private _appendRenderedOutputDelta(
    overlay: HTMLElement,
    deltaValue: string,
  ): boolean {
    if (!deltaValue) {
      return true;
    }
    const lastParagraph = overlay.lastElementChild as HTMLElement | null;
    if (!lastParagraph?.classList?.contains("zp-paragraph")) {
      return false;
    }

    const leadingBreakLength =
      this._getLeadingOutputParagraphBreakLength(deltaValue);
    const hasPendingParagraphContent =
      this._getLastOutputParagraphStart(this._lastRenderedValue) <
      this._lastRenderedValue.length;
    const startsNewParagraph =
      leadingBreakLength > 0 ||
      (!hasPendingParagraphContent &&
        STREAM_RENDER_TRAILING_NEWLINE_REGEX.test(this._lastRenderedValue));
    const plainAppendValue = deltaValue.slice(leadingBreakLength);
    if (!startsNewParagraph && /^[ \t]*[_^]/.test(plainAppendValue)) {
      // A streamed script belongs to the preceding token (for example
      // `85` followed by `^{\circ}`), so render the paragraph with context.
      return false;
    }
    const previousParagraphStart = this._getLastOutputParagraphStart(
      this._lastRenderedValue,
    );
    const previousParagraphSource = this._lastRenderedValue.slice(
      previousParagraphStart,
    );
    const previousTrailingSpace =
      /[ \t]+$/.exec(previousParagraphSource)?.[0] ?? "";
    const deltaLeadingSpace = /^[ \t]+/.exec(deltaValue)?.[0] ?? "";
    const boundarySpace = previousTrailingSpace + deltaLeadingSpace;
    // Fast path for plain text without math/LaTeX: append directly as
    // a text node without going through renderMathInText.  This covers
    // both CJK and Latin/numeric output, avoiding a full re-render on
    // every streaming tick for short text that has no math.
    // However, if the delta contains newline characters (actual \n or
    // escaped \\n), we must NOT use this fast path — renderMathInText
    // converts \n to <br> and splits into separate zp-paragraph
    // elements, while a text node would collapse \n to whitespace
    // (white-space: normal). This mismatch causes a visible layout
    // shift when flushOutputRender does a full re-render.
    const hasNewlineInDelta =
      STREAM_RENDER_NEWLINE_REGEX.test(plainAppendValue);
    STREAM_RENDER_NEWLINE_REGEX.lastIndex = 0;
    if (
      plainAppendValue.length > 0 &&
      !boundarySpace &&
      !hasNewlineInDelta &&
      !containsMath(plainAppendValue) &&
      // A macron at the delta start combines with the previous chunk's
      // last letter in the final render (x + ˉ → x\textsuperscript{-});
      // re-render with full context instead of appending it standalone.
      !/^(?:\u00AF|\u02C9|\u0304)/.test(plainAppendValue) &&
      // Two adjacent minus signs merge into one during final normalization
      // (−− → −); re-render with context instead of appending.
      !(
        previousParagraphSource.endsWith("\u2212") &&
        plainAppendValue.startsWith("\u2212")
      )
    ) {
      const targetParagraph = startsNewParagraph
        ? ((this.ownerDocument ?? document).createElementNS(
            HTML_NS,
            "div",
          ) as HTMLElement)
        : lastParagraph;
      if (startsNewParagraph) {
        targetParagraph.className = "zp-paragraph";
        overlay.appendChild(targetParagraph);
      }
      // Normalize exactly like the final render: escapeHtml applies
      // hyphenateForWrap(normalizePlainText(text)). Streaming must show
      // the same text the completion render produces, otherwise raw LaTeX
      // (\textbf{}, ~, \\, …) appears during output and the layout/font
      // of already-output text jumps when the translation completes.
      const normalizedAppendValue = normalizePlainText(plainAppendValue);
      if (
        normalizedAppendValue.includes("\n") ||
        normalizedAppendValue.includes("\\") ||
        normalizedAppendValue.includes("$")
      ) {
        // Normalization introduced paragraph breaks (e.g. \\ or \newline),
        // leftover LaTeX markup (e.g. \textsuperscript{...}), or a dollar
        // sign that may belong to a citation split across chunk boundaries
        // ($1, … 2$ becomes superscripts in the final render); fall back
        // to a full re-render so it renders correctly with context.
        return false;
      }
      const hyphenatedValue = hyphenateForWrap(normalizedAppendValue);
      const lastNode = targetParagraph.lastChild;
      if (lastNode?.nodeType === 3) {
        (lastNode as Text).appendData(hyphenatedValue);
      } else {
        targetParagraph.appendChild(
          (this.ownerDocument ?? document).createTextNode(hyphenatedValue),
        );
      }
      return true;
    }
    const newParagraphs = this._createRenderedOutputParagraphs(deltaValue);
    if (!newParagraphs.length) {
      // The delta normalizes to no visible content (e.g. a bare \n which
      // _normalizeRenderSource converts to a newline, then filters out
      // as an empty paragraph). Previously this returned true, which
      // updated _lastRenderedValue without touching the DOM — causing a
      // desync where subsequent appends could not detect the gap and
      // content after \n appeared stuck. Return false so the caller
      // performs a full re-render that correctly normalizes the value.
      return false;
    }
    if (
      newParagraphs.some((paragraph) => paragraph.querySelector(".katex-error"))
    ) {
      // The delta may only be invalid without its preceding token. Let the
      // caller re-render the current paragraph instead of preserving red TeX.
      return false;
    }

    let startIndex: number;
    if (startsNewParagraph) {
      startIndex = 0;
    } else {
      if (boundarySpace) {
        lastParagraph.appendChild(
          (this.ownerDocument ?? document).createTextNode(boundarySpace),
        );
      }
      while (newParagraphs[0].firstChild) {
        lastParagraph.appendChild(newParagraphs[0].firstChild);
      }
      startIndex = 1;
    }

    for (let i = startIndex; i < newParagraphs.length; i++) {
      if (!newParagraphs[i].textContent?.trim()) {
        continue;
      }
      overlay.appendChild(newParagraphs[i]);
    }
    return true;
  }

  private _getLeadingOutputParagraphBreakLength(text: string): number {
    const match = STREAM_RENDER_LEADING_NEWLINE_REGEX.exec(text);
    return match?.[0].length ?? 0;
  }

  private _getLastOutputParagraphStart(text: string): number {
    STREAM_RENDER_NEWLINE_REGEX.lastIndex = 0;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = STREAM_RENDER_NEWLINE_REGEX.exec(text))) {
      start = match.index + match[0].length;
    }
    STREAM_RENDER_NEWLINE_REGEX.lastIndex = 0;
    return start;
  }

  private _createRenderedOutputParagraphs(
    paragraphSource: string,
  ): HTMLElement[] {
    const normalized = this._normalizeRenderSource(
      stripCitationMathDelimiters(paragraphSource),
    );
    if (!normalized) {
      return [];
    }
    const doc = this.ownerDocument ?? document;
    const template = doc.createElement("template");
    template.innerHTML = renderMathInText(doc, normalized);
    return Array.from(
      (template.content as unknown as DocumentFragment).children,
    )
      .filter((child) =>
        (child as HTMLElement).classList?.contains("zp-paragraph"),
      )
      .map((child) => child as HTMLElement);
  }

  private _captureOverlaySelection(): SelectionOffsets | null {
    if (!this._overlay) return null;
    const selection = this.ownerDocument?.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) {
      return null;
    }
    if (
      !this._overlay.contains(anchorNode) ||
      !this._overlay.contains(focusNode)
    ) {
      return null;
    }
    const anchor = this._getOffsetInOverlay(anchorNode, selection.anchorOffset);
    const focus = this._getOffsetInOverlay(focusNode, selection.focusOffset);
    if (selection.isCollapsed) {
      return { start: anchor, end: anchor, anchor, focus: anchor };
    }
    const range = selection.getRangeAt(0);
    if (
      !this._overlay.contains(range.startContainer) ||
      !this._overlay.contains(range.endContainer)
    ) {
      return null;
    }

    const start = this._getOffsetInOverlay(
      range.startContainer,
      range.startOffset,
    );
    const end = this._getOffsetInOverlay(range.endContainer, range.endOffset);
    return { start, end, anchor, focus };
  }

  private _onDocumentSelectionChange = () => {
    if (!this._overlay) {
      this._hasOverlaySelection = false;
      return;
    }
    const selection = this.ownerDocument?.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
      this._hasOverlaySelection = false;
      return;
    }
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const inside =
      !!anchorNode &&
      !!focusNode &&
      this._overlay.contains(anchorNode) &&
      this._overlay.contains(focusNode);
    this._hasOverlaySelection = inside;
    if (inside) {
      if (
        this._isSelectingOverlay &&
        selection.isCollapsed &&
        this._lastSelectionOffsets &&
        this._lastSelectionOffsets.start !== this._lastSelectionOffsets.end
      ) {
        return;
      }
      const offsets = this._captureOverlaySelection();
      if (offsets) {
        this._lastSelectionOffsets = offsets;
      }
    } else if (this._isSelectingOverlay) {
      this._restoreSelectionIfLost();
    }
  };

  private _getOffsetInOverlay(node: Node, offset: number): number {
    if (!this._overlay) return 0;
    const doc = this.ownerDocument;
    if (!doc) return 0;
    try {
      const range = doc.createRange();
      range.selectNodeContents(this._overlay);
      range.setEnd(node, offset);
      return this._getVisibleTextLength(range.cloneContents());
    } catch {
      const textNodes = this._getVisibleTextNodes(this._overlay);
      let total = 0;
      for (const textNode of textNodes) {
        const length = textNode.nodeValue?.length ?? 0;
        if (textNode === node) {
          return total + Math.min(Math.max(offset, 0), length);
        }
        total += length;
      }
      return total;
    }
  }

  private _restoreOverlaySelection(offsets: SelectionOffsets): void {
    if (!this._overlay) return;
    const selection = this.ownerDocument?.getSelection?.();
    const doc = this.ownerDocument;
    if (!selection || !doc) return;

    const anchorPos = this._findTextPosition(this._overlay, offsets.anchor);
    const focusPos = this._findTextPosition(this._overlay, offsets.focus);
    if (anchorPos && focusPos && selection.setBaseAndExtent) {
      selection.removeAllRanges();
      selection.setBaseAndExtent(
        anchorPos.node,
        anchorPos.offset,
        focusPos.node,
        focusPos.offset,
      );
      return;
    }

    const startPos = this._findTextPosition(this._overlay, offsets.start);
    const endPos = this._findTextPosition(this._overlay, offsets.end);
    if (!startPos || !endPos) return;

    const range = doc.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private _findTextPosition(
    root: Node,
    offset: number,
  ): { node: Text; offset: number } | null {
    const textNodes = this._getVisibleTextNodes(root);
    let remaining = Math.max(0, offset);
    let lastNode: Text | null = null;

    for (const node of textNodes) {
      const length = node.nodeValue?.length ?? 0;
      if (remaining <= length) {
        return { node, offset: remaining };
      }
      remaining -= length;
      lastNode = node;
    }

    if (lastNode) {
      const length = lastNode.nodeValue?.length ?? 0;
      return { node: lastNode, offset: length };
    }
    return null;
  }

  private _getVisibleTextNodes(root: Node): Text[] {
    const doc = this.ownerDocument;
    if (!doc) return [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.nodeValue || "";
        if (!text) return NodeFilter.FILTER_REJECT;
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".katex-mathml")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes: Text[] = [];
    let current = walker.nextNode() as Text | null;
    while (current) {
      nodes.push(current);
      current = walker.nextNode() as Text | null;
    }
    return nodes;
  }

  private _getVisibleTextLength(root: Node): number {
    const doc = this.ownerDocument;
    if (!doc) return 0;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.nodeValue || "";
        if (!text) return NodeFilter.FILTER_REJECT;
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".katex-mathml")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let len = 0;
    let current = walker.nextNode() as Text | null;
    while (current) {
      len += current.nodeValue?.length ?? 0;
      current = walker.nextNode() as Text | null;
    }
    return len;
  }

  private _restoreOverlayScroll(
    overlay: HTMLElement,
    top: number,
    left: number,
  ): void {
    overlay.scrollTop = top;
    overlay.scrollLeft = left;
  }

  private _restoreTextboxScroll(top: number, left: number): void {
    const target = this._textbox as any;
    if (!target) {
      return;
    }
    target.scrollTop = top;
    target.scrollLeft = left;
    if (target.inputField) {
      target.inputField.scrollTop = top;
      target.inputField.scrollLeft = left;
    }
  }

  private _getCurrentScrollPosition(): { top: number; left: number } {
    const overlay = this._overlay;
    if (overlay) {
      return {
        top: overlay.scrollTop || this._overlayScrollTop,
        left: overlay.scrollLeft || this._overlayScrollLeft,
      };
    }
    const target = this._textbox as any;
    const inputField = target?.inputField;
    return {
      top: Number(target?.scrollTop || inputField?.scrollTop || 0),
      left: Number(target?.scrollLeft || inputField?.scrollLeft || 0),
    };
  }

  private _hideOverlay(): void {
    if (this._overlay) {
      this._overlayScrollTop = this._overlay.scrollTop;
      this._overlayScrollLeft = this._overlay.scrollLeft;
      this._overlay.remove();
      this._overlay = null;
    }
    if (this._sourceResizeObserver) {
      this._sourceResizeObserver.disconnect();
      this._sourceResizeObserver = null;
    }
    this._isSelectingOverlay = false;
    this._hasOverlaySelection = false;
    this._lastSelectionOffsets = null;
    this._lastRenderedHtml = "";
    this._restoringSelection = false;
    this.toggleAttribute("overlay-visible", false);
  }

  private _onDocumentMouseUp = () => {
    this._isSelectingOverlay = false;
  };

  private _restoreSelectionIfLost(): void {
    if (!this._overlay || !this._isSelectingOverlay) {
      return;
    }
    if (!this._lastSelectionOffsets || this._restoringSelection) {
      return;
    }
    const selection = this.ownerDocument?.getSelection?.();
    if (selection && selection.rangeCount > 0) {
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (
        anchorNode &&
        focusNode &&
        this._overlay.contains(anchorNode) &&
        this._overlay.contains(focusNode)
      ) {
        return;
      }
    }
    this._restoringSelection = true;
    const view = this.ownerDocument?.defaultView;
    const raf = view?.requestAnimationFrame?.bind(view);
    const run = () => {
      if (
        this._overlay &&
        this._isSelectingOverlay &&
        this._lastSelectionOffsets
      ) {
        this._restoreOverlaySelection(this._lastSelectionOffsets);
      }
      this._restoringSelection = false;
    };
    if (raf) {
      raf(run);
    } else {
      setTimeout(run, 0);
    }
  }

  private _setOverlayHtml(
    overlay: HTMLElement,
    html: string,
    forceReplace = false,
  ): void {
    overlay.removeAttribute("data-render-fallback");
    const doc = this.ownerDocument ?? document;
    const template = doc.createElement("template");
    template.innerHTML = html;
    if (forceReplace) {
      overlay.replaceChildren(template.content);
      return;
    }
    // Two paragraphs are considered equal when their HTML matches, or when
    // their visible text matches ignoring soft hyphens. Streaming appends
    // hyphenate per-chunk, so words split across chunks get different soft
    // hyphen positions than the full render — rewriting such paragraphs
    // would reflow already-output text for no visible gain.
    // The comparison also normalizes whitespace (trailing/leading spaces,
    // multiple spaces) because _normalizeRenderSource trims each line in
    // the full-render path but the streaming fast path appends text nodes
    // without trimming, so the raw innerHTML may differ by whitespace even
    // though the visible text is identical.
    const paragraphsEqual = (a: HTMLElement, b: HTMLElement): boolean => {
      if (a.innerHTML === b.innerHTML) {
        return true;
      }
      // For paragraphs with math markup, compare innerHTML with soft
      // hyphens and whitespace stripped. KaTeX HTML never contains soft
      // hyphens, so if the stripped HTML matches, the KaTeX structure is
      // identical and only the plain-text soft hyphen positions or
      // trailing whitespace differ. Skipping the rewrite avoids
      // re-parsing and re-laying-out the KaTeX spans.
      const stripLight = (s: string) => s.replace(/\u00AD/g, "");
      if (a.querySelector(".katex") || b.querySelector(".katex")) {
        return stripLight(a.innerHTML) === stripLight(b.innerHTML);
      }
      // For plain-text paragraphs, compare visible text ignoring soft
      // hyphens and collapsing whitespace. This catches cases where the
      // streaming fast path appended a trailing space that the full
      // render trims via _normalizeRenderSource + wrapParagraphs.
      const stripFull = (s: string | undefined) =>
        (s ?? "")
          .replace(/\u00AD/g, "")
          .replace(/\s+/g, " ")
          .trim();
      return stripFull(a.textContent) === stripFull(b.textContent);
    };
    // If overlay already has paragraph children, update them in-place
    // to avoid layout shifting caused by replacing the whole overlay.
    const newChildren = Array.from(
      (template.content as unknown as DocumentFragment).children,
    ) as HTMLElement[];
    const existing = Array.from(overlay.children) as HTMLElement[];
    const allAreParagraphs =
      existing.length > 0 &&
      existing.every(
        (c) => c.classList && c.classList.contains("zp-paragraph"),
      );
    const newAllParagraphs =
      newChildren.length > 0 &&
      newChildren.every(
        (c) => c.classList && c.classList.contains("zp-paragraph"),
      );

    if (allAreParagraphs && newAllParagraphs) {
      if (existing.length === newChildren.length) {
        for (let i = 0; i < existing.length; i++) {
          // Skip paragraphs whose content is unchanged. Rewriting identical
          // innerHTML re-parses and re-lays-out already-output text,
          // causing visible font/layout shifts when streaming completes.
          if (paragraphsEqual(existing[i], newChildren[i])) {
            continue;
          }
          // replace only innerHTML to keep element references stable
          existing[i].innerHTML = newChildren[i].innerHTML;
        }
        return;
      }
      // When new content has more paragraphs (e.g. streaming completion
      // adds remaining paragraphs), update existing paragraphs in-place
      // and append the extra ones. This avoids a full replaceChildren
      // which causes visible layout flicker.
      if (newChildren.length > existing.length) {
        const minLen = Math.min(existing.length, newChildren.length);
        for (let i = 0; i < minLen; i++) {
          if (paragraphsEqual(existing[i], newChildren[i])) {
            continue;
          }
          existing[i].innerHTML = newChildren[i].innerHTML;
        }
        for (let i = minLen; i < newChildren.length; i++) {
          overlay.appendChild(newChildren[i]);
        }
        return;
      }
      // New content has fewer paragraphs — update in-place and remove extras
      const minLen = Math.min(existing.length, newChildren.length);
      for (let i = 0; i < minLen; i++) {
        if (paragraphsEqual(existing[i], newChildren[i])) {
          continue;
        }
        existing[i].innerHTML = newChildren[i].innerHTML;
      }
      for (let i = existing.length - 1; i >= minLen; i--) {
        existing[i].remove();
      }
      return;
    }

    overlay.replaceChildren(template.content);
  }

  private _setOverlayPlainText(overlay: HTMLElement, text: string): void {
    const doc = this.ownerDocument ?? document;
    const normalized = this._normalizePlainFallbackSource(text);
    const lines = normalized.split("\n").filter((line) => line.trim());
    const fragment = doc.createDocumentFragment();
    for (const line of lines) {
      const paragraph = doc.createElementNS(HTML_NS, "div") as HTMLElement;
      paragraph.className = "zp-paragraph";
      this._appendPlainFallbackNodes(paragraph, line);
      fragment.appendChild(paragraph);
    }
    overlay.setAttribute("data-render-fallback", "true");
    overlay.replaceChildren(fragment);
  }

  private _normalizeRenderSource(text: string): string {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\\r\\n|\\n(?![a-z])|\\r(?![a-z])/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }

  private _appendPlainFallbackNodes(parent: HTMLElement, text: string): void {
    const doc = this.ownerDocument ?? document;
    const normalizedText = this._normalizeLatexTextScripts(text);
    const scriptRegex =
      /\\(textsuperscript|textsubscript)\s*(?:\{([^{}]*)\}|\[([^\]]*)\]|([+\-\u2212\u2010-\u2015]?\d+(?:\.\d+)?))|<(sup|sub)\b[^>]*>([\s\S]*?)<\/\5>/gi;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const appendText = (value: string) => {
      const cleaned = this._cleanPlainFallbackSegment(value);
      if (cleaned) {
        parent.appendChild(doc.createTextNode(cleaned));
      }
    };

    while ((match = scriptRegex.exec(normalizedText)) !== null) {
      appendText(normalizedText.slice(lastIndex, match.index));
      const tagName =
        match[1] === "textsuperscript" || match[5]?.toLowerCase() === "sup"
          ? "sup"
          : "sub";
      const scriptNode = doc.createElementNS(HTML_NS, tagName) as HTMLElement;
      scriptNode.textContent = this._cleanPlainFallbackSegment(
        match[2] ?? match[3] ?? match[4] ?? match[6] ?? "",
      );
      parent.appendChild(scriptNode);
      lastIndex = match.index + match[0].length;
    }
    appendText(normalizedText.slice(lastIndex));

    if (!parent.childNodes.length) {
      parent.textContent = "\u00A0";
    }
  }

  private _renderedHtmlLooksComplete(html: string, source: string): boolean {
    const comparableSource = this._toComparableDisplayText(source);
    if (comparableSource.length < 24) {
      return true;
    }

    try {
      const doc = this.ownerDocument ?? document;
      const template = doc.createElement("template");
      template.innerHTML = html;
      const renderedText = this._getVisibleText(template.content);
      return this._visibleTextLooksComplete(renderedText, source);
    } catch {
      return false;
    }
  }

  private _visibleTextLooksComplete(
    visibleText: string,
    source: string,
  ): boolean {
    const comparableSource = this._toComparableDisplayText(source);
    if (comparableSource.length < 24) {
      return true;
    }
    const comparableRendered = this._toComparableDisplayText(visibleText);
    if (!comparableRendered) {
      return false;
    }
    const minimumRenderedLength = Math.floor(
      comparableSource.length * OUTPUT_COMPLETION_MIN_RATIO,
    );
    if (comparableRendered.length < minimumRenderedLength) {
      return false;
    }
    const tailLength = Math.min(
      64,
      Math.max(24, Math.floor(comparableSource.length * 0.08)),
    );
    const tail = comparableSource.slice(-tailLength);
    const tailIndex = comparableRendered.lastIndexOf(tail);
    if (tailIndex < 0) {
      return false;
    }
    const trailingGap = comparableRendered.length - (tailIndex + tail.length);
    return (
      trailingGap <= Math.max(16, Math.floor(comparableSource.length * 0.03))
    );
  }

  private _getVisibleText(root: Node): string {
    return this._getVisibleTextNodes(root)
      .map((node) => node.nodeValue || "")
      .join("");
  }

  private _toComparableDisplayText(text: string): string {
    return this._toPlainFallbackText(text)
      .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\u2212\u2010-\u2015]/g, "-")
      .normalize("NFKC")
      .replace(/\s+/gu, "");
  }

  private _normalizePlainFallbackSource(text: string): string {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\\r\\n|\\n(?![a-z])|\\r(?![a-z])/g, "\n")
      .replace(
        /\\(?:section|subsection|subsubsection)\*?\s*\{([^{}]*)\}/g,
        "$1",
      )
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  private _cleanPlainFallbackSegment(text: string): string {
    return String(text || "")
      .replace(/\\circ\b/g, "\u00B0")
      .replace(
        /\\(?:mathrm|mathit|mathbf|mathbb|mathsf|text)\s*\{([^{}]*)\}/g,
        "$1",
      )
      .replace(/\\(?:ce|ch)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\([%$&#_{}])/g, "$1")
      .replace(/\\(?:,|;|:|!|quad\b|qquad\b)/g, " ")
      .replace(/\\[A-Za-z]+\*?/g, "")
      .replace(/\\(?![A-Za-z])/g, "")
      .replace(/[ \t]+/g, " ");
  }

  private _normalizeLatexTextScripts(text: string): string {
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
        /([A-Za-z][A-Za-z0-9]*)\s*\^\s*(?:\u00AF|\u02C9|\u0304)/g,
        "$1\\textsuperscript{-}",
      )
      .replace(
        /([A-Za-z][A-Za-z0-9]*)\s*(?:\u00AF|\u02C9|\u0304)/g,
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
      .replace(
        /\^\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?/g,
        "\\textsuperscript{$1}",
      )
      .replace(/_\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?/g, "\\textsubscript{$1}");
  }

  private _toPlainFallbackText(text: string): string {
    return this._normalizeLatexTextScripts(text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\\r\\n|\\n(?![a-z])|\\r(?![a-z])/g, "\n")
      .replace(/\$\s*[_^]\s*\{?\s*\\text\s*\{([^{}]*)\}\s*\}?\s*\$/g, "$1")
      .replace(/\$\s*[_^]\s*\{([^{}]*)\}\s*\$/g, "$1")
      .replace(/\$\s*[_^]\s*([^$\s{}]+)\s*\$/g, "$1")
      .replace(
        /\$\s*\\(?:mathrm|mathit|mathbf|mathbb|mathsf|text)\s*\{([^{}]*)\}\s*\$/g,
        "$1",
      )
      .replace(/\$\s*([^$\n]{1,64}?)\s*\$/g, "$1")
      .replace(/<(?:sup|sub)\b[^>]*>([\s\S]*?)<\/(?:sup|sub)>/gi, "$1")
      .replace(/\\(?:textsuperscript|textsubscript)\s*\{([^{}]*)\}/g, "$1")
      .replace(
        /\\(?:mathrm|mathit|mathbf|mathbb|mathsf|text)\s*\{([^{}]*)\}/g,
        "$1",
      )
      .replace(/\\(?:ce|ch)\s*\{([^{}]*)\}/g, "$1")
      .replace(
        /\\(?:section|subsection|subsubsection)\*?\s*\{([^{}]*)\}/g,
        "$1",
      )
      .replace(/\\([%$&#_{}])/g, "$1")
      .replace(/\\(?:,|;|:|!|quad\b|qquad\b)/g, " ")
      .replace(/\\[A-Za-z]+\*?/g, "")
      .replace(/\\(?![A-Za-z])/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  destroy(): void {
    this._cancelRender();
    this._hideOverlay();
    if (this._textbox) {
      this._textbox.removeEventListener("input", this._onInput);
      this._textbox.removeEventListener("focus", this._onFocus);
      this._textbox.removeEventListener("blur", this._onBlur);
    }
    this.ownerDocument?.removeEventListener("mouseup", this._onDocumentMouseUp);
    this.ownerDocument?.removeEventListener(
      "selectionchange",
      this._onDocumentSelectionChange,
    );
  }
}
