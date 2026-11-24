export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type SelectionFragment = {
  text: string;
  rect: RectLike;
  order: number;
  hasEOL?: boolean;
};

export type SelectionLine = RectLike & {
  text: string;
  fragments: SelectionFragment[];
  order: number;
};

export type SelectionColumn = RectLike & {
  lines: SelectionLine[];
};

export type PdfPageChar = {
  c?: string;
  u?: string;
  rect?: number[];
  inlineRect?: number[];
  rotation?: number;
  fontName?: string;
  fontSize?: number;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
  ignorable?: boolean;
  isolated?: boolean;
  offset?: number;
};

export type StructuredPageSelectionSlice = {
  pageIndex: number;
  pageChars: PdfPageChar[];
  startOffset: number;
  endOffset: number;
};

type StructuredPageLine = RectLike & {
  bodyTop: number;
  bodyBottom: number;
  bodyHeight: number;
  pageIndex: number;
  fullText: string;
  selectedText: string;
  fontSize: number;
  fontName: string;
  firstWordWidth: number;
  zoteroParagraphBreakAfter: boolean;
  endsWithIgnorableBreak: boolean;
  startsSelected: boolean;
  endsSelected: boolean;
  runIndex: number;
};

type ColumnRunMetrics = {
  colLeft: number;
  colRight: number;
  colWidth: number;
  medianHeight: number;
  medianFontSize: number;
  normalLineGap: number;
  normalLineStep: number;
};

const SENTENCE_END_REGEX =
  /(?:[.!?]["')\]\u201d\u2019]*|[:\u3002\uff01\uff1f\uff1a]["')\]\u201d\u2019\u300d\u300f\u3011]*|(?<=[A-Za-z)\]"'\u201d\u2019])\.(?:\d{1,3}(?:[,\-\u2013]\d{1,3})*|[\u00b9\u00b2\u00b3\u2070-\u2079]+)|(?<=[A-Za-z\u00C0-\u024F])\.(?:\s*\[\d+(?:[,\-\u2013]\d+)*\]))$/u;
const TRAILING_ABBREV_NON_END_REGEX =
  /\b(?:Fig|Figs|Eq|Eqs|Ref|Refs|Sec|Tab|Vol|No|pp|cf|vs|e\.g|i\.e|Dr|Prof|Mr|Mrs|Ms|St)\.$/i;
const CJK_EDGE_REGEX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const BULLET_ITEM_START_REGEX = /^\s*[\u2022\u25cf\u25aa\u25e6]\s+/u;
const NUMBERED_ITEM_START_REGEX =
  /^\s*(?:\[\d{1,4}\]|\(\d{1,2}\)|\d{1,2}\.)\s+(?:\p{Lu}|[\u3400-\u9fff])/u;
const ARTICLE_SECTION_LABEL_REGEX =
  /^(?:abstract|summary|introduction|background|results?(?:\s+and\s+discussion)?|discussion|conclusions?|methods?|materials\s+and\s+methods|experimental(?:\s+(?:section|procedures?))?|references|acknowledg(?:e)?ments?|data\s+availability|supporting\s+information|supplementary\s+(?:information|materials?))$/iu;
const LEADING_ARTICLE_SECTION_LABEL_REGEX =
  /^(abstract|summary|introduction|background|results?(?:\s+and\s+discussion)?|discussion|conclusions?|methods?|materials\s+and\s+methods|experimental(?:\s+(?:section|procedures?))?|references|acknowledg(?:e)?ments?|data\s+availability|supporting\s+information|supplementary\s+(?:information|materials?))\s+/iu;

export function extractParagraphsFromStructuredSlices(
  slices: StructuredPageSelectionSlice[],
): string {
  if (!slices.length) {
    return "";
  }

  const sortedSlices = [...slices].sort((a, b) => a.pageIndex - b.pageIndex);
  const allSelectedLines: StructuredPageLine[] = [];
  const allRunMetrics = new Map<string, ColumnRunMetrics>();
  let totalZoteroBreaks = 0;
  let midSentenceZoteroBreaks = 0;

  for (const slice of sortedSlices) {
    const pageLines = buildStructuredPageLines(slice);
    if (!pageLines.length) {
      continue;
    }

    const runs = assignStructuredColumnRuns(pageLines);
    runs.forEach((runLines, runIdx) => {
      allRunMetrics.set(
        `${slice.pageIndex}:${runIdx}`,
        computeStructuredRunMetrics(runLines),
      );
    });

    for (const line of pageLines) {
      if (line.zoteroParagraphBreakAfter) {
        totalZoteroBreaks += 1;
        if (
          !endsSentence(line.fullText) &&
          !isLikelyHeadingText(line.fullText)
        ) {
          midSentenceZoteroBreaks += 1;
        }
      }
      if (line.selectedText) {
        allSelectedLines.push(line);
      }
    }
  }

  if (!allSelectedLines.length) {
    return "";
  }

  const isOcrNoisy =
    midSentenceZoteroBreaks >= 3 &&
    midSentenceZoteroBreaks / Math.max(1, totalZoteroBreaks) >= 0.3;

  const paragraphs: StructuredPageLine[][] = [[allSelectedLines[0]]];
  for (let i = 1; i < allSelectedLines.length; i++) {
    const prev = allSelectedLines[i - 1];
    const curr = allSelectedLines[i];
    const next =
      i + 1 < allSelectedLines.length ? allSelectedLines[i + 1] : undefined;
    const prevRun = allRunMetrics.get(`${prev.pageIndex}:${prev.runIndex}`)!;
    const currRun = allRunMetrics.get(`${curr.pageIndex}:${curr.runIndex}`)!;

    if (
      shouldStartNewStructuredParagraph(
        prev,
        curr,
        next,
        prevRun,
        currRun,
        isOcrNoisy,
      )
    ) {
      paragraphs.push([curr]);
    } else {
      paragraphs[paragraphs.length - 1].push(curr);
    }
  }

  return paragraphs
    .map((paragraphLines) => joinStructuredParagraphLines(paragraphLines))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildStructuredPageLines(
  slice: StructuredPageSelectionSlice,
): StructuredPageLine[] {
  const { pageIndex, pageChars } = slice;
  const startOffset = Math.max(
    0,
    Math.min(slice.startOffset, pageChars.length),
  );
  const endOffset = Math.max(
    startOffset,
    Math.min(slice.endOffset, pageChars.length),
  );
  if (!pageChars.length || startOffset >= endOffset) {
    return [];
  }

  const hasExplicitLineBreaks = pageChars.some((ch) =>
    Boolean(ch.lineBreakAfter),
  );
  const lineRanges: Array<{ start: number; end: number }> = [];

  if (hasExplicitLineBreaks) {
    let lineStart = 0;
    for (let i = 0; i < pageChars.length; i++) {
      if (pageChars[i].lineBreakAfter || i === pageChars.length - 1) {
        lineRanges.push({ start: lineStart, end: i });
        lineStart = i + 1;
      }
    }
  } else {
    let lineStart = 0;
    let prevRect: RectLike | undefined;
    for (let i = 0; i < pageChars.length; i++) {
      const currRect = getReadingCharRect(pageChars[i]);
      if (
        prevRect &&
        currRect &&
        Math.abs(
          (currRect.top + currRect.bottom) / 2 -
            (prevRect.top + prevRect.bottom) / 2,
        ) > Math.max(4, Math.min(prevRect.height, currRect.height) * 0.6)
      ) {
        lineRanges.push({ start: lineStart, end: i - 1 });
        lineStart = i;
        prevRect = currRect;
      } else if (currRect) {
        prevRect = prevRect ? unionRects([prevRect, currRect]) : currRect;
      }
    }
    if (lineStart < pageChars.length) {
      lineRanges.push({ start: lineStart, end: pageChars.length - 1 });
    }
  }

  const lines: StructuredPageLine[] = [];
  for (const { start, end } of lineRanges) {
    const lineChars = pageChars.slice(start, end + 1);
    const fullText = buildCharsLineText(lineChars);
    if (!fullText) {
      continue;
    }

    const charRects = lineChars
      .filter((ch) => !ch.ignorable)
      .map(getReadingCharRect)
      .filter((r): r is RectLike => Boolean(r));
    const fallbackRects = charRects.length
      ? charRects
      : lineChars
          .map(getReadingCharRect)
          .filter((r): r is RectLike => Boolean(r));
    const lineRect = unionRects(fallbackRects);
    if (!lineRect) {
      continue;
    }

    const fontSizes = lineChars
      .filter(
        (ch) =>
          !ch.ignorable && typeof ch.fontSize === "number" && ch.fontSize > 0,
      )
      .map((ch) => ch.fontSize as number);
    const fontSize = median(fontSizes) || lineRect.height || 10;

    const mainFontRects = lineChars
      .filter(
        (ch) =>
          !ch.ignorable &&
          (typeof ch.fontSize !== "number" || ch.fontSize >= fontSize * 0.85),
      )
      .map(getReadingCharRect)
      .filter((r): r is RectLike => Boolean(r));
    const bodyRect = unionRects(mainFontRects) || lineRect;
    const fontName = getDominantFontName(lineChars);
    const firstWordWidth = computeFirstWordWidth(lineChars, fontSize);

    const lastChar = lineChars[lineChars.length - 1];
    let lastNonIgnorable: PdfPageChar | undefined;
    for (let k = lineChars.length - 1; k >= 0; k--) {
      if (!lineChars[k].ignorable) {
        lastNonIgnorable = lineChars[k];
        break;
      }
    }

    const zoteroParagraphBreakAfter = Boolean(
      lastChar?.paragraphBreakAfter || lastNonIgnorable?.paragraphBreakAfter,
    );
    const endsWithIgnorableBreak = Boolean(
      lastChar?.ignorable && lastChar?.lineBreakAfter,
    );

    const selStart = Math.max(start, startOffset);
    const selEnd = Math.min(end + 1, endOffset);
    const selectedChars =
      selStart < selEnd ? pageChars.slice(selStart, selEnd) : [];
    const selectedText = selectedChars.length
      ? buildCharsLineText(selectedChars)
      : "";

    const selectedLastChar = selectedChars[selectedChars.length - 1];
    const selectedEndsWithIgnorableBreak =
      selEnd > end
        ? endsWithIgnorableBreak
        : Boolean(
            selectedLastChar?.ignorable && selectedLastChar?.lineBreakAfter,
          );

    lines.push({
      ...lineRect,
      bodyTop: bodyRect.top,
      bodyBottom: bodyRect.bottom,
      bodyHeight: bodyRect.height || lineRect.height,
      pageIndex,
      fullText,
      selectedText,
      fontSize,
      fontName,
      firstWordWidth,
      zoteroParagraphBreakAfter,
      endsWithIgnorableBreak: selectedEndsWithIgnorableBreak,
      startsSelected: selStart === start,
      endsSelected: selEnd > end,
      runIndex: 0,
    });
  }

  return mergeSplitInlineStructuredLines(lines);
}

function mergeSplitInlineStructuredLines(
  lines: StructuredPageLine[],
): StructuredPageLine[] {
  if (lines.length <= 1) {
    return lines;
  }

  const merged: StructuredPageLine[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = lines[i];

    const verticalOverlap =
      Math.min(prev.bottom, curr.bottom) - Math.max(prev.top, curr.top);
    const minHeight = Math.min(prev.height, curr.height);
    const maxHeight = Math.max(prev.height, curr.height);
    const prevCenter = (prev.top + prev.bottom) / 2;
    const currCenter = (curr.top + curr.bottom) / 2;
    const verticallySameLine =
      verticalOverlap > minHeight * 0.2 ||
      Math.abs(prevCenter - currCenter) <= maxHeight * 0.55;

    const horizontalGap = curr.left - prev.right;
    const inlineAdjacent =
      horizontalGap >= -4 && horizontalGap <= maxHeight * 1.8;

    const isInlineFragment =
      curr.fontSize <= prev.fontSize * 0.9 ||
      prev.fontSize <= curr.fontSize * 0.9 ||
      curr.width <= maxHeight * 3.5 ||
      prev.width <= maxHeight * 3.5;

    if (verticallySameLine && inlineAdjacent && isInlineFragment) {
      const insertSpace =
        horizontalGap >
        Math.max(1.5, Math.min(prev.fontSize, curr.fontSize) * 0.22);
      const joinText = (a: string, b: string) => {
        if (!a) return b;
        if (!b) return a;
        return insertSpace ? a + " " + b : a + b;
      };

      prev.fullText = joinText(prev.fullText, curr.fullText);
      if (prev.selectedText || curr.selectedText) {
        prev.selectedText = joinText(prev.selectedText, curr.selectedText);
      }
      prev.left = Math.min(prev.left, curr.left);
      prev.top = Math.min(prev.top, curr.top);
      prev.right = Math.max(prev.right, curr.right);
      prev.bottom = Math.max(prev.bottom, curr.bottom);
      prev.width = prev.right - prev.left;
      prev.height = prev.bottom - prev.top;
      if (curr.fontSize >= prev.fontSize * 0.85) {
        prev.bodyTop = Math.min(prev.bodyTop, curr.bodyTop);
        prev.bodyBottom = Math.max(prev.bodyBottom, curr.bodyBottom);
        prev.bodyHeight = prev.bodyBottom - prev.bodyTop;
      }
      prev.fontSize = Math.max(prev.fontSize, curr.fontSize);
      prev.zoteroParagraphBreakAfter = curr.zoteroParagraphBreakAfter;
      prev.endsWithIgnorableBreak = curr.endsWithIgnorableBreak;
      prev.endsSelected = curr.endsSelected;
      continue;
    }

    merged.push(curr);
  }

  return merged;
}

function getReadingCharRect(ch: PdfPageChar): RectLike | undefined {
  const raw = ch.inlineRect || ch.rect;
  if (!raw || typeof raw.length !== "number" || raw.length < 4) {
    return undefined;
  }
  const x1 = Number(raw[0]);
  const y1 = Number(raw[1]);
  const x2 = Number(raw[2]);
  const y2 = Number(raw[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return undefined;
  }
  const rotation = ch.rotation || 0;
  if (rotation === 90) {
    return normalizeRect([y1, x1, y2, x2]);
  }
  if (rotation === 180) {
    return normalizeRect([-x2, y1, -x1, y2]);
  }
  if (rotation === 270) {
    return normalizeRect([-y2, -x2, -y1, -x1]);
  }
  return normalizeRect([x1, -y2, x2, -y1]);
}

function buildCharsLineText(chars: PdfPageChar[]): string {
  let out = "";
  for (const ch of chars) {
    if (ch.ignorable) {
      continue;
    }
    const piece = ch.c ?? ch.u ?? "";
    if (piece) {
      out += piece;
    }
    if (ch.spaceAfter) {
      out += " ";
    }
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

function getDominantFontName(chars: PdfPageChar[]): string {
  const counts = new Map<string, number>();
  for (const ch of chars) {
    if (ch.ignorable || !ch.fontName) {
      continue;
    }
    counts.set(ch.fontName, (counts.get(ch.fontName) || 0) + 1);
  }
  let bestName = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestName = name;
    }
  }
  return bestName;
}

function computeFirstWordWidth(chars: PdfPageChar[], fontSize: number): number {
  const tokenRects: RectLike[] = [];
  let started = false;
  for (const ch of chars) {
    if (ch.ignorable) {
      continue;
    }
    const piece = ch.c ?? ch.u ?? "";
    if (!started && (!piece || /^\s+$/u.test(piece))) {
      continue;
    }
    if (started && (!piece || /^\s+$/u.test(piece))) {
      break;
    }
    started = true;
    const rect = getReadingCharRect(ch);
    if (rect) {
      tokenRects.push(rect);
    }
    if (ch.spaceAfter) {
      break;
    }
  }
  const union = unionRects(tokenRects);
  return union ? union.width : fontSize * 2;
}

function assignStructuredColumnRuns(
  lines: StructuredPageLine[],
): StructuredPageLine[][] {
  if (!lines.length) {
    return [];
  }

  const pageMinLeft = Math.min(...lines.map((l) => l.left));
  const pageMaxRight = Math.max(...lines.map((l) => l.right));
  const pageWidth = Math.max(40, pageMaxRight - pageMinLeft);

  const runs: StructuredPageLine[][] = [[lines[0]]];
  let runLeft = lines[0].left;
  let runRight = lines[0].right;
  lines[0].runIndex = 0;

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : undefined;
    const currentRun = runs[runs.length - 1];
    const runWidth = Math.max(10, runRight - runLeft);

    const jumpedUp =
      curr.top < prev.top - Math.max(prev.height, curr.height) * 0.6;
    const disjointRight = curr.left > runRight + 6;
    const disjointLeft = curr.right < runLeft - 6;

    const wideToNarrowTransition =
      currentRun.length >= 2 &&
      runWidth > pageWidth * 0.64 &&
      curr.width < pageWidth * 0.5 &&
      curr.right < runRight - pageWidth * 0.16 &&
      (!next ||
        (next.width < pageWidth * 0.5 &&
          next.right < runRight - pageWidth * 0.16));

    const narrowToWideTransition =
      currentRun.length >= 2 &&
      runWidth < pageWidth * 0.54 &&
      curr.width > pageWidth * 0.64 &&
      curr.right > runRight + Math.max(runWidth * 0.35, 30);

    if (
      jumpedUp ||
      disjointRight ||
      disjointLeft ||
      wideToNarrowTransition ||
      narrowToWideTransition
    ) {
      const newRunIdx = runs.length;
      curr.runIndex = newRunIdx;
      runs.push([curr]);
      runLeft = curr.left;
      runRight = curr.right;
      continue;
    }

    curr.runIndex = runs.length - 1;
    currentRun.push(curr);
    runLeft = Math.min(runLeft, curr.left);
    runRight = Math.max(runRight, curr.right);
  }

  return runs;
}

function computeStructuredRunMetrics(
  runLines: StructuredPageLine[],
): ColumnRunMetrics {
  const allFontSizes = runLines.map((l) => l.fontSize).filter((s) => s > 0);
  const runMedianFontSize = median(allFontSizes) || 10;
  const bodyLinesRaw = runLines.filter(
    (l) =>
      Math.abs(l.fontSize - runMedianFontSize) <= 1.5 &&
      l.fullText.length >= 12,
  );
  const bodyLines = bodyLinesRaw.length >= 2 ? bodyLinesRaw : runLines;

  const lefts = bodyLines.map((l) => l.left);
  const rights = bodyLines.map((l) => l.right);
  const colLeft =
    findDominantMargin(lefts, 2.5, "min") ?? percentile(lefts, 0.2);
  const rightCandidate = findDominantRightMargin(rights, 3.5);
  const colRight = rightCandidate ?? percentile(rights, 0.8);
  const colWidth = Math.max(20, colRight - colLeft);

  const heights = bodyLines.map((l) => l.bodyHeight).filter((h) => h > 0);
  const medianHeight = median(heights) || runMedianFontSize || 10;

  const gaps: number[] = [];
  const steps: number[] = [];
  for (let i = 1; i < runLines.length; i++) {
    const gap = runLines[i].bodyTop - runLines[i - 1].bodyBottom;
    const step = runLines[i].bodyTop - runLines[i - 1].bodyTop;
    if (gap >= -2 && gap <= medianHeight * 1.4) {
      gaps.push(gap);
    }
    if (step > 0 && step <= medianHeight * 2.6) {
      steps.push(step);
    }
  }

  const normalLineGap = gaps.length
    ? percentile(gaps, 0.35)
    : medianHeight * 0.2;
  const normalLineStep = steps.length
    ? percentile(steps, 0.35)
    : medianHeight * 1.25;

  return {
    colLeft,
    colRight,
    colWidth,
    medianHeight,
    medianFontSize: runMedianFontSize,
    normalLineGap,
    normalLineStep,
  };
}

function findDominantMargin(
  values: number[],
  tolerance: number,
  tieBreak: "min" | "max",
): number | undefined {
  if (values.length < 2) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  let bestCount = 0;
  let bestValue: number | undefined;

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    const members = sorted.filter((v) => Math.abs(v - anchor) <= tolerance);
    if (members.length < 2) {
      continue;
    }
    const avg = median(members);
    if (
      members.length > bestCount ||
      (members.length === bestCount &&
        bestValue !== undefined &&
        (tieBreak === "min" ? avg < bestValue : avg > bestValue))
    ) {
      bestCount = members.length;
      bestValue = avg;
    }
  }
  return bestValue;
}

function findDominantRightMargin(
  values: number[],
  tolerance: number,
): number | undefined {
  if (values.length < 2) {
    return undefined;
  }
  const upperHalfThreshold = percentile(values, 0.45);
  const upperValues = values.filter((v) => v >= upperHalfThreshold - tolerance);
  return findDominantMargin(
    upperValues.length >= 2 ? upperValues : values,
    tolerance,
    "max",
  );
}

function shouldStartNewStructuredParagraph(
  prev: StructuredPageLine,
  curr: StructuredPageLine,
  next: StructuredPageLine | undefined,
  prevRun: ColumnRunMetrics,
  currRun: ColumnRunMetrics,
  isOcrNoisy: boolean,
): boolean {
  const prevEndedSentence = endsSentence(prev.fullText);
  const currStartsCandidate = startsParagraphCandidate(curr.fullText);
  const prevHeading = isStructuredHeadingLine(prev, prevRun);
  const currHeading = isStructuredHeadingLine(curr, currRun);

  if (prevHeading || currHeading) {
    return true;
  }

  if (BULLET_ITEM_START_REGEX.test(curr.fullText)) {
    return true;
  }

  const currIndent = curr.left - currRun.colLeft;
  const currIndentThreshold = Math.max(currRun.medianFontSize * 0.55, 5);
  const currIndented =
    currIndent > currIndentThreshold && currIndent < currRun.colWidth * 0.45;

  const prevShortThreshold = Math.max(
    prevRun.medianFontSize * 2.2,
    prevRun.colWidth * 0.12,
  );
  const prevRemaining = prevRun.colRight - prev.right;
  const prevMeaningfullyShort =
    prevRemaining > prevShortThreshold &&
    (prevRemaining > curr.firstWordWidth + prevRun.medianFontSize * 0.8 ||
      prevRemaining > prevRun.colWidth * 0.25);

  const sameColumnRun =
    prev.pageIndex === curr.pageIndex && prev.runIndex === curr.runIndex;

  if (!sameColumnRun) {
    if (!prevEndedSentence) {
      return false;
    }
    if (
      currIndented ||
      prevMeaningfullyShort ||
      NUMBERED_ITEM_START_REGEX.test(curr.fullText)
    ) {
      return true;
    }
    return false;
  }

  const run = currRun;
  const gap = curr.bodyTop - prev.bodyBottom;
  const step = curr.bodyTop - prev.bodyTop;

  const clearGap =
    gap >
      run.normalLineGap +
        Math.max(run.medianHeight * 0.28, run.medianFontSize * 0.25, 2.5) &&
    step > run.normalLineStep * 1.24;
  const largeGap =
    gap >
    run.normalLineGap +
      Math.max(run.medianHeight * 0.5, run.medianFontSize * 0.45, 4.5);

  if (largeGap) {
    return true;
  }
  if (clearGap && (prevEndedSentence || prevMeaningfullyShort)) {
    return true;
  }

  if (
    NUMBERED_ITEM_START_REGEX.test(curr.fullText) &&
    (prevEndedSentence || prevMeaningfullyShort || clearGap)
  ) {
    return true;
  }

  if (
    Math.abs(curr.fontSize - prev.fontSize) > 1.2 &&
    (prevEndedSentence || prev.fontName !== curr.fontName)
  ) {
    return true;
  }

  if (
    prev.fontName &&
    curr.fontName &&
    prev.fontName !== curr.fontName &&
    prevEndedSentence &&
    (prevRemaining > prevShortThreshold * 0.5 ||
      currIndent > currIndentThreshold * 0.5)
  ) {
    return true;
  }

  if (currIndented) {
    const isHangingIndentContinuation =
      next &&
      next.pageIndex === curr.pageIndex &&
      next.runIndex === curr.runIndex &&
      Math.abs(next.left - curr.left) <= 2 &&
      (BULLET_ITEM_START_REGEX.test(prev.fullText) ||
        NUMBERED_ITEM_START_REGEX.test(prev.fullText)) &&
      !prevMeaningfullyShort;

    if (
      !isHangingIndentContinuation &&
      prevEndedSentence &&
      (curr.left - prev.left > currIndentThreshold * 0.5 ||
        prevRemaining > prevShortThreshold)
    ) {
      return true;
    }
  }

  if (prevEndedSentence && currStartsCandidate && prevMeaningfullyShort) {
    return true;
  }

  const hasZoteroConfirmingCue =
    step > run.normalLineStep * 1.15 ||
    currIndent > currIndentThreshold * 0.4 ||
    prevRemaining > prevShortThreshold * 0.5;
  if (
    !isOcrNoisy &&
    prev.zoteroParagraphBreakAfter &&
    prevEndedSentence &&
    hasZoteroConfirmingCue
  ) {
    return true;
  }

  return false;
}

function isStructuredHeadingLine(
  line: StructuredPageLine,
  run: ColumnRunMetrics,
): boolean {
  const text = cleanInlineText(line.fullText);
  if (!text) {
    return false;
  }
  if (isLikelyArticleSectionLabel(text) || isLikelySectionHeading(text)) {
    return true;
  }
  if (
    line.fontSize > run.medianFontSize + 1.2 &&
    text.length <= 120 &&
    !endsSentence(text)
  ) {
    return true;
  }
  if (
    isLikelyStandaloneHeading(text) &&
    line.right < run.colRight - Math.max(run.medianFontSize * 2, 16)
  ) {
    return true;
  }
  return false;
}

function joinStructuredParagraphLines(lines: StructuredPageLine[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.selectedText.trim();
    if (!text) {
      continue;
    }
    if (!out) {
      out = text;
      continue;
    }
    const prev = lines[i - 1];
    if (prev.endsWithIgnorableBreak) {
      out += text;
      continue;
    }
    const prevEnd = out[out.length - 1];
    const currStart = text[0] || "";
    if (CJK_EDGE_REGEX.test(prevEnd) && CJK_EDGE_REGEX.test(currStart)) {
      out += text;
    } else {
      out += ` ${text}`;
    }
  }
  return out.trim();
}

export function extractSelectionFromPageText(
  pageText: string,
  fallback: string,
): string {
  const pageMap = buildComparableMap(pageText);
  const target = buildComparableMap(fallback).text;
  if (!pageMap.text || !target) {
    return "";
  }

  let start = pageMap.text.indexOf(target);
  let matchedLength = target.length;
  let activeMap = pageMap;

  if (start < 0) {
    const strippedPageMap = buildComparableMap(pageText, true);
    const strippedTarget = buildComparableMap(fallback, true).text;
    if (strippedPageMap.text && strippedTarget) {
      const strippedStart = strippedPageMap.text.indexOf(strippedTarget);
      if (strippedStart >= 0) {
        start = strippedStart;
        matchedLength = strippedTarget.length;
        activeMap = strippedPageMap;
      }
    }
  }

  if (start < 0) {
    return "";
  }

  const end = start + matchedLength - 1;
  const sourceStart = activeMap.starts[start];
  const sourceEnd = activeMap.ends[end];
  if (typeof sourceStart !== "number" || typeof sourceEnd !== "number") {
    return "";
  }

  const selected = pageText
    .slice(sourceStart, sourceEnd)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (
    buildComparableMap(selected, activeMap !== pageMap).text !==
    (activeMap !== pageMap ? buildComparableMap(fallback, true).text : target)
  ) {
    return "";
  }
  return restoreParagraphBreaksFromCollapsedText(selected) || selected;
}

function buildComparableMap(text: string, stripHyphens = false) {
  let comparable = "";
  const starts: number[] = [];
  const ends: number[] = [];

  for (let index = 0; index < text.length; ) {
    const char = text[index];
    const codePoint = text.codePointAt(index);
    const sourceChar = codePoint ? String.fromCodePoint(codePoint) : char;
    const nextIndex = index + sourceChar.length;
    const normalized = sourceChar.normalize("NFKC");

    for (const normalizedChar of normalized) {
      if (/\s/u.test(normalizedChar)) {
        continue;
      }
      if (
        stripHyphens &&
        (normalizedChar === "-" ||
          normalizedChar === "\u00ad" ||
          normalizedChar === "\u2010")
      ) {
        continue;
      }
      comparable += normalizedChar;
      starts.push(index);
      ends.push(nextIndex);
    }

    index = nextIndex;
  }

  return {
    text: comparable,
    starts,
    ends,
  };
}

export function restoreParagraphBreaksFromCollapsedText(text: string): string {
  const normalized = normalizeSelectedText(text);
  if (!normalized) {
    return normalized;
  }
  if (normalized.includes("\n")) {
    return normalizeParagraphLineBreaks(normalized);
  }

  const headingBreaks = restoreLeadingArticleHeadingBreaks(normalized);
  if (headingBreaks) {
    return headingBreaks;
  }

  const breakCandidates = normalized.match(/[ \t]{2,}/g);
  if (!breakCandidates) {
    return "";
  }

  const segments: string[] = [];
  let current = "";
  let cursor = 0;

  for (const match of normalized.matchAll(/[ \t]{2,}/g)) {
    const index = match.index ?? 0;
    current += normalized.slice(cursor, index);
    const after = normalized.slice(index + match[0].length);
    if (shouldBreakCollapsedText(current, after, match[0])) {
      const segment = cleanInlineText(current);
      if (segment) {
        segments.push(segment);
      }
      current = "";
    } else if (current && !/\s$/u.test(current)) {
      current += " ";
    }
    cursor = index + match[0].length;
  }

  current += normalized.slice(cursor);
  const tail = cleanInlineText(current);
  if (tail) {
    segments.push(tail);
  }

  return segments.length > 1 ? segments.join("\n") : "";
}

function shouldBreakCollapsedText(current: string, after: string, gap = "") {
  const segment = cleanInlineText(current);
  const next = after.trimStart();
  if (!segment || !next) {
    return false;
  }

  if (isLikelyArticleSectionLabel(segment)) {
    return true;
  }

  if (isLikelyStandaloneHeading(segment)) {
    return true;
  }

  if (isLikelySectionHeading(segment)) {
    return true;
  }

  if (/^\d+(?:\.\d+)*\s+\p{Lu}/u.test(next)) {
    return true;
  }

  if (
    BULLET_ITEM_START_REGEX.test(next) ||
    (endsSentence(segment) && NUMBERED_ITEM_START_REGEX.test(next))
  ) {
    return true;
  }

  if (/[ \t]{2,}/u.test(gap)) {
    return endsSentence(segment) && startsCollapsedParagraphCandidate(next);
  }

  return (
    endsSentence(segment) &&
    startsCollapsedParagraphCandidate(next) &&
    !isCollapsedContinuationStart(next)
  );
}

function restoreLeadingArticleHeadingBreaks(text: string) {
  const match = LEADING_ARTICLE_SECTION_LABEL_REGEX.exec(cleanInlineText(text));
  if (!match) {
    return "";
  }

  const sectionLabel = match[1].trim();
  const rest = cleanInlineText(text.slice(match[0].length));
  if (!rest) {
    return sectionLabel;
  }

  const headingBoundary = findArticleSubheadingBodyBoundary(rest);
  if (headingBoundary > 0) {
    const heading = cleanInlineText(rest.slice(0, headingBoundary));
    const body = cleanInlineText(rest.slice(headingBoundary));
    if (heading && body) {
      return [sectionLabel, heading, body].join("\n");
    }
  }

  return [sectionLabel, rest].join("\n");
}

function findArticleSubheadingBodyBoundary(text: string) {
  const bodyStartRegex =
    /\s+(?:A|An|As|Figure|Fig\.?|For|Here|In|Our|Scheme|Table|The|These|This|Those|To|We)\b/gu;

  for (const match of text.matchAll(bodyStartRegex)) {
    const index = match.index ?? 0;
    const before = cleanInlineText(text.slice(0, index));
    const after = cleanInlineText(text.slice(index));
    if (isLikelyArticleSubheading(before) && startsLikelyArticleBody(after)) {
      return index;
    }
  }

  return -1;
}

function endsSentence(text: string): boolean {
  const value = cleanInlineText(text);
  if (!value) {
    return false;
  }
  if (TRAILING_ABBREV_NON_END_REGEX.test(value)) {
    return false;
  }
  return SENTENCE_END_REGEX.test(value);
}

function isLikelyHeadingText(text: string): boolean {
  return (
    isLikelyArticleSectionLabel(text) ||
    isLikelySectionHeading(text) ||
    isLikelyStandaloneHeading(text)
  );
}

function isLikelySectionHeading(text: string) {
  const value = cleanInlineText(text);
  return (
    value.length <= 80 &&
    /^\d+(?:\.\d+)*\s+\p{Lu}/u.test(value) &&
    !endsSentence(value)
  );
}

function isLikelyArticleSectionLabel(text: string) {
  const value = cleanInlineText(text);
  return value.length <= 48 && ARTICLE_SECTION_LABEL_REGEX.test(value);
}

function isLikelyArticleSubheading(text: string) {
  const value = cleanInlineText(text);
  if (
    !value ||
    value.length > 120 ||
    endsSentence(value) ||
    /[,，;；:：]/u.test(value)
  ) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  return (
    words.length >= 2 &&
    words.length <= 14 &&
    /^(?:\d|\p{Lu}|[\u3400-\u9fff])/u.test(value)
  );
}

function isLikelyStandaloneHeading(text: string) {
  const value = cleanInlineText(text);
  if (
    !value ||
    value.length > 96 ||
    endsSentence(value) ||
    /[,，;；:：]/u.test(value) ||
    isCollapsedContinuationStart(value)
  ) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 10) {
    return false;
  }
  return /^(?:\d|\p{Lu}|[\u3400-\u9fff])/u.test(value);
}

function isLikelyHeadingTail(text: string) {
  const value = cleanInlineText(text);
  if (
    !value ||
    value.length > 72 ||
    endsSentence(value) ||
    /[,，;；:：]/u.test(value) ||
    isCollapsedContinuationStart(value)
  ) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && /^(?:\p{L}|\d)/u.test(value);
}

function cleanInlineText(text: string) {
  return normalizeSelectedText(text)
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function startsParagraphCandidate(text: string) {
  return /^(?:\p{Lu}|\d|["'([\u201c\u2018\u300a\u300c\u2022\u25cf]|[\u3400-\u9fff\u3040-\u30ff])/u.test(
    cleanInlineText(text),
  );
}

function startsCollapsedParagraphCandidate(text: string) {
  return /^(?:\p{Lu}|\d|["'([\u201c\u2018\u300a\u300c]|[\u3400-\u9fff\u3040-\u30ff])/u.test(
    cleanInlineText(text),
  );
}

function startsLikelyArticleBody(text: string) {
  const value = cleanInlineText(text);
  return /^(?:A|An|As|Fig\.?|Figure|For|Here|In|Our|Scheme|Table|The|These|This|Those|To|We)\b/u.test(
    value,
  );
}

function isCollapsedContinuationStart(text: string) {
  return /^(?:a|an|and|as|because|but|for|if|nor|or|our|so|that|the|then|thereby|therefore|these|this|those|thus|we|when|where|whereas|which|while|with|yet)\b/i.test(
    cleanInlineText(text),
  );
}

export function normalizeParagraphLineBreaks(text: string) {
  return normalizeSelectedText(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function plainTextFromFragments(fragments: SelectionFragment[]) {
  const lines = buildSelectionLines(fragments);
  if (lines.length) {
    const text = groupLinesIntoParagraphs(lines).join("\n").trim();
    return restoreParagraphBreaksFromCollapsedText(text) || text;
  }
  const text = [...fragments]
    .sort((a, b) => a.order - b.order)
    .map((fragment) => fragment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return restoreParagraphBreaksFromCollapsedText(text) || text;
}

export function paragraphizeFragments(
  fragments: SelectionFragment[],
  fallback: string,
) {
  const lines = buildSelectionLines(fragments);
  if (lines.length <= 1) {
    return "";
  }

  const paragraphs = groupLinesIntoParagraphs(lines);
  if (paragraphs.length <= 1) {
    const collapsed = lines
      .map((line) => line.text)
      .join(" ")
      .replace(/\s+/g, " ");
    return (
      restoreParagraphBreaksFromCollapsedText(fallback) ||
      restoreParagraphBreaksFromCollapsedText(collapsed) ||
      ""
    );
  }

  return fitParagraphsToFallback(paragraphs, fallback);
}

export function buildSelectionLines(fragments: SelectionFragment[]) {
  const sorted = fragments
    .filter((fragment) => fragment.text.trim())
    .sort((a, b) => {
      const topBandDiff =
        Math.round(a.rect.top / 3) - Math.round(b.rect.top / 3);
      return topBandDiff || a.rect.left - b.rect.left || a.order - b.order;
    });
  const lines: SelectionLine[] = [];

  for (const fragment of sorted) {
    const line = lines.find((candidate) =>
      isSameVisualLine(candidate, fragment.rect),
    );
    if (line) {
      line.fragments.push(fragment);
      mergeRectIntoLine(line, fragment.rect);
      continue;
    }

    lines.push({
      ...fragment.rect,
      order: fragment.order,
      text: "",
      fragments: [fragment],
    });
  }

  // Merge any split fragments that ended up adjacent on the same visual line
  lines.sort(compareSelectionLinesByVisualOrder);
  const consolidated: SelectionLine[] = [];
  for (const line of lines) {
    const existing = consolidated.find((candidate) =>
      isSameVisualLine(candidate, line),
    );
    if (existing) {
      existing.fragments.push(...line.fragments);
      mergeRectIntoLine(existing, line);
    } else {
      consolidated.push(line);
    }
  }

  const builtLines = consolidated
    .map((line) => ({
      ...line,
      order: Math.min(...line.fragments.map((fragment) => fragment.order)),
      text: buildLineText(line.fragments),
    }))
    .filter((line) => line.text);

  return orderSelectionLinesForReading(builtLines);
}

export function orderSelectionLinesForReading(lines: SelectionLine[]) {
  if (lines.length <= 1) {
    return lines;
  }

  const columns = buildSelectionColumns(lines);
  if (columns.length <= 1) {
    return [...lines].sort(compareSelectionLinesByVisualOrder);
  }

  return columns
    .sort((a, b) => a.left - b.left || a.top - b.top)
    .flatMap((column) => column.lines.sort(compareSelectionLinesByVisualOrder));
}

function buildSelectionColumns(lines: SelectionLine[]) {
  const metrics = getLineMetrics(lines);
  const indentTolerance = Math.max(
    metrics.medianCharWidth * 4,
    metrics.medianHeight * 1.5,
    16,
  );
  const columns: SelectionColumn[] = [];

  for (const line of [...lines].sort(
    (a, b) => a.left - b.left || a.top - b.top,
  )) {
    const column = columns.find((candidate) =>
      isLineInColumn(line, candidate, indentTolerance),
    );
    if (!column) {
      columns.push({
        ...line,
        lines: [line],
      });
      continue;
    }

    column.lines.push(line);
    column.left = Math.min(column.left, line.left);
    column.top = Math.min(column.top, line.top);
    column.right = Math.max(column.right, line.right);
    column.bottom = Math.max(column.bottom, line.bottom);
    column.width = column.right - column.left;
    column.height = column.bottom - column.top;
  }

  return columns;
}

function isLineInColumn(
  line: SelectionLine,
  column: SelectionColumn,
  indentTolerance: number,
) {
  const horizontalOverlap =
    Math.min(line.right, column.right) - Math.max(line.left, column.left);
  const minWidth = Math.min(line.width, column.width);
  if (horizontalOverlap > Math.max(2, minWidth * 0.25)) {
    return true;
  }

  return (
    line.left >= column.left - indentTolerance &&
    line.right <= column.right + indentTolerance
  );
}

export function groupLinesIntoParagraphs(lines: SelectionLine[]) {
  if (!lines.length) {
    return [];
  }

  const columns = buildSelectionColumns(lines);
  const columnMetricsByLine = new Map<SelectionLine, ColumnRunMetrics>();
  for (const column of columns) {
    const colLines = [...column.lines].sort(compareSelectionLinesByVisualOrder);
    const metrics = computeSelectionColumnMetrics(colLines);
    for (const line of colLines) {
      columnMetricsByLine.set(line, metrics);
    }
  }

  const paragraphs: SelectionLine[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const prevMetrics = columnMetricsByLine.get(prev)!;
    const currMetrics = columnMetricsByLine.get(curr)!;
    if (shouldStartNewParagraph(prev, curr, prevMetrics, currMetrics)) {
      paragraphs.push([curr]);
    } else {
      paragraphs[paragraphs.length - 1].push(curr);
    }
  }

  return paragraphs
    .map((paragraphLines) => joinSelectionParagraphLines(paragraphLines))
    .filter((paragraph) => paragraph);
}

function joinSelectionParagraphLines(lines: SelectionLine[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();
    if (!text) {
      continue;
    }
    if (!out) {
      out = text;
      continue;
    }
    if (/[A-Za-z]-$/u.test(out) && /^[a-z]/u.test(text)) {
      out = `${out.slice(0, -1)}${text}`;
      continue;
    }
    const prevEnd = out[out.length - 1];
    const currStart = text[0] || "";
    if (CJK_EDGE_REGEX.test(prevEnd) && CJK_EDGE_REGEX.test(currStart)) {
      out += text;
    } else {
      out += ` ${text}`;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function fitParagraphsToFallback(paragraphs: string[], fallback: string) {
  const candidate = paragraphs.join("\n").trim();
  const candidateComparable = getComparableText(candidate);
  const fallbackComparable = getComparableText(fallback);

  if (!candidateComparable) {
    return "";
  }
  if (!fallbackComparable) {
    return candidate;
  }
  if (candidateComparable === fallbackComparable) {
    return candidate;
  }

  const candidateNoHyphen = candidateComparable.replace(/[-\u00ad\u2010]/g, "");
  const fallbackNoHyphen = fallbackComparable.replace(/[-\u00ad\u2010]/g, "");
  if (candidateNoHyphen === fallbackNoHyphen) {
    return candidate;
  }

  const paragraphLengths = paragraphs.map(
    (paragraph) => getComparableText(paragraph).length,
  );
  const totalLength = paragraphLengths.reduce((sum, length) => sum + length, 0);
  const ratio = totalLength / Math.max(1, fallbackComparable.length);
  if (ratio < 0.9 || ratio > 1.1) {
    return "";
  }

  const fitted = splitFallbackByComparableLengths(fallback, paragraphLengths);
  return getComparableText(fitted) === fallbackComparable ? fitted : "";
}

function splitFallbackByComparableLengths(text: string, lengths: number[]) {
  const breakTargets: number[] = [];
  let cursor = 0;
  for (let i = 0; i < lengths.length - 1; i++) {
    cursor += lengths[i];
    breakTargets.push(cursor);
  }

  const breaks = breakTargets
    .map((target) => findTextIndexByComparableLength(text, target))
    .map((index) => adjustBreakIndex(text, index))
    .filter(
      (index, idx, all) =>
        index > 0 && index < text.length && index !== all[idx - 1],
    );

  if (!breaks.length) {
    return text.trim();
  }

  const segments: string[] = [];
  let start = 0;
  for (const end of breaks) {
    const segment = text.slice(start, end).trim();
    if (segment) {
      segments.push(segment);
    }
    start = end;
  }

  const tail = text.slice(start).trim();
  if (tail) {
    segments.push(tail);
  }
  return segments.join("\n");
}

function findTextIndexByComparableLength(text: string, target: number) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/\s/u.test(text[i])) {
      count += 1;
    }
    if (count >= target) {
      return i + 1;
    }
  }
  return text.length;
}

function adjustBreakIndex(text: string, index: number) {
  const start = Math.max(1, index - 14);
  const end = Math.min(text.length - 1, index + 14);
  let best = index;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = start; i <= end; i++) {
    const left = text.slice(0, i).trimEnd();
    const right = text.slice(i).trimStart();
    if (!left || !right) {
      continue;
    }

    let score = -Math.abs(i - index);
    if (/\s/u.test(text[i - 1] || "") || /\s/u.test(text[i] || "")) {
      score += 20;
    }
    if (endsSentence(left)) {
      score += 30;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  return best;
}

function getLineMetrics(lines: SelectionLine[]) {
  const heights = lines
    .map((line) => line.height)
    .filter((height) => height > 0);
  const topDeltas = lines
    .slice(1)
    .map((line, idx) => line.top - lines[idx].top)
    .filter((delta) => delta > 0);
  const charWidths = lines
    .map((line) => line.width / Math.max(1, line.text.length))
    .filter((width) => width > 0);

  return {
    commonLeft: percentile(
      lines.map((line) => line.left),
      0.25,
    ),
    commonRight: percentile(
      lines.map((line) => line.right),
      0.75,
    ),
    medianHeight: median(heights) || 10,
    medianTopDelta: median(topDeltas) || (median(heights) || 10) * 1.25,
    medianCharWidth: median(charWidths) || 6,
  };
}

function computeSelectionColumnMetrics(
  lines: SelectionLine[],
): ColumnRunMetrics {
  const lefts = lines.map((l) => l.left);
  const rights = lines.map((l) => l.right);
  const colLeft = findDominantMargin(lefts, 3, "min") ?? percentile(lefts, 0.2);
  const colRight =
    findDominantRightMargin(rights, 4) ?? percentile(rights, 0.8);
  const colWidth = Math.max(20, colRight - colLeft);

  const heights = lines.map((l) => l.height).filter((h) => h > 0);
  const medianHeight = median(heights) || 10;

  const gaps: number[] = [];
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].top - lines[i - 1].bottom;
    const step = lines[i].top - lines[i - 1].top;
    if (gap >= -2 && gap <= medianHeight * 1.4) {
      gaps.push(gap);
    }
    if (step > 0 && step <= medianHeight * 2.6) {
      steps.push(step);
    }
  }

  const normalLineGap = gaps.length
    ? percentile(gaps, 0.35)
    : medianHeight * 0.2;
  const normalLineStep = steps.length
    ? percentile(steps, 0.35)
    : medianHeight * 1.25;

  return {
    colLeft,
    colRight,
    colWidth,
    medianHeight,
    medianFontSize: medianHeight,
    normalLineGap,
    normalLineStep,
  };
}

function shouldStartNewParagraph(
  previous: SelectionLine,
  current: SelectionLine,
  prevMetrics: ColumnRunMetrics,
  currMetrics: ColumnRunMetrics,
) {
  const previousEndedSentence = endsSentence(previous.text);
  const currentStartsCandidate = startsParagraphCandidate(current.text);

  if (
    isLikelyArticleSectionLabel(previous.text) ||
    isLikelySectionHeading(previous.text) ||
    isLikelyArticleSectionLabel(current.text) ||
    isLikelySectionHeading(current.text) ||
    BULLET_ITEM_START_REGEX.test(current.text) ||
    (previousEndedSentence && NUMBERED_ITEM_START_REGEX.test(current.text))
  ) {
    return true;
  }

  const currIndentThreshold = Math.max(currMetrics.medianHeight * 0.5, 5);
  const currentIndented =
    current.left - currMetrics.colLeft > currIndentThreshold &&
    current.left - currMetrics.colLeft < currMetrics.colWidth * 0.45;
  const prevShortThreshold = Math.max(
    prevMetrics.medianHeight * 2.2,
    prevMetrics.colWidth * 0.12,
  );
  const previousShort =
    prevMetrics.colRight - previous.right > prevShortThreshold;

  const columnReset =
    currMetrics !== prevMetrics ||
    current.top < previous.top - prevMetrics.normalLineStep * 1.2;
  if (columnReset) {
    if (!previousEndedSentence) {
      return false;
    }
    return currentIndented || previousShort;
  }

  const gap = current.top - previous.bottom;
  const step = current.top - previous.top;
  const clearGap =
    gap >
      currMetrics.normalLineGap +
        Math.max(currMetrics.medianHeight * 0.28, 2.5) &&
    step > currMetrics.normalLineStep * 1.24;
  const largeGap =
    gap >
    currMetrics.normalLineGap + Math.max(currMetrics.medianHeight * 0.5, 4.5);
  if (largeGap || (clearGap && (previousEndedSentence || previousShort))) {
    return true;
  }

  if (
    previousShort &&
    (isLikelyArticleSubheading(previous.text) ||
      isLikelyStandaloneHeading(previous.text) ||
      (isLikelyHeadingTail(previous.text) && currentStartsCandidate))
  ) {
    return true;
  }

  if (
    currentIndented &&
    previousEndedSentence &&
    (current.left - previous.left > currIndentThreshold * 0.5 || previousShort)
  ) {
    return true;
  }

  return previousEndedSentence && currentStartsCandidate && previousShort;
}

export function buildLineText(fragments: SelectionFragment[]) {
  const sorted = [...fragments].sort(
    (a, b) => a.rect.left - b.rect.left || a.order - b.order,
  );
  let line = "";
  let previous: SelectionFragment | undefined;

  for (const fragment of sorted) {
    const text = fragment.text.replace(/\s+/g, " ");
    if (!text) {
      continue;
    }

    if (previous && shouldInsertSpace(previous, fragment, line, text)) {
      line += " ";
    }
    line += text;
    previous = fragment;
  }

  return line.replace(/\s+/g, " ").trim();
}

function shouldInsertSpace(
  previous: SelectionFragment,
  current: SelectionFragment,
  lineSoFar: string,
  currentText: string,
) {
  if (!lineSoFar || /\s$/u.test(lineSoFar) || /^\s/u.test(currentText)) {
    return false;
  }
  const previousEnd = lineSoFar[lineSoFar.length - 1];
  const currentStart = currentText.trimStart()[0] || "";
  if (CJK_EDGE_REGEX.test(previousEnd) || CJK_EDGE_REGEX.test(currentStart)) {
    return false;
  }

  const gap = current.rect.left - previous.rect.right;
  const charWidth = previous.rect.width / Math.max(1, previous.text.length);
  return gap > Math.max(2, charWidth * 0.35);
}

function isSameVisualLine(line: SelectionLine, rect: RectLike) {
  if (!isHorizontallyCompatibleLine(line, rect)) {
    return false;
  }

  const overlap =
    Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top);
  const minHeight = Math.min(line.height, rect.height);
  if (overlap > minHeight * 0.45) {
    return true;
  }

  const lineCenter = (line.top + line.bottom) / 2;
  const rectCenter = (rect.top + rect.bottom) / 2;
  return Math.abs(lineCenter - rectCenter) <= Math.max(2, minHeight * 0.45);
}

function isHorizontallyCompatibleLine(line: SelectionLine, rect: RectLike) {
  const gap =
    rect.right < line.left
      ? line.left - rect.right
      : rect.left > line.right
        ? rect.left - line.right
        : 0;
  if (gap <= 0) {
    return true;
  }

  const minHeight = Math.min(line.height, rect.height);
  const bothWideColumnSegments =
    line.width > minHeight * 8 && rect.width > minHeight * 8;
  const maxReasonableInlineGap = bothWideColumnSegments
    ? Math.max(10, minHeight * 1.1)
    : Math.max(20, minHeight * 1.9);
  return gap <= maxReasonableInlineGap;
}

function compareSelectionLinesByVisualOrder(
  a: SelectionLine,
  b: SelectionLine,
) {
  return a.top - b.top || a.left - b.left || a.order - b.order;
}

function mergeRectIntoLine(line: SelectionLine, rect: RectLike) {
  line.left = Math.min(line.left, rect.left);
  line.top = Math.min(line.top, rect.top);
  line.right = Math.max(line.right, rect.right);
  line.bottom = Math.max(line.bottom, rect.bottom);
  line.width = line.right - line.left;
  line.height = line.bottom - line.top;
}

export function normalizeSelectedText(text: string) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

export function getComparableText(text: string) {
  return normalizeSelectedText(text).replace(/\s+/gu, "").normalize("NFKC");
}

export function getComparableScore(text: string, fallback: string) {
  const value = getComparableText(text);
  const target = getComparableText(fallback);
  if (!value || !target) {
    return 0;
  }
  if (value === target) {
    return 1;
  }
  const lengthRatio =
    Math.min(value.length, target.length) /
    Math.max(value.length, target.length);
  if (value.includes(target) || target.includes(value)) {
    return lengthRatio;
  }
  const noHyphenValue = value.replace(/[-\u00ad\u2010]/g, "");
  const noHyphenTarget = target.replace(/[-\u00ad\u2010]/g, "");
  if (noHyphenValue === noHyphenTarget) {
    return 1;
  }
  if (
    noHyphenValue.includes(noHyphenTarget) ||
    noHyphenTarget.includes(noHyphenValue)
  ) {
    return (
      Math.min(noHyphenValue.length, noHyphenTarget.length) /
      Math.max(noHyphenValue.length, noHyphenTarget.length)
    );
  }
  return 0;
}

export function toRectLike(rect: DOMRect | DOMRectReadOnly): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  };
}

export function rectRelativeToPage(rect: DOMRect, pageRect: RectLike) {
  return normalizeRect([
    rect.left - pageRect.left,
    rect.top - pageRect.top,
    rect.right - pageRect.left,
    rect.bottom - pageRect.top,
  ]);
}

export function normalizeRect(rect: number[]): RectLike {
  const left = Math.min(rect[0], rect[2]);
  const top = Math.min(rect[1], rect[3]);
  const right = Math.max(rect[0], rect[2]);
  const bottom = Math.max(rect[1], rect[3]);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function intersects(a: RectLike, b: RectLike) {
  const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return horizontal > 0 && vertical > Math.min(a.height, b.height) * 0.2;
}

export function unionRects(rects: RectLike[]) {
  if (!rects.length) {
    return undefined;
  }
  return normalizeRect([
    Math.min(...rects.map((rect) => rect.left)),
    Math.min(...rects.map((rect) => rect.top)),
    Math.max(...rects.map((rect) => rect.right)),
    Math.max(...rects.map((rect) => rect.bottom)),
  ]);
}

export function median(values: number[]) {
  return percentile(values, 0.5);
}

export function percentile(values: number[], ratio: number) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * ratio)),
  );
  return sorted[index];
}
