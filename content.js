(async function () {
  "use strict";

  const APP = "dt";
  const TRANSLATION_INTERVAL_MS = 3000;
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  const MESSAGE_SELECTOR = 'li[id^="chat-messages-"], li[role="listitem"], div[role="listitem"], article';
  const CONTENT_SELECTOR = '[id^="message-content-"], [class*="messageContent"]';
  const FALLBACK_CONTENT_SELECTOR = '[class*="embedDescription"], [class*="markup"]';

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

  const state = {
    settings: await loadSettings(),
    observer: null,
    debugPanel: null,
    lastScanCount: 0,
    processing: new Set(),
    queue: [],
    active: 0,
    maxConcurrent: 1,
    nextTranslationAt: 0,
    translationPausedUntil: 0,
  };

  function hasExtensionContext() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!hasExtensionContext()) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (value) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve(value || {});
        });
      } catch (error) {
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      if (!hasExtensionContext()) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.set(value, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (error) {
        resolve();
      }
    });
  }

  async function loadSettings() {
    const saved = await storageGet({ settings: DEFAULTS });
    const settings = Object.assign({}, DEFAULTS, saved.settings || {});
    if (!saved.settings || saved.settings.manualModeVersion !== 1) {
      settings.autoTranslate = false;
      settings.rightClickTranslate = true;
      settings.manualModeVersion = 1;
      await storageSet({ settings });
    }
    return settings;
  }

  async function saveSettings() {
    await storageSet({ settings: state.settings });
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function cacheKey(text) {
    return `${APP}:cache:google:${state.settings.targetLang}:${hashText(text)}`;
  }

  async function getCached(text) {
    if (!state.settings.cacheEnabled) return null;
    const key = cacheKey(text);
    const saved = await storageGet({ [key]: null });
    return saved[key];
  }

  async function setCached(text, value) {
    if (!state.settings.cacheEnabled) return;
    await storageSet({ [cacheKey(text)]: value });
  }

  function isEnabled() {
    return state.settings.enabled !== false;
  }

  function normalizeText(text) {
    return text
      .replace(/\u200b/g, "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isProbablySkippable(text) {
    if (!text || text.length < state.settings.minLength) return true;
    if (/^https?:\/\/\S+$/i.test(text)) return true;
    if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*_+=<>|/\\-]+$/.test(text)) return true;
    return false;
  }

  function isMostlyTargetChinese(text) {
    if (!state.settings.targetLang.startsWith("zh")) return false;
    const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const letters = (text.match(/[A-Za-z\u3400-\u9fff]/g) || []).length;
    return letters > 0 && chinese / letters > 0.55;
  }

  function findMessageNode(contentNode) {
    return contentNode.closest('li[id^="chat-messages-"], li[role="listitem"], div[role="listitem"], article') ||
      contentNode.parentElement;
  }

  function findMessageContent(messageNode) {
    const contents = getMessageContentNodes(messageNode);
    const directContent = contents.find((node) => node.id && node.id.startsWith("message-content-"));
    if (directContent) return directContent;
    if (contents.length > 0) return contents[contents.length - 1];

    const candidates = Array.from(messageNode.querySelectorAll(FALLBACK_CONTENT_SELECTOR));
    return candidates.find((node) => normalizeText(node.innerText || "").length > 0) || null;
  }

  function getMessageContentNodes(messageNode) {
    const nodes = Array.from(messageNode.querySelectorAll(CONTENT_SELECTOR));
    const filtered = nodes.filter((node) => {
      if (node.closest(`.${APP}-result-row, .${APP}-toolbar`)) return false;
      if (node.closest('[class*="repliedMessage"], [class*="replying"], [class*="threadMessageAccessory"]')) return false;
      if (node.closest('[class*="embed"]')) return false;
      return normalizeText(node.innerText || node.textContent || "").length > 0;
    });

    const direct = filtered.filter((node) => node.id && node.id.startsWith("message-content-"));
    return direct.length > 0 ? direct : filtered;
  }

  function resultAnchor(contentNode) {
    return contentNode.closest('[class*="contents"]') || contentNode;
  }

  function ensureResultRow(messageNode, contentNode) {
    let row = messageNode.querySelector(`.${APP}-result-row`);
    if (row) {
      if (row.parentElement !== messageNode) messageNode.appendChild(row);
    } else {
      row = document.createElement("div");
      row.className = `${APP}-result-row`;
      messageNode.appendChild(row);
    }

    const oldResults = Array.from(messageNode.querySelectorAll(`.${APP}-result`))
      .filter((result) => !result.closest(`.${APP}-result-row`));
    oldResults.forEach((result, index) => {
      if (index === 0) row.appendChild(result);
      else result.remove();
    });
    return row;
  }

  function getMessageText(contentNode) {
    const clone = contentNode.cloneNode(true);
    clone.querySelectorAll(`.${APP}-result, .${APP}-toolbar, button`).forEach((node) => node.remove());
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  function getFullMessageText(messageNode, fallbackContentNode) {
    const nodes = getMessageContentNodes(messageNode);
    const usableNodes = nodes.length > 0 ? nodes : [fallbackContentNode].filter(Boolean);
    const parts = usableNodes.map((node) => getMessageText(node)).filter(Boolean);
    return normalizeText(Array.from(new Set(parts)).join("\n"));
  }

  function ensureToolbar(messageNode, contentNode) {
    if (!isEnabled()) return;
    const existingToolbars = Array.from(messageNode.querySelectorAll(`.${APP}-toolbar`));
    if (existingToolbars.length > 0) {
      existingToolbars.slice(1).forEach((toolbar) => toolbar.remove());
      if (existingToolbars[0].parentElement !== messageNode) {
        messageNode.appendChild(existingToolbars[0]);
      }
      messageNode.dataset.dtReady = "1";
      messageNode.classList.add(`${APP}-message`);
      return;
    }

    if (messageNode.dataset.dtReady === "1") return;
    messageNode.dataset.dtReady = "1";
    messageNode.classList.add(`${APP}-message`);

    const toolbar = document.createElement("span");
    toolbar.className = `${APP}-toolbar`;
    toolbar.setAttribute("aria-label", "Message translation actions");

    const button = document.createElement("button");
    button.type = "button";
    button.className = `${APP}-button`;
    button.textContent = "T";
    button.title = "Translate message";
    button.setAttribute("aria-label", "Translate message");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      translateMessage(messageNode, contentNode, { force: true, manual: true });
    });

    toolbar.appendChild(button);
    contentNode.insertAdjacentElement("afterend", toolbar);

    if (messageNode.dataset.dtContextReady !== "1") {
      messageNode.dataset.dtContextReady = "1";
      messageNode.addEventListener("contextmenu", (event) => {
        if (!isEnabled() || !state.settings.rightClickTranslate) return;
        if (event.target.closest(`.${APP}-result, .${APP}-toolbar, a, button`)) return;
        event.preventDefault();
        event.stopPropagation();
        translateMessage(messageNode, contentNode, { force: true, manual: true });
      });
    }

    if (state.settings.autoTranslate) {
      window.setTimeout(() => translateMessage(messageNode, contentNode, { force: false }), 80);
    }
  }

  function setStatus(messageNode, status) {
    messageNode.dataset.dtStatus = status;
  }

  function renderResult(messageNode, contentNode, translated, meta) {
    let result = messageNode.querySelector(`.${APP}-result`);
    if (!result) {
      result = document.createElement("div");
      result.className = `${APP}-result`;
      ensureResultRow(messageNode, contentNode).appendChild(result);
    }

    const provider = meta && meta.provider ? meta.provider : "google";
    result.classList.remove(`${APP}-error`);
    result.title = `Translated by ${provider}`;
    result.innerHTML = "";

    const header = document.createElement("div");
    header.className = `${APP}-result-header`;

    const label = document.createElement("span");
    label.className = `${APP}-result-label`;
    label.textContent = `Translated to ${state.settings.targetLang}`;

    const controls = document.createElement("span");
    controls.className = `${APP}-result-controls`;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = `${APP}-mini-button`;
    copyButton.textContent = "Copy";
    copyButton.title = "Copy translation";
    copyButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyText(translated);
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = `${APP}-mini-button`;
    closeButton.textContent = "Hide";
    closeButton.title = "Hide translation";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = result.closest(`.${APP}-result-row`);
      if (row) {
        row.remove();
      } else {
        result.remove();
      }
      delete messageNode.dataset.dtStatus;
    });

    controls.append(copyButton, closeButton);
    header.append(label, controls);

    const body = document.createElement("div");
    body.className = `${APP}-result-body`;
    body.textContent = translated;

    result.append(header, body);
    setStatus(messageNode, "done");
  }

  function renderError(messageNode, contentNode, error) {
    let result = messageNode.querySelector(`.${APP}-result`);
    if (!result) {
      result = document.createElement("div");
      result.className = `${APP}-result ${APP}-error`;
      ensureResultRow(messageNode, contentNode).appendChild(result);
    } else {
      result.classList.add(`${APP}-error`);
    }
    result.innerHTML = "";

    const body = document.createElement("div");
    body.className = `${APP}-result-body`;
    body.textContent = `Translation failed: ${error.message || error}`;
    result.appendChild(body);
    setStatus(messageNode, "error");
  }

  function renderLoading(messageNode, contentNode) {
    let result = messageNode.querySelector(`.${APP}-result`);
    if (!result) {
      result = document.createElement("div");
      result.className = `${APP}-result`;
      ensureResultRow(messageNode, contentNode).appendChild(result);
    }

    result.classList.remove(`${APP}-error`);
    result.innerHTML = "";

    const body = document.createElement("div");
    body.className = `${APP}-result-body ${APP}-loading`;
    body.textContent = "Translating...";
    result.appendChild(body);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => notify("Translation copied."));
      return;
    }

    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    notify("Translation copied.");
  }

  async function translateMessage(messageNode, contentNode, options) {
    if (!isEnabled()) return;
    const text = getFullMessageText(messageNode, contentNode);
    if (isProbablySkippable(text) || isMostlyTargetChinese(text)) return;

    const fingerprint = `${messageNode.id || ""}:${hashText(text)}`;
    if (!options.force && state.processing.has(fingerprint)) return;
    if (!options.force && messageNode.dataset.dtStatus === "done") return;

    const cached = await getCached(text);
    if (cached) {
      renderResult(messageNode, contentNode, cached, { provider: "cache" });
      return;
    }

    state.processing.add(fingerprint);

    const task = async () => {
      try {
        setStatus(messageNode, "loading");
        renderLoading(messageNode, contentNode);
        if (!options.manual) await waitForTranslationSlot();
        const translated = await translateWithGoogle(text, "zh-CN", true, options.manual);
        await setCached(text, translated);
        renderResult(messageNode, contentNode, translated, { provider: "google" });
      } catch (error) {
        if (/HTTP 429/i.test(error && error.message)) {
          state.translationPausedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          state.queue.length = 0;
          state.processing.clear();
        }
        renderError(messageNode, contentNode, error);
      } finally {
        state.processing.delete(fingerprint);
      }
    };

    if (options.manual) {
      void task();
    } else {
      enqueue(task);
    }
  }

  async function waitForTranslationSlot() {
    const now = Date.now();
    const availableAt = Math.max(state.nextTranslationAt, state.translationPausedUntil);
    const wait = Math.max(0, availableAt - now);
    state.nextTranslationAt = Math.max(now, availableAt) + TRANSLATION_INTERVAL_MS;
    if (wait > 0) await sleep(wait);
  }

  function enqueue(task) {
    state.queue.push(task);
    drainQueue();
  }

  function drainQueue() {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const task = state.queue.shift();
      state.active += 1;
      Promise.resolve()
        .then(task)
        .finally(() => {
          state.active -= 1;
          drainQueue();
        });
    }
  }

  async function translateWithGoogle(text, targetLang, forceChinese, manual) {
    const response = await sendRuntimeMessage({
      type: "dt-translate",
      text,
      targetLang,
      forceChinese: Boolean(forceChinese),
      manual: Boolean(manual),
      microsoftKey: state.settings.microsoftKey || "",
      microsoftRegion: state.settings.microsoftRegion || "",
      deeplKey: state.settings.deeplKey || "",
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "background translation failed");
    }

    return response.translated;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!hasExtensionContext()) {
        reject(new Error("Extension was reloaded. Refresh Discord and try again."));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(new Error("Extension was reloaded. Refresh Discord and try again."));
      }
    });
  }

  function prepareMessage(messageNode, contentNode) {
    if (!isEnabled()) return false;
    if (!messageNode || !contentNode) return false;
    const text = getFullMessageText(messageNode, contentNode);
    if (isProbablySkippable(text)) return false;
    ensureToolbar(messageNode, contentNode);
    return true;
  }

  function translateVisibleMessages(options) {
    if (!isEnabled()) return 0;
    let translated = 0;
    document.querySelectorAll(`[data-dt-ready="1"]`).forEach((messageNode) => {
      const contentNode = findMessageContent(messageNode);
      if (!contentNode) return;
      translated += 1;
      translateMessage(messageNode, contentNode, { force: Boolean(options && options.force) });
    });
    return translated;
  }

  function findComposer() {
    const candidates = Array.from(document.querySelectorAll(
      '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-slate-editor="true"]'
    ));

    return candidates.reverse().find((node) => {
      const text = (node.getAttribute("aria-label") || "") + " " + (node.getAttribute("data-slate-editor") || "");
      const rect = node.getBoundingClientRect();
      return rect.width > 120 && rect.height > 10 && !/search/i.test(text);
    }) || null;
  }

  function getComposerText(composer) {
    return normalizeText(composer.innerText || composer.textContent || "");
  }

  async function setComposerText(composer, text) {
    const mainWorldResult = await replaceComposerInMainWorld(text);
    if (mainWorldResult && mainWorldResult.handled &&
        normalizeText(mainWorldResult.text) === normalizeText(text)) {
      return true;
    }
    if (mainWorldResult) return false;

    composer.focus();
    selectComposerContents(composer);
    document.execCommand("insertText", false, text);
    await sleep(100);

    let current = getComposerText(composer);
    if (current === normalizeText(text)) {
      return true;
    }

    // Discord's Slate editor may reject insertText in some composer modes.
    // Its paste handler is the closest state-aware fallback available here.
    selectComposerContents(composer);
    dispatchTextPaste(composer, text);
    await sleep(100);

    current = getComposerText(composer);
    return current === normalizeText(text);
  }

  function replaceComposerInMainWorld(text) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const resultEvent = "dt:replace-composer-result";
      const timeout = window.setTimeout(() => {
        document.removeEventListener(resultEvent, onResult);
        resolve(null);
      }, 800);

      function onResult(event) {
        if (!event.detail || event.detail.requestId !== requestId) return;
        window.clearTimeout(timeout);
        document.removeEventListener(resultEvent, onResult);
        resolve(event.detail);
      }

      document.addEventListener(resultEvent, onResult);
      document.dispatchEvent(new CustomEvent("dt:replace-composer", {
        detail: { requestId, text },
      }));
    });
  }

  function dispatchTextPaste(composer, text) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    composer.dispatchEvent(pasteEvent);
  }

  function selectComposerContents(composer) {
    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function translateComposer() {
    if (!isEnabled()) return;
    const composer = findComposer();
    if (!composer) {
      notify("Discord input box was not found.");
      return;
    }

    const text = getComposerText(composer);
    if (!text) {
      notify("Type Chinese first, then click CN->EN.");
      return;
    }

    try {
      setComposerButtonLoading(true);
      const translated = await translateWithGoogle(text, state.settings.composeTargetLang || "en");
      const replaced = await setComposerText(composer, translated);
      if (!replaced) {
        await copyText(translated);
        notify("Translated text copied. Discord did not replace the input cleanly.");
        return;
      }
      notify("Input translated to English.");
    } catch (error) {
      notify(`Input translation failed: ${error.message || error}`);
    } finally {
      setComposerButtonLoading(false);
    }
  }

  function ensureComposerTool() {
    if (!isEnabled()) return;
    if (document.querySelector(`.${APP}-compose-tool`)) return;

    const composer = findComposer();
    if (!composer) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `${APP}-compose-tool`;
    button.textContent = "CN->EN";
    button.title = "Translate your input to English";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      translateComposer();
    });

    const wrapper = composer.closest('[class*="channelTextArea"], form') || composer.parentElement;
    if (wrapper) {
      wrapper.classList.add(`${APP}-compose-wrapper`);
      wrapper.appendChild(button);
    }
  }

  function setComposerButtonLoading(isLoading) {
    const button = document.querySelector(`.${APP}-compose-tool`);
    if (!button) return;
    button.disabled = isLoading;
    button.textContent = isLoading ? "..." : "CN->EN";
  }

  function resetToolbars() {
    document.querySelectorAll(`.${APP}-toolbar`).forEach((node) => node.remove());
    document.querySelectorAll(`[data-dt-ready="1"]`).forEach((node) => {
      delete node.dataset.dtReady;
    });
  }

  function cleanupPluginUi() {
    resetToolbars();
    document.querySelectorAll(`.${APP}-result-row, .${APP}-compose-tool, .${APP}-toast`).forEach((node) => node.remove());
    document.querySelectorAll(`.${APP}-message`).forEach((node) => {
      node.classList.remove(`${APP}-message`);
      delete node.dataset.dtStatus;
    });
    if (state.debugPanel) {
      state.debugPanel.remove();
      state.debugPanel = null;
    }
  }

  function scan(root) {
    if (!isEnabled()) return 0;
    const scope = root && root.querySelectorAll ? root : document;
    let prepared = 0;
    const seen = new Set();

    const contentNodes = scope.matches && scope.matches(CONTENT_SELECTOR)
      ? [scope]
      : Array.from(scope.querySelectorAll(CONTENT_SELECTOR));

    contentNodes.forEach((contentNode) => {
      const messageNode = findMessageNode(contentNode);
      if (!messageNode || seen.has(messageNode)) return;
      seen.add(messageNode);
      const primaryContentNode = findMessageContent(messageNode) || contentNode;
      if (prepareMessage(messageNode, primaryContentNode)) prepared += 1;
    });

    const messages = scope.matches && scope.matches(MESSAGE_SELECTOR)
      ? [scope]
      : Array.from(scope.querySelectorAll(MESSAGE_SELECTOR));

    messages.forEach((messageNode) => {
      if (seen.has(messageNode)) return;
      seen.add(messageNode);
      const contentNode = findMessageContent(messageNode);
      if (prepareMessage(messageNode, contentNode)) prepared += 1;
    });

    return prepared;
  }

  function startObserver() {
    if (!isEnabled()) {
      cleanupPluginUi();
      return;
    }
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scan(node);
          if (node.nodeType === Node.ELEMENT_NODE) ensureComposerTool();
        }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    const count = scan(document);
    ensureComposerTool();
    updateDebugPanel(count);
    if (!document.documentElement.dataset.dtLoadedNotice) {
      document.documentElement.dataset.dtLoadedNotice = "1";
      notify(`Discord Translator loaded. Found ${count} visible messages.`);
    }
  }

  function notify(message) {
    const toast = document.createElement("div");
    toast.className = `${APP}-toast`;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2600);
  }

  function ensureDebugPanel() {
    if (!isEnabled()) return null;
    if (state.debugPanel && document.body.contains(state.debugPanel)) return state.debugPanel;

    const panel = document.createElement("div");
    panel.className = `${APP}-debug`;

    const title = document.createElement("div");
    title.className = `${APP}-debug-title`;
    title.textContent = "DT";

    const status = document.createElement("div");
    status.className = `${APP}-debug-status`;
    status.textContent = "loaded";

    const rescan = document.createElement("button");
    rescan.type = "button";
    rescan.className = `${APP}-debug-button`;
    rescan.textContent = "Scan";
    rescan.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetToolbars();
      const count = scan(document);
      updateDebugPanel(count);
      const queued = translateVisibleMessages({ force: true });
      updateDebugPanel(count, queued);
      notify(`Rescanned. Found ${count} visible messages.`);
    });

    panel.append(title, status, rescan);
    document.body.appendChild(panel);
    state.debugPanel = panel;
    return panel;
  }

  function updateDebugPanel(count, queued) {
    state.lastScanCount = count;
    const panel = ensureDebugPanel();
    if (!panel) return;
    const status = panel.querySelector(`.${APP}-debug-status`);
    if (status) {
      status.textContent = queued == null ? `${count} messages` : `${count} messages, ${queued} queued`;
    }
  }

  function addStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .${APP}-message {
        position: relative;
      }

      .${APP}-toolbar {
        position: absolute;
        top: 6px;
        right: 12px;
        display: inline-flex;
        align-items: center;
        margin: 0;
        opacity: 0;
        transform: translateY(-2px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: auto;
      }

      .${APP}-message:hover .${APP}-toolbar,
      .${APP}-message:focus-within .${APP}-toolbar {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .${APP}-button {
        min-width: 20px;
        height: 20px;
        border: 0;
        border-radius: 3px;
        color: #b5bac1;
        background: #313338;
        font-size: 12px;
        font-weight: 700;
        line-height: 20px;
        cursor: pointer;
        padding: 0 6px;
      }

      .${APP}-button:hover {
        color: #ffffff;
        background: #4e5058;
      }

      [data-dt-status="loading"] .${APP}-button {
        opacity: 0.65;
        cursor: wait;
      }

      .${APP}-result-row {
        display: block;
        box-sizing: border-box;
        width: auto;
        max-width: 900px;
        margin-top: 6px;
        margin-right: 16px;
        margin-left: 60px;
        padding-right: 0;
        clear: both;
      }

      .${APP}-result {
        position: relative;
        display: block;
        box-sizing: border-box;
        width: 100%;
        max-width: 760px;
        padding: 8px 36px 8px 11px;
        border-left: 3px solid #5865f2;
        border-radius: 4px;
        color: #e3e5e8;
        background: rgba(88, 101, 242, 0.1);
        font-size: 0.94em;
        line-height: 1.45;
        white-space: pre-wrap;
      }

      .${APP}-result-header {
        display: none;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 4px;
        color: #949ba4;
        font-size: 12px;
        line-height: 1.2;
        white-space: nowrap;
      }

      .${APP}-result-label {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .${APP}-result-controls {
        position: absolute;
        top: 5px;
        right: 6px;
        display: inline-flex;
        gap: 4px;
        flex: none;
        opacity: 0;
        transition: opacity 120ms ease;
      }

      .${APP}-result:hover .${APP}-result-controls,
      .${APP}-result:focus-within .${APP}-result-controls {
        opacity: 1;
      }

      .${APP}-mini-button {
        height: 18px;
        border: 0;
        border-radius: 3px;
        padding: 0 5px;
        color: #b5bac1;
        background: rgba(30, 31, 34, 0.72);
        font: 10px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }

      .${APP}-mini-button:hover {
        color: #ffffff;
        background: #3f4147;
      }

      .${APP}-result-body {
        display: block;
        min-height: 1.45em;
        overflow-wrap: anywhere;
      }

      html[data-dt-compact="1"] .${APP}-result {
        padding-top: 6px;
        padding-bottom: 6px;
        font-size: 0.92em;
      }

      .${APP}-error {
        color: #f38ba8;
        border-left-color: #f38ba8;
      }

      .${APP}-toast {
        position: fixed;
        right: 20px;
        bottom: 28px;
        z-index: 2147483647;
        max-width: min(420px, calc(100vw - 40px));
        padding: 10px 12px;
        border-radius: 6px;
        color: #f2f3f5;
        background: #1e1f22;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .${APP}-debug {
        position: fixed;
        right: 18px;
        bottom: 84px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 8px;
        border: 1px solid #3f4147;
        border-radius: 6px;
        color: #dbdee1;
        background: #1e1f22;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26);
        font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .${APP}-debug-title {
        min-width: 22px;
        color: #ffffff;
        font-weight: 800;
      }

      .${APP}-debug-status {
        color: #b5bac1;
        white-space: nowrap;
      }

      .${APP}-debug-button {
        height: 22px;
        border: 0;
        border-radius: 4px;
        padding: 0 8px;
        color: #ffffff;
        background: #5865f2;
        font: 12px/22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }

      .${APP}-debug-button:hover {
        background: #4752c4;
      }

      .${APP}-compose-tool {
        position: absolute;
        right: 260px;
        bottom: 10px;
        z-index: 4;
        height: 26px;
        min-width: 58px;
        border: 0;
        border-radius: 4px;
        padding: 0 8px;
        color: #ffffff;
        background: #5865f2;
        font: 12px/26px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
      }

      .${APP}-compose-tool:hover {
        background: #4752c4;
      }

      .${APP}-compose-tool:disabled {
        opacity: 0.65;
        cursor: wait;
      }

      .${APP}-compose-wrapper {
        position: relative;
      }
    `;
    document.documentElement.dataset.dtCompact = state.settings.compactMode ? "1" : "0";
    document.documentElement.appendChild(style);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    state.settings = Object.assign({}, DEFAULTS, changes.settings.newValue || {});
    document.documentElement.dataset.dtCompact = state.settings.compactMode ? "1" : "0";
    if (!isEnabled()) {
      if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
      cleanupPluginUi();
      return;
    }
    if (!state.observer) startObserver();
    scan(document);
    ensureComposerTool();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "dt-rescan") return false;
    if (!isEnabled()) {
      cleanupPluginUi();
      sendResponse({ ok: true, count: 0, queued: 0, disabled: true });
      return true;
    }
    resetToolbars();
    const count = scan(document);
    const queued = translateVisibleMessages({ force: true });
    updateDebugPanel(count, queued);
    notify(`Rescanned. Found ${count} visible messages.`);
    sendResponse({ ok: true, count, queued });
    return true;
  });

  window.DiscordTranslator = {
    get settings() {
      return Object.assign({}, state.settings);
    },
    async setAutoTranslate(value) {
      state.settings.autoTranslate = Boolean(value);
      await saveSettings();
      scan(document);
    },
    scan: () => scan(document),
  };

  addStyle();

  if (document.body) {
    startObserver();
  } else {
    window.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }
})();
