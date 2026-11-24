import { config } from "../../package.json";

export {
  getPref,
  setPref,
  clearPref,
  getPrefJSON,
  registerPrefObserver,
  unregisterPrefObserver,
};

type KeysWithStringValue<T> = {
  [K in keyof T]: T[K] extends string ? K : never;
}[keyof T];

type KeysWithNumberValue<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

type KeysWithBooleanValue<T> = {
  [K in keyof T]: T[K] extends boolean ? K : never;
}[keyof T];

type _PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];
export type PrefKeys = keyof _PluginPrefsMap;
export type PrefKeysWithStringValue = KeysWithStringValue<_PluginPrefsMap>;
export type PrefKeysWithNumberValue = KeysWithNumberValue<_PluginPrefsMap>;
export type PrefKeysWithBooleanValue = KeysWithBooleanValue<_PluginPrefsMap>;

function getPref<K extends keyof _PluginPrefsMap>(key: K): _PluginPrefsMap[K];
function getPref(key: string): string | number | boolean;
function getPref(key: string): string | number | boolean {
  return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as any;
}

function setPref<K extends keyof _PluginPrefsMap>(
  key: K,
  value: _PluginPrefsMap[K],
): void;
function setPref(key: string, value: string | number | boolean): void;
function setPref(key: string, value: string | number | boolean) {
  return Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

function clearPref<K extends keyof _PluginPrefsMap>(key: K): void;
function clearPref(key: string): void;
function clearPref(key: string) {
  return Zotero.Prefs.clear(`${config.prefsPrefix}.${key}`, true);
}

function getPrefJSON(key: string) {
  try {
    return JSON.parse(String(getPref(key) || "{}"));
  } catch (e) {
    setPref(key, "{}");
  }
  return {};
}

function registerPrefObserver<K extends keyof _PluginPrefsMap>(
  key: K,
  callback: (value: _PluginPrefsMap[K]) => void,
): symbol;
function registerPrefObserver(
  key: string,
  callback: (value: any) => void,
): symbol;
function registerPrefObserver(key: string, callback: (value: any) => void) {
  return Zotero.Prefs.registerObserver(
    `${config.prefsPrefix}.${key}`,
    callback,
    true,
  );
}

function unregisterPrefObserver(observerID: symbol) {
  return Zotero.Prefs.unregisterObserver(observerID);
}

/**
 * Get the user-configurable minimum height (in px) for the translation
 * result area. Falls back to 63 (≈3 lines at default font) for
 * missing/invalid values.
 */
export function getMinResultHeight(): number {
  const value = Number.parseFloat(String(getPref("minResultHeight") ?? ""));
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : 63;
}

/**
 * Default number of Custom GPT services (matches prefs.js defaults).
 */
export const CUSTOM_GPT_DEFAULT_COUNT = 20;
export const CUSTOM_GPT_MIN_COUNT = 1;
export const CUSTOM_GPT_MAX_COUNT = 100;

/**
 * Get the user-configurable number of Custom GPT services.
 * Falls back to 20 for missing/invalid values and clamps to [1, 100].
 */
export function getCustomGPTCount(): number {
  const value = Number.parseInt(String(getPref("customGPTCount") ?? ""), 10);
  if (!Number.isFinite(value)) {
    return CUSTOM_GPT_DEFAULT_COUNT;
  }
  return Math.min(Math.max(value, CUSTOM_GPT_MIN_COUNT), CUSTOM_GPT_MAX_COUNT);
}

/**
 * Parse a Custom GPT service id (`customgpt<N>`) into its 1-based index.
 * Returns undefined for ids that are not Custom GPT services.
 */
export function getCustomGPTIndexOf(id: string): number | undefined {
  const match = /^customgpt(\d+)$/.exec(id);
  if (!match) {
    return undefined;
  }
  const index = Number.parseInt(match[1], 10);
  return Number.isFinite(index) && index >= 1 ? index : undefined;
}
