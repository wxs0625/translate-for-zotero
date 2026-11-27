const concatKey = Zotero.isMac ? "Meta" : "Control";

export function registerShortcuts() {
  let concatKeyPressed = false;
  let concatKeyUsedAsModifier = false;

  ztoolkit.Keyboard.register((ev, data) => {
    if (data.type === "keydown") {
      if (ev.key === concatKey) {
        if (!ev.repeat) {
          concatKeyPressed = true;
          concatKeyUsedAsModifier = false;
        }
      } else if (concatKeyPressed) {
        concatKeyUsedAsModifier = true;
      }
    }
    if (data.type === "keyup") {
      if (ev.key === concatKey) {
        if (concatKeyPressed && !concatKeyUsedAsModifier) {
          if (addon.data.translate.concatCheckbox) {
            addon.data.translate.concatCheckbox = false;
            addon.data.translate.concatKey = false;
          } else {
            addon.data.translate.concatKey = !addon.data.translate.concatKey;
          }
          addon.hooks.onReaderTabPanelRefresh();
        }
        concatKeyPressed = false;
        concatKeyUsedAsModifier = false;
      }
      if (data.keyboard?.equals("accel,T")) {
        const isReaderWindow =
          ((ev.target as Element | null)?.ownerDocument?.location?.href ||
            ev.target?.ownerGlobal?.location?.href) ===
          "chrome://zotero/content/reader.xhtml";
        if (!isReaderWindow) {
          addon.hooks.onShortcuts(
            Zotero.getMainWindow().Zotero_Tabs.selectedType,
          );
        } else {
          addon.hooks.onShortcuts("reader");
        }
      }
    }
  });
}
