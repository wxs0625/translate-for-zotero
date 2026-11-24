import { getLocaleID } from "../utils/locale";
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getLastTranslateTask } from "../utils/task";
import { TranslatorPanel } from "../elements/panel";
import { isWindowAlive } from "../utils/window";
import { services } from "./services";

let paneKey = "";
let pinnedBody: HTMLElement | null = null;
let lockedItemDetails: HTMLElement | null = null;
const hookedItemDetails = new WeakSet<HTMLElement>();
let suppressPaneHookDepth = 0;
const scheduledPinTimers = new WeakMap<HTMLElement, number[]>();
const scheduledMaximizeTimers = new WeakMap<HTMLElement, number[]>();
const detailsScrollbarStyleState = new WeakMap<
  HTMLElement,
  {
    detailsOverflowY: string;
    detailsScrollbarWidth: string;
    viewOverflowY: string | null;
    viewScrollbarWidth: string | null;
  }
>();

const verticalScrollKeys = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function isEditableTarget(target: EventTarget | null) {
  const elem = target as HTMLElement | null;
  if (!elem) {
    return false;
  }
  if ((elem as HTMLInputElement).isContentEditable) {
    return true;
  }
  const tagName = elem.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea";
}

function isElementLike(value: unknown): value is HTMLElement {
  return !!value && typeof value === "object" && "nodeType" in value && (value as Node).nodeType === Node.ELEMENT_NODE;
}

function getParentElement(elem: Element | null): Element | null {
  if (!elem) {
    return null;
  }
  if (elem.parentElement) {
    return elem.parentElement;
  }
  const root = elem.getRootNode();
  if (root && isElementLike((root as ShadowRoot).host)) {
    return (root as ShadowRoot).host;
  }
  return null;
}

function canElementConsumeWheel(elem: HTMLElement, deltaY: number) {
  if (Math.abs(deltaY) <= 0) {
    return false;
  }
  const scrollHeight = elem.scrollHeight;
  const clientHeight = elem.clientHeight;
  if (scrollHeight <= clientHeight + 1) {
    return false;
  }
  if (deltaY > 0) {
    return elem.scrollTop + clientHeight < scrollHeight - 1;
  }
  return elem.scrollTop > 0;
}

function canPanelConsumeWheel(target: HTMLElement | null, deltaY: number) {
  const panel = target?.closest("translator-plugin-panel") as HTMLElement | null;
  if (!panel) {
    return false;
  }
  let current: Element | null = target;
  while (current) {
    if (isElementLike(current) && canElementConsumeWheel(current, deltaY)) {
      return true;
    }
    if (current === panel) {
      break;
    }
    current = getParentElement(current);
  }
  return false;
}

function onPreventVerticalWheel(ev: Event) {
  const wheelEvent = ev as WheelEvent;
  if (Math.abs(wheelEvent.deltaY) <= 0) {
    return;
  }
  if (canPanelConsumeWheel(wheelEvent.target as HTMLElement | null, wheelEvent.deltaY)) {
    return;
  }
  wheelEvent.preventDefault();
  wheelEvent.stopPropagation();
}

function onPreventVerticalKeydown(ev: Event) {
  const keyEvent = ev as KeyboardEvent;
  if (!verticalScrollKeys.has(keyEvent.key) || isEditableTarget(keyEvent.target)) {
    return;
  }
  keyEvent.preventDefault();
  keyEvent.stopPropagation();
}

function onPreventTouchMove(ev: Event) {
  ev.preventDefault();
  ev.stopPropagation();
}

function toggleDetailsScrollbarVisibility(details: HTMLElement, hidden: boolean) {
  const viewItem = details.querySelector(".zotero-view-item") as HTMLElement | null;
  if (hidden) {
    if (!detailsScrollbarStyleState.has(details)) {
      detailsScrollbarStyleState.set(details, {
        detailsOverflowY: details.style.overflowY,
        detailsScrollbarWidth: details.style.scrollbarWidth,
        viewOverflowY: viewItem ? viewItem.style.overflowY : null,
        viewScrollbarWidth: viewItem ? viewItem.style.scrollbarWidth : null,
      });
    }
    details.style.overflowY = "hidden";
    details.style.scrollbarWidth = "none";
    if (viewItem) {
      viewItem.style.overflowY = "hidden";
      viewItem.style.scrollbarWidth = "none";
    }
    return;
  }

  const previousState = detailsScrollbarStyleState.get(details);
  if (!previousState) {
    return;
  }
  details.style.overflowY = previousState.detailsOverflowY;
  details.style.scrollbarWidth = previousState.detailsScrollbarWidth;
  if (viewItem && previousState.viewOverflowY !== null) {
    viewItem.style.overflowY = previousState.viewOverflowY;
    viewItem.style.scrollbarWidth = previousState.viewScrollbarWidth || "";
  }
  detailsScrollbarStyleState.delete(details);
}

function lockItemDetailsScroll(details: HTMLElement) {
  if (lockedItemDetails === details) {
    return;
  }
  unlockItemDetailsScroll();
  toggleDetailsScrollbarVisibility(details, true);
  details.addEventListener("wheel", onPreventVerticalWheel, {
    passive: false,
    capture: true,
  });
  details.addEventListener("keydown", onPreventVerticalKeydown, true);
  details.addEventListener("touchmove", onPreventTouchMove, {
    passive: false,
    capture: true,
  });
  lockedItemDetails = details;
}

function unlockItemDetailsScroll() {
  if (!lockedItemDetails) {
    return;
  }
  const details = lockedItemDetails;
  details.removeEventListener("wheel", onPreventVerticalWheel, true);
  details.removeEventListener("keydown", onPreventVerticalKeydown, true);
  details.removeEventListener("touchmove", onPreventTouchMove, true);
  toggleDetailsScrollbarVisibility(details, false);
  lockedItemDetails = null;
}

function isAllowedHeaderTarget(target: HTMLElement | null) {
  if (!target) {
    return false;
  }
  if (target.closest(".translate-pin-indicator")) {
    return true;
  }
  const button = target.closest("toolbarbutton, button") as HTMLElement | null;
  if (!button) {
    return false;
  }
  const l10nID = button.getAttribute("data-l10n-id") || "";
  return (
    l10nID === getLocaleID("itemPaneSection-openStandalone") ||
    l10nID === getLocaleID("itemPaneSection-fullHeight")
  );
}

function keepSectionExpanded(body: HTMLElement) {
  const section = body.closest("item-pane-custom-section") as HTMLElement | null;
  const head = section?.querySelector(".head") as HTMLElement | null;
  if (!section || !head) {
    return;
  }
  if (head.dataset.translateNoCollapseBound !== "true") {
    head.dataset.translateNoCollapseBound = "true";
    head.addEventListener(
      "click",
      (ev: MouseEvent) => {
        if (isAllowedHeaderTarget(ev.target as HTMLElement | null)) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
      },
      true,
    );
    head.addEventListener(
      "keydown",
      (ev: KeyboardEvent) => {
        if (!(["Enter", " "] as string[]).includes(ev.key)) {
          return;
        }
        if (isAllowedHeaderTarget(ev.target as HTMLElement | null)) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
      },
      true,
    );
  }

  // Keep this section permanently expanded.
  section.classList.remove("collapsed");
  section.removeAttribute("collapsed");
  section.setAttribute("open", "true");
}

function ensureHeaderPinIndicator(body: HTMLElement) {
  const section = body.closest("item-pane-custom-section") as HTMLElement | null;
  const head = section?.querySelector(".head") as HTMLElement | null;
  if (!head) {
    return null;
  }
  if (head.dataset.translatePinHeadBound !== "true") {
    head.dataset.translatePinHeadBound = "true";
    head.addEventListener("dblclick", (ev: MouseEvent) => {
      if (ev.button !== 0) {
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (target?.closest("toolbarbutton, button, .translate-pin-indicator")) {
        return;
      }
      ev.preventDefault();
      applyPinnedState(body, pinnedBody !== body);
    });
  }
  let indicator = head.querySelector(".translate-pin-indicator") as HTMLElement | null;
  if (!indicator) {
    indicator = head.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as unknown as HTMLElement;
    indicator.className = "translate-pin-indicator";
    indicator.style.width = "16px";
    indicator.style.height = "16px";
    indicator.style.minWidth = "16px";
    indicator.style.marginInlineEnd = "6px";
    indicator.style.background =
      `center / contain no-repeat url(chrome://${config.addonRef}/content/icons/lock-12.svg)`;
    indicator.style.cursor = "pointer";

    const firstAction = head.querySelector(
      "toolbarbutton, button, image",
    ) as ChildNode | null;
    if (firstAction?.parentNode === head) {
      head.insertBefore(indicator, firstAction);
    } else {
      head.append(indicator);
    }

    indicator.addEventListener("click", (ev: MouseEvent) => {
      if (ev.button !== 0) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      applyPinnedState(body, pinnedBody !== body);
    });
  }
  return indicator;
}

function applyPinnedState(body: HTMLElement, pinned: boolean) {
  keepSectionExpanded(body);
  const section = body.closest("item-pane-custom-section") as HTMLElement | null;
  const details = body.closest("item-details") as HTMLElement | null;
  const pinIndicator = ensureHeaderPinIndicator(body);
  if (pinIndicator) {
    pinIndicator.style.opacity = pinned ? "0.95" : "0.35";
  }
  if (!details) {
    return;
  }
  section?.toggleAttribute("data-translate-pinned", pinned);
  if (pinned) {
    maximizeTranslateSection(body);
    pinnedBody = body;
    lockItemDetailsScroll(details);
  } else if (pinnedBody === body) {
    pinnedBody = null;
    unlockItemDetailsScroll();
    clearScheduledPin(body);
    clearScheduledMaximize(body);
  }
}

function maximizeTranslateSection(body: HTMLElement) {
  const details = body.closest("item-details") as any;
  onUpdateHeight({ body });
  // @ts-ignore 'item-details' is a custom element on Zotero
  suppressPaneHookDepth += 1;
  try {
    details?.scrollToPane?.(paneKey || "translate");
  } finally {
    suppressPaneHookDepth = Math.max(0, suppressPaneHookDepth - 1);
  }
}

function ensurePaneSwitchUnlock(body: HTMLElement) {
  const details = body.closest("item-details") as HTMLElement | null;
  if (!details || hookedItemDetails.has(details)) {
    return;
  }
  const original = (details as any).scrollToPane?.bind(details);
  if (typeof original !== "function") {
    return;
  }
  hookedItemDetails.add(details);
  (details as any).scrollToPane = (paneID: string, ...args: any[]) => {
    if (suppressPaneHookDepth === 0 && paneID) {
      const translatePaneID = paneKey || "translate";
      if (paneID === translatePaneID) {
        applyPinnedState(body, true);
      } else if (pinnedBody) {
        applyPinnedState(pinnedBody, false);
      }
    }
    return original(paneID, ...args);
  };
}

function clearScheduledPin(body: HTMLElement) {
  const view = body.ownerDocument?.defaultView;
  const clearTimer = view?.clearTimeout?.bind(view) ?? clearTimeout;
  const timers = scheduledPinTimers.get(body);
  if (!timers?.length) {
    return;
  }
  timers.forEach((id) => clearTimer(id));
  scheduledPinTimers.delete(body);
}

function clearScheduledMaximize(body: HTMLElement) {
  const view = body.ownerDocument?.defaultView;
  const clearTimer = view?.clearTimeout?.bind(view) ?? clearTimeout;
  const timers = scheduledMaximizeTimers.get(body);
  if (!timers?.length) {
    return;
  }
  timers.forEach((id) => clearTimer(id));
  scheduledMaximizeTimers.delete(body);
}

function scheduleApplyPinnedState(body: HTMLElement, pinned: boolean) {
  clearScheduledPin(body);
  const view = body.ownerDocument?.defaultView;
  const setTimer = view?.setTimeout?.bind(view) ?? setTimeout;
  // Defer to keep pin state and icon in sync across startup/item switches.
  const timers = [
    setTimer(() => applyPinnedState(body, pinned), 0) as unknown as number,
    setTimer(() => applyPinnedState(body, pinned), 200) as unknown as number,
    setTimer(() => applyPinnedState(body, pinned), 500) as unknown as number,
  ];
  scheduledPinTimers.set(body, timers);
}

function scheduleMaximizeTranslateSection(body: HTMLElement) {
  clearScheduledMaximize(body);
  const view = body.ownerDocument?.defaultView;
  const setTimer = view?.setTimeout?.bind(view) ?? setTimeout;
  // Defer to let layout/pane registration settle before scrolling.
  const timers = [
    setTimer(() => maximizeTranslateSection(body), 0) as unknown as number,
    setTimer(() => maximizeTranslateSection(body), 200) as unknown as number,
  ];
  scheduledMaximizeTimers.set(body, timers);
}

export function registerReaderTabPanel() {
  const key = Zotero.ItemPaneManager.registerSection({
    paneID: "translate",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("itemPaneSection-header"),
      icon: `chrome://${config.addonRef}/content/icons/section-16.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("itemPaneSection-sidenav"),
      icon: `chrome://${config.addonRef}/content/icons/section-20.svg`,
      // @ts-ignore
      orderable: false,
    },
    bodyXHTML: "<translator-plugin-panel />",
    onInit,
    onDestroy,
    onRender: ({ body, item }) => {
      const panel = body.querySelector(
        "translator-plugin-panel",
      ) as TranslatorPanel;
      panel.item = item;
      panel.render();
      keepSectionExpanded(body);
      const nextItemID = String(item?.id || "");
      const prevItemID = body.dataset.itemID || "";
      if (!prevItemID || nextItemID !== prevItemID) {
        body.dataset.itemID = nextItemID;
        applyPinnedState(body, true);
        scheduleApplyPinnedState(body, true);
        scheduleMaximizeTranslateSection(body);
      }
    },
    onItemChange,
    sectionButtons: [
      {
        type: "openStandalone",
        icon: "chrome://zotero/skin/16/universal/open-link.svg",
        l10nID: getLocaleID("itemPaneSection-openStandalone"),
        onClick: ({ event }) => {
          openWindowPanel();
        },
      },
      {
        type: "fullHeight",
        icon: `chrome://${config.addonRef}/content/icons/full-16.svg`,
        l10nID: getLocaleID("itemPaneSection-fullHeight"),
        onClick: ({ body }) => {
          maximizeTranslateSection(body);
        },
      },
    ],
  });
  if (key) paneKey = key;
}

async function openWindowPanel() {
  if (addon.data.panel.windowPanel && !addon.data.panel.windowPanel.closed) {
    addon.data.panel.windowPanel.close();
  }
  const dialogData = {
    loadLock: Zotero.Promise.defer(),
  };
  const win: Window = ztoolkit.getGlobal("openDialog")(
    `chrome://${config.addonRef}/content/standalone.xhtml`,
    `${config.addonRef}-standalone`,
    `chrome,extrachrome,menubar,resizable=yes,scrollbars,status,dialog=no,${
      getPref("keepWindowTop") ? ",alwaysRaised=yes" : ""
    }`,
    dialogData,
  )!;
  await dialogData.loadLock.promise;
  buildExtraPanel(win.document);
  updateExtraPanel(win.document);
  addon.data.panel.windowPanel = win;
}

export function updateReaderTabPanels() {
  Object.values(addon.data.panel.activePanels).forEach((refresh: any) =>
    refresh(),
  );
  const win = addon.data.panel.windowPanel;
  if (win && isWindowAlive(win)) {
    updateExtraPanel(win.document);
  }
}

export function refreshPanelModelMenus() {
  const containers: Array<HTMLElement | Document> = [...panelBodies.values()];
  const win = addon.data.panel.windowPanel;
  if (win && isWindowAlive(win)) {
    containers.push(win.document);
  }
  for (const container of containers) {
    const panel = container.querySelector(
      "translator-plugin-panel",
    ) as TranslatorPanel;
    panel?.refreshModelMenu();
  }
}

export function refreshPanelServicesMenus() {
  const containers: Array<HTMLElement | Document> = [...panelBodies.values()];
  const win = addon.data.panel.windowPanel;
  if (win && isWindowAlive(win)) {
    containers.push(win.document);
  }
  for (const container of containers) {
    const panel = container.querySelector(
      "translator-plugin-panel",
    ) as TranslatorPanel;
    panel?.refreshServicesMenu();
  }
}

const panelBodies = new Map<string, HTMLElement>();

function onInit({ body, refresh }: { body: HTMLElement; refresh: () => void }) {
  const paneUID = Zotero.Utilities.randomString(8);
  body.dataset.paneUid = paneUID;
  addon.data.panel.activePanels[paneUID] = refresh;
  panelBodies.set(paneUID, body);
  keepSectionExpanded(body);
  ensureHeaderPinIndicator(body);
  ensurePaneSwitchUnlock(body);
  // Pin and maximize on startup so the sidebar stays fixed and the panel opens at full height
  applyPinnedState(body, true);
  scheduleApplyPinnedState(body, true);
  scheduleMaximizeTranslateSection(body);
}

function buildExtraPanel(doc: Document) {
  doc.querySelector("#add-source")?.addEventListener("click", () => {
    const extraServices = getPref("extraEngines");
    const allServices = services.getAllServices();
    setPref(
      "extraEngines",
      extraServices
        ? `${extraServices},${allServices[0].id}`
        : allServices[0].id,
    );
    openWindowPanel();
  });
  const pinButton = doc.querySelector("#pin-window") as XUL.Button;
  pinButton?.addEventListener("click", () => {
    setPref("keepWindowTop", !getPref("keepWindowTop"));
    openWindowPanel();
  });
  pinButton.dataset.l10nArgs = JSON.stringify({
    mode: getPref("keepWindowTop") ? "pinned" : "unpinned",
  });

  const extraEngines = (getPref("extraEngines") as string)
    .split(",")
    .filter((thisServiceId) => services.getServiceById(thisServiceId));
  if (!extraEngines.length) {
    return;
  }
  ztoolkit.UI.appendElement(
    {
      tag: "vbox",
      styles: {
        flexShrink: "1",
        flexGrow: "1",
      },
      children: extraEngines.map((serviceId, idx) => {
        return {
          tag: "vbox",
          styles: {
            flexShrink: "1",
            flexGrow: "1",
          },
          children: [
            {
              tag: "hbox",
              id: `${serviceId}-${idx}`,
              attributes: {
                align: "center",
              },
              classList: [serviceId],
              children: [
                {
                  tag: "menulist",
                  attributes: {
                    value: serviceId,
                    native: "true",
                  },
                  listeners: [
                    {
                      type: "command",
                      listener: (ev: Event) => {
                        const menulist = ev.currentTarget as XUL.MenuList;
                        const newService = menulist.value;
                        const [serviceId, idx] =
                          menulist.parentElement?.id.split("-") || [];
                        const extraServices = (
                          getPref("extraEngines") as string
                        ).split(",");
                        if (extraServices[Number(idx)] === serviceId) {
                          // If the idx and service matches
                          extraServices[Number(idx)] = newService;
                          menulist.parentElement!.id = `${newService}-${idx}`;
                          menulist.parentElement!.className = newService;
                          setPref("extraEngines", extraServices.join(","));
                        } else {
                          // Otherwise reload window
                          openWindowPanel();
                        }
                      },
                    },
                  ],
                  children: [
                    {
                      tag: "menupopup",
                      children: services
                        .getAllServicesWithType("sentence")
                        .map((s) => ({
                          tag: "menuitem",
                          attributes: {
                            label: services.getServiceNameByID(s.id),
                            value: s.id,
                          },
                        })),
                    },
                  ],
                },
                {
                  tag: "button",
                  namespace: "xul",
                  attributes: {
                    "data-l10n-id": getLocaleID("remove-source"),
                  },
                  listeners: [
                    {
                      type: "click",
                      listener: (ev) => {
                        const [serviceId, idx] =
                          (ev.target as XUL.Button).parentElement?.id.split(
                            "-",
                          ) || [];
                        const extraServices = (
                          getPref("extraEngines") as string
                        ).split(",");
                        // If the idx and service matches
                        if (extraServices[Number(idx)] === serviceId) {
                          extraServices.splice(Number(idx), 1);
                          setPref("extraEngines", extraServices.join(","));
                        }
                        openWindowPanel();
                      },
                    },
                  ],
                },
              ],
            },
            {
              tag: "editable-text",
              namespace: "xul",
              attributes: {
                multiline: "true",
              },
              styles: {
                fontSize: `${getPref("fontSize")}px`,
                lineHeight: getPref("lineHeight") as string,
              },
            },
          ],
        };
      }),
    },
    doc.querySelector("#extra-container")!,
  );
}

function onItemChange({
  tabType,
  item,
  body,
  setEnabled,
}: {
  tabType: string;
  item: Zotero.Item;
  body: HTMLElement;
  setEnabled: (enabled: boolean) => void;
}) {
  if (tabType !== "reader") {
    if (pinnedBody && pinnedBody !== body) {
      applyPinnedState(pinnedBody, false);
    }
    applyPinnedState(body, false);
    setEnabled(false);
  } else {
    keepSectionExpanded(body);
    applyPinnedState(body, true);
    scheduleApplyPinnedState(body, true);
    scheduleMaximizeTranslateSection(body);
  }
  const nextItemID = String(item?.id || "");
  const prevItemID = body.dataset.itemID || "";
  addon.data.translate.concatKey = false;
  addon.data.translate.concatCheckbox = false;
  addon.hooks.onReaderTabPanelRefresh();
  body.dataset.itemID = nextItemID;
  return true;
}

function updateExtraPanel(container: HTMLElement | Document) {
  const lastTask = getLastTranslateTask();
  const panel = container.querySelector(
    "translator-plugin-panel",
  ) as TranslatorPanel;
  if (panel) {
    panel.item = Zotero.Items.get(lastTask?.itemId || -1);
    panel.render();
  }

  const extraTasks = lastTask?.extraTasks;
  if (extraTasks?.length === 0) {
    return;
  }
  extraTasks?.forEach((task) => {
    Array.from(
      container.querySelectorAll(`.${task.service}+editable-text`),
    ).forEach((elem) => ((elem as HTMLTextAreaElement).value = task.result));
  });
}

function onDestroy(options: any) {
  const { body } = options;
  const paneUID = body.dataset.paneUid;
  applyPinnedState(body, false);
  delete addon.data.panel.activePanels[paneUID];
  panelBodies.delete(paneUID);
}

function onUpdateHeight({ body }: { body: HTMLElement }) {
  const details = body.closest("item-details");
  const head = body.closest("item-pane-custom-section")?.querySelector(".head");
  const heightKey = "--details-height";

  body?.style.setProperty(
    heightKey,
    `${details!.querySelector(".zotero-view-item")!.clientHeight - head!.clientHeight - 8}px`,
  );
}
