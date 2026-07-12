// uimodal.js
// Replaces native window.confirm/alert with a themed modal — the native
// browser dialogs can't be restyled and read as jarring next to everything
// else in the app. Loaded early (right after dbclient.js) so every other
// app file can call uiConfirm/uiAlert unconditionally.
//
// Both stack on document.body directly (not #modal-root), so they still
// work correctly when triggered from inside an already-open form modal
// (e.g. the Delete button inside the Edit Payment modal).
//
// Enter always confirms/dismisses (the default action), Escape always
// cancels — matches the "Enter is default yes" convention used throughout.

function _uiDialog(message, { okText, cancelText, danger } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const okClass = danger ? "btn-danger" : "btn-accent";
    overlay.innerHTML = `
      <div class="confirm-modal">
        <p class="confirm-message"></p>
        <div class="confirm-actions">
          ${cancelText !== null ? `<button type="button" class="btn-ghost confirm-cancel-btn">${cancelText || "Cancel"}</button>` : ""}
          <button type="button" class="${okClass} confirm-ok-btn">${okText || "OK"}</button>
        </div>
      </div>`;
    overlay.querySelector(".confirm-message").textContent = message;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector(".confirm-ok-btn");
    const cancelBtn = overlay.querySelector(".confirm-cancel-btn");
    okBtn.focus();

    function finish(result) {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    }

    document.addEventListener("keydown", onKeydown, true);
    okBtn.addEventListener("click", () => finish(true));
    if (cancelBtn) cancelBtn.addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
  });
}

/** Drop-in async replacement for window.confirm — resolves true/false. */
function uiConfirm(message, opts) {
  return _uiDialog(message, opts);
}

/** Drop-in async replacement for window.alert — resolves once dismissed. */
function uiAlert(message, opts) {
  return _uiDialog(message, { okText: "OK", ...opts, cancelText: null });
}

/** Drop-in async replacement for window.prompt — resolves to the typed
 *  string, or null if cancelled (same contract as window.prompt). */
function uiPrompt(message, { okText, cancelText, placeholder } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-modal">
        <p class="confirm-message"></p>
        <input type="text" class="confirm-prompt-input" placeholder="${placeholder || ""}" autocomplete="off" />
        <div class="confirm-actions">
          <button type="button" class="btn-ghost confirm-cancel-btn">${cancelText || "Cancel"}</button>
          <button type="button" class="btn-accent confirm-ok-btn">${okText || "OK"}</button>
        </div>
      </div>`;
    overlay.querySelector(".confirm-message").textContent = message;
    document.body.appendChild(overlay);

    const input = overlay.querySelector(".confirm-prompt-input");
    const okBtn = overlay.querySelector(".confirm-ok-btn");
    const cancelBtn = overlay.querySelector(".confirm-cancel-btn");
    input.focus();

    function finish(result) {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    }

    document.addEventListener("keydown", onKeydown, true);
    okBtn.addEventListener("click", () => finish(input.value));
    cancelBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
  });
}
