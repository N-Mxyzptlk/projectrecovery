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

/** Wires a search input's clear ("x") button — shown only once there's
 *  text, clicking it clears the value, refocuses the input, and calls
 *  onClear so the caller can re-run its own filtering. Reusable by any
 *  search field in the app. */
function attachSearchClear(inputEl, clearBtnEl, onClear) {
  inputEl.addEventListener("input", () => {
    clearBtnEl.classList.toggle("hidden", inputEl.value.length === 0);
  });
  clearBtnEl.addEventListener("click", () => {
    inputEl.value = "";
    clearBtnEl.classList.add("hidden");
    inputEl.focus();
    onClear();
  });
}

/** Escape blurs whatever text input/textarea currently has focus, site-wide
 *  — a plain "get me out of this field" affordance. Doesn't fire inside the
 *  confirm/alert/prompt modals above (their own capture-phase Escape
 *  handler already runs first and removes the field from the DOM). */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.blur();
});

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

/* ============================================
   5-star rating widget — shared by Guitar and Movies. A plain renderer for
   read-only display, plus an interactive editor (hover previews up to the
   hovered star, click selects) for Add/Edit forms. Both share the same
   `.star-rating-star`/`.lit` classes so they render identically.
   ============================================ */
function starRatingDisplayHtml(rating) {
  const r = rating || 0;
  return `<span class="star-rating star-rating-display">${[1, 2, 3, 4, 5]
    .map((n) => `<span class="star-rating-star ${n <= r ? "lit" : ""}">&#9733;</span>`)
    .join("")}</span>`;
}

function renderStarRatingEditorHtml(idPrefix, rating) {
  return `
    <div class="star-rating star-rating-editor" id="${idPrefix}-rating-editor" data-rating="${rating || 0}">
      ${[1, 2, 3, 4, 5].map((n) => `<span class="star-rating-star" data-value="${n}">&#9733;</span>`).join("")}
    </div>`;
}

function wireStarRatingEditor(idPrefix) {
  const container = document.getElementById(`${idPrefix}-rating-editor`);
  const stars = [...container.querySelectorAll(".star-rating-star")];

  function paint(value) {
    stars.forEach((s) => s.classList.toggle("lit", parseInt(s.dataset.value, 10) <= value));
  }

  paint(parseInt(container.dataset.rating, 10) || 0);

  stars.forEach((star) => {
    star.addEventListener("mouseenter", () => paint(parseInt(star.dataset.value, 10)));
    star.addEventListener("click", () => {
      container.dataset.rating = star.dataset.value;
      paint(parseInt(star.dataset.value, 10));
    });
  });

  container.addEventListener("mouseleave", () => paint(parseInt(container.dataset.rating, 10) || 0));
}

function getStarRatingValue(idPrefix) {
  const container = document.getElementById(`${idPrefix}-rating-editor`);
  return parseInt(container.dataset.rating, 10) || 0;
}
