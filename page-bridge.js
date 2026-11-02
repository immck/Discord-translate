(() => {
  "use strict";

  const REQUEST_EVENT = "dt:replace-composer";
  const RESULT_EVENT = "dt:replace-composer-result";

  function findComposer() {
    const candidates = Array.from(document.querySelectorAll(
      '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-slate-editor="true"]'
    ));

    return candidates.reverse().find((node) => {
      const label = node.getAttribute("aria-label") || "";
      const rect = node.getBoundingClientRect();
      return rect.width > 120 && rect.height > 10 && !/search/i.test(label);
    }) || null;
  }

  function getReactFiber(node) {
    const key = Object.getOwnPropertyNames(node).find((name) =>
      name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$")
    );
    return key ? node[key] : null;
  }

  function isSlateEditor(value) {
    return value && typeof value === "object" && Array.isArray(value.children) &&
      typeof value.apply === "function" &&
      typeof value.deleteFragment === "function" &&
      typeof value.insertText === "function";
  }

  function findSlateEditor(composer) {
    let fiber = getReactFiber(composer);
    while (fiber) {
      const candidates = [
        fiber.memoizedProps && fiber.memoizedProps.value,
        fiber.pendingProps && fiber.pendingProps.value,
      ];
      const editor = candidates.find(isSlateEditor);
      if (editor) return editor;

      let dependency = fiber.dependencies && fiber.dependencies.firstContext;
      while (dependency) {
        if (isSlateEditor(dependency.memoizedValue)) return dependency.memoizedValue;
        dependency = dependency.next;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function getEditorTextPoints(editor) {
    const points = [];

    function visit(nodes, parentPath) {
      nodes.forEach((node, index) => {
        const path = parentPath.concat(index);
        if (node && typeof node.text === "string") {
          points.push({ path, length: node.text.length });
        } else if (node && Array.isArray(node.children)) {
          visit(node.children, path);
        }
      });
    }

    visit(editor.children, []);
    if (points.length === 0) return null;
    return {
      anchor: { path: points[0].path, offset: 0 },
      focus: {
        path: points[points.length - 1].path,
        offset: points[points.length - 1].length,
      },
    };
  }

  function replaceWithSlateEditor(editor, text) {
    const range = getEditorTextPoints(editor);
    if (!range) return false;
    const previous = editor.selection;
    editor.apply({
      type: "set_selection",
      properties: previous ? {
        anchor: previous.anchor,
        focus: previous.focus,
      } : null,
      newProperties: range,
    });
    editor.deleteFragment();
    editor.insertText(text);
    return true;
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const detail = event.detail || {};
    const requestId = detail.requestId;
    const text = typeof detail.text === "string" ? detail.text : "";
    const composer = findComposer();
    let handled = false;

    if (requestId && composer && text) {
      const editor = findSlateEditor(composer);
      if (editor) {
        handled = replaceWithSlateEditor(editor, text);
      }
    }

    window.setTimeout(() => {
      document.dispatchEvent(new CustomEvent(RESULT_EVENT, {
        detail: {
          requestId,
          handled,
          text: composer ? (composer.innerText || composer.textContent || "") : "",
        },
      }));
    }, 120);
  });
})();
