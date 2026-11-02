"use strict";

const DEFAULTS = {
  enabled: true,
  targetLang: "zh-CN",
  composeTargetLang: "en",
  autoTranslate: false,
  rightClickTranslate: true,
  manualModeVersion: 1,
  cacheEnabled: true,
  compactMode: true,
  minLength: 2,
  microsoftKey: "",
  microsoftRegion: "",
  deeplKey: "",
};

const enabled = document.getElementById("enabled");
const targetLang = document.getElementById("targetLang");
const autoTranslate = document.getElementById("autoTranslate");
const rightClickTranslate = document.getElementById("rightClickTranslate");
const cacheEnabled = document.getElementById("cacheEnabled");
const compactMode = document.getElementById("compactMode");
const toggleEnabled = document.getElementById("toggleEnabled");
const save = document.getElementById("save");
const rescan = document.getElementById("rescan");

async function load() {
  const saved = await storageGet({ settings: DEFAULTS });
  const settings = Object.assign({}, DEFAULTS, saved.settings || {});
  if (!saved.settings || saved.settings.manualModeVersion !== 1) {
    settings.autoTranslate = false;
    settings.rightClickTranslate = true;
    settings.manualModeVersion = 1;
    await storageSet({ settings });
  }
  enabled.checked = settings.enabled;
  targetLang.value = settings.targetLang;
  autoTranslate.checked = settings.autoTranslate;
  rightClickTranslate.checked = settings.rightClickTranslate !== false;
  cacheEnabled.checked = settings.cacheEnabled;
  compactMode.checked = settings.compactMode;
  document.getElementById("microsoftKey").value = settings.microsoftKey || "";
  document.getElementById("microsoftRegion").value = settings.microsoftRegion || "";
  document.getElementById("deeplKey").value = settings.deeplKey || "";
  updateToggleButton();
}

async function persist() {
  const settings = {
    enabled: enabled.checked,
    targetLang: targetLang.value.trim() || DEFAULTS.targetLang,
    composeTargetLang: DEFAULTS.composeTargetLang,
    autoTranslate: autoTranslate.checked,
    rightClickTranslate: rightClickTranslate.checked,
    manualModeVersion: 1,
    cacheEnabled: cacheEnabled.checked,
    compactMode: compactMode.checked,
    minLength: DEFAULTS.minLength,
    microsoftKey: document.getElementById("microsoftKey").value.trim(),
    microsoftRegion: document.getElementById("microsoftRegion").value.trim(),
    deeplKey: document.getElementById("deeplKey").value.trim(),
  };

  await storageSet({ settings });
  save.textContent = "Saved";
  window.setTimeout(() => {
    save.textContent = "Save";
  }, 1000);
}

async function togglePlugin() {
  enabled.checked = !enabled.checked;
  updateToggleButton();
  await persist();
}

function updateToggleButton() {
  toggleEnabled.textContent = enabled.checked ? "Disable plugin" : "Enable plugin";
}

async function rescanActiveTab() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) return null;

  try {
    return await sendTabMessage(tab.id, { type: "dt-rescan" });
  } catch (error) {
    return null;
  }
}

async function handleRescan() {
  const response = await rescanActiveTab();
  rescan.textContent = response && response.ok
    ? `Found ${response.count}`
    : "Open Discord first";
  window.setTimeout(() => {
    rescan.textContent = "Rescan visible messages";
  }, 1400);
}

save.addEventListener("click", persist);
enabled.addEventListener("change", updateToggleButton);
toggleEnabled.addEventListener("click", togglePlugin);
rescan.addEventListener("click", handleRescan);
load();

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (value) => resolve(value || {}));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, resolve);
  });
}

function queryTabs(query) {
  return new Promise((resolve) => {
    chrome.tabs.query(query, (tabs) => resolve(tabs || []));
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}
