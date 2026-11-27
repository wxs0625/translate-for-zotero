import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefsScripts,
  registerPrefsWindow,
} from "./modules/preferenceWindow";
import {
  registerReaderTabPanel,
  updateReaderTabPanels,
} from "./modules/tabpanel";
import { buildReaderPopup, updateReaderPopup } from "./modules/popup";
import { registerNotify } from "./modules/notify";
import { registerReaderInitializer } from "./modules/reader";
import { getPref } from "./utils/prefs";
import {
  addTranslateAnnotationTask,
  addTranslateTask,
  addTranslateTitleTask,
  getLastTranslateTask,
  TranslateTask,
} from "./utils/task";
import { setDefaultPrefSettings } from "./modules/defaultPrefs";
import Addon from "./addon";
import { registerMenu } from "./modules/menu";
import { registerExtraColumns } from "./modules/itemTree";
import { registerShortcuts } from "./modules/shortcuts";
import { registerItemPaneInfoRows } from "./modules/infoBox";
import { registerCustomFields } from "./modules/fields";
import { prewarmMathRendering } from "./utils/mathRenderer";

const CONCAT_AUTO_TRANSLATE_DEBOUNCE_MS = 150;
let concatAutoTranslateTimer: number | null = null;
let concatAutoTranslateTick = 0;
let lastAutoTranslateTaskKey = "";

function clearConcatAutoTranslateTimer() {
  if (concatAutoTranslateTimer === null) {
    return;
  }
  const win = Zotero.getMainWindow?.();
  const clearTimer = win?.clearTimeout?.bind(win) ?? clearTimeout;
  clearTimer(concatAutoTranslateTimer);
  concatAutoTranslateTimer = null;
}

function scheduleConcatAutoTranslate(task?: TranslateTask) {
  clearConcatAutoTranslateTimer();
  const currentTick = ++concatAutoTranslateTick;
  const win = Zotero.getMainWindow?.();
  const setTimer = win?.setTimeout?.bind(win) ?? setTimeout;
  concatAutoTranslateTimer = setTimer(() => {
    concatAutoTranslateTimer = null;
    if (currentTick !== concatAutoTranslateTick) {
      return;
    }
    const latestTask =
      (task?.id ? getLastTranslateTask({ id: task.id }) : undefined) ||
      getLastTranslateTask({ type: "text" });
    if (!latestTask || latestTask.type !== "text") {
      return;
    }
    // In concat mode, only trigger once for the latest merged text.
    triggerAutoTranslate(latestTask);
  }, CONCAT_AUTO_TRANSLATE_DEBOUNCE_MS) as unknown as number;
}

function triggerAutoTranslate(task?: TranslateTask) {
  const latestTask = task || getLastTranslateTask({ type: "text" });
  if (!latestTask || latestTask.type !== "text") {
    return;
  }
  const taskKey = [
    latestTask.id,
    latestTask.service,
    latestTask.raw,
    latestTask.langfrom || "",
    latestTask.langto || "",
  ].join("\u0000");
  if (
    latestTask.status === "processing" ||
    (latestTask.status === "success" && lastAutoTranslateTaskKey === taskKey)
  ) {
    return;
  }
  lastAutoTranslateTaskKey = taskKey;
  addon.hooks.onTranslate(latestTask);
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // TODO: Remove this after zotero#3387 is merged
  if (__env__ === "development") {
    // Keep in sync with the scripts/startup.mjs
    const loadDevToolWhen = `Plugin ${config.addonID} startup`;
    ztoolkit.log(loadDevToolWhen);
  }

  initLocale();

  addon.data.translate.concatKey = false;
  addon.data.translate.concatCheckbox = false;

  setDefaultPrefSettings();

  registerCustomFields();

  registerReaderInitializer();

  registerShortcuts();

  registerNotify(["item"]);

  registerPrefsWindow();

  registerExtraColumns();

  registerItemPaneInfoRows();

  registerReaderTabPanel();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(win: Window): Promise<void> {
  await new Promise((resolve) => {
    if (win.document.readyState !== "complete") {
      win.document.addEventListener("readystatechange", () => {
        if (win.document.readyState === "complete") {
          resolve(void 0);
        }
      });
    }
    resolve(void 0);
  });

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Services.scriptloader.loadSubScript(
    `chrome://${config.addonRef}/content/scripts/customElements.js`,
    win,
  );

  (win as any).MozXULElement.insertFTLIfNeeded(
    `${config.addonRef}-mainWindow.ftl`,
  );

  registerMenu();

  // Prewarm KaTeX so the first formula rendered during streaming doesn't
  // cause a one-time initialization hitch (~3ms cold start + lazy font load).
  const idle = (win as any).requestIdleCallback?.bind(win);
  const runPrewarm = () => {
    prewarmMathRendering();
    // Best-effort font preload so the first `.katex` span doesn't trigger
    // synchronous woff2 fetch + font-swap reflow mid-stream.
    try {
      const fontSet = (win.document as any).fonts;
      if (fontSet?.load) {
        Promise.all([
          fontSet.load("1.21em KaTeX_Main"),
          fontSet.load("1.21em KaTeX_Math"),
        ]).catch(() => {});
      }
    } catch {
      // ignore
    }
  };
  if (idle) {
    idle(runPrewarm, { timeout: 3000 });
  } else {
    win.setTimeout(runPrewarm, 2000);
  }

  win.document.addEventListener("focusout", (ev) => {
    if (ev.target !== win.document) {
      return;
    }
    if (addon.data.translate.concatKey) {
      addon.data.translate.concatKey = false;
      addon.hooks.onReaderTabPanelRefresh();
    }
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  win.document
    .querySelector(`[href="${config.addonRef}-mainWindow.ftl"]`)
    ?.remove();
}

function onShutdown(): void {
  clearConcatAutoTranslateTimer();
  ztoolkit.unregisterAll();
  Zotero.getMainWindows().forEach((win) => {
    onMainWindowUnload(win);
  });
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (event === "add" && type === "item") {
    if (
      !getPref("enableAnnotationFromSyncTranslation") &&
      extraData?.skipAutoSync
    )
      return;
    const annotationItems = Zotero.Items.get(ids as number[]).filter((item) =>
      item.isAnnotation(),
    );
    if (annotationItems.length === 0) {
      return;
    }
    if (getPref("enableComment")) {
      addon.hooks.onTranslateInBatch(
        annotationItems
          .map((item) => addTranslateAnnotationTask(item.id))
          .filter((task) => task) as TranslateTask[],
        { noDisplay: true },
      );
    }
  } else if (type === "tab" && ["select", "add", "close"].includes(event)) {
    clearConcatAutoTranslateTimer();
    lastAutoTranslateTaskKey = "";
    if (addon.data.translate.concatKey || addon.data.translate.concatCheckbox) {
      addon.data.translate.concatKey = false;
      addon.data.translate.concatCheckbox = false;
      addon.hooks.onReaderTabPanelRefresh();
    }
  } else {
    return;
  }
}

function onPrefsLoad(event: Event) {
  // `ownerGlobal` is undefined on Zotero 11+ (Firefox 153); use defaultView
  registerPrefsScripts(
    (event.target as Element)?.ownerDocument?.defaultView ||
      (event.target as any).ownerGlobal,
  );
}

function onShortcuts(type: string) {
  switch (type) {
    case "library":
      {
        addon.hooks.onTranslateInBatch(
          (Zotero.getActiveZoteroPane()?.getSelectedItems(true) || [])
            .map((id) => addTranslateTitleTask(id, true))
            .filter((task) => task) as TranslateTask[],
          { noDisplay: true, noCache: true },
        );
      }
      break;
    case "reader":
      {
        addon.hooks.onTranslate(undefined, {
          noCheckZoteroItemLanguage: true,
          noCache: true,
        });
      }
      break;
    default:
      break;
  }
}

async function onTranslate(): Promise<void>;
async function onTranslate(
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(
  task: TranslateTask | undefined,
  options?: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(...data: any) {
  let task = undefined;
  let options = {};
  if (data.length === 1) {
    if (data[0].raw) {
      task = data[0];
    } else {
      options = data[0];
    }
  } else if (data.length === 2) {
    task = data[0];
    options = data[1];
  }
  await addon.data.translate.services.runTranslationTask(task, options);
}

async function onTranslateInBatch(
  tasks: TranslateTask[],
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"] = {},
) {
  for (const task of tasks) {
    await addon.hooks.onTranslate(task, options);
    await Zotero.Promise.delay(addon.data.translate.batchTaskDelay);
  }
}

function onReaderPopupShow(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const selection = addon.data.translate.selectedText;
  if (!selection.trim()) {
    clearConcatAutoTranslateTimer();
    return;
  }
  const isConcatMode =
    addon.data.translate.concatCheckbox ||
    ((getPref("enableConcatKey") as boolean) && addon.data.translate.concatKey);
  const task = getLastTranslateTask({ type: "text" });
  if (task?.raw === selection) {
    try {
      buildReaderPopup(event, task);
      updateReaderPopup(task.id);
    } catch (e) {
      ztoolkit.log("Failed to build/update reader popup", e);
    }
    // Refresh the sidebar panel so the selected text is displayed there too.
    addon.hooks.onReaderTabPanelRefresh();
    if (getPref("enableAuto")) {
      if (isConcatMode) {
        scheduleConcatAutoTranslate(task);
      } else {
        clearConcatAutoTranslateTimer();
        triggerAutoTranslate(task);
      }
    }
    return;
  }
  const newTask = addTranslateTask(selection, event.reader.itemID, "text");
  lastAutoTranslateTaskKey = "";
  if (!newTask) {
    clearConcatAutoTranslateTimer();
    return;
  }
  try {
    buildReaderPopup(event, newTask);
    updateReaderPopup(newTask.id);
  } catch (e) {
    ztoolkit.log("Failed to build/update reader popup", e);
  }
  // Refresh the sidebar panel immediately so the selected text is displayed
  // even if auto-translation is disabled or runTranslationTask returns early.
  addon.hooks.onReaderTabPanelRefresh();
  if (getPref("enableAuto")) {
    if (isConcatMode) {
      scheduleConcatAutoTranslate(newTask);
    } else {
      clearConcatAutoTranslateTimer();
      triggerAutoTranslate(newTask);
    }
  } else {
    clearConcatAutoTranslateTimer();
  }
}

function onReaderPopupRefresh() {
  updateReaderPopup();
}

function onReaderTabPanelRefresh() {
  updateReaderTabPanels();
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onNotify,
  onPrefsLoad,
  onShortcuts,
  onTranslate,
  onTranslateInBatch,
  onReaderPopupShow,
  onReaderPopupRefresh,
  onReaderTabPanelRefresh,
};
