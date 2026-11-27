import { TranslateService } from "./base";
import {
  getString,
  getPref,
  getLastTranslateTask,
  getActiveReceiveToken,
  TranslateTask,
  TranslateTaskRunner,
  abortActiveRequests,
  autoDetectLanguage,
  bumpActiveReceiveToken,
  isTaskSnapshotStillActive,
  stripEmptyLines,
  getServiceSecret,
  setPref,
  getCustomGPTCount,
  getCustomGPTIndexOf,
  getCustomGPTDisplayName,
  normalizeLLMEndpoint,
  sanitizeTaskForLog,
} from "../../utils";

import { Aliyun } from "./aliyun";
import { Tencent } from "./tencent";
import { ChatGPT, customGPTServices, azureGPT } from "./gpt";
import { Baidu } from "./baidu";
import { BaiduField } from "./baidufield";
import { Bing } from "./bing";
import { BingDict } from "./bingdict";
import { Caiyun } from "./caiyun";
import { CambridgeDict } from "./cambridgedict";
import { Claude } from "./claude";
import { Cnki } from "./cnki";
import { CollinsDict } from "./collinsdict";
import { DeeplFree, DeeplPro } from "./deepl";
import { FreeDictionaryAPI } from "./freedictionaryapi";
import { Gemini } from "./gemini";
import { Google, GoogleAPI } from "./google";
import { Haici } from "./haici";
import { HaiciDict } from "./haicidict";
import { Huoshan } from "./huoshan";
import { HuoshanWeb } from "./huoshanweb";
import { LibreTranslate } from "./libretranslate";
import { Microsoft } from "./microsoft";
import { Mtranserver } from "./mtranserver";
import { Niutrans } from "./niutrans";
import { Nllb } from "./nllb";
import { Openl } from "./openl";
import { Pot } from "./pot";
import { QwenMT } from "./qwenmt";
import { WeblioDict } from "./webliodict";
import { XFfrans } from "./xftrans";
import { TencentTransmart } from "./tencenttransmart";
import { Youdao } from "./youdao";
import { YoudaoDict } from "./youdaodict";
import { YoudaoZhiyun } from "./youdaozhiyun";
import { YoudaoZhiyunLLM } from "./youdaozhiyunllm";
import { DeepLCustom } from "./deeplcustom";
import { DeepLX } from "./deeplx";
import { GramotaDict } from "./gramotadict";
import { Iciba } from "./iciba";
import { MyMemory } from "./mymemory";
import { WordsTalk } from "./wordstalk";

const register: TranslateService[] = [
  Aliyun,
  Baidu,
  BaiduField,
  Bing,
  BingDict,
  Caiyun,
  CambridgeDict,
  Claude,
  Cnki,
  CollinsDict,
  DeeplFree,
  DeeplPro,
  DeepLCustom,
  DeepLX,
  FreeDictionaryAPI,
  Gemini,
  Google,
  GoogleAPI,
  GramotaDict,
  ChatGPT,
  ...customGPTServices,
  azureGPT,
  Haici,
  HaiciDict,
  Huoshan,
  HuoshanWeb,
  Iciba,
  LibreTranslate,
  Microsoft,
  Mtranserver,
  MyMemory,
  Niutrans,
  Nllb,
  Openl,
  Pot,
  QwenMT,
  Tencent,
  TencentTransmart,
  WeblioDict,
  WordsTalk,
  XFfrans,
  Youdao,
  YoudaoDict,
  YoudaoZhiyun,
  YoudaoZhiyunLLM,
];

type ModelListRequest = {
  url: string;
  headers: Record<string, string>;
};

function parseResponseBody(response: any): any {
  const body = response?.response ?? response?.responseText ?? response;
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function normalizeModelName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/^models\//, "");
}

function uniqueModelNames(values: unknown[]): string[] {
  return [...new Set(values.map(normalizeModelName).filter(Boolean))];
}

function getOpenAIModelsEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    let pathname = url.pathname.replace(/\/+$/, "");
    pathname = pathname.replace(
      /:(?:stream)?(?:generateContent|chat)?[^/]*$/,
      "",
    );
    if (pathname.endsWith("/models")) {
      return url.href;
    }

    for (const suffix of [
      "/chat/completions",
      "/responses",
      "/completions",
      "/messages",
    ]) {
      if (pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }

    if (!pathname || pathname === "/") {
      pathname = "/v1";
    }
    if (!pathname.endsWith("/v1") && !pathname.endsWith("/v1beta")) {
      pathname = `${pathname}/v1`;
    }
    url.pathname = `${pathname}/models`.replace(/\/\/+/g, "/");
    return url.href;
  } catch {
    return undefined;
  }
}

function getModelNamesFromResponse(payload: any): string[] {
  const candidates = [
    Array.isArray(payload) ? payload : undefined,
    payload?.data,
    payload?.models,
    payload?.result,
    payload?.result?.data,
    payload?.result?.models,
  ].find(Array.isArray);
  if (!candidates) {
    return [];
  }
  return uniqueModelNames(
    candidates.map((entry: any) =>
      typeof entry === "string"
        ? entry
        : entry?.id || entry?.name || entry?.model || entry?.model_id,
    ),
  );
}

function getGeminiModelName(endpoint: string): string {
  const match = endpoint.match(/\/models\/([^/?#:]+)/);
  if (!match) {
    return "";
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function setGeminiModelName(endpoint: string, model: string): string {
  const normalizedModel = normalizeModelName(model);
  if (!normalizedModel) {
    return endpoint;
  }
  const encodedModel = encodeURIComponent(normalizedModel);
  try {
    const url = new URL(endpoint);
    const marker = "/models/";
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex >= 0) {
      url.pathname = `${url.pathname.slice(0, markerIndex + marker.length)}${encodedModel}`;
    } else {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}${marker}${encodedModel}`;
    }
    return url.href;
  } catch {
    return endpoint.replace(/(\/models\/)[^/?#:]+/, `$1${encodedModel}`);
  }
}

export class TranslationServices {
  #services: readonly TranslateService[] = Object.freeze(
    this.sortServices(register),
  );

  /**
   * The services visible to the user, filtered at read-time by the
   * `customGPTCount` pref: Custom GPT services whose index exceeds the
   * configured count are excluded. Reading the pref lazily here makes
   * runtime count changes take effect without rebuilding the frozen list.
   */
  get #activeServices(): readonly TranslateService[] {
    const count = getCustomGPTCount();
    return this.#services.filter((service) => {
      const customIndex = getCustomGPTIndexOf(service.id);
      return customIndex === undefined || customIndex <= count;
    });
  }

  /**
   * Sort the TranslateService list by the following rules:
   * 1. Free and no-config services (no secret, no config) come first.
   * 2. All other services are sorted by `id` in ascending order (case-insensitive).
   * 3. Services whose `id` starts with "custom" are placed last
   *    (sorted by `id` in ascending order within this group).
   */
  private sortServices<T extends TranslateService>(services: T[]) {
    return services.sort((a, b) => {
      const rank = (s: T) => {
        const needsSecret = !!s.defaultSecret || !!s.secretValidator;
        const hasConfig = !!s.config;
        const needExternalConfig = s.requireExternalConfig;

        // Rank for sentence services
        if (s.type === "sentence") {
          // Group 4: "custom" at the start → last
          if (s.id.startsWith("custom")) return 3;

          // Group 1: Free sentence services (no secret, no external config)
          if (!needsSecret && !needExternalConfig) return 0;

          // Group 2: No-secret but requires external config
          if (!needsSecret && needExternalConfig) return 1;

          // Group 3: Needs secret but no config
          if (needsSecret && !hasConfig) return 2;

          // Default (Sentence service needs secret and has config) — also rank 2
          return 2;
        }
        // Rank for word services
        else {
          // Default //TODO Modify it if necessary in the future
          return 0;
        }
      };

      const ra = rank(a);
      const rb = rank(b);

      if (ra !== rb) return ra - rb;
      // Within the Custom GPT group, sort numerically by index so that
      // e.g. customgpt2 comes before customgpt10 (lexicographic order
      // would place customgpt10 first).
      const ia = getCustomGPTIndexOf(a.id);
      const ib = getCustomGPTIndexOf(b.id);
      if (ia !== undefined && ib !== undefined && ia !== ib) {
        return ia - ib;
      }
      return a.id.localeCompare(b.id);
    });
  }

  public getServiceById(id: string): TranslateService | undefined {
    return this.#activeServices.find((service) => service.id === id);
  }

  public getAllServices(): TranslateService[] {
    return [...this.#activeServices];
  }

  public getAllServicesWithType(type: string): TranslateService[] {
    return this.getAllServices().filter((service) => service.type === type);
  }

  public getServiceModelPrefKey(id: string): string | undefined {
    if (id === "chatgpt") {
      return "chatGPT.model";
    }
    if (id === "azuregpt") {
      return "azureGPT.model";
    }
    if (id.startsWith("customgpt")) {
      const index = id.slice("customgpt".length);
      return index ? `customGPT${index}.model` : undefined;
    }
    const modelServices = new Set([
      "claude",
      "nllb",
      "qwenmt",
      "youdaozhiyunllm",
    ]);
    return modelServices.has(id) ? `${id}.model` : undefined;
  }

  public getServiceModelByID(id: string): string {
    if (id === "gemini") {
      return getGeminiModelName(String(getPref("gemini.endPoint") || ""));
    }
    const prefKey = this.getServiceModelPrefKey(id);
    if (!prefKey) {
      return "";
    }
    return String(getPref(prefKey) || "").trim();
  }

  public setServiceModelByID(id: string, model: string): boolean {
    const normalizedModel = normalizeModelName(model);
    if (!normalizedModel) {
      return false;
    }
    if (id === "gemini") {
      const endpoint = String(getPref("gemini.endPoint") || "");
      const nextEndpoint = setGeminiModelName(endpoint, normalizedModel);
      if (nextEndpoint === endpoint) {
        return false;
      }
      setPref("gemini.endPoint", nextEndpoint);
      return true;
    }
    const prefKey = this.getServiceModelPrefKey(id);
    if (!prefKey) {
      return false;
    }
    setPref(prefKey, normalizedModel);
    return true;
  }

  private getModelListRequest(id: string): ModelListRequest | undefined {
    const secret = getServiceSecret(id);
    const authHeaders: Record<string, string> = {
      Accept: "application/json",
    };
    if (secret) {
      authHeaders.Authorization = `Bearer ${secret}`;
      authHeaders["api-key"] = secret;
    }

    if (id === "gemini") {
      try {
        const endpoint = new URL(String(getPref("gemini.endPoint") || ""));
        const marker = "/models/";
        const markerIndex = endpoint.pathname.indexOf(marker);
        endpoint.pathname =
          markerIndex >= 0
            ? endpoint.pathname.slice(0, markerIndex + "/models".length)
            : endpoint.pathname.endsWith("/models")
              ? endpoint.pathname
              : `${endpoint.pathname.replace(/\/+$/, "")}/models`;
        endpoint.searchParams.set("key", secret);
        return {
          url: endpoint.href,
          headers: { Accept: "application/json" },
        };
      } catch {
        return undefined;
      }
    }

    if (id === "claude") {
      const endpoint = getOpenAIModelsEndpoint(
        String(getPref("claude.endPoint") || ""),
      );
      return endpoint
        ? {
            url: endpoint,
            headers: {
              Accept: "application/json",
              "anthropic-version": "2023-06-01",
              "x-api-key": secret,
            },
          }
        : undefined;
    }

    const isOpenAICompatible =
      id === "chatgpt" || id.startsWith("customgpt") || id === "qwenmt";
    if (!isOpenAICompatible) {
      return undefined;
    }

    const prefPrefix =
      id === "qwenmt"
        ? "qwenmt"
        : id === "chatgpt"
          ? "chatGPT"
          : id.replace("gpt", "GPT");
    const apiFormat = id.startsWith("customgpt")
      ? String(getPref(`${prefPrefix}.apiFormat`) || "openai")
      : "openai";
    const normalizedEndpoint = normalizeLLMEndpoint(
      String(getPref(`${prefPrefix}.endPoint`) || ""),
      apiFormat,
    );
    const endpoint = getOpenAIModelsEndpoint(normalizedEndpoint);
    if (!endpoint) {
      return undefined;
    }
    let customHeaders: Record<string, string> = {};
    if (id === "chatgpt" || id.startsWith("customgpt")) {
      try {
        const parsed = JSON.parse(
          String(getPref(`${prefPrefix}.customHeaders`) || "{}"),
        );
        if (parsed && typeof parsed === "object") {
          const blocked = new Set([
            "content-type",
            "authorization",
            "api-key",
            "x-api-key",
            "anthropic-version",
          ]);
          customHeaders = Object.fromEntries(
            Object.entries(parsed)
              .filter(([key]) => !blocked.has(key.toLowerCase()))
              .map(([key, value]) => [key, String(value)]),
          );
        }
      } catch {
        customHeaders = {};
      }
    }
    const headers = {
      ...(apiFormat === "anthropic"
        ? {
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": secret,
          }
        : authHeaders),
      ...customHeaders,
    };
    return { url: endpoint, headers };
  }

  public async fetchServiceModels(id: string): Promise<string[]> {
    return (await this.fetchServiceModelsDetailed(id)).models;
  }

  public async fetchServiceModelsDetailed(
    id: string,
  ): Promise<{ models: string[]; fetched: boolean }> {
    const current = this.getServiceModelByID(id);
    if (id === "nllb") {
      return {
        models: uniqueModelNames([current, "nllb-api", "nllb-serve"]),
        fetched: true,
      };
    }
    if (id === "youdaozhiyunllm") {
      return { models: uniqueModelNames([current, "0", "3"]), fetched: true };
    }
    const request = this.getModelListRequest(id);
    if (!request) {
      return { models: current ? [current] : [], fetched: false };
    }

    try {
      const response = await Zotero.HTTP.request("GET", request.url, {
        headers: request.headers,
        responseType: "json",
      });
      if (
        typeof response?.status === "number" &&
        (response.status < 200 || response.status >= 300)
      ) {
        return { models: current ? [current] : [], fetched: false };
      }

      const payload = parseResponseBody(response);
      let models: string[];
      if (id === "gemini") {
        const candidates = Array.isArray(payload?.models) ? payload.models : [];
        models = uniqueModelNames(
          candidates
            .filter((entry: any) => {
              const methods = entry?.supportedGenerationMethods;
              return (
                !Array.isArray(methods) || methods.includes("generateContent")
              );
            })
            .map((entry: any) => entry?.name),
        );
      } else {
        models = getModelNamesFromResponse(payload);
      }
      return { models: uniqueModelNames([current, ...models]), fetched: true };
    } catch {
      return { models: current ? [current] : [], fetched: false };
    }
  }

  public getServiceNameByID(id: string, includeModel = true): string {
    const customIndex = getCustomGPTIndexOf(id);
    const baseName =
      (getPref(`renameServices.${id}`) as string) ||
      (customIndex !== undefined
        ? getCustomGPTDisplayName(customIndex)
        : getString(`service-${id}`));
    const model =
      id === "gemini" || this.getServiceModelPrefKey(id)
        ? this.getServiceModelByID(id)
        : "";
    const displayName =
      includeModel && model ? `${baseName} - ${model}` : baseName;
    const service = this.getServiceById(id);
    if (
      !!service?.defaultSecret ||
      !!service?.secretValidator ||
      id.startsWith("custom")
    ) {
      return displayName + "🗝️";
    }
    if (service?.requireExternalConfig) {
      return displayName + "📍";
    }
    return displayName;
  }

  public getAllServiceNames(): string[] {
    return this.getAllServices().map((service) =>
      this.getServiceNameByID(service.id),
    );
  }

  public getAllServiceNamesWithType(type: string): string[] {
    return this.getAllServicesWithType(type).map((service) =>
      this.getServiceNameByID(service.id),
    );
  }

  /**
   * Get the set of unconfigured service IDs.
   * A service is unconfigured if it requires a secret but none is set or validation fails.
   * @returns Set of service IDs that are not configured
   */
  public getUnconfiguredServiceIds(): Set<string> {
    const unconfigured = new Set<string>();

    let secrets: Record<string, string> = {};
    try {
      secrets = JSON.parse((getPref("secretObj") as string) || "{}");
    } catch {
      secrets = {};
    }

    for (const service of this.#activeServices) {
      const needsSecret =
        !!service.defaultSecret ||
        !!service.secretValidator ||
        service.id.startsWith("custom");

      if (!needsSecret) continue;

      const secret = secrets[service.id] || "";
      if (!secret) {
        unconfigured.add(service.id);
        continue;
      }

      if (service.secretValidator) {
        try {
          if (!service.secretValidator(secret).status) {
            unconfigured.add(service.id);
          }
        } catch {
          // Validation error - treat as configured
        }
      }
    }

    return unconfigured;
  }

  public async runTranslationTask(
    task?: TranslateTask,
    options: {
      noCheckZoteroItemLanguage?: boolean;
      noDisplay?: boolean;
      noCache?: boolean;
      forceRestart?: boolean;
    } = {},
  ): Promise<boolean> {
    ztoolkit.log("runTranslationTask", options);
    const { noCache, noCheckZoteroItemLanguage, noDisplay, forceRestart } =
      options;

    task = task || getLastTranslateTask();
    if (!task || !task.raw) {
      return false;
    }
    if (
      task.type === "text" &&
      task.status === "processing" &&
      addon.data.translate.activeTaskId === task.id &&
      !forceRestart
    ) {
      return false;
    }
    if (task.type === "text") {
      const previousActive = addon.data.translate.activeTaskId;
      const shouldInvalidatePreviousReceive =
        forceRestart || previousActive !== task.id;
      addon.data.translate.activeTaskId = task.id;
      if (shouldInvalidatePreviousReceive) {
        bumpActiveReceiveToken();
      }
      // Invalidate the old receive callbacks before aborting their XHRs.
      // XMLHttpRequest abort dispatches loadend synchronously in some Zotero
      // builds, so aborting first can let the previous task commit once more.
      if (
        (previousActive && previousActive !== task.id) ||
        (forceRestart && task.status === "processing")
      ) {
        abortActiveRequests();
      }
    }
    // Check whether item language is in disabled languages list
    let disabledByItemLanguage = false;
    if (!noCheckZoteroItemLanguage && task.itemId) {
      const taskItem = Zotero.Items.get(task.itemId);
      const item = taskItem && Zotero.Items.getTopLevel([taskItem])[0];
      if (item && task.type !== "custom") {
        const detectedLang = getPref("enableAutoDetectLanguage")
          ? task.langfrom || autoDetectLanguage(item).fromLanguage
          : (item.getField("language") as string) || "";
        const itemLangFull = (detectedLang || "").trim();
        const itemLangMajor = itemLangFull.split("-")[0];
        const disabledLanguages = String(getPref("disabledLanguages") || "")
          .split(/[,;，；]/)
          .map((lang) => lang.trim().toLowerCase())
          .filter(Boolean);
        disabledByItemLanguage =
          disabledLanguages.length > 0 &&
          !!itemLangFull &&
          (disabledLanguages.includes(itemLangFull.toLowerCase()) ||
            disabledLanguages.includes(itemLangMajor.toLowerCase()));
      }
    }
    if (disabledByItemLanguage) {
      ztoolkit.log("disabledByItemLanguage");
      return false;
    }
    task.status = "processing" as TranslateTask["status"];
    // Remove possible translation results (for annotations).
    const splitChar = (getPref("splitChar") as string).trim();
    // /🔤[^🔤]*🔤/g
    const regex =
      splitChar === ""
        ? ""
        : new RegExp(`${splitChar}[^${splitChar}]*${splitChar}`, "g");
    task.raw = task.raw.replace(regex, "");
    task.rawSnapshotAliases = undefined;
    const rawSnapshot = task.raw;
    const receiveToken =
      task.type === "text" ? getActiveReceiveToken() : undefined;
    const shouldDisplayTask = () =>
      isTaskSnapshotStillActive(task!, rawSnapshot, receiveToken);
    if (task.type === "text") {
      task.outputScrollTop = 0;
      task.outputScrollLeft = 0;
      task.outputHasRendered = false;
    }
    let cacheHit = false;
    if (!noCache) {
      // Check cache before displaying translating status so cache hits render immediately.
      const cachedTask = addon.data.translate.queue.findLast((_t) => {
        return (
          _t.status === "success" &&
          typeof _t.result === "string" &&
          _t.result.trim().length > 0 &&
          _t.raw === task!.raw &&
          _t.service === task!.service &&
          (!task.langfrom || _t.langfrom === task.langfrom) &&
          (!task.langto || _t.langto === task.langto)
        );
      });

      if (cachedTask) {
        cacheHit = true;
        ztoolkit.log("cache hit", sanitizeTaskForLog(cachedTask));
        task.audio = cachedTask.audio;
        task.result = cachedTask.result;
        task.status = "success";

        if (!noDisplay) {
          if (!shouldDisplayTask()) {
            return false;
          }
          addon.api.getTemporaryRefreshHandler()();
        }
      }
    }

    if (!cacheHit) {
      task.result = getString("status-translating");
      // Display raw text and translating status immediately.
      if (!noDisplay) {
        if (!shouldDisplayTask()) {
          return false;
        }
        addon.api.getTemporaryRefreshHandler()();
      }
      // Get task service
      const service = this.getServiceById(task.service);
      if (!service) {
        task.result = `${task.service} is not implemented.`;
        task.status = "fail";
        return false;
      }

      // Run task
      const runner = new TranslateTaskRunner(
        service.translate,
        shouldDisplayTask,
      );
      await runner.run(task);
      if (!shouldDisplayTask()) {
        return false;
      }

      const resultRegex = getPref("resultRegex") as string;
      if (resultRegex) {
        try {
          const regex = new RegExp(resultRegex, "g");
          // Remove all matches
          task.result = task.result.replace(regex, "");
        } catch (e) {
          ztoolkit.log("Invalid result regex", e);
          task.result = `Invalid result regex: ${resultRegex}. Please check settings > Translate > Advanced > Result Regex.`;
        }
      }

      const stripEnabled = getPref("stripEmptyLines") as boolean;
      if (stripEnabled && task.result) {
        task.result = stripEmptyLines(task.result, true);
      }

      // Treat an empty translation as a failure so configured candidate services can be tried.
      if (task.status === "success" && !task.result?.trim()) {
        ztoolkit.log("Empty translation result; treating as failure", {
          service: task.service,
          raw: task.raw,
        });
        task.result = "";
        task.status = "fail";
      }

      // Run extra tasks. Do not wait.
      if (task.extraTasks?.length) {
        Promise.all(
          task.extraTasks.map((extraTask) => {
            return this.runTranslationTask(extraTask, {
              noCheckZoteroItemLanguage,
              noDisplay: true,
            });
          }),
        ).then(() => {
          addon.hooks.onReaderTabPanelRefresh();
        });
      }
      // Try candidate services if current run fails
      if (task.status === "fail" && task.candidateServices.length > 0) {
        task.service = task.candidateServices.shift()!;
        task.status = "waiting";
        return await this.runTranslationTask(task, options);
      } else {
        // Display result
        if (!noDisplay) {
          if (!shouldDisplayTask()) {
            return false;
          }
          addon.api.getTemporaryRefreshHandler()();
        }
      }
    }

    const success = task.status === "success";
    const item = Zotero.Items.get(task.itemId!);
    // Data storage for corresponding types
    if (success) {
      switch (task.type) {
        case "annotation":
          {
            if (item) {
              const savePosition = getPref("annotationTranslationPosition") as
                | "comment"
                | "body";
              const savePositionInBody = getPref(
                "annotationTranslationPositionInBody",
              ) as "before" | "after";
              const currentText = (
                (savePosition === "comment"
                  ? item.annotationComment
                  : item.annotationText) || ""
              ).replace(regex, "");
              const translationText = `${splitChar}${task.result}${splitChar}\n`;
              let text = `${
                currentText[currentText.length - 1] === "\n" ? "" : "\n"
              }${translationText}`;
              if (splitChar !== "") {
                text =
                  savePosition === "body" && savePositionInBody === "before"
                    ? `${translationText}${currentText}`
                    : `${currentText}${text}`;
              }
              item[
                savePosition === "comment"
                  ? "annotationComment"
                  : "annotationText"
              ] = text;

              // Auto tag
              const enableAutoTag = getPref(
                "enableAutoTagAnnotation",
              ) as boolean;
              if (enableAutoTag) {
                const tagContent = getPref("annotationTagContent") as string;
                if (tagContent && tagContent.trim()) {
                  const tag = tagContent.trim();
                  // Check if the tag already exists
                  const existingTags = item.getTags();
                  const tagExists = existingTags.some(
                    (existingTag) => existingTag.tag === tag,
                  );

                  if (!tagExists) {
                    item.addTag(tag);
                  }
                }
              }
              item.saveTx();
            }
          }
          break;
        case "title":
          {
            if (item) {
              ztoolkit.ExtraField.setExtraField(
                item,
                "titleTranslation",
                task.result,
              );
              item.saveTx();
            }
          }
          break;
        case "abstract":
          {
            if (item) {
              ztoolkit.ExtraField.setExtraField(
                item,
                "abstractTranslation",
                // A dirty workaround to make it collapsible on Zotero 6
                task.result,
              );
              item.saveTx();
            }
          }
          break;
        default:
          break;
      }
    }
    return success;
  }
}

export const services = new TranslationServices();
