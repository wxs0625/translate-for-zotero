import { config } from "../../package.json";
import { PluginCEBase } from "./base";
import { getMinResultHeight, getPref, setPref } from "../utils/prefs";
import { LANG_CODE } from "../utils/config";
import {
  addTranslateTask,
  autoDetectLanguage,
  getLastTranslateTask,
  putTranslateTaskAtHead,
} from "../utils/task";
import type { TranslationServices } from "../modules/services";

//@ts-expect-error addon instance not typed
const services = Zotero[config.addonInstance].data.translate
  .services as TranslationServices;

const OUTPUT_CONTEXT_POPUP_ID = `${config.addonRef}-standalone-output-context-popup`;
const OUTPUT_CONTEXT_COPY_SELECTION_ID = `${config.addonRef}-standalone-output-copy-selection`;
const OUTPUT_CONTEXT_COPY_RESULT_ID = `${config.addonRef}-standalone-output-copy-result`;
const OUTPUT_CONTEXT_COPY_RAW_ID = `${config.addonRef}-standalone-output-copy-raw`;
const OUTPUT_CONTEXT_COPY_BOTH_ID = `${config.addonRef}-standalone-output-copy-both`;
const OUTPUT_CONTEXT_SELECT_ALL_ID = `${config.addonRef}-standalone-output-select-all`;
const OUTPUT_CONTEXT_LABELS = {
  copySelection: "\u590d\u5236",
  copyResult: "\u590d\u5236\u7ed3\u679c",
  copyRaw: "\u590d\u5236\u6e90\u6587",
  copyBoth: "\u590d\u5236\u6e90\u6587\u548c\u7ed3\u679c",
  selectAll: "\u5168\u9009",
};

export class TranslatorPanel extends PluginCEBase {
  _item: Zotero.Item | null = null;

  _taskID = "";
  _hasPendingUserEdit = false;
  _outputContextSelectionText = "";
  _outputContextTaskID = "";
  _modelRequestSerial = 0;
  _modelServiceID = "";
  _modelMenuUpdating = false;
  _streamingTaskId = "";
  _streamingLastOutputLen = -1;

  get item() {
    return this._item;
  }

  set item(val) {
    this._item = val;
  }

  _getInputFieldID() {
    return (getPref("rawResultOrder") ? "result-text" : "raw-text") as
      | "raw-text"
      | "result-text";
  }

  _getOutputFieldID() {
    return (getPref("rawResultOrder") ? "raw-text" : "result-text") as
      | "raw-text"
      | "result-text";
  }

  _getTextTaskByID(taskID: string) {
    if (!taskID) {
      return undefined;
    }
    const task = getLastTranslateTask({ id: taskID });
    if (task?.type === "text") {
      return task;
    }
    return undefined;
  }

  _getActiveTextTask() {
    const byTaskID = this._getTextTaskByID(this._taskID);
    const byActiveID = this._getTextTaskByID(
      this._addon.data.translate.activeTaskId,
    );
    const keepPanelTask =
      this._hasPendingUserEdit || this._isFieldFocused(this._getInputFieldID());
    if (keepPanelTask && byTaskID) {
      return byTaskID;
    }
    if (byActiveID) {
      return byActiveID;
    }
    if (byTaskID) {
      return byTaskID;
    }
    for (let i = this._addon.data.translate.queue.length - 1; i >= 0; i--) {
      const task = this._addon.data.translate.queue[i];
      if (task.type === "text") {
        return task;
      }
    }
    return undefined;
  }

  _getFieldValue(type: "raw-text" | "result-text") {
    const elem = this._queryID(type) as XUL.Textbox | null;
    return elem?.value || "";
  }

  _isFieldFocused(type: "raw-text" | "result-text") {
    const elem = this._queryID(type) as HTMLElement | null;
    if (!elem) {
      return false;
    }
    const active = elem.ownerDocument?.activeElement;
    return !!active && (active === elem || elem.contains(active));
  }

  _syncTextTaskFromInput(rawInput?: string) {
    const inputFieldID = this._getInputFieldID();
    const value =
      typeof rawInput === "string"
        ? rawInput
        : this._getFieldValue(inputFieldID);
    let task = this._getActiveTextTask();
    if (task && task.status === "processing" && task.raw !== value) {
      task = undefined;
    }
    if (!task) {
      task = addTranslateTask(value, this.item?.id, "text");
    }
    if (!task) {
      return undefined;
    }
    this._taskID = task.id;
    task.raw = value;
    if (task.status !== "processing") {
      task.status = "waiting";
    }
    task.extraTasks?.forEach((extraTask) => {
      extraTask.raw = value;
      if (extraTask.status !== "processing") {
        extraTask.status = "waiting";
      }
    });
    this._addon.data.translate.activeTaskId = task.id;
    putTranslateTaskAtHead(task.id);
    return task;
  }

  _onTextInput = (e: Event) => {
    const currentTarget = e.currentTarget as HTMLElement | null;
    const fieldID = this._unwrapID(currentTarget?.id || "");
    if (fieldID !== this._getInputFieldID()) {
      return;
    }
    const nextValue =
      ((e.target as HTMLTextAreaElement | undefined)?.value as string) ??
      this._getFieldValue(this._getInputFieldID());
    const task = this._syncTextTaskFromInput(nextValue);
    if (!task) {
      return;
    }
    this._hasPendingUserEdit = true;
  };

  _onTextFocusOut = (e: Event) => {
    const focusEvent = e as FocusEvent;
    const currentTarget = e.currentTarget as HTMLElement | null;
    const fieldID = this._unwrapID(currentTarget?.id || "");
    if (fieldID !== this._getInputFieldID()) {
      return;
    }
    const nextTarget = focusEvent.relatedTarget as HTMLElement | null;
    if (currentTarget && nextTarget && currentTarget.contains(nextTarget)) {
      return;
    }
    if (nextTarget?.closest(`#${this._wrapID("translate")}`)) {
      return;
    }
    if (!this._hasPendingUserEdit) {
      return;
    }
    const task = this._syncTextTaskFromInput();
    this._hasPendingUserEdit = false;
    if (!task?.raw) {
      return;
    }
    this._addon.hooks.onTranslate(task, {
      noCheckZoteroItemLanguage: true,
      noCache: true,
    });
  };

  _getCurrentOutputTask(taskID?: string) {
    return (
      this._getTextTaskByID(taskID || "") ||
      this._getTextTaskByID(this._taskID) ||
      this._getActiveTextTask()
    );
  }

  _copyOutputContextText(text?: string) {
    if (!text) {
      return;
    }
    new this._addon.data.ztoolkit.Clipboard()
      .addText(text, "text/plain")
      .copy();
  }

  _copyOutputContextTaskContent(type: "raw" | "result" | "both") {
    const task = this._getCurrentOutputTask(this._outputContextTaskID);
    if (!task) {
      return;
    }
    const text =
      type === "raw"
        ? task.raw
        : type === "result"
          ? task.result
          : `${task.raw}\n----\n${task.result}`;
    this._copyOutputContextText(text);
  }

  _getOutputContextField() {
    return this._queryID(this._getOutputFieldID()) as HTMLElement | null;
  }

  _eventInsideElement(event: Event, elem: HTMLElement) {
    const path = (event as any).composedPath?.() as EventTarget[] | undefined;
    if (path?.includes(elem)) {
      return true;
    }
    let node = event.target as any;
    while (node) {
      if (node === elem) {
        return true;
      }
      node = node.parentElement || node.parentNode || node.host;
    }
    return false;
  }

  _getSelectedTextFromOutput(elem: HTMLElement | null) {
    if (!elem) {
      return "";
    }
    const doc = elem.ownerDocument;
    const selection = doc?.getSelection?.();
    if (selection && selection.rangeCount > 0) {
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (
        anchorNode &&
        focusNode &&
        elem.contains(anchorNode) &&
        elem.contains(focusNode)
      ) {
        return selection.toString();
      }
    }

    const editable = elem.querySelector?.("editable-text") as any;
    const textarea = elem.querySelector?.(
      "textarea",
    ) as HTMLTextAreaElement | null;
    const control =
      textarea || editable?.inputField || (elem as any).inputField;
    const value =
      (typeof control?.value === "string" ? control.value : "") ||
      ((elem as any).value as string) ||
      "";
    if (
      typeof control?.selectionStart === "number" &&
      typeof control?.selectionEnd === "number"
    ) {
      const start = Math.max(0, control.selectionStart);
      const end = Math.max(start, control.selectionEnd);
      return value.slice(start, end);
    }
    return "";
  }

  _selectAllOutputContextText() {
    const elem = this._getOutputContextField();
    if (!elem) {
      return;
    }
    const overlay = elem.querySelector?.(".math-overlay") as HTMLElement | null;
    if (overlay) {
      const doc = elem.ownerDocument;
      const selection = doc?.getSelection?.();
      const range = doc?.createRange?.();
      if (selection && range) {
        selection.removeAllRanges();
        range.selectNodeContents(overlay);
        selection.addRange(range);
        return;
      }
    }

    const editable = elem.querySelector?.("editable-text") as any;
    const textarea = elem.querySelector?.(
      "textarea",
    ) as HTMLTextAreaElement | null;
    const control =
      textarea || editable?.inputField || editable || (elem as any);
    const value =
      (typeof control?.value === "string" ? control.value : "") ||
      ((elem as any).value as string) ||
      "";
    control?.focus?.();
    if (typeof control?.setSelectionRange === "function") {
      control.setSelectionRange(0, value.length);
      return;
    }
    if (
      typeof control?.selectionStart === "number" &&
      typeof control?.selectionEnd === "number"
    ) {
      control.selectionStart = 0;
      control.selectionEnd = value.length;
    }
  }

  _ensureOutputContextPopup() {
    const doc = this.ownerDocument ?? document;
    let popup = doc.querySelector(`#${OUTPUT_CONTEXT_POPUP_ID}`) as any;
    if (popup) {
      return popup;
    }

    // @ts-ignore createXULElement is available in Zotero/Firefox runtime
    popup = doc.createXULElement("menupopup");
    popup.id = OUTPUT_CONTEXT_POPUP_ID;

    const appendMenuItem = (
      id: string,
      label: string,
      onCommand: () => void,
    ) => {
      // @ts-ignore createXULElement is available in Zotero/Firefox runtime
      const item = doc.createXULElement("menuitem") as any;
      item.id = id;
      item.setAttribute("label", label);
      item.addEventListener("command", onCommand);
      popup.append(item);
      return item;
    };

    const getCurrentPanel = () =>
      (popup._currentPanel as TranslatorPanel | null) || this;

    appendMenuItem(
      OUTPUT_CONTEXT_COPY_SELECTION_ID,
      OUTPUT_CONTEXT_LABELS.copySelection,
      () => {
        const panel = getCurrentPanel();
        panel._copyOutputContextText(
          panel._getSelectedTextFromOutput(panel._getOutputContextField()) ||
            panel._outputContextSelectionText,
        );
      },
    );
    appendMenuItem(
      OUTPUT_CONTEXT_COPY_RESULT_ID,
      OUTPUT_CONTEXT_LABELS.copyResult,
      () => {
        getCurrentPanel()._copyOutputContextTaskContent("result");
      },
    );
    appendMenuItem(
      OUTPUT_CONTEXT_COPY_RAW_ID,
      OUTPUT_CONTEXT_LABELS.copyRaw,
      () => {
        getCurrentPanel()._copyOutputContextTaskContent("raw");
      },
    );
    appendMenuItem(
      OUTPUT_CONTEXT_COPY_BOTH_ID,
      OUTPUT_CONTEXT_LABELS.copyBoth,
      () => {
        getCurrentPanel()._copyOutputContextTaskContent("both");
      },
    );

    // @ts-ignore createXULElement is available in Zotero/Firefox runtime
    popup.append(doc.createXULElement("menuseparator"));

    appendMenuItem(
      OUTPUT_CONTEXT_SELECT_ALL_ID,
      OUTPUT_CONTEXT_LABELS.selectAll,
      () => {
        getCurrentPanel()._selectAllOutputContextText();
      },
    );

    popup.addEventListener("popuphidden", () => {
      popup._currentPanel = null;
    });

    let popupSet = doc.querySelector("popupset") as any;
    if (!popupSet && typeof (doc as any).createXULElement === "function") {
      popupSet = (doc as any).createXULElement("popupset");
      doc.documentElement?.append(popupSet);
    }
    (popupSet || doc.documentElement || doc.body)?.append(popup);
    return popup;
  }

  _prepareOutputContextPopup(outputElem: HTMLElement) {
    const popup = this._ensureOutputContextPopup();
    const task = this._getCurrentOutputTask();
    this._outputContextSelectionText =
      this._getSelectedTextFromOutput(outputElem);
    this._outputContextTaskID = task?.id || this._taskID;
    popup._currentPanel = this;

    const setDisabled = (id: string, disabled: boolean) => {
      const item = popup.querySelector(`#${id}`) as any;
      if (item) {
        item.disabled = disabled;
      }
    };
    setDisabled(
      OUTPUT_CONTEXT_COPY_SELECTION_ID,
      !this._outputContextSelectionText,
    );
    setDisabled(OUTPUT_CONTEXT_COPY_RESULT_ID, !task?.result);
    setDisabled(OUTPUT_CONTEXT_COPY_RAW_ID, !task?.raw);
    setDisabled(OUTPUT_CONTEXT_COPY_BOTH_ID, !task?.raw && !task?.result);
    setDisabled(
      OUTPUT_CONTEXT_SELECT_ALL_ID,
      !(task?.result || this._getFieldValue(this._getOutputFieldID())),
    );
  }

  _onOutputContextMenu = (event: Event) => {
    const mouseEvent = event as MouseEvent;
    const outputElem = this._getOutputContextField();
    if (!outputElem || !this._eventInsideElement(event, outputElem)) {
      return;
    }

    this._prepareOutputContextPopup(outputElem);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const popup = this._ensureOutputContextPopup();
    try {
      if (typeof popup.openPopupAtScreen === "function") {
        popup.openPopupAtScreen(mouseEvent.screenX, mouseEvent.screenY, true);
        return;
      }
    } catch {
      // Fall back to anchor-based opening below.
    }
    popup.openPopup?.(outputElem, "after_start", 0, 0, true, false, mouseEvent);
  };

  get content() {
    return this._parseContentID(
      MozXULElement.parseXULToFragment(`
<linkset>
  <html:link rel="localization" href="${config.addonRef}-panel.ftl" />
  <html:link
    rel="stylesheet"
    href="chrome://${config.addonRef}/content/styles/panel.css"
  ></html:link>
</linkset>
<hbox id="engine" align="center">
  <menulist id="services" class="service-menulist" native="true">
    <menupopup>
      ${services
        .getAllServicesWithType("sentence")
        .map((service) => {
          const customName = services.getServiceNameByID(service.id, false);
          return `<menuitem label="${customName}" value="${service.id}" />`;
        })
        .join("\n")}
    </menupopup>
  </menulist>
  <menulist id="models" class="model-menulist" native="true" hidden="true">
    <menupopup>
      <menuitem label="-" value="" disabled="true" />
    </menupopup>
  </menulist>
  <button id="translate" data-l10n-id="translate" />
</hbox>
<hbox id="language" align="center">
  <menulist id="langfrom" class="lang-menulist" native="true">
    <menupopup>
      ${LANG_CODE.map((lang) => `<menuitem label="${lang.name}" value="${lang.code}" />`).join("\n")}
    </menupopup>
  </menulist>
  <toolbarbutton id="swap-language" class="icon-button" data-l10n-id="swapLanguage" />
  <menulist id="langto" class="lang-menulist" native="true">
    <menupopup>
      ${LANG_CODE.map((lang) => `<menuitem label="${lang.name}" value="${lang.code}" />`).join("\n")}
    </menupopup>
  </menulist>
</hbox>
<html:div class="separator"></html:div>
<html:div id="text-container" class="editor-container">
  ${
    (getPref("enableMathRendering") as boolean)
      ? `<math-textbox id="raw-text"></math-textbox>`
      : `<editable-text id="raw-text" multiline="true" />`
  }
  <html:div id="resizer" class="draggable-container">
    <html:div class="separator"></html:div>
  </html:div>
  ${
    (getPref("enableMathRendering") as boolean)
      ? `<math-textbox id="result-text"></math-textbox>`
      : `<editable-text id="result-text" multiline="true" />`
  }
</html:div>
<html:div class="separator"></html:div>
<html:div class="options-container">
  <html:div id="auto-container" class="options-grid">
    <html:label class="options-label" data-l10n-id="auto" />
    <html:div class="options-content">
      <checkbox id="auto-trans-selection" native="true" data-l10n-id="autoTranslateSelection" />
      <checkbox id="auto-trans-annotation" native="true" data-l10n-id="autoTranslateAnnotation" />
    </html:div>
  </html:div>
  <html:div id="concat-container" class="options-grid">
    <html:label class="options-label" data-l10n-id="selection" />
    <html:div class="options-content">
      <checkbox id="concat" native="true" data-l10n-id="enableConcat" />
      <button id="clear-concat" data-l10n-id="clearConcat" />
    </html:div>
  </html:div>
  <html:div id="copy-container" class="options-grid" >
    <html:label class="options-label" data-l10n-id="copy" />
    <html:div class="options-content">
      <button id="copy-raw" data-l10n-id="copyRaw" />
      <button id="copy-result" data-l10n-id="copyResult" />
      <button id="copy-both" data-l10n-id="copyBoth" />
    </html:div>
  </html:div>
</html:div>
`),
    );
  }

  init(): void {
    // Services
    this._queryID("services")?.addEventListener("command", (e) => {
      const newService = (e.target as XUL.MenuList).value;
      setPref("translateSource", newService);
      void this._refreshModelMenu(newService);
      this._addon.hooks.onReaderTabPanelRefresh();
      const data = this._syncTextTaskFromInput() || this._getActiveTextTask();
      if (!data) {
        return;
      }
      data.service = newService;
      this._addon.hooks.onTranslate(data, {
        noCheckZoteroItemLanguage: true,
        noCache: true,
        forceRestart: true,
      });
    });

    // Models
    this._queryID("models")?.addEventListener("command", (e) => {
      if (this._modelMenuUpdating) {
        return;
      }
      const serviceID = String(
        (this._queryID("services") as XUL.MenuList | null)?.value ||
          getPref("translateSource") ||
          "",
      );
      const model = String((e.target as XUL.MenuList).value || "").trim();
      if (
        !serviceID ||
        !model ||
        !services.setServiceModelByID(serviceID, model)
      ) {
        return;
      }
      this._addon.hooks.onReaderTabPanelRefresh();
      const data = this._syncTextTaskFromInput() || this._getActiveTextTask();
      if (!data) {
        return;
      }
      data.service = serviceID;
      this._addon.hooks.onTranslate(data, {
        noCheckZoteroItemLanguage: true,
        noCache: true,
        forceRestart: true,
      });
    });

    // Translate
    this._queryID("translate")?.addEventListener("command", () => {
      const task = this._syncTextTaskFromInput();
      if (!task?.raw) {
        return;
      }
      this._hasPendingUserEdit = false;
      this._addon.hooks.onTranslate(task, {
        noCheckZoteroItemLanguage: true,
        noCache: true,
        forceRestart: true,
      });
    });

    // Language change
    this._queryID("langfrom")?.addEventListener("command", (e) => {
      const newValue = (e.target as XUL.MenuList).value;
      setPref("sourceLanguage", newValue);
      const itemID = this.item?.id;
      if (itemID) {
        this._addon.data.translate.cachedSourceLanguage[Number(itemID)] =
          newValue;
      }
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("swap-language")?.addEventListener("command", () => {
      const langfrom = getPref("sourceLanguage") as string;
      const langto = getPref("targetLanguage") as string;
      setPref("targetLanguage", langfrom);
      setPref("sourceLanguage", langto);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("langto")?.addEventListener("command", (e) => {
      setPref("targetLanguage", (e.target as XUL.MenuList).value);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    // Text change
    this._queryID("raw-text")?.addEventListener("input", this._onTextInput);
    this._queryID("result-text")?.addEventListener("input", this._onTextInput);
    this._queryID("raw-text")?.addEventListener(
      "focusout",
      this._onTextFocusOut,
    );
    this._queryID("result-text")?.addEventListener(
      "focusout",
      this._onTextFocusOut,
    );
    this.addEventListener("contextmenu", this._onOutputContextMenu, {
      capture: true,
    });

    // Auto translate
    this._queryID("auto-trans-selection")?.addEventListener("command", (e) => {
      setPref("enableAuto", (e.target as XUL.Checkbox).checked);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("auto-trans-annotation")?.addEventListener("command", (e) => {
      setPref("enableComment", (e.target as XUL.Checkbox).checked);
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    // Concat
    this._queryID("concat")?.addEventListener("command", (e) => {
      const checked = (e.target as XUL.Checkbox).checked;
      this._addon.data.translate.concatCheckbox = checked;
      // Ensure mouse toggling can always cancel keyboard concat mode.
      this._addon.data.translate.concatKey = false;
      this._addon.hooks.onReaderTabPanelRefresh();
    });

    this._queryID("clear-concat")?.addEventListener("command", () => {
      const task = getLastTranslateTask();
      if (task) {
        task.raw = "";
        task.result = "";
        task.extraTasks.forEach((t) => {
          t.result = "";
        });
        this._addon.hooks.onReaderTabPanelRefresh();
      }
    });

    // Copy
    this._queryID("copy-raw")?.addEventListener("command", () => {
      const task = getLastTranslateTask({ id: this._taskID });
      if (task) {
        new this._addon.data.ztoolkit.Clipboard()
          .addText(task.raw, "text/plain")
          .copy();
      }
    });

    this._queryID("copy-result")?.addEventListener("command", () => {
      const task = getLastTranslateTask({ id: this._taskID });
      if (task) {
        new this._addon.data.ztoolkit.Clipboard()
          .addText(task.result, "text/plain")
          .copy();
      }
    });

    this._queryID("copy-both")?.addEventListener("command", () => {
      const task = getLastTranslateTask({ id: this._taskID });
      if (task) {
        new this._addon.data.ztoolkit.Clipboard()
          .addText(`${task.raw}\n----\n${task.result}`, "text/plain")
          .copy();
      }
    });

    // Draggable text area
    const resizer = this._queryID("resizer") as HTMLElement;
    const container = this._queryID("text-container") as HTMLElement;
    const rawArea = this._queryID("raw-text") as HTMLElement;
    const resultArea = this._queryID("result-text") as HTMLElement;

    rawArea.style.flex = `${getPref("customRawRatio")} 1 0%`;
    resultArea.style.flex = `${getPref("customResultRatio")} 1 0%`;

    let isDragging = false;
    let containerRect: DOMRect;
    resizer?.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) {
        return;
      }
      isDragging = true;
      e.preventDefault();
      containerRect = container.getBoundingClientRect();
      window.document.addEventListener("mousemove", doDrag);
      window.document.addEventListener("mouseup", (e: MouseEvent) => {
        isDragging = false;
        window.document.removeEventListener("mousemove", doDrag);
      });
    });

    function doDrag(e: MouseEvent) {
      if (!isDragging) {
        return;
      }
      const newRawHeight = e.clientY - containerRect.top;
      // Source can shrink to 1 line; result keeps the user-configured
      // minimum height in px (minResultHeight pref).
      const rawStyle = getComputedStyle(rawArea);
      const containerStyle = getComputedStyle(container);
      const fs = parseFloat(
        rawStyle?.fontSize || containerStyle?.fontSize || "15",
      );
      const lh =
        parseFloat(rawStyle?.lineHeight || "") / fs ||
        Number(getPref("lineHeight")) ||
        1.5;
      const rawMinHeight = Math.round(fs * lh + 9); // 1 line + padding
      const resultMinHeight = getMinResultHeight(); // configured px
      const maxRawHeight = containerRect.height - resultMinHeight - 13;
      if (newRawHeight >= rawMinHeight && newRawHeight <= maxRawHeight) {
        const newResultHeight = containerRect.height - newRawHeight - 13;
        const newRawRatio = (
          newRawHeight / Math.min(newRawHeight, newResultHeight)
        ).toFixed(3);
        const newResultRatio = (
          newResultHeight / Math.min(newRawHeight, newResultHeight)
        ).toFixed(3);
        rawArea.style.flex = `${newRawRatio} 1 0%`;
        resultArea.style.flex = `${newResultRatio} 1 0%`;
        setPref("customRawRatio", newRawRatio);
        setPref("customResultRatio", newResultRatio);
      }
    }

    resizer?.addEventListener("dblclick", (e: MouseEvent) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      rawArea.style.flex = "1 1 0%";
      resultArea.style.flex = "1 1 0%";
      setPref("customRawRatio", "1");
      setPref("customResultRatio", "1");
    });
  }

  destroy(): void {
    this._modelRequestSerial++;
    this.removeEventListener("contextmenu", this._onOutputContextMenu, true);
  }

  _setModelMenu(serviceID: string, models: string[], selectedModel = "") {
    const menuList = this._queryID("models") as any;
    const menuPopup = menuList?.querySelector("menupopup") as any;
    if (!menuList || !menuPopup) {
      return;
    }

    const values = [
      ...new Set(
        models.map((model) => String(model || "").trim()).filter(Boolean),
      ),
    ];
    const hasModelSetting =
      serviceID === "gemini" || !!services.getServiceModelPrefKey(serviceID);
    const createMenuItem = () =>
      menuPopup.ownerDocument.createXULElement?.("menuitem") ||
      menuPopup.ownerDocument.createElement("menuitem");
    this._modelMenuUpdating = true;
    try {
      while (menuPopup.firstChild) {
        menuPopup.removeChild(menuPopup.firstChild);
      }
      if (!values.length) {
        const emptyItem = createMenuItem();
        emptyItem.setAttribute("label", "-");
        emptyItem.setAttribute("value", "");
        emptyItem.setAttribute("disabled", "true");
        menuPopup.appendChild(emptyItem);
      } else {
        for (const model of values) {
          const item = createMenuItem();
          item.setAttribute("label", model);
          item.setAttribute("value", model);
          menuPopup.appendChild(item);
        }
      }
      const showModelMenu = hasModelSetting && values.length > 0;
      menuList.hidden = !showModelMenu;
      menuList.disabled = !showModelMenu;
      const nextValue = selectedModel || values[0] || "";
      menuList.value = nextValue;
    } finally {
      this._modelMenuUpdating = false;
    }
  }

  async _refreshModelMenu(serviceID: string) {
    const requestSerial = ++this._modelRequestSerial;
    this._modelServiceID = serviceID;
    const currentModel = services.getServiceModelByID(serviceID);
    this._setModelMenu(
      serviceID,
      currentModel ? [currentModel] : [],
      currentModel,
    );

    const models = await services.fetchServiceModels(serviceID);
    if (
      requestSerial !== this._modelRequestSerial ||
      this._modelServiceID !== serviceID ||
      String((this._queryID("services") as any)?.value || "") !== serviceID
    ) {
      return;
    }

    let selectedModel = services.getServiceModelByID(serviceID);
    if (!selectedModel && models[0]) {
      services.setServiceModelByID(serviceID, models[0]);
      selectedModel = services.getServiceModelByID(serviceID) || models[0];
    }
    this._setModelMenu(serviceID, models, selectedModel);
  }

  /**
   * Force re-fetch of the model list for the currently selected service.
   * Called when models are fetched from the preferences window.
   */
  public refreshModelMenu() {
    const serviceID = String(getPref("translateSource") || "");
    if (serviceID) {
      void this._refreshModelMenu(serviceID);
    }
  }

  /**
   * Rebuild the service menu and re-apply filters. Called when the custom
   * GPT service count preference changes.
   */
  public refreshServicesMenu() {
    this._rebuildServicesMenu();
    this._refreshServiceLabels();
    this._filterUnconfiguredServices();
  }

  /**
   * Refresh provider-model labels after preferences change without rebuilding
   * the panel element.
   */
  _refreshServiceLabels() {
    const menuPopup = this._queryID("services")?.querySelector("menupopup");
    if (!menuPopup) return;
    menuPopup.querySelectorAll("menuitem").forEach((item) => {
      const serviceID = item.getAttribute("value");
      if (!serviceID) return;
      const label = services.getServiceNameByID(serviceID, false);
      item.setAttribute("label", label);
      (item as any).label = label;
      item.setAttribute("tooltiptext", label);
    });
  }

  /**
   * Rebuild the service dropdown menu items. Called when the custom GPT
   * service count changes so newly enabled/disabled services appear or
   * disappear without recreating the entire panel.
   */
  _rebuildServicesMenu() {
    const menulist = this._queryID("services") as XUL.MenuList | null;
    if (!menulist) return;
    const currentValue = menulist.value;
    const newItems = services
      .getAllServicesWithType("sentence")
      .map((service) => {
        const label = services.getServiceNameByID(service.id, false);
        return `<menuitem label="${label}" value="${service.id}" />`;
      })
      .join("\n");
    const fragment = MozXULElement.parseXULToFragment(
      `<menupopup>${newItems}</menupopup>`,
    );
    const newPopup = fragment.childNodes[0] as Node;
    menulist.replaceChildren(newPopup);
    if (currentValue && services.getServiceById(currentValue)) {
      menulist.value = currentValue;
    }
  }

  /**
   * Filter unconfigured services from the dropdown menu.
   * Hides services that require API keys but haven't been configured.
   */
  _filterUnconfiguredServices() {
    const menuPopup = this._queryID("services")?.querySelector("menupopup");
    if (!menuPopup) return;

    const menuItems = menuPopup.querySelectorAll("menuitem");
    const hideUnconfigured = getPref("hideUnconfiguredServices") as boolean;
    const unconfiguredIds = hideUnconfigured
      ? services.getUnconfiguredServiceIds()
      : null;

    menuItems.forEach((item) => {
      const serviceId = item.getAttribute("value");
      (item as HTMLElement).hidden = !!unconfiguredIds?.has(serviceId || "");
    });
  }

  render() {
    // Apply the user-configurable minimum height (px) of the translation
    // result area (minResultHeight pref).
    this.style.setProperty("--min-result-height", `${getMinResultHeight()}px`);
    this.style.setProperty(
      "--output-background-color",
      (getPref("outputBackgroundColor") as string) || "#ffffff",
    );
    this.style.setProperty(
      "--source-background-color",
      (getPref("sourceBackgroundColor") as string) || "#ffffff",
    );
    const updateHidden = (type: string, pref: string) => {
      const elem = this._queryID(type) as XUL.Box;
      const hidden = !getPref(pref) as boolean;
      elem.hidden = hidden;
      if (
        elem.nextElementSibling?.classList.contains("separator") ||
        elem.nextElementSibling?.classList.contains("draggable-container")
      ) {
        (elem.nextElementSibling as HTMLDivElement).hidden = hidden;
      }
    };
    const setCheckBox = (type: string, checked: boolean) => {
      const elem = this._queryID(type) as XUL.Checkbox;
      elem.checked = checked;
    };
    const setValue = (type: string, value: string) => {
      const elem = this._queryID(type) as XUL.Textbox;
      elem.value = value;
    };
    const hashText = (value: string) => {
      let hash = 0;
      for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
      }
      return String(hash);
    };
    const getScrollTargets = (elem: any, includeContainers = false) => {
      const targets: any[] = [];
      const seen = new Set<any>();
      const add = (target: any) => {
        if (!target || seen.has(target)) {
          return;
        }
        seen.add(target);
        targets.push(target);
      };
      const editable = elem?.querySelector?.("editable-text");
      const textarea = elem?.querySelector?.("textarea");
      const overlay = elem?.querySelector?.(".math-overlay");
      add(elem);
      add(elem?.inputField);
      add(editable);
      add((editable as any)?.inputField);
      add(textarea);
      add(overlay);
      if (includeContainers) {
        add(this);
        let current = elem?.parentElement || this.parentElement;
        while (current) {
          add(current);
          if (
            current.localName === "item-details" ||
            current.classList?.contains("zotero-view-item")
          ) {
            break;
          }
          current = current.parentElement;
        }
        const sectionBody = this.closest?.(".body") || this.parentElement;
        add(sectionBody);
        add(this.closest?.("item-details"));
        add(this.closest?.(".zotero-view-item"));
      }
      return targets;
    };
    const captureFieldScroll = (type: string, includeContainers = false) => {
      const elem = this._queryID(type) as any;
      return getScrollTargets(elem, includeContainers).map((target: any) => ({
        target,
        top: Number(target.scrollTop) || 0,
        left: Number(target.scrollLeft) || 0,
      }));
    };
    const restoreFieldScroll = (
      positions: { target: any; top: number; left: number }[],
    ) => {
      if (!positions.length) {
        return;
      }
      const restore = () => {
        positions.forEach(({ target, top, left }) => {
          try {
            target.scrollTop = top;
            target.scrollLeft = left;
          } catch {
            // ignore non-scrollable nodes
          }
        });
      };
      restore();
    };
    const setValueAndRefresh = (
      type: string,
      value: string,
      preserveScroll = false,
      includeContainers = false,
    ) => {
      const elem = this._queryID(type) as any;
      if (!elem) {
        return;
      }
      const scrollPositions = preserveScroll
        ? captureFieldScroll(type, includeContainers)
        : [];
      if (typeof elem.setValueAndRefresh === "function") {
        elem.setValueAndRefresh(value);
        restoreFieldScroll(scrollPositions);
        return;
      }
      elem.value = value;
      elem.refreshOverlay?.();
      restoreFieldScroll(scrollPositions);
    };
    const readOutputScroll = (elem: any) => {
      if (!elem) {
        return { top: 0, left: 0 };
      }
      if (typeof elem.getOutputScrollPosition === "function") {
        return elem.getOutputScrollPosition();
      }
      const target =
        elem.querySelector?.(".math-overlay") ||
        elem.querySelector?.("editable-text") ||
        elem;
      return {
        top: Number(target?.scrollTop) || 0,
        left: Number(target?.scrollLeft) || 0,
      };
    };
    const writeOutputScroll = (elem: any, top = 0, left = 0) => {
      if (!elem) {
        return;
      }
      if (typeof elem.setOutputScrollPosition === "function") {
        elem.setOutputScrollPosition(top, left);
        return;
      }
      getScrollTargets(elem).forEach((target: any) => {
        try {
          target.scrollTop = top;
          target.scrollLeft = left;
        } catch {
          // ignore non-scrollable nodes
        }
      });
    };
    const rememberOutputScroll = (elem: any, task: any, force = false) => {
      if (!elem || !task) {
        return;
      }
      const taskBoundToCurrentElement =
        elem.getAttribute?.("data-output-task-id") === task.id;
      if (!force && !taskBoundToCurrentElement) {
        return;
      }
      const pos = readOutputScroll(elem);
      task.outputScrollTop = pos.top;
      task.outputScrollLeft = pos.left;
    };
    const bindOutputScrollTracker = (elem: any, task: any) => {
      if (!elem || !task) {
        return;
      }
      const bindTargets = [
        elem,
        elem?.querySelector?.(".math-overlay"),
        elem?.querySelector?.("editable-text"),
        elem?.querySelector?.("textarea"),
      ].filter(Boolean);
      bindTargets.forEach((target: any) => {
        if (target.getAttribute?.("data-output-scroll-bound") === "true") {
          return;
        }
        target.setAttribute?.("data-output-scroll-bound", "true");
        target.addEventListener?.("scroll", () => {
          const activeTask = this._getActiveTextTask();
          if (!activeTask || activeTask.id !== task.id) {
            return;
          }
          const activeOutputElem = this._queryID(
            this._getOutputFieldID(),
          ) as any;
          rememberOutputScroll(activeOutputElem || elem, activeTask, true);
        });
      });
    };
    const scrollFieldToTop = (type: string) => {
      const elem = this._queryID(type) as any;
      if (!elem) {
        return;
      }
      const scrollTargets = getScrollTargets(elem);
      const reset = () => {
        scrollTargets.forEach((target) => {
          try {
            target.scrollTop = 0;
            target.scrollLeft = 0;
          } catch {
            // ignore non-scrollable nodes
          }
        });
        elem.scrollToTop?.();
      };
      reset();
      const view = elem.ownerDocument?.defaultView;
      const raf = view?.requestAnimationFrame?.bind(view);
      if (raf) {
        raf(reset);
      } else {
        setTimeout(reset, 0);
      }
    };
    const setPalceHolder = (type: string, placeholder: string) => {
      const elem = this._queryID(type) as XUL.Textbox;
      elem.placeholder = placeholder;
    };
    const setTextBoxStyle = (type: string) => {
      const elem = this._queryID(type) as XUL.Textbox;
      elem.style.fontSize = `${getPref("fontSize")}px`;
      elem.style.lineHeight = getPref("lineHeight") as string;
    };
    const setSourceBackgroundColor = () => {
      const color = (getPref("sourceBackgroundColor") as string) || "#ffffff";
      const source = this._queryID("raw-text") as any;
      if (!source) {
        return;
      }
      const editable = source.querySelector?.("editable-text") as any;
      const targets = [
        source,
        source.inputField,
        source.querySelector?.("textarea"),
        editable,
        editable?.inputField,
        editable?.querySelector?.("textarea"),
        source.querySelector?.(".math-overlay"),
      ].filter(Boolean);
      targets.forEach((target: any) => {
        target.style?.setProperty("background-color", color, "important");
      });
    };
    const setReadOnly = (type: string, readonly: boolean) => {
      const elem = this._queryID(type) as HTMLElement | null;
      if (!elem) return;
      const target = (elem as any).querySelector?.("editable-text") ?? elem;
      if (readonly) {
        (target as any).readOnly = true;
        (target as any).setAttribute?.("readonly", "true");
      } else {
        delete (target as any).readOnly;
        (target as any).removeAttribute?.("readonly");
      }
      elem.classList.toggle("output-area", readonly);
    };

    const avoidSelectAllOnFocus = (type: string) => {
      const elem = this._queryID(type) as HTMLElement | null;
      if (!elem || elem.getAttribute("data-no-select-all-bound") === "true") {
        return;
      }
      const target = (elem as any).querySelector?.("editable-text") ?? elem;
      const collapseIfAllSelected = (ev: Event) => {
        const t = ev.currentTarget as any;
        if (
          typeof t.selectionStart === "number" &&
          typeof t.selectionEnd === "number" &&
          t.selectionStart === 0 &&
          t.selectionEnd === ((t.value as string)?.length ?? 0)
        ) {
          const pos = (t.value as string)?.length ?? 0;
          t.selectionStart = pos;
          t.selectionEnd = pos;
        }
      };
      target.addEventListener("focus", collapseIfAllSelected, {
        capture: true,
      });
      target.addEventListener("mouseup", collapseIfAllSelected, {
        capture: true,
      });
      target.addEventListener("keyup", collapseIfAllSelected, {
        capture: true,
      });
      elem.setAttribute("data-no-select-all-bound", "true");
    };

    // --- Streaming fast path ---
    // During LLM streaming (task.status === "processing"), the UI
    // configuration (updateHidden, _refreshServiceLabels,
    // _filterUnconfiguredServices, setTextBoxStyle, setReadOnly,
    // setPalceHolder, setCheckBox, autoDetectLanguage, model menu, etc.)
    // does not change between chunks. Skip all of it and only update the
    // output field value, preserving scroll position.
    const fastPathTask = this._getActiveTextTask();
    setSourceBackgroundColor();
    if (
      fastPathTask &&
      fastPathTask.status === "processing" &&
      this._streamingTaskId === fastPathTask.id
    ) {
      this._taskID = fastPathTask.id;
      const fpOutputId = this._getOutputFieldID();
      const fpOutputElem = this._queryID(fpOutputId) as any;
      const fpOutputValue = fastPathTask.result;
      const fpCurrentVal = fpOutputElem?.value ?? "";
      // Keep task tracking attributes in sync so the full-path transition
      // when status becomes "success" sees consistent state (no flicker).
      fpOutputElem?.setOutputTask?.(fastPathTask.id);
      fpOutputElem?.setAttribute?.("data-output-task-id", fastPathTask.id);
      fpOutputElem?.setAttribute?.("data-render-processing-only", "true");
      // Use a length-based render key during streaming (same as full path)
      const fpRenderKey = `${fastPathTask.id}:${fpOutputValue.length}`;
      // Only update if the output text actually changed
      if (fpCurrentVal !== fpOutputValue) {
        // Preserve scroll without forced reflow: use element's own
        // scroll-preservation mechanism instead of captureFieldScroll.
        if (typeof fpOutputElem?.setValueAndRefresh === "function") {
          fpOutputElem.setValueAndRefresh(fpOutputValue);
        } else {
          fpOutputElem.value = fpOutputValue;
          fpOutputElem?.refreshOverlay?.();
        }
      }
      fpOutputElem?.setAttribute?.("data-output-render-key", fpRenderKey);
      fastPathTask.outputHasRendered = true;
      return;
    }
    // Track streaming state: first render of a processing task falls
    // through to the full path (which sets up UI); subsequent renders
    // of the same task use the fast path above.
    if (fastPathTask && fastPathTask.status === "processing") {
      this._streamingTaskId = fastPathTask.id;
    } else {
      this._streamingTaskId = "";
    }
    // --- End streaming fast path ---

    updateHidden("engine", "showSidebarEngine");
    updateHidden("language", "showSidebarLanguage");
    updateHidden("raw-text", "showSidebarRaw");
    updateHidden("auto-container", "showSidebarSettings");
    updateHidden("concat-container", "showSidebarConcat");
    updateHidden("copy-container", "showSidebarCopy");

    // Filter unconfigured services from dropdown if preference is enabled
    this._refreshServiceLabels();
    this._filterUnconfiguredServices();

    const selectedService = String(getPref("translateSource") || "");
    setValue("services", selectedService);
    if (this._modelServiceID !== selectedService) {
      void this._refreshModelMenu(selectedService);
    } else {
      const hasModelSetting =
        selectedService === "gemini" ||
        !!services.getServiceModelPrefKey(selectedService);
      const currentModel = services.getServiceModelByID(selectedService);
      const modelMenu = this._queryID("models") as any;
      const hasCurrentModel = [
        ...(modelMenu?.querySelectorAll("menuitem") || []),
      ].some((item: any) => item.getAttribute("value") === currentModel);
      if (currentModel && !hasCurrentModel) {
        this._setModelMenu(selectedService, [currentModel], currentModel);
      } else if (currentModel && modelMenu) {
        modelMenu.hidden = !hasModelSetting;
        modelMenu.disabled = !hasModelSetting;
        modelMenu.value = currentModel;
      } else if (modelMenu && !hasModelSetting) {
        modelMenu.hidden = true;
        modelMenu.disabled = true;
      }
    }

    const { fromLanguage, toLanguage } = autoDetectLanguage(this.item);
    setValue("langfrom", fromLanguage);
    setValue("langto", toLanguage);

    setCheckBox("auto-trans-selection", getPref("enableAuto") as boolean);
    setCheckBox("auto-trans-annotation", getPref("enableComment") as boolean);
    const isConcatMode =
      this._addon.data.translate.concatCheckbox ||
      ((getPref("enableConcatKey") as boolean) &&
        this._addon.data.translate.concatKey);
    setCheckBox("concat", isConcatMode);

    setTextBoxStyle("raw-text");
    setTextBoxStyle("result-text");
    const reverseRawResult = getPref("rawResultOrder");
    // Ensure whichever box is used as output is read-only and visually marked
    setReadOnly("raw-text", !!reverseRawResult);
    setReadOnly("result-text", !reverseRawResult);
    avoidSelectAllOnFocus(reverseRawResult ? "raw-text" : "result-text");
    setPalceHolder(
      "raw-text",
      reverseRawResult ? "" : "Select or type to translate",
    );
    setPalceHolder(
      "result-text",
      reverseRawResult ? "Select or type to translate" : "",
    );
    const outputId = this._getOutputFieldID();
    const inputId = this._getInputFieldID();
    const rawMathElem = this._queryID("raw-text") as any;
    rawMathElem?.setAttribute?.("data-render-processing-only", "false");
    const resultMathElem = this._queryID("result-text") as any;
    resultMathElem?.setAttribute?.("data-render-processing-only", "false");

    const lastTask = this._getActiveTextTask();
    if (!lastTask) {
      this.toggleAttribute("data-output-expanded", false);
      rawMathElem?.refreshOverlay?.();
      resultMathElem?.refreshOverlay?.();
      return;
    }
    // For manually update translation task
    this._taskID = lastTask.id;

    const outputValue = lastTask.result;
    const inputValue = lastTask.raw;
    const outputElem = this._queryID(outputId) as any;
    const inputElem = this._queryID(inputId) as HTMLElement | null;
    rememberOutputScroll(outputElem, lastTask);
    bindOutputScrollTracker(outputElem, lastTask);
    outputElem?.setAttribute?.(
      "data-render-processing-only",
      String(lastTask.status === "processing"),
    );
    const currentOutputVal = outputElem?.value ?? "";
    const currentInputVal = this._getFieldValue(inputId);
    const outputRenderKey =
      lastTask.status === "processing"
        ? `${lastTask.id}:${outputValue.length}`
        : `${lastTask.id}:${outputValue.length}:${hashText(outputValue)}`;
    const lastOutputRenderKey =
      outputElem?.getAttribute?.("data-output-render-key") || "";
    const lastOutputTaskId =
      outputElem?.getAttribute?.("data-output-task-id") || "";
    const outputTaskChanged = lastOutputTaskId !== lastTask.id;
    outputElem?.setOutputTask?.(lastTask.id);
    const preserveOutputScrollForTask =
      lastTask.outputHasRendered || lastOutputTaskId === lastTask.id;
    const outputElementAlreadyShowingTask = lastOutputTaskId === lastTask.id;
    const shouldRestoreSavedOutputScroll =
      preserveOutputScrollForTask && !outputElementAlreadyShowingTask;
    // Avoid forced reflow from captureFieldScroll during the transition
    // from streaming to completion. The math-overlay preserves scroll
    // internally via _overlayScrollTop/_overlayScrollLeft. Only capture
    // scroll when we actually need to restore it (task changed).
    const renderScrollPositions =
      preserveOutputScrollForTask && outputTaskChanged
        ? captureFieldScroll(outputId, false)
        : [];
    const expandOutput =
      !!outputValue &&
      !this._hasPendingUserEdit &&
      !this._isFieldFocused(inputId);
    this.toggleAttribute("data-output-expanded", expandOutput);
    inputElem?.classList.toggle("source-collapsed", expandOutput);
    outputElem?.classList?.toggle?.("output-expanded", expandOutput);

    const inputFocused = this._isFieldFocused(inputId);
    if (!inputFocused && currentInputVal !== inputValue) {
      setValueAndRefresh(inputId, inputValue, true, true);
    } else if (!inputFocused) {
      (this._queryID(inputId) as any)?.refreshOverlay?.();
    }
    const shouldUpdateOutput =
      outputTaskChanged ||
      !(lastTask.status === "processing" && !outputValue && currentOutputVal);
    // During the transition from streaming to completion, the render key
    // changes from "id:length" to "id:length:hash". This is expected and
    // should NOT trigger a full re-render — flushOutputRender handles the
    // final render. Only force refresh if the task changed or the text
    // content actually differs.
    const isStreamingToCompletion =
      !outputTaskChanged &&
      lastTask.status === "success" &&
      lastTask.outputHasRendered &&
      currentOutputVal === outputValue;
    const shouldRefreshOutput =
      shouldUpdateOutput &&
      !isStreamingToCompletion &&
      (currentOutputVal !== outputValue ||
        lastOutputRenderKey !== outputRenderKey);
    if (shouldRefreshOutput) {
      const shouldResetOutputScroll = !preserveOutputScrollForTask;
      setValueAndRefresh(outputId, outputValue, true, false);
      outputElem?.setAttribute?.("data-output-render-key", outputRenderKey);
      outputElem?.setAttribute?.("data-output-task-id", lastTask.id);
      if (shouldResetOutputScroll) {
        writeOutputScroll(outputElem, 0, 0);
        lastTask.outputScrollTop = 0;
        lastTask.outputScrollLeft = 0;
      }
      lastTask.outputHasRendered = true;
    }
    if (lastTask.status === "success" && outputValue) {
      outputElem?.flushOutputRender?.(outputValue);
      // Update render key after flush so subsequent renders see consistent state
      outputElem?.setAttribute?.("data-output-render-key", outputRenderKey);
      outputElem?.setAttribute?.("data-output-task-id", lastTask.id);
      lastTask.outputHasRendered = true;
    }
    restoreFieldScroll(renderScrollPositions);
    if (shouldRestoreSavedOutputScroll) {
      writeOutputScroll(
        outputElem,
        lastTask.outputScrollTop || 0,
        lastTask.outputScrollLeft || 0,
      );
    }
  }
}
