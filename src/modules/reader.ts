import { config } from "../../package.json";
import { SVGIcon } from "../utils/config";
import {
  addTranslateAnnotationTask,
  addTranslateTask,
  getLastTranslateTask,
} from "../utils/task";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  buildLineText,
  buildSelectionLines,
  extractParagraphsFromStructuredSlices,
  extractSelectionFromPageText,
  getComparableScore,
  getComparableText,
  groupLinesIntoParagraphs,
  intersects,
  normalizeParagraphLineBreaks,
  normalizeRect,
  normalizeSelectedText,
  orderSelectionLinesForReading,
  paragraphizeFragments,
  PdfPageChar,
  plainTextFromFragments,
  rectRelativeToPage,
  restoreParagraphBreaksFromCollapsedText,
  SelectionFragment,
  SelectionLine,
  StructuredPageSelectionSlice,
  toRectLike,
  unionRects,
} from "./pdfParagraphs";

type PdfTextContentItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

let selectionTextRestoreSerial = 0;

export function registerReaderInitializer() {
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    (event) => {
      const restoreSerial = ++selectionTextRestoreSerial;
      const { text: selectedText, structuredResolved } =
        getSelectionTextWithParagraphs(event);
      addon.data.translate.selectedText = selectedText;
      addon.hooks.onReaderPopupShow(event);
      if (event.reader.type === "pdf" && !structuredResolved) {
        updateSelectionTextWithPageTextContent(
          event,
          selectedText,
          restoreSerial,
        );
      }
    },
    config.addonID,
  );

  Zotero.Reader.registerEventListener(
    "renderSidebarAnnotationHeader",
    (event) => {
      const { reader, doc, params, append } = event;
      const annotationData = params.annotation;
      const annotationId = annotationData.id;

      append(
        ztoolkit.UI.createElement(doc, "div", {
          id: `${config.addonRef}-annotation-translate-${annotationId}`,
          classList: ["icon"],
          attributes: {
            "data-annotation-id": annotationId,
          },
          properties: {
            innerHTML: SVGIcon,
            title: getString("sideBarIcon-title"),
          },
          listeners: [
            {
              type: "click",
              listener: (e) => {
                const target = e.currentTarget as HTMLElement;
                const task = addTranslateAnnotationTask(
                  reader._item.libraryID,
                  target.dataset.annotationId || annotationId,
                );
                addon.hooks.onTranslate(task, {
                  noCheckZoteroItemLanguage: true,
                  noDisplay: true,
                  forceRestart: true,
                });
                e.preventDefault();
              },
            },
            {
              type: "mouseover",
              listener: (e) => {
                (e.target as HTMLElement).style.backgroundColor =
                  "var(--color-sidepane)";
              },
            },
            {
              type: "mouseout",
              listener: (e) => {
                (e.target as HTMLElement).style.removeProperty(
                  "background-color",
                );
              },
            },
          ],
          enableElementRecord: false,
          ignoreIfExists: true,
        }),
      );
    },
    config.addonID,
  );
}

function getSelectionTextWithParagraphs(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
): { text: string; structuredResolved: boolean } {
  const annotation = unwrapXray(event.params?.annotation);
  const fallback = normalizeSelectedText(annotation?.text || "");
  if (event.reader.type !== "pdf") {
    return { text: fallback, structuredResolved: true };
  }
  if (fallback.includes("\n")) {
    return {
      text: normalizeParagraphLineBreaks(fallback),
      structuredResolved: true,
    };
  }

  try {
    const fromStructured = getPdfSelectionTextFromStructuredPages(
      event.reader,
      annotation,
      fallback,
      undefined,
      event.doc,
    );
    if (fromStructured) {
      return { text: fromStructured, structuredResolved: true };
    }
  } catch (e) {
    ztoolkit.log("Failed to restore PDF selection from structured pages", e);
  }

  let fromDOMSelection = "";
  try {
    fromDOMSelection = getPdfSelectionTextFromDOMSelection(
      event.reader,
      fallback,
      event.doc,
    );
    if (fromDOMSelection && fromDOMSelection.includes("\n")) {
      return { text: fromDOMSelection, structuredResolved: false };
    }
  } catch (e) {
    ztoolkit.log("Failed to restore PDF selection paragraphs", e);
  }

  if (fallback) {
    try {
      const fromRects = getPdfSelectionTextFromAnnotationRects(
        event.reader,
        annotation,
        fallback,
        event.doc,
      );
      if (fromRects && fromRects.includes("\n")) {
        return { text: fromRects, structuredResolved: false };
      }
    } catch (e) {
      ztoolkit.log("Failed to restore PDF selection from rects", e);
    }

    const fromCollapsed = restoreParagraphBreaksFromCollapsedText(fallback);
    if (fromCollapsed) {
      return { text: fromCollapsed, structuredResolved: false };
    }
  }

  return {
    text: fromDOMSelection || fallback,
    structuredResolved: false,
  };
}

function updateSelectionTextWithPageTextContent(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
  originalText: string,
  restoreSerial: number,
) {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 300;
  const annotation = unwrapXray(event.params?.annotation);

  const attemptRestore = (retryCount: number) => {
    if (restoreSerial !== selectionTextRestoreSerial) {
      return;
    }

    restorePdfSelectionAsync(event.reader, annotation, originalText, event.doc)
      .then((restoredText) => {
        if (
          restoreSerial !== selectionTextRestoreSerial ||
          getComparableText(addon.data.translate.selectedText) !==
            getComparableText(originalText)
        ) {
          return;
        }

        if (!restoredText || restoredText === originalText) {
          if (
            retryCount < MAX_RETRIES &&
            (!originalText.trim() || !restoredText)
          ) {
            const win = Zotero.getMainWindow?.();
            const setTimer = win?.setTimeout?.bind(win) ?? setTimeout;
            setTimer(() => attemptRestore(retryCount + 1), RETRY_DELAY_MS);
          }
          return;
        }

        addon.data.translate.selectedText = restoredText;
        const updateResult = updateActiveTextTaskSource(
          originalText,
          restoredText,
        );
        if (!updateResult) {
          if (!originalText.trim()) {
            const newTask = addTranslateTask(
              restoredText,
              event.reader.itemID,
              "text",
            );
            if (newTask) {
              addon.hooks.onReaderTabPanelRefresh();
              if (getPref("enableAuto")) {
                addon.hooks.onTranslate(newTask, {
                  noCheckZoteroItemLanguage: true,
                  noCache: true,
                });
              }
            }
          }
          return;
        }
        addon.hooks.onReaderPopupRefresh();
        addon.hooks.onReaderTabPanelRefresh();
        if (
          updateResult.contentChanged &&
          (updateResult.wasProcessing ||
            (updateResult.wasSuccess && (getPref("enableAuto") as boolean)))
        ) {
          addon.hooks.onTranslate(updateResult.task, {
            noCheckZoteroItemLanguage: true,
            noCache: true,
            forceRestart: true,
          });
        }
      })
      .catch((e) => {
        ztoolkit.log("Failed to restore PDF selection from page text", e);
      });
  };

  attemptRestore(0);
}

function updateActiveTextTaskSource(
  previousText: string,
  restoredText: string,
) {
  const task = getLastTranslateTask({ type: "text" });
  if (
    !task ||
    getComparableText(task.raw) !== getComparableText(previousText)
  ) {
    return undefined;
  }

  const contentChanged =
    normalizeSelectedText(previousText) !== normalizeSelectedText(restoredText);
  const wasProcessing = task.status === "processing";
  const wasSuccess = task.status === "success";
  if (wasProcessing && !contentChanged) {
    task.rawSnapshotAliases = Array.from(
      new Set([...(task.rawSnapshotAliases || []), task.raw]),
    );
  }
  task.raw = restoredText;
  task.extraTasks?.forEach((extraTask) => {
    if (getComparableText(extraTask.raw) !== getComparableText(previousText)) {
      return;
    }
    if (extraTask.status === "processing" && !contentChanged) {
      extraTask.rawSnapshotAliases = Array.from(
        new Set([...(extraTask.rawSnapshotAliases || []), extraTask.raw]),
      );
    }
    extraTask.raw = restoredText;
  });

  return { task, contentChanged, wasProcessing, wasSuccess };
}

export function getPdfSelectionTextFromStructuredPages(
  reader: _ZoteroTypes.ReaderInstance,
  annotation: _ZoteroTypes.Annotations.AnnotationJson,
  fallback: string,
  extraPages?: Record<number, { chars?: PdfPageChar[] }>,
  doc?: Document,
) {
  const view = getPdfView(reader, doc);
  const pdfPages = unwrapXray(view?._pdfPages) as
    | Record<number, { chars?: PdfPageChar[] }>
    | undefined;
  const pageCharsCache = new Map<number, PdfPageChar[] | undefined>();
  const getPageChars = (pageIndex: number): PdfPageChar[] | undefined => {
    if (pageCharsCache.has(pageIndex)) {
      return pageCharsCache.get(pageIndex);
    }
    const rawPage = unwrapXray(
      extraPages?.[pageIndex] || pdfPages?.[pageIndex],
    );
    const chars = clonePageChars(rawPage?.chars);
    pageCharsCache.set(pageIndex, chars);
    return chars;
  };

  const selectionRanges =
    toLocalArray<any>(unwrapXray(view?._selectionRanges)) || [];

  if (selectionRanges.length) {
    const slices: StructuredPageSelectionSlice[] = [];
    for (let i = 0; i < selectionRanges.length; i++) {
      const sr = unwrapXray(selectionRanges[i]);
      if (!sr || sr.collapsed) {
        continue;
      }
      const pos = unwrapXray(sr.position);
      const pageIndex =
        typeof pos?.pageIndex === "number"
          ? pos.pageIndex
          : typeof sr.pageIndex === "number"
            ? sr.pageIndex
            : undefined;
      if (typeof pageIndex !== "number") {
        continue;
      }
      const pageChars = getPageChars(pageIndex);
      if (!pageChars) {
        continue;
      }
      const anchorOffset = Number(sr.anchorOffset);
      const headOffset = Number(sr.headOffset);
      if (!Number.isFinite(anchorOffset) || !Number.isFinite(headOffset)) {
        continue;
      }
      const startOffset = Math.max(0, Math.min(anchorOffset, headOffset));
      const endOffset = Math.min(
        pageChars.length,
        Math.max(anchorOffset, headOffset),
      );
      if (endOffset <= startOffset) {
        continue;
      }
      slices.push({ pageIndex, pageChars, startOffset, endOffset });
    }

    if (slices.length) {
      slices.sort((a, b) => a.pageIndex - b.pageIndex);
      const annotationPos = unwrapXray(annotation?.position);
      const annotationPageIndex = annotationPos?.pageIndex;
      const matchesPage =
        typeof annotationPageIndex !== "number" ||
        slices.some((s) => s.pageIndex === annotationPageIndex);
      if (matchesPage) {
        const extracted = extractParagraphsFromStructuredSlices(slices);
        if (
          extracted &&
          (!fallback || getComparableScore(extracted, fallback) >= 0.85)
        ) {
          return extracted;
        }
      }
    }
  }

  const annotationPos = unwrapXray(annotation?.position);
  const pageIndex = annotationPos?.pageIndex;
  const rects = cloneRectList(annotationPos?.rects);
  if (typeof pageIndex !== "number" || !rects.length) {
    return "";
  }

  const slices: StructuredPageSelectionSlice[] = [];
  const primaryChars = getPageChars(pageIndex);
  if (primaryChars) {
    const range = findCharOffsetRangeByRects(primaryChars, rects);
    if (range) {
      slices.push({
        pageIndex,
        pageChars: primaryChars,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      });
    }
  }

  const nextPageRects = cloneRectList((annotationPos as any)?.nextPageRects);
  if (nextPageRects.length) {
    const nextChars = getPageChars(pageIndex + 1);
    if (nextChars) {
      const nextRange = findCharOffsetRangeByRects(nextChars, nextPageRects);
      if (nextRange) {
        slices.push({
          pageIndex: pageIndex + 1,
          pageChars: nextChars,
          startOffset: nextRange.startOffset,
          endOffset: nextRange.endOffset,
        });
      }
    }
  }

  if (!slices.length) {
    return "";
  }

  const extracted = extractParagraphsFromStructuredSlices(slices);
  if (
    extracted &&
    (!fallback || getComparableScore(extracted, fallback) >= 0.85)
  ) {
    return extracted;
  }

  return "";
}

function findCharOffsetRangeByRects(
  chars: PdfPageChar[],
  rawRects: number[][],
): { startOffset: number; endOffset: number } | undefined {
  const rects = rawRects.map((r) => normalizeRect(r));
  if (!rects.length) {
    return undefined;
  }

  let startOffset = Number.POSITIVE_INFINITY;
  let endOffset = -1;

  for (let i = 0; i < chars.length; i++) {
    const raw = chars[i]?.inlineRect || chars[i]?.rect;
    if (!raw || raw.length < 4) {
      continue;
    }
    const cx = (raw[0] + raw[2]) / 2;
    const cy = (raw[1] + raw[3]) / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      continue;
    }
    const hit = rects.some(
      (rect) =>
        cx >= rect.left - 1.5 &&
        cx <= rect.right + 1.5 &&
        cy >= rect.top - 1.5 &&
        cy <= rect.bottom + 1.5,
    );
    if (hit) {
      if (i < startOffset) {
        startOffset = i;
      }
      if (i > endOffset) {
        endOffset = i;
      }
    }
  }

  if (!Number.isFinite(startOffset) || endOffset < startOffset) {
    return undefined;
  }

  return {
    startOffset,
    endOffset: endOffset + 1,
  };
}

async function restorePdfSelectionAsync(
  reader: _ZoteroTypes.ReaderInstance,
  annotation: _ZoteroTypes.Annotations.AnnotationJson,
  fallback: string,
  doc?: Document,
) {
  const annotationPos = unwrapXray(annotation?.position);
  const pageIndex = annotationPos?.pageIndex;
  if (typeof pageIndex === "number") {
    const view = getPdfView(reader, doc);
    const pdfWin = unwrapXray(getPdfWindow(reader, doc));
    const pdfDocument = unwrapXray(pdfWin?.PDFViewerApplication?.pdfDocument);
    const extraPages: Record<number, { chars?: PdfPageChar[] }> = {};

    const loadPage = async (idx: number) => {
      const existingPages = unwrapXray(view?._pdfPages);
      if (unwrapXray(existingPages?.[idx])?.chars?.length) {
        return;
      }
      if (typeof view?._ensureBasicPageData === "function") {
        try {
          await view._ensureBasicPageData(idx);
        } catch {
          // ignore and try getPageData below
        }
      }
      const updatedPages = unwrapXray(view?._pdfPages);
      if (
        !unwrapXray(updatedPages?.[idx])?.chars?.length &&
        pdfDocument?.getPageData
      ) {
        try {
          const arg = cloneIntoWindow({ pageIndex: idx }, pdfWin);
          const data = unwrapXray(await pdfDocument.getPageData(arg));
          if (data?.chars?.length) {
            extraPages[idx] = data;
          }
        } catch {
          // ignore
        }
      }
    };

    await loadPage(pageIndex);
    if (cloneRectList((annotationPos as any)?.nextPageRects).length) {
      await loadPage(pageIndex + 1);
    }

    const fromStructured = getPdfSelectionTextFromStructuredPages(
      reader,
      annotation,
      fallback,
      extraPages,
      doc,
    );
    if (fromStructured) {
      return fromStructured;
    }
  }

  return getPdfSelectionTextFromPageTextContent(
    reader,
    annotation,
    fallback,
    doc,
  );
}

async function getPdfSelectionTextFromPageTextContent(
  reader: _ZoteroTypes.ReaderInstance,
  annotation: _ZoteroTypes.Annotations.AnnotationJson,
  fallback: string,
  doc?: Document,
) {
  const annotationPos = unwrapXray(annotation?.position);
  const pageIndex = annotationPos?.pageIndex;
  if (typeof pageIndex !== "number") {
    return "";
  }

  const pageView = unwrapXray(getPdfPageView(reader, pageIndex, doc));
  const pdfWin = unwrapXray(getPdfWindow(reader, doc));
  const pdfDocument = unwrapXray(pdfWin?.PDFViewerApplication?.pdfDocument);
  const pdfPage = unwrapXray(
    pageView?.pdfPage ||
      (pdfDocument?.getPage ? await pdfDocument.getPage(pageIndex + 1) : null),
  );
  const viewport = unwrapXray(
    pageView?.viewport ||
      (pdfPage?.getViewport
        ? pdfPage.getViewport(cloneIntoWindow({ scale: 1 }, pdfWin))
        : null),
  );

  if (!pdfPage || !viewport) {
    return "";
  }

  const textContent = unwrapXray(await pdfPage.getTextContent());
  const rawItems = toLocalArray<PdfTextContentItem>(
    unwrapXray(textContent?.items),
  );
  if (!rawItems?.length) {
    return "";
  }

  const fragments = getPdfTextContentFragments(rawItems, viewport);
  if (!fragments.length) {
    return "";
  }

  const lines = buildTextContentLines(fragments);
  if (lines.length <= 1) {
    return "";
  }

  const pageText = groupLinesIntoParagraphs(lines).join("\n");
  const selectedText = extractSelectionFromPageText(pageText, fallback);
  return selectedText.includes("\n") ? selectedText : "";
}

function getPdfTextContentFragments(
  items: PdfTextContentItem[],
  viewport: any,
) {
  const viewportTransform = cloneNumberTuple(
    unwrapXray(viewport?.transform),
    6,
  );
  const viewportScale = Math.abs(Number(viewport?.scale)) || 1;
  const fragments: SelectionFragment[] = [];

  for (let order = 0; order < items.length; order++) {
    const item = unwrapXray(items[order]);
    if (!item || typeof item.str !== "string") {
      continue;
    }

    const text = item.str;
    const rect = getPdfTextItemRect(item, viewportTransform, viewportScale);
    if (!rect) {
      continue;
    }

    fragments.push({
      text,
      rect,
      order,
      hasEOL: Boolean(item.hasEOL),
    });
  }
  return fragments;
}

function getPdfTextItemRect(
  item: PdfTextContentItem,
  viewportTransform: number[] | undefined,
  scale: number,
) {
  const transform = cloneNumberTuple(unwrapXray(item.transform), 6);
  if (!transform) {
    return undefined;
  }

  const transformed = viewportTransform
    ? multiplyAffineTransform(viewportTransform, transform)
    : transform;

  const x = transformed[4];
  const y = transformed[5];
  const width =
    Math.abs(Number(item.width) || 0) * scale ||
    Math.max(1, String(item.str || "").length) *
      Math.max(1, Math.abs(Number(item.height) || 0) * scale * 0.5);
  const height =
    Math.hypot(transformed[2] || 0, transformed[3] || 0) ||
    Math.abs(Number(item.height) || 0) * scale ||
    10;

  if (![x, y, width, height].every(Number.isFinite)) {
    return undefined;
  }

  return normalizeRect([x, y - height, x + width, y]);
}

function multiplyAffineTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyViewportTransformToRect(
  transform: number[],
  rect: number[],
): number[] {
  const x1 = transform[0] * rect[0] + transform[2] * rect[1] + transform[4];
  const y1 = transform[1] * rect[0] + transform[3] * rect[1] + transform[5];
  const x2 = transform[0] * rect[2] + transform[2] * rect[3] + transform[4];
  const y2 = transform[1] * rect[2] + transform[3] * rect[3] + transform[5];
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}

function buildTextContentLines(fragments: SelectionFragment[]) {
  if (!fragments.some((fragment) => fragment.hasEOL)) {
    return buildSelectionLines(fragments);
  }

  const lines: SelectionLine[] = [];
  let current: SelectionFragment[] = [];
  const pushLine = () => {
    const line = buildLineFromFragments(current);
    if (line?.text) {
      lines.push(line);
    }
    current = [];
  };

  for (const fragment of fragments) {
    if (fragment.text.trim()) {
      current.push(fragment);
    }
    if (fragment.hasEOL) {
      pushLine();
    }
  }
  pushLine();

  return orderSelectionLinesForReading(lines);
}

function buildLineFromFragments(fragments: SelectionFragment[]) {
  if (!fragments.length) {
    return undefined;
  }

  const rect = unionRects(fragments.map((fragment) => fragment.rect));
  if (!rect) {
    return undefined;
  }

  return {
    ...rect,
    order: Math.min(...fragments.map((fragment) => fragment.order)),
    text: buildLineText(fragments),
    fragments: [...fragments],
  };
}

function getPdfSelectionTextFromDOMSelection(
  reader: _ZoteroTypes.ReaderInstance,
  fallback: string,
  doc?: Document,
) {
  const pdfWin = getPdfWindow(reader, doc);
  const selection = pdfWin?.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }

  const fragments: SelectionFragment[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    fragments.push(...getTextFragmentsFromRange(selection.getRangeAt(i)));
  }
  return (
    paragraphizeFragments(fragments, fallback) ||
    plainTextFromFragments(fragments)
  );
}

function getPdfSelectionTextFromAnnotationRects(
  reader: _ZoteroTypes.ReaderInstance,
  annotation: _ZoteroTypes.Annotations.AnnotationJson,
  fallback: string,
  doc?: Document,
) {
  const annotationPos = unwrapXray(annotation?.position);
  const rects = cloneRectList(annotationPos?.rects);
  if (!rects.length || typeof annotationPos?.pageIndex !== "number") {
    return "";
  }

  const pageView = unwrapXray(
    getPdfPageView(reader, annotationPos.pageIndex, doc),
  );
  const pageDiv = pageView?.div as HTMLElement | undefined;
  const textLayerDiv = getTextLayerDiv(pageView);
  if (!pageView || !pageDiv || !textLayerDiv) {
    return "";
  }

  const pageRect = toRectLike(pageDiv.getBoundingClientRect());
  const spans =
    toLocalArray<HTMLElement>(textLayerDiv.querySelectorAll("span")) || [];
  const spanFragments: SelectionFragment[] = [];
  for (let order = 0; order < spans.length; order++) {
    const elem = spans[order];
    const rect = rectRelativeToPage(elem.getBoundingClientRect(), pageRect);
    spanFragments.push({
      text: elem.textContent || "",
      rect,
      order,
    });
  }

  const viewport = unwrapXray(pageView.viewport);
  const viewportTransform = cloneNumberTuple(
    unwrapXray(viewport?.transform),
    6,
  );
  const rectCandidates = [rects.map(normalizeRect)];
  if (viewportTransform) {
    rectCandidates.unshift(
      rects.map((rect) =>
        normalizeRect(applyViewportTransformToRect(viewportTransform, rect)),
      ),
    );
  }

  let best = "";
  let bestScore = 0;
  for (const selectionRects of rectCandidates) {
    const fragments = spanFragments.filter(
      (fragment) =>
        fragment.text.trim() &&
        selectionRects.some((rect) => intersects(rect, fragment.rect)),
    );
    const text = paragraphizeFragments(fragments, fallback);
    const score = getComparableScore(text, fallback);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }

  return bestScore >= 0.9 ? best : "";
}

function getComponentsUtils(): any {
  try {
    return (
      (globalThis as any).Components?.utils ||
      (Zotero.getMainWindow?.() as any)?.Components?.utils
    );
  } catch {
    return undefined;
  }
}

function unwrapXray<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  try {
    const Cu = getComponentsUtils();
    if (Cu?.waiveXrays) {
      return Cu.waiveXrays(value) as T;
    }
  } catch {
    // ignore
  }
  try {
    if ("wrappedJSObject" in (value as any)) {
      return ((value as any).wrappedJSObject || value) as T;
    }
  } catch {
    // ignore
  }
  return value;
}

function cloneIntoWindow<T>(value: T, targetWin: any): T {
  if (!value || typeof value !== "object" || !targetWin) {
    return value;
  }
  try {
    const Cu = getComponentsUtils();
    if (Cu?.cloneInto) {
      return Cu.cloneInto(value, targetWin) as T;
    }
  } catch {
    // ignore
  }
  return value;
}

function toLocalArray<T = any>(value: any): T[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const len = value.length;
  if (typeof len !== "number" || len < 0 || !Number.isFinite(len)) {
    return undefined;
  }
  const result: T[] = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = value[i];
  }
  return result;
}

function cloneNumberTuple(raw: any, minLen: number): number[] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const len = raw.length;
  if (typeof len !== "number" || len < minLen) {
    return undefined;
  }
  const out: number[] = new Array(minLen);
  for (let i = 0; i < minLen; i++) {
    const v = Number(raw[i]);
    if (!Number.isFinite(v)) {
      return undefined;
    }
    out[i] = v;
  }
  return out;
}

function cloneRectList(rawRects: any): number[][] {
  const list = toLocalArray<any>(unwrapXray(rawRects));
  if (!list?.length) {
    return [];
  }
  const out: number[][] = [];
  for (let i = 0; i < list.length; i++) {
    const tuple = cloneNumberTuple(unwrapXray(list[i]), 4);
    if (tuple) {
      out.push(tuple);
    }
  }
  return out;
}

function clonePageChars(rawChars: any): PdfPageChar[] | undefined {
  const unwrapped = unwrapXray(rawChars);
  if (!unwrapped || typeof unwrapped !== "object") {
    return undefined;
  }
  const len = unwrapped.length;
  if (typeof len !== "number" || len <= 0 || !Number.isFinite(len)) {
    return undefined;
  }
  const result: PdfPageChar[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const ch = unwrapXray(unwrapped[i]);
    if (!ch || typeof ch !== "object") {
      result[i] = {};
      continue;
    }
    result[i] = {
      c: typeof ch.c === "string" ? ch.c : undefined,
      u: typeof ch.u === "string" ? ch.u : undefined,
      rect: cloneNumberTuple(unwrapXray(ch.rect), 4),
      inlineRect: cloneNumberTuple(unwrapXray(ch.inlineRect), 4),
      rotation: typeof ch.rotation === "number" ? ch.rotation : 0,
      fontName: typeof ch.fontName === "string" ? ch.fontName : undefined,
      fontSize: typeof ch.fontSize === "number" ? ch.fontSize : undefined,
      spaceAfter: Boolean(ch.spaceAfter),
      lineBreakAfter: Boolean(ch.lineBreakAfter),
      paragraphBreakAfter: Boolean(ch.paragraphBreakAfter),
      ignorable: Boolean(ch.ignorable),
      isolated: Boolean(ch.isolated),
      offset: typeof ch.offset === "number" ? ch.offset : i,
    };
  }
  return result;
}

function getPdfView(reader: _ZoteroTypes.ReaderInstance, doc?: Document) {
  const internalReader = unwrapXray((reader._internalReader || reader) as any);
  const docReader = unwrapXray(unwrapXray(doc?.defaultView as any)?._reader);
  const candidates = [
    internalReader?._lastView,
    internalReader?._primaryView,
    internalReader?._secondaryView,
    docReader?._lastView,
    docReader?._primaryView,
    docReader?._secondaryView,
    reader,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const view = unwrapXray(candidate);
    if (
      view?._pdfPages ||
      view?._selectionRanges ||
      view?._iframeWindow?.PDFViewerApplication
    ) {
      return view;
    }
  }
  return unwrapXray(
    internalReader?._lastView ||
      internalReader?._primaryView ||
      docReader?._lastView ||
      docReader?._primaryView ||
      reader,
  );
}

function getPdfWindow(reader: _ZoteroTypes.ReaderInstance, doc?: Document) {
  const view = getPdfView(reader, doc);
  return view?._iframeWindow || (reader as any)._iframeWindow;
}

function getPdfPageView(
  reader: _ZoteroTypes.ReaderInstance,
  pageIndex: number,
  doc?: Document,
) {
  const pdfViewer = unwrapXray(
    getPdfWindow(reader, doc)?.PDFViewerApplication?.pdfViewer,
  );
  if (!pdfViewer) {
    return undefined;
  }
  if (typeof pdfViewer.getPageView === "function") {
    return pdfViewer.getPageView(pageIndex);
  }
  return pdfViewer._pages?.[pageIndex];
}

function getTextLayerDiv(pageView: any): HTMLElement | undefined {
  return (
    pageView?.textLayer?.div ||
    pageView?.textLayer?.textLayerDiv ||
    pageView?.div?.querySelector?.(".textLayer")
  );
}

function getTextFragmentsFromRange(range: Range) {
  const doc = range.commonAncestorContainer.ownerDocument;
  if (!doc) {
    return [];
  }

  const root =
    range.commonAncestorContainer.nodeType === 3
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root) {
    return [];
  }

  const fragments: SelectionFragment[] = [];
  const acceptTextNode = (node: Node) =>
    node.nodeType === 3 && !!node.nodeValue && range.intersectsNode(node);

  const nodes: Text[] = [];
  if (acceptTextNode(range.commonAncestorContainer)) {
    nodes.push(range.commonAncestorContainer as Text);
  } else {
    const walker = doc.createTreeWalker(root, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (acceptTextNode(node)) {
        nodes.push(node as Text);
      }
    }
  }

  for (let order = 0; order < nodes.length; order++) {
    const node = nodes[order];
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end <= start) {
      continue;
    }

    const text = node.data.slice(start, end);
    if (!text.trim()) {
      continue;
    }

    const textRange = doc.createRange();
    textRange.setStart(node, start);
    textRange.setEnd(node, end);
    const clientRects = toLocalArray<DOMRect>(textRange.getClientRects());
    if (!clientRects?.length) {
      continue;
    }
    const rects = clientRects
      .map(toRectLike)
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const rect = unionRects(rects);
    if (!rect) {
      continue;
    }

    fragments.push({ text, rect, order });
  }

  return fragments;
}
