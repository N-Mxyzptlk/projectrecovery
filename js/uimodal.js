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

/** Generic vertical drag-to-reorder for one row within containerEl. Wires
 *  a single row; call once per row (including ones added later), not
 *  re-run over the whole list, so listeners never stack. Shared by the
 *  Movies platform-order picker, the Guitar/Movies catalogue lists, and
 *  the Settings app-module editor. `onDrop(row)` fires once, after a real
 *  drag (not a plain tap) ends, so callers can persist the new order.
 *
 *  Move/up/cancel are tracked on `document`, not the handle itself — the
 *  row gets physically reordered in the DOM as you drag past a neighbor,
 *  and moving an element mid-drag can silently release its pointer
 *  capture, which made the handle stop receiving its own pointerup
 *  (drag would get "stuck"). Listening on document is immune to that.
 *
 *  The dragged row never moves in the DOM until drop — it just follows
 *  the finger via `transform: translateY()` (rAF-batched) plus a slight
 *  scale/shadow "pop out". Displaced siblings animate out of the way via
 *  the same transform, computed once per frame from a position snapshot
 *  taken at drag start (a FLIP animation), so nothing teleports. */
function wireDragHandle(containerEl, row, { handleSelector = ".drag-handle", onDrop } = {}) {
  const handle = row.querySelector(handleSelector);
  if (!handle) return;

  let dragging = false;
  let moved = false;
  let startY = 0;
  let rowHeight = 0;
  let originalIndex = -1;
  let allRows = [];
  let currentShift = 0;
  let rafId = null;
  let pendingDy = 0;

  function applyShift(shift) {
    if (shift === currentShift) return;
    currentShift = shift;
    allRows.forEach((sib, i) => {
      if (sib === row) return;
      let sibShift = 0;
      if (shift > 0 && i > originalIndex && i <= originalIndex + shift) sibShift = -1;
      else if (shift < 0 && i < originalIndex && i >= originalIndex + shift) sibShift = 1;
      sib.style.transition = "transform 0.15s ease";
      sib.style.transform = sibShift ? `translateY(${sibShift * rowHeight}px)` : "";
    });
  }

  function applyDrag(dy) {
    row.style.transform = `translateY(${dy}px) scale(1.03)`;
    const maxShift = allRows.length - 1 - originalIndex;
    const minShift = -originalIndex;
    applyShift(Math.max(minShift, Math.min(maxShift, Math.round(dy / rowHeight))));
  }

  function onPointerMove(e) {
    if (!dragging) return;
    pendingDy = e.clientY - startY;
    if (Math.abs(pendingDy) > 3) moved = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      applyDrag(pendingDy);
    });
  }

  function onPointerEnd() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerEnd);
    document.removeEventListener("pointercancel", onPointerEnd);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    const targetIndex = Math.max(0, Math.min(allRows.length - 1, originalIndex + currentShift));

    // Finish sliding the dragged row the rest of the way into its target
    // slot — siblings are already sitting at their shifted position from
    // the drag itself — then, once that settle animation completes,
    // reorder the DOM to match and clear every inline style in one
    // synchronous step. Since the DOM's new natural layout exactly
    // matches what's already rendered, nothing visibly jumps.
    row.style.transition = "transform 0.15s ease";
    row.style.transform = `translateY(${currentShift * rowHeight}px) scale(1.03)`;

    setTimeout(() => {
      allRows.forEach((r) => {
        r.style.transition = "";
        r.style.transform = "";
      });
      row.classList.remove("dragging");
      if (targetIndex !== originalIndex) {
        const ref = targetIndex < originalIndex ? allRows[targetIndex] : allRows[targetIndex].nextSibling;
        containerEl.insertBefore(row, ref);
      }
      if (moved && onDrop) onDrop(row);
    }, 160);
  }

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = false;
    startY = e.clientY;
    rowHeight = row.getBoundingClientRect().height || 1;
    allRows = [...containerEl.children];
    originalIndex = allRows.indexOf(row);
    currentShift = 0;
    row.style.transition = "none";
    row.classList.add("dragging");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
  });
}

/** Show/hide + reorder editor for the app-modules list — reads/writes
 *  profiles.nav_apps via resolvedNavApps()/saveNavAppsPref() (dbclient.js),
 *  the same preference the desktop sidebar and mobile drawer read at boot.
 *  Shared by desktop's Settings page and mobile's Settings sheet, each
 *  rendering into their own container id and passing their own `onSaved`
 *  callback to refresh whatever nav UI they own (sidebar, drawer, Home
 *  shortcuts) immediately after a change — no reload needed on the same
 *  device, though a *different* device's already-open session won't see
 *  it until it re-reads the preference (that's what the drawer's refresh
 *  button, mobile.js, is for). */
function renderNavModuleEditor(containerId, onSaved) {
  const box = document.getElementById(containerId);
  if (!box) return;

  // Start from the current preference (visible entries in their saved
  // order) if there is one, else every module visible in its built-in
  // order; append any module missing from a saved preference (e.g. a newly
  // added app) as visible, so it isn't silently dropped from the editor.
  const base = navAppsPref && navAppsPref.length > 0
    ? navAppsPref.filter((p) => APP_MODULES.some((m) => m.app === p.app))
    : APP_MODULES.map((m) => ({ app: m.app, visible: true }));
  APP_MODULES.forEach((m) => {
    if (!base.some((p) => p.app === m.app)) base.push({ app: m.app, visible: true });
  });

  box.innerHTML = base
    .map(({ app, visible }) => {
      const label = APP_MODULES.find((m) => m.app === app)?.label || app;
      return `
      <div class="nav-module-row" data-app="${app}">
        <span class="drag-handle" title="Drag to reorder">&#9776;</span>
        <span class="nav-module-label">${label}</span>
        <label class="nav-module-toggle">
          <input type="checkbox" ${visible ? "checked" : ""} />
          <span class="nav-module-toggle-track"></span>
        </label>
      </div>`;
    })
    .join("");

  async function persist() {
    const pref = [...box.querySelectorAll(".nav-module-row")].map((row) => ({
      app: row.dataset.app,
      visible: row.querySelector('input[type="checkbox"]').checked,
    }));
    await saveNavAppsPref(pref); // defined in dbclient.js
    if (onSaved) onSaved();
  }

  box.querySelectorAll(".nav-module-row").forEach((row) => {
    wireDragHandle(box, row, { onDrop: persist });
    row.querySelector('input[type="checkbox"]').addEventListener("change", async (e) => {
      const anyChecked = [...box.querySelectorAll('input[type="checkbox"]')].some((c) => c.checked);
      if (!anyChecked) {
        e.target.checked = true; // don't allow hiding the last visible module
        await uiAlert("At least one app module must stay visible.");
        return;
      }
      persist();
    });
  });
}

/* ============================================
   Mobile press-state false positives — on touch devices, CSS :active
   matches from the moment of touchstart, the exact same event that begins
   a scroll, and mobile browsers don't reliably clear it once a touch
   turns out to be a scroll rather than a tap. That's what makes buttons
   visually "light up" as a finger just passes over them while scrolling.
   Every :active rule's own look stays untouched — this only changes when
   it's allowed to show. Tracks movement since touchstart and, the moment
   it crosses a small threshold, forces the browser to drop :active
   matching for that element by yanking pointer-events for one frame
   (a documented workaround: toggling pointer-events forces a hit-test
   recompute, which is what actually un-matches :active — there's no
   direct DOM API to just tell the browser "stop matching :active here").
   ============================================ */
(function () {
  const PRESSABLE_SELECTOR =
    "button, [class*='btn'], [class*='chip'], [class*='tab'], [class*='item'], [class*='row'], [class*='fab'], [class*='handle'], [class*='tile'], [class*='action'], [class*='nub']";
  const MOVE_THRESHOLD = 10;

  let startX = 0;
  let startY = 0;
  let pressedEl = null;

  function cancelPressedState() {
    if (!pressedEl) return;
    const el = pressedEl;
    pressedEl = null;
    el.style.pointerEvents = "none";
    requestAnimationFrame(() => {
      el.style.pointerEvents = "";
    });
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      pressedEl = e.target.closest(PRESSABLE_SELECTOR);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!pressedEl) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      // Only a vertical scroll should clear the pressed state — a
      // horizontal-dominant move is a swipe gesture (drawer, calendar,
      // card actions), and forcing pointer-events:none mid-swipe can make
      // the browser synthesize a pointercancel that aborts whatever drag
      // recognizer is tracking that same touch (e.g. the edge-swipe
      // drawer, if the touch started on a pressable row like a Home
      // payment/todo item).
      if (dy > MOVE_THRESHOLD && dy > dx) {
        cancelPressedState();
      }
    },
    { passive: true }
  );

  document.addEventListener("touchend", () => {
    pressedEl = null;
  });
  document.addEventListener("touchcancel", cancelPressedState);
})();

/** Turns on the back-and-forth marquee scroll (see .m-guitar-title-line in
 *  mobile.css) for any matching line whose text is actually too wide for
 *  its box — a row's real width isn't known until it's laid out, so this
 *  runs after the rows are already in the DOM, not at template-string
 *  time. Safe to call repeatedly (e.g. after every re-render). */
function activateMarqueeOverflow(containerEl, lineSelector) {
  containerEl.querySelectorAll(lineSelector).forEach((line) => {
    const inner = line.querySelector(".marquee-text");
    if (!inner) return;
    const overflow = inner.scrollWidth - line.clientWidth;
    if (overflow > 2) {
      line.classList.add("marquee-active");
      line.style.setProperty("--marquee-distance", `${-(overflow + 12)}px`);
    } else {
      line.classList.remove("marquee-active");
      line.style.removeProperty("--marquee-distance");
    }
  });
}

/* ============================================
   Bottom sheets — swipe down on the handle to dismiss, in addition to
   tapping the backdrop. Delegated globally on document (not wired per
   sheet) since .m-sheet-overlay is created dynamically all over the app
   (Add Song, Add Movie, Settings, Journal edit, ...) — this way every one
   of them gets it for free, including ones added later, with no per-sheet
   wiring needed.
   ============================================ */
(function () {
  const CLOSE_RATIO = 0.25; // drag down past 25% of the sheet's own height to dismiss
  const DRAG_START_THRESHOLD = 6;

  let sheetEl = null;
  let overlayEl = null;
  let startY = 0;
  let dragging = false;
  let committed = false;
  let sheetHeight = 0;

  document.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".m-sheet-handle");
    if (!handle) return;
    sheetEl = handle.closest(".m-sheet");
    overlayEl = handle.closest(".m-sheet-overlay");
    if (!sheetEl || !overlayEl) return;
    dragging = true;
    committed = false;
    startY = e.clientY;
    sheetHeight = sheetEl.getBoundingClientRect().height || 1;
  });

  document.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (!committed) {
      if (dy < DRAG_START_THRESHOLD) return; // only a real downward drag commits — an upward wiggle stays a no-op
      committed = true;
      sheetEl.style.transition = "none";
    }
    sheetEl.style.transform = `translateY(${Math.max(0, dy)}px)`;
  });

  const onRelease = (e) => {
    if (!dragging) return;
    dragging = false;
    if (!committed) return;

    const dy = Math.max(0, e.clientY - startY);
    const closingSheet = sheetEl;
    const closingOverlay = overlayEl;
    closingSheet.style.transition = "transform 0.2s ease";

    if (dy > sheetHeight * CLOSE_RATIO) {
      closingSheet.style.transform = "translateY(100%)";
      setTimeout(() => closingOverlay.remove(), 200);
    } else {
      closingSheet.style.transform = "translateY(0)";
    }
  };

  document.addEventListener("pointerup", onRelease);
  document.addEventListener("pointercancel", onRelease);
})();
