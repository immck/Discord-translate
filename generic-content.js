(() => {
  "use strict";

  let contextText = "";
  let contextPoint = { x: 24, y: 24 };

  document.addEventListener("contextmenu", (event) => {
    contextPoint = { x: event.clientX, y: event.clientY };
    const selected = String(window.getSelection() || "").trim();
    contextText = selected || findNearbyText(event);
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "dt-get-context-text") {
      sendResponse({ text: contextText.slice(0, 5000) });
      return false;
    }
    if (message.type === "dt-show-page-translation") {
      showTranslation(message);
      return false;
    }
    return false;
  });

  function findNearbyText(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const preferred = path.find((node) => node instanceof Element && node.matches(
      '[data-testid="tweetText"], [data-testid="post-container"], shreddit-post, article, blockquote, p, li'
    ));
    if (preferred) return cleanText(preferred.innerText || preferred.textContent || "");

    const element = event.target instanceof Element ? event.target : event.target.parentElement;
    let current = element;
    while (current && current !== document.body) {
      const text = cleanText(current.innerText || current.textContent || "");
      if (text.length >= 2 && text.length <= 2000) return text;
      current = current.parentElement;
    }
    return "";
  }

  function cleanText(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 5000);
  }

  function showTranslation(message) {
    document.getElementById("dt-page-translation-host")?.remove();

    const host = document.createElement("div");
    host.id = "dt-page-translation-host";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.right = "18px";
    host.style.bottom = "18px";
    host.style.width = "min(420px, calc(100vw - 36px))";
    const root = host.attachShadow({ mode: "closed" });

    const panel = document.createElement("div");
    panel.className = "panel";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = message.error ? "翻译失败" : "翻译为中文";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.title = "关闭";
    close.textContent = "×";
    close.addEventListener("click", () => host.remove());
    title.appendChild(close);

    const body = document.createElement("div");
    body.className = message.error ? "body error" : "body";
    body.textContent = message.error || message.translated || "没有可翻译的文字";
    panel.append(title, body);

    const style = document.createElement("style");
    style.textContent = `
      .panel { overflow: hidden; border: 1px solid #3f4147; border-radius: 6px; color: #f2f3f5; background: #1e1f22; box-shadow: 0 10px 30px rgba(0,0,0,.35); font: 14px/1.55 system-ui, sans-serif; }
      .title { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 0 10px 0 12px; color: #b5bac1; background: #2b2d31; font-size: 12px; font-weight: 700; }
      .close { width: 26px; height: 26px; border: 0; color: #b5bac1; background: transparent; font-size: 22px; line-height: 24px; cursor: pointer; }
      .close:hover { color: #fff; }
      .body { max-height: 240px; overflow: auto; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .error { color: #fa8da4; }
    `;
    root.append(style, panel);
    document.documentElement.appendChild(host);
  }
})();
