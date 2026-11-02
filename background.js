"use strict";

const providerCooldowns = new Map();
let edgeAuthToken = "";
let edgeAuthExpiresAt = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "dt-translate-page-text",
      title: "翻译此处为中文",
      contexts: ["all"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "dt-translate-page-text" || !tab || !tab.id) return;
  void translatePageContext(info, tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "dt-translate") return false;

  translateWithGoogle(
    message.text || "",
    message.targetLang || "zh-CN",
    Boolean(message.forceChinese),
    Boolean(message.manual),
    message.microsoftKey || "",
    message.microsoftRegion || "",
    message.deeplKey || ""
  )
    .then((translated) => sendResponse({ ok: true, translated }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function translatePageContext(info, tabId) {
  try {
    const context = info.selectionText
      ? { text: info.selectionText }
      : await sendTabMessage(tabId, { type: "dt-get-context-text" });
    const text = String(context && context.text || "").trim();
    if (!text) throw new Error("没有找到可翻译的文字");

    const stored = await storageGet({ settings: {} });
    const settings = stored.settings || {};
    const translated = await translateWithGoogle(
      text,
      "zh-CN",
      true,
      true,
      settings.microsoftKey || "",
      settings.microsoftRegion || "",
      settings.deeplKey || ""
    );
    await sendTabMessage(tabId, { type: "dt-show-page-translation", translated });
  } catch (error) {
    await sendTabMessage(tabId, {
      type: "dt-show-page-translation",
      error: error.message || String(error),
    }).catch(() => {});
  }
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (value) => resolve(value || {}));
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function translateWithGoogle(text, targetLang, forceChinese, manual, microsoftKey, microsoftRegion, deeplKey) {
  if (!text.trim()) throw new Error("empty text");

  if (forceChinese) targetLang = "zh-CN";

  const sourceLang = detectSourceLanguage(text, targetLang);
  const microsoftTarget = targetLang === "zh-CN" ? "zh-Hans" : targetLang;

  const googleParams = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: targetLang,
    dt: "t",
    q: text,
  });
  const memoryParams = new URLSearchParams({
    q: text.slice(0, 500),
    langpair: `${sourceLang}|${targetLang}`,
  });
  const providers = [
    {
      name: "Google",
      url: `https://translate.googleapis.com/translate_a/single?${googleParams.toString()}`,
      parse(data) {
        return Array.isArray(data[0])
          ? data[0].map((part) => part && part[0]).filter(Boolean).join("")
          : "";
      },
    },
    {
      name: "Google Web",
      url: `https://translate.google.com/translate_a/single?${googleParams.toString()}`,
      parse(data) {
        return Array.isArray(data[0])
          ? data[0].map((part) => part && part[0]).filter(Boolean).join("")
          : "";
      },
    },
    ...(microsoftKey ? [{
      name: "Microsoft",
      url: `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(microsoftTarget)}`,
      options: {
        method: "POST",
        headers: Object.assign({
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": microsoftKey,
        }, microsoftRegion ? { "Ocp-Apim-Subscription-Region": microsoftRegion } : {}),
        body: JSON.stringify([{ Text: text }]),
      },
      parse(data) {
        return data && data[0] && data[0].translations && data[0].translations[0]
          && data[0].translations[0].text;
      },
    }] : []),
    ...(deeplKey ? [{
      name: "DeepL",
      url: "https://api-free.deepl.com/v2/translate",
      options: {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${deeplKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          text,
          target_lang: targetLang.startsWith("zh") ? "ZH" : targetLang.toUpperCase(),
        }).toString(),
      },
      parse(data) {
        return data && data.translations && data.translations[0] && data.translations[0].text;
      },
    }] : []),
    {
      name: "Microsoft Edge",
      async request(signal) {
        const token = await getEdgeAuthToken(signal);
        return fetch(
          `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(microsoftTarget)}`,
          {
            method: "POST",
            signal,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify([{ Text: text }]),
          }
        );
      },
      parse(data) {
        return data && data[0] && data[0].translations && data[0].translations[0]
          && data[0].translations[0].text;
      },
    },
    {
      name: "MyMemory",
      url: `https://api.mymemory.translated.net/get?${memoryParams.toString()}`,
      parse(data) {
        // Some MyMemory responses use a string status or omit responseStatus.
        // The translatedText field is the useful success signal.
        return data && data.responseData && data.responseData.translatedText;
      },
    },
  ];
  const failures = [];

  for (const provider of providers) {
    const cooldownUntil = providerCooldowns.get(provider.name) || 0;
    if (!manual && cooldownUntil > Date.now()) {
      failures.push(`${provider.name} cooling down`);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = provider.request
        ? await provider.request(controller.signal)
        : await fetch(provider.url, Object.assign({ signal: controller.signal }, provider.options || {}));
      clearTimeout(timeout);
      if (!response.ok) {
        if (response.status === 429) {
          providerCooldowns.set(provider.name, Date.now() + 60000);
        }
        failures.push(`${provider.name} HTTP ${response.status}`);
        continue;
      }

      const translated = String(provider.parse(await response.json()) || "").trim();
      if (translated) return translated;
      failures.push(`${provider.name} returned no translation`);
    } catch (error) {
      providerCooldowns.set(provider.name, Date.now() + 30000);
      failures.push(`${provider.name} unavailable`);
    }
  }

  throw new Error(`Translation services unavailable (${failures.join(", ")})`);
}

async function getEdgeAuthToken(signal) {
  if (edgeAuthToken && edgeAuthExpiresAt > Date.now()) return edgeAuthToken;

  const response = await fetch("https://edge.microsoft.com/translate/auth", { signal });
  if (!response.ok) throw new Error(`Microsoft Edge auth HTTP ${response.status}`);
  const token = (await response.text()).trim();
  if (!token) throw new Error("Microsoft Edge auth returned no token");

  edgeAuthToken = token;
  edgeAuthExpiresAt = Date.now() + (8 * 60 * 1000);
  return edgeAuthToken;
}

function detectSourceLanguage(text, targetLang) {
  if (/[\u3400-\u9fff]/.test(text)) return "zh-CN";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0900-\u097f]/.test(text)) return "hi";
  if (/[\u0980-\u09ff]/.test(text)) return "bn";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[\u0590-\u05ff]/.test(text)) return "he";
  if (/[\u0370-\u03ff]/.test(text)) return "el";
  if (/[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text)) return "vi";
  return targetLang.startsWith("zh") ? "en" : "zh-CN";
}
