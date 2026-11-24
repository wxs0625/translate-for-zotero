import { getPrefJSON, setPref } from "../../utils/prefs";
import { TranslateService } from "./base";

const translate = <TranslateService["translate"]>async function (data) {
  const appId = await getAppId();
  if (!appId) {
    throw "Service error: Haici sentence translation API (fanyi.dict.cn) is no longer available upstream.";
  }

  const xhr = await Zotero.HTTP.request(
    "GET",
    `http://api.microsofttranslator.com/V2/Ajax.svc/TranslateArray?appId=${appId}&from=${
      data.langfrom
    }&to=${data.langto}&texts=["${encodeURIComponent(
      data.raw.replace(/"/g, '\\"'),
    )}"]`,
    { responseType: "json" },
  );
  if (xhr?.status !== 200) {
    throw `Request error: ${xhr?.status}`;
  }

  try {
    let tgt = "";
    xhr.response.forEach((line: { TranslatedText: string }) => {
      tgt += line.TranslatedText;
    });
    data.result = tgt;
  } catch {
    throw `Service error: ${xhr.response}`;
  }
};

async function getAppId(forceRefresh: boolean = false) {
  let appId = "";
  let doRefresh = true;
  try {
    const appIdObj = getPrefJSON("haiciAppId");
    if (
      !forceRefresh &&
      appIdObj &&
      appIdObj.appId &&
      new Date().getTime() - appIdObj.t < 60 * 60 * 1000
    ) {
      appId = appIdObj.appId;
      doRefresh = false;
    }
  } catch (e) {
    ztoolkit.log(e);
  }
  if (doRefresh) {
    const xhr = await Zotero.HTTP.request(
      "GET",
      "https://capi.dict.cn/fanyi.php",
      {
        headers: {
          Referer: "https://fanyi.dict.cn/",
        },
        responseType: "text",
      },
    );
    const matched =
      typeof xhr?.response === "string"
        ? xhr.response.match(/"([^"]+)"/)
        : null;
    if (!matched?.[1]) {
      throw "Service error: Haici sentence translation API (fanyi.dict.cn) is no longer available upstream.";
    }
    appId = matched[1];
    setPref(
      "haiciAppId",
      JSON.stringify({
        t: new Date().getTime(),
        appId: appId,
      }),
    );
  }
  return appId;
}

export const Haici: TranslateService = {
  id: "haici",
  type: "sentence",
  translate,
};
