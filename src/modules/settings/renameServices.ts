import { getPref, setPref, getCustomGPTCount } from "../../utils/prefs";
import { getString, getCustomGPTDisplayName } from "../../utils/locale";

function getCustomGPTFields() {
  return Array.from({ length: getCustomGPTCount() }, (_, index) => {
    const customGPTIndex = index + 1;
    return {
      id: `customgpt${customGPTIndex}`,
      prefKey: `renameServices.customgpt${customGPTIndex}`,
      label: getCustomGPTDisplayName(customGPTIndex),
    };
  });
}

export async function renameServicesDialog() {
  const CUSTOM_GPT_FIELDS = getCustomGPTFields();
  const dialog = new ztoolkit.Dialog(4, 1);
  const dialogData: { [key: string | number]: any } = {};
  CUSTOM_GPT_FIELDS.forEach((field) => {
    dialogData[field.id] = getPref(field.prefKey);
  });

  const customFieldsChildren = CUSTOM_GPT_FIELDS.flatMap((field) => {
    return [
      {
        tag: "label",
        namespace: "html",
        attributes: {
          for: field.id,
        },
        properties: {
          innerHTML: field.label,
        },
      },
      {
        tag: "input",
        id: field.id,
        attributes: {
          "data-bind": field.id,
          "data-prop": "value",
          type: "string",
          placeholder: "Maximum 15 characters",
          maxlength: "15",
        },
      },
    ];
  });

  dialog
    .setDialogData(dialogData)
    .addCell(
      0,
      0,
      {
        tag: "div",
        namespace: "html",
        styles: {
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "15px 20px",
          alignItems: "center",
          padding: "20px",
          maxHeight: "60vh",
          overflowY: "auto",
        },
        children: [
          {
            tag: "label",
            namespace: "html",
            properties: {
              innerHTML: getString("service-renameServices-head"),
            },
            styles: {
              gridColumn: "1 / span 2",
              marginBottom: "5px",
            },
          },
          ...customFieldsChildren,
          {
            tag: "label",
            namespace: "html",
            properties: {
              innerHTML: getString("service-renameServices-hint"),
            },
            styles: {
              gridColumn: "1 / span 2",
              fontSize: "0.9rem",
            },
          },
        ],
      },
      false,
    )
    .addButton(getString("service-renameServices-close"), "close")
    .addButton(getString("service-renameServices-save"), "save")
    .open(getString("service-renameServices-title"));

  await dialogData.unloadLock?.promise;
  switch (dialogData._lastButtonId) {
    case "save":
      {
        CUSTOM_GPT_FIELDS.forEach((field) => {
          setPref(field.prefKey, dialogData[field.id]);
        });
      }
      break;
    default:
      break;
  }
}
