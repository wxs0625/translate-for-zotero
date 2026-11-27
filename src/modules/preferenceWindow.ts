import { config, homepage } from "../../package.json";
import { LANG_CODE } from "../utils/config";
import { getString } from "../utils/locale";
import { getPref, setPref, getCustomGPTCount } from "../utils/prefs";
import {
  getServiceSecret,
  setServiceSecret,
  validateServiceSecret,
} from "../utils/secret";
import { createServiceSettingsDialog } from "../utils";
import { services } from "./services";
import { refreshPanelModelMenus, refreshPanelServicesMenus } from "./tabpanel";

export function registerPrefsWindow() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: getString("pref-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    helpURL: homepage,
  });
}

export function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  addon.data.prefs.window = _window;
  buildPrefsPane();
  updatePrefsPaneDefault();
}

let customGPTCountDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function buildPrefsPane() {
  const doc = addon.data.prefs.window?.document;
  if (!doc) {
    return;
  }

  // menus
  buildSentenceServicesMenulist();

  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      id: makeId("sentenceServiceModel"),
      attributes: {
        native: "true",
        disabled: "true",
      },
      listeners: [
        {
          type: "command",
          listener: () => {
            onPrefsEvents("setSentenceModel");
          },
        },
      ],
      children: [
        {
          tag: "menupopup",
          children: [
            {
              tag: "menuitem",
              attributes: {
                label: "-",
                value: "",
                disabled: "true",
              },
            },
          ],
        },
      ],
    },
    doc.querySelector(`#${makeId("sentenceServiceModel-placeholder")}`)!,
  );

  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      id: makeId("wordServices"),
      attributes: {
        value: getPref("dictSource") as string,
        native: "true",
      },
      classList: ["use-word-service"],
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            onPrefsEvents("setWordService");
          },
        },
      ],
      children: [
        {
          tag: "menupopup",
          children: services.getAllServicesWithType("word").map((s) => ({
            tag: "menuitem",
            attributes: {
              label: services.getServiceNameByID(s.id),
              value: s.id,
            },
          })),
        },
      ],
    },
    doc.querySelector(`#${makeId("wordServices-placeholder")}`)!,
  );

  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      id: makeId("langfrom"),
      attributes: {
        value: getPref("sourceLanguage") as string,
        native: "true",
      },
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            onPrefsEvents("setSourceLanguage");
          },
        },
      ],
      styles: {
        maxWidth: "250px",
      },
      children: [
        {
          tag: "menupopup",
          children: LANG_CODE.map((lang) => ({
            tag: "menuitem",
            attributes: {
              label: lang.name,
              value: lang.code,
            },
          })),
        },
      ],
    },
    doc.querySelector(`#${makeId("langfrom-placeholder")}`)!,
  );

  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      id: makeId("langto"),
      attributes: {
        value: getPref("targetLanguage") as string,
        native: "true",
      },
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            onPrefsEvents("setTargetLanguage");
          },
        },
      ],
      styles: {
        maxWidth: "250px",
      },
      children: [
        {
          tag: "menupopup",
          children: LANG_CODE.map((lang) => ({
            tag: "menuitem",
            attributes: {
              label: lang.name,
              value: lang.code,
            },
          })),
        },
      ],
    },
    doc.querySelector(`#${makeId("langto-placeholder")}`)!,
  );

  doc
    .querySelector(`#${makeId("manageKeys")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("manageKeys");
    });
  doc
    .querySelector(`#${makeId("renameServices")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("renameServices");
    });

  doc
    .querySelector(`#${makeId("fetchModels")}`)
    ?.addEventListener("command", () => {
      onPrefsEvents("fetchModels");
    });

  doc
    .querySelector(`#${makeId("enableAuto")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setAutoTranslateSelection");
    });

  doc
    .querySelector(`#${makeId("enableComment")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setAutoTranslateAnnotation");
    });

  doc
    .querySelector(`#${makeId("annotationTranslationPosition")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setAnnotationTranslationPosition");
    });

  doc
    .querySelector(`#${makeId("enablePopup")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setEnablePopup");
    });

  doc
    .querySelector(`#${makeId("enableAddToNote")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setEnableAddToNote");
    });

  doc
    .querySelector(`#${makeId("showPlayBtn")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setShowPlayBtn");
    });

  doc
    .querySelector(`#${makeId("useWordService")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setUseWordService");
    });

  doc
    .querySelector(`#${makeId("hideUnconfiguredServices")}`)
    ?.addEventListener("command", () => {
      addon.hooks.onReaderTabPanelRefresh();
    });

  doc
    .querySelector(`#${makeId("sentenceServicesSecret")}`)
    ?.addEventListener("blur", (e: Event) => {
      onPrefsEvents("updateSentenceSecret");
    });

  doc
    .querySelector(`#${makeId("wordServicesSecret")}`)
    ?.addEventListener("blur", (e: Event) => {
      onPrefsEvents("updateWordSecret");
    });

  doc
    .querySelector(`#${makeId("fontSize")}`)
    ?.addEventListener("input", (e: Event) => {
      onPrefsEvents("updateFontSize");
    });

  doc
    .querySelector(`#${makeId("lineHeight")}`)
    ?.addEventListener("input", (e: Event) => {
      onPrefsEvents("updatelineHeight");
    });

  doc
    .querySelector(`#${makeId("minResultHeight")}`)
    ?.addEventListener("input", (e: Event) => {
      onPrefsEvents("updateMinResultHeight");
    });

  doc
    .querySelector(`#${makeId("outputBackgroundColor")}`)
    ?.addEventListener("input", (e: Event) => {
      setPref("outputBackgroundColor", (e.target as HTMLInputElement).value);
      onPrefsEvents("updateOutputBackgroundColor");
    });
  doc
    .querySelector(`#${makeId("outputBackgroundColor")}`)
    ?.addEventListener("change", (e: Event) => {
      setPref("outputBackgroundColor", (e.target as HTMLInputElement).value);
      onPrefsEvents("updateOutputBackgroundColor");
    });

  doc
    .querySelector(`#${makeId("sourceBackgroundColor")}`)
    ?.addEventListener("input", (e: Event) => {
      setPref("sourceBackgroundColor", (e.target as HTMLInputElement).value);
      onPrefsEvents("updateSourceBackgroundColor");
    });
  doc
    .querySelector(`#${makeId("sourceBackgroundColor")}`)
    ?.addEventListener("change", (e: Event) => {
      setPref("sourceBackgroundColor", (e.target as HTMLInputElement).value);
      onPrefsEvents("updateSourceBackgroundColor");
    });

  doc
    .querySelector(`#${makeId("customGPTCount")}`)
    ?.addEventListener("input", (e: Event) => {
      onPrefsEvents("updateCustomGPTCount");
    });

  doc
    .querySelector(`#${makeId("reset-titleTranslation")}`)
    ?.addEventListener("command", (e: Event) => {
      ztoolkit
        .getGlobal("ZoteroPane")
        .getSelectedItems()
        .forEach((item) => {
          ztoolkit.ExtraField.setExtraField(item, "titleTranslation", "");
        });
    });

  doc
    .querySelector(`#${makeId("reset-abstractTranslation")}`)
    ?.addEventListener("command", (e: Event) => {
      ztoolkit
        .getGlobal("ZoteroPane")
        .getSelectedItems()
        .forEach((item) => {
          ztoolkit.ExtraField.setExtraField(item, "abstractTranslation", "");
        });
    });

  doc
    .querySelector(`#${makeId("enableAutoTagAnnotation")}`)
    ?.addEventListener("command", (e: Event) => {
      onPrefsEvents("setEnableAutoTagAnnotation");
    });
}

function updatePrefsPaneDefault() {
  onPrefsEvents("setAutoTranslateAnnotation", false);
  onPrefsEvents("setAnnotationTranslationPosition", false);
  onPrefsEvents("setEnablePopup", false);
  onPrefsEvents("setShowPlayBtn", false);
  onPrefsEvents("setUseWordService", false);
  onPrefsEvents("setSentenceSecret", false);
  onPrefsEvents("setWordSecret", false);
  onPrefsEvents("setEnableAutoTagAnnotation", false);
}

function buildSentenceServicesMenulist() {
  const doc = addon.data.prefs.window?.document;
  if (!doc) {
    return;
  }
  const oldElement =
    doc.querySelector(`#${makeId("sentenceServices")}`) ||
    doc.querySelector(`#${makeId("sentenceServices-placeholder")}`);
  if (!oldElement) {
    return;
  }
  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      id: makeId("sentenceServices"),
      attributes: {
        value: getPref("translateSource") as string,
        native: "true",
      },
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            onPrefsEvents("setSentenceService");
          },
        },
      ],
      children: [
        {
          tag: "menupopup",
          children: services.getAllServicesWithType("sentence").map((s) => ({
            tag: "menuitem",
            attributes: {
              label: services.getServiceNameByID(s.id),
              value: s.id,
            },
          })),
        },
      ],
    },
    oldElement,
  );
}

function onPrefsEvents(type: string, fromElement: boolean = true) {
  const doc = addon.data.prefs.window?.document;
  if (!doc) {
    return;
  }

  const setDisabled = (className: string, disabled: boolean) => {
    doc
      .querySelectorAll(`.${className}`)
      .forEach(
        (elem) => ((elem as XUL.Element & XUL.IDisabled).disabled = disabled),
      );
  };
  switch (type) {
    case "setAutoTranslateSelection":
      addon.hooks.onReaderTabPanelRefresh();
      break;
    case "setAutoTranslateAnnotation":
      {
        addon.hooks.onReaderTabPanelRefresh();
      }
      break;
    case "setAnnotationTranslationPosition":
      {
        const elemValue = fromElement
          ? (
              doc.querySelector(
                `#${makeId("annotationTranslationPosition")}`,
              ) as XUL.Element
            ).getAttribute("value")
          : (getPref("annotationTranslationPosition") as string);
        const hidden = elemValue !== "body";
        setDisabled("annotation-translation-position-in-body", hidden);
      }
      break;
    case "setEnablePopup":
      {
        const elemValue = fromElement
          ? (doc.querySelector(`#${makeId("enablePopup")}`) as XUL.Checkbox)
              .checked
          : (getPref("enablePopup") as boolean);
        const hidden = !elemValue;
        setDisabled("enable-popup", hidden);
        if (!hidden) {
          onPrefsEvents("setEnableAddToNote", fromElement);
        }
      }
      break;
    case "setEnableAddToNote":
      {
        const elemValue = fromElement
          ? (doc.querySelector(`#${makeId("enableAddToNote")}`) as XUL.Checkbox)
              .checked
          : (getPref("enableNote") as boolean);
        const hidden = !elemValue;
        setDisabled("enable-popup-addtonote", hidden);
      }
      break;
    case "setShowPlayBtn":
      {
        const elemValue = fromElement
          ? (doc.querySelector(`#${makeId("showPlayBtn")}`) as XUL.Checkbox)
              .checked
          : (getPref("showPlayBtn") as boolean);
        const hidden = !elemValue;
        setDisabled("show-play-btn", hidden);
      }
      break;
    case "setUseWordService":
      {
        const elemValue = fromElement
          ? (doc.querySelector(`#${makeId("useWordService")}`) as XUL.Checkbox)
              .checked
          : (getPref("enableDict") as boolean);
        const hidden = !elemValue;
        setDisabled("use-word-service", hidden);
        if (!hidden) {
          onPrefsEvents("setShowPlayBtn", fromElement);
        }
      }
      break;
    case "setEnableAutoTagAnnotation":
      {
        const elemValue = fromElement
          ? (
              doc.querySelector(
                `#${makeId("enableAutoTagAnnotation")}`,
              ) as XUL.Checkbox
            ).checked
          : (getPref("enableAutoTagAnnotation") as boolean);
        const hidden = !elemValue;
        setDisabled("enable-auto-tag-annotation", hidden);
      }
      break;
    case "setSentenceService":
      {
        setPref(
          "translateSource",
          (
            doc.querySelector(`#${makeId("sentenceServices")}`) as XUL.MenuList
          ).getAttribute("value")!,
        );
        updateModelMenulist();
        onPrefsEvents("setSentenceSecret", fromElement);
        addon.hooks.onReaderTabPanelRefresh();
      }
      break;
    case "updateSentenceSecret":
      {
        const serviceId = getPref("translateSource") as string;
        const inputElem = doc.querySelector(
          `#${makeId("sentenceServicesSecret")}`,
        ) as HTMLInputElement;
        const trimmedValue = inputElem.value.trim();
        if (trimmedValue !== inputElem.value) {
          inputElem.value = trimmedValue;
        }
        if (trimmedValue !== getServiceSecret(serviceId)) {
          setServiceSecret(serviceId, trimmedValue);
        }
      }
      break;
    case "setSentenceSecret":
      {
        const serviceId = getPref("translateSource") as string;
        const secretCheckResult = validateServiceSecret(
          serviceId,
          (validateResult) => {
            if (fromElement && !validateResult.status) {
              addon.data.prefs.window?.alert(
                `You see this because the translation service ${serviceId} requires SECRET, which is NOT correctly set.\n\nDetails:\n${validateResult.info}`,
              );
            }
          },
        );
        (
          doc.querySelector(
            `#${makeId("sentenceServicesSecret")}`,
          ) as HTMLInputElement
        ).value = secretCheckResult.secret;

        // Update secret status button
        const statusButton = doc.querySelector(
          `#${makeId("sentenceServicesStatus")}`,
        ) as XUL.Button;
        const service =
          addon.data.translate.services.getServiceById(serviceId)!;
        if (service.config) {
          statusButton.hidden = false;
          statusButton.label = getString("service-dialog-config");
          statusButton.onclick = (ev) => {
            createServiceSettingsDialog(service);
          };
        } else {
          statusButton.hidden = true;
        }
        updateModelMenulist();
      }
      break;
    case "setWordService":
      {
        setPref(
          "dictSource",
          (
            doc.querySelector(`#${makeId("wordServices")}`) as XUL.MenuList
          ).getAttribute("value")!,
        );
        onPrefsEvents("setWordSecret", fromElement);
      }
      break;
    case "updateWordSecret":
      {
        const serviceId = getPref("dictSource") as string;
        const inputElem = doc.querySelector(
          `#${makeId("wordServicesSecret")}`,
        ) as HTMLInputElement;
        const trimmedValue = inputElem.value.trim();
        if (trimmedValue !== inputElem.value) {
          inputElem.value = trimmedValue;
        }
        if (trimmedValue !== getServiceSecret(serviceId)) {
          setServiceSecret(serviceId, trimmedValue);
        }
      }
      break;
    case "setWordSecret":
      {
        const serviceId = getPref("dictSource") as string;
        const secretCheckResult = validateServiceSecret(
          serviceId,
          (validateResult) => {
            if (fromElement && !validateResult.status) {
              addon.data.prefs.window?.alert(
                `You see this because the translation service ${serviceId} requires SECRET, which is NOT correctly set.\n\nDetails:\n${validateResult.info}`,
              );
            }
          },
        );
        (
          doc.querySelector(
            `#${makeId("wordServicesSecret")}`,
          ) as HTMLInputElement
        ).value = secretCheckResult.secret;
      }
      break;
    case "setSourceLanguage":
      {
        setPref(
          "sourceLanguage",
          (
            doc.querySelector(`#${makeId("langfrom")}`) as XUL.MenuList
          ).getAttribute("value")!,
        );
        addon.hooks.onReaderTabPanelRefresh();
      }
      break;
    case "setTargetLanguage":
      {
        setPref(
          "targetLanguage",
          (
            doc.querySelector(`#${makeId("langto")}`) as XUL.MenuList
          ).getAttribute("value")!,
        );
        addon.hooks.onReaderTabPanelRefresh();
      }
      break;
    case "updateFontSize":
      addon.api.getTemporaryRefreshHandler()();
      break;
    case "updatelineHeight":
      addon.api.getTemporaryRefreshHandler()();
      break;
    case "updateMinResultHeight":
      addon.api.getTemporaryRefreshHandler()();
      break;
    case "updateOutputBackgroundColor":
      addon.api.getTemporaryRefreshHandler()();
      break;
    case "updateSourceBackgroundColor":
      addon.api.getTemporaryRefreshHandler()();
      break;
    case "updateCustomGPTCount":
      {
        if (customGPTCountDebounceTimer) {
          clearTimeout(customGPTCountDebounceTimer);
        }
        customGPTCountDebounceTimer = setTimeout(() => {
          customGPTCountDebounceTimer = undefined;
          onPrefsEvents("applyCustomGPTCount", false);
        }, 300);
      }
      break;
    case "applyCustomGPTCount":
      {
        const inputElem = doc.querySelector(
          `#${makeId("customGPTCount")}`,
        ) as HTMLInputElement | null;
        const clampedCount = getCustomGPTCount();
        if (inputElem) {
          inputElem.value = String(clampedCount);
        }
        setPref("customGPTCount", String(clampedCount));
        buildSentenceServicesMenulist();
        refreshPanelServicesMenus();
        addon.hooks.onReaderTabPanelRefresh();
      }
      break;
    case "manageKeys":
      {
        import("../modules/settings/manageKeys").then(
          ({ manageKeysDialog }) => {
            manageKeysDialog();
          },
        );
      }
      break;
    case "renameServices":
      {
        import("../modules/settings/renameServices").then(
          ({ renameServicesDialog }) => {
            renameServicesDialog();
          },
        );
      }
      break;
    case "setSentenceModel":
      {
        const serviceID = getPref("translateSource") as string;
        const model = String(
          (
            doc.querySelector(
              `#${makeId("sentenceServiceModel")}`,
            ) as XUL.MenuList
          )?.value || "",
        ).trim();
        if (model && services.setServiceModelByID(serviceID, model)) {
          updateSentenceServiceLabels();
          addon.hooks.onReaderTabPanelRefresh();
        }
      }
      break;
    case "fetchModels":
      {
        void (async () => {
          const serviceID = getPref("translateSource") as string;
          if (!supportsModelListing(serviceID)) {
            showFetchModelsNotify(getString("service-fetchModels-unsupported"));
            return;
          }
          const button = doc.querySelector(
            `#${makeId("fetchModels")}`,
          ) as XUL.Button | null;
          const originalLabel = button?.label || "";
          if (button) {
            button.disabled = true;
            button.label = getString("service-fetchModels-fetching");
          }
          const result = await services.fetchServiceModelsDetailed(serviceID);
          if (addon.data.prefs.window?.document !== doc) {
            return;
          }
          if (button) {
            button.label = originalLabel;
          }
          updateModelMenulist(result.fetched ? result.models : undefined);
          if (result.fetched) {
            refreshPanelModelMenus();
            showFetchModelsNotify(
              getString("service-fetchModels-done", {
                args: { count: result.models.length },
              }),
            );
          } else {
            showFetchModelsNotify(getString("service-fetchModels-failed"));
          }
        })();
      }
      break;
    default:
      return;
  }
}

function supportsModelListing(serviceID: string): boolean {
  return serviceID === "gemini" || !!services.getServiceModelPrefKey(serviceID);
}

function updateModelMenulist(models?: string[], selectedModel?: string) {
  const doc = addon.data.prefs.window?.document;
  if (!doc) {
    return;
  }
  const serviceID = getPref("translateSource") as string;
  const menuList = doc.querySelector(
    `#${makeId("sentenceServiceModel")}`,
  ) as XUL.MenuList | null;
  const fetchButton = doc.querySelector(
    `#${makeId("fetchModels")}`,
  ) as XUL.Button | null;
  if (!menuList) {
    return;
  }
  const menuPopup = menuList.querySelector("menupopup");
  if (!menuPopup) {
    return;
  }
  const supported = supportsModelListing(serviceID);
  const values = [
    ...new Set(
      (models || []).map((model) => String(model || "").trim()).filter(Boolean),
    ),
  ];
  const currentModel = selectedModel || services.getServiceModelByID(serviceID);
  if (currentModel && !values.includes(currentModel)) {
    values.unshift(currentModel);
  }
  const createMenuItem = () =>
    (menuPopup.ownerDocument as any).createXULElement?.("menuitem") ||
    menuPopup.ownerDocument.createElement("menuitem");
  while (menuPopup.firstChild) {
    menuPopup.removeChild(menuPopup.firstChild);
  }
  if (!supported || !values.length) {
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
  const modelRow = menuList.closest("hbox") as HTMLElement | null;
  if (modelRow) {
    modelRow.hidden = !supported;
  }
  menuList.disabled = !supported || !values.length;
  if (fetchButton) {
    fetchButton.disabled = !supported;
  }
  menuList.value = currentModel || values[0] || "";
}

function updateSentenceServiceLabels() {
  const doc = addon.data.prefs.window?.document;
  if (!doc) {
    return;
  }
  const menuPopup = doc
    .querySelector(`#${makeId("sentenceServices")}`)
    ?.querySelector("menupopup");
  if (!menuPopup) {
    return;
  }
  menuPopup.querySelectorAll("menuitem").forEach((item) => {
    const serviceID = item.getAttribute("value");
    if (!serviceID) {
      return;
    }
    const label = services.getServiceNameByID(serviceID);
    item.setAttribute("label", label);
    (item as any).label = label;
    item.setAttribute("tooltiptext", label);
  });
}

function showFetchModelsNotify(text: string) {
  new ztoolkit.ProgressWindow(getString("service-fetchModels-title"))
    .createLine({
      text,
      progress: 100,
      type: "default",
    })
    .show();
}

function makeId(type: string) {
  return `${config.addonRef}-${type}`;
}
