// movies.js
// Movies/TV watchlist — one flat catalogue (same shape as guitar.js), with
// a movie/TV type filter and a multi-select platform-tag picker instead of
// guitar's boolean flags, since a title can legitimately sit on more than
// one streaming service at once. Reuses supabaseClient, escapeHtml,
// openModal/closeModal, enhanceSelect, currentApp from desktop.js; and
// escapeHtmlMobile, beginMutation/endMutation, the .m-sheet pattern,
// mApp/renderFabStack from mobile.js. Loaded after guitar.js.

const MOVIE_PLATFORM_COLORS = {
  "Netflix": "#E50914",
  "Prime Video": "#00A8E1",
  "Disney+": "#113CCF",
  "HBO Max": "#9B2FAE",
  "Apple TV+": "#FFFFFF", // special-cased in moviePlatformBadgeStyle — plain black+white reads better than a translucent-black tint
};
const MOVIE_PLATFORM_PRESETS = Object.keys(MOVIE_PLATFORM_COLORS);

function moviePlatformBadgeStyle(name) {
  if (name === "Apple TV+") return "background:#000;color:#fff;border-color:#ffffff33;";
  const color = MOVIE_PLATFORM_COLORS[name] || "#6c63ff"; // custom/non-preset platforms fall back to the app accent color
  return `background:${color}22;color:${color};border-color:${color}55;`;
}

function moviePlatformBadgeHtml(name) {
  return `<span class="movie-platform-badge" style="${moviePlatformBadgeStyle(name)}">${escapeHtml(name)}</span>`;
}

function movieTypeBadgeHtml(mediaType) {
  return mediaType === "tv"
    ? `<span class="movie-type-badge type-tv">TV Show</span>`
    : `<span class="movie-type-badge type-movie">Movie</span>`;
}

/** Reorderable "selected platforms" list — one row per platform already on
 *  the title, each with a drag handle (reorder) and a remove button. Order
 *  in this list IS the stored order (read back via getPlatformOrderSelected
 *  at submit time), which is what lets the user put their most-used
 *  platform first. */
function renderPlatformOrderListHtml(platforms) {
  return (platforms || [])
    .map(
      (p) => `
    <div class="platform-order-row" data-platform="${escapeHtml(p)}">
      <span class="platform-order-handle" title="Drag to reorder">&#9776;</span>
      <span class="movie-platform-badge" style="${moviePlatformBadgeStyle(p)}">${escapeHtml(p)}</span>
      <button type="button" class="platform-order-remove" aria-label="Remove platform">&times;</button>
    </div>`
    )
    .join("");
}

/** The "add a platform" chip row — only presets not already selected, so
 *  clicking a chip always means "add", never "toggle off" (removal happens
 *  via the order-list's own remove button instead). */
function renderPlatformAddPickerHtml(selected) {
  const selectedSet = new Set(selected || []);
  const available = MOVIE_PLATFORM_PRESETS.filter((p) => !selectedSet.has(p));
  return available
    .map((p) => `<div class="movie-platform-chip" data-platform="${escapeHtml(p)}" style="${moviePlatformBadgeStyle(p)}">${escapeHtml(p)}</div>`)
    .join("");
}

/** Generic vertical drag-to-reorder for one row within containerEl — same
 *  live-drag-then-settle Pointer Events pattern used elsewhere in the app
 *  (attachGuitarSongSwipe, attachEdgeSwipeDrawer), just vertical instead of
 *  horizontal. Wires a single row; called once per row (including ones
 *  added later), not re-run over the whole list, so listeners never stack. */
function wireDragHandle(containerEl, row) {
  const handle = row.querySelector(".platform-order-handle");
  if (!handle) return;

  let dragging = false;
  let startY = 0;
  let rowHeight = 0;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    rowHeight = row.getBoundingClientRect().height || 1;
    row.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const offset = Math.round(dy / rowHeight);
    if (offset === 0) return;

    const rows = [...containerEl.children];
    const idx = rows.indexOf(row);
    const targetIdx = Math.max(0, Math.min(rows.length - 1, idx + offset));
    if (targetIdx === idx) return;

    const targetRow = rows[targetIdx];
    if (offset > 0) containerEl.insertBefore(row, targetRow.nextSibling);
    else containerEl.insertBefore(row, targetRow);
    startY = e.clientY;
  });

  const endDrag = () => {
    dragging = false;
    row.classList.remove("dragging");
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

/** Wires the whole platform editor (order list + add picker + custom
 *  input) for one Add/Edit form. `idPrefix` picks the desktop vs mobile
 *  element ids ("movie-platform" / "m-movie-platform"). */
function wireMoviePlatformEditor(idPrefix) {
  const orderListEl = document.getElementById(`${idPrefix}-order-list`);
  const addPickerEl = document.getElementById(`${idPrefix}-add-picker`);
  const customInputEl = document.getElementById(`${idPrefix}-custom`);

  function wireRemoveButtons() {
    orderListEl.querySelectorAll(".platform-order-remove").forEach((btn) => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        btn.closest(".platform-order-row").remove();
        refreshAddPicker();
      });
    });
  }

  function refreshAddPicker() {
    const selected = getPlatformOrderSelected(idPrefix);
    addPickerEl.innerHTML = renderPlatformAddPickerHtml(selected);
    wireAddChips();
  }

  function wireAddChips() {
    addPickerEl.querySelectorAll(".movie-platform-chip").forEach((chip) => {
      chip.addEventListener("click", () => addPlatform(chip.dataset.platform));
    });
  }

  function addPlatform(name) {
    const selected = getPlatformOrderSelected(idPrefix);
    if (selected.some((p) => p.toLowerCase() === name.toLowerCase())) return;

    const row = document.createElement("div");
    row.className = "platform-order-row";
    row.dataset.platform = name;
    row.innerHTML = `
      <span class="platform-order-handle" title="Drag to reorder">&#9776;</span>
      <span class="movie-platform-badge" style="${moviePlatformBadgeStyle(name)}">${escapeHtml(name)}</span>
      <button type="button" class="platform-order-remove" aria-label="Remove platform">&times;</button>
    `;
    orderListEl.appendChild(row);
    wireDragHandle(orderListEl, row);
    wireRemoveButtons();
    refreshAddPicker();
  }

  orderListEl.querySelectorAll(".platform-order-row").forEach((row) => wireDragHandle(orderListEl, row));
  wireRemoveButtons();
  wireAddChips();

  customInputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = customInputEl.value.trim();
    if (!name) return;
    customInputEl.value = "";
    addPlatform(name);
  });
}

function getPlatformOrderSelected(idPrefix) {
  return [...document.querySelectorAll(`#${idPrefix}-order-list .platform-order-row`)].map((r) => r.dataset.platform);
}

let moviesCache = [];
let movieFilter = "all"; // 'all' | 'movie' | 'tv' — shared filter state, desktop and mobile read/write the same one

async function loadMoviesCache() {
  const { data, error } = await supabaseClient.from("movies_watchlist").select("*").order("created_at", { ascending: false });
  if (!error) moviesCache = data || [];
  return moviesCache;
}

function filterMovies(items, filter) {
  if (filter === "movie" || filter === "tv") return items.filter((m) => m.media_type === filter);
  return items;
}

async function deleteMovie(id) {
  if (!(await uiConfirm("Remove this from your watchlist?"))) return;
  const { error } = await supabaseClient.from("movies_watchlist").delete().eq("id", id);
  if (error) return uiAlert("Failed to delete: " + error.message);
  await refreshMoviesAfterAction();
}

/** Re-renders whichever shell (desktop and/or mobile) is currently showing
 *  Movies, after an action changes the underlying data — same pattern as
 *  guitar.js's refreshGuitarAfterAction. */
async function refreshMoviesAfterAction() {
  await loadMoviesCache();
  if (typeof currentApp !== "undefined" && currentApp === "movies") {
    renderMoviesFilterTabs();
    renderMoviesList();
  }
  if (typeof mApp !== "undefined" && mApp === "movies") {
    renderMoviesMobileScreen();
  }
}

/* ============================================
   DESKTOP
   ============================================ */
async function loadMoviesDashboard() {
  await loadMoviesCache();
  renderMoviesFilterTabs();
  renderMoviesList();
}

function renderMoviesFilterTabs() {
  const box = document.getElementById("movies-filter-tabs");
  if (!box) return;
  const counts = {
    all: moviesCache.length,
    movie: filterMovies(moviesCache, "movie").length,
    tv: filterMovies(moviesCache, "tv").length,
  };
  box.innerHTML = `
    <div class="filter-tab ${movieFilter === "all" ? "active" : ""}" data-filter="all">All <span class="count">${counts.all}</span></div>
    <div class="filter-tab ${movieFilter === "movie" ? "active" : ""}" data-filter="movie">Movies <span class="count">${counts.movie}</span></div>
    <div class="filter-tab ${movieFilter === "tv" ? "active" : ""}" data-filter="tv">TV Shows <span class="count">${counts.tv}</span></div>
  `;
  box.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      movieFilter = tab.dataset.filter;
      renderMoviesFilterTabs();
      renderMoviesList();
    });
  });
}

function renderMoviesList() {
  const listEl = document.getElementById("movies-list");
  if (!listEl) return;
  const items = filterMovies(moviesCache, movieFilter);

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">${movieFilter === "all" ? "Watchlist is empty" : movieFilter === "movie" ? "No movies yet" : "No TV shows yet"}</div>
        <p>Add something you want to watch.</p>
        <button class="btn-accent" onclick="openMovieModal()">+ Add title</button>
      </div>`;
    return;
  }

  listEl.innerHTML = items.map((m) => renderMovieRow(m)).join("");
}

function renderMovieRow(movie) {
  return `
    <div class="card-row" data-movie-id="${movie.id}">
      <div>
        <div class="title movie-title-row">
          <span>${escapeHtml(movie.title)}</span>
          ${movieTypeBadgeHtml(movie.media_type)}
          ${(movie.platforms || []).map((p) => moviePlatformBadgeHtml(p)).join("")}
        </div>
        ${movie.rating ? `<div class="meta">${starRatingDisplayHtml(movie.rating)}</div>` : ""}
      </div>
      <div class="row-actions">
        <button class="icon-btn" onclick="openMovieModal('${movie.id}')">Edit</button>
        <button class="icon-btn danger" onclick="deleteMovie('${movie.id}')">Delete</button>
      </div>
    </div>`;
}

function wireMoviesActions() {
  document.getElementById("add-movie-btn").addEventListener("click", () => openMovieModal());
}

function openMovieModal(movieId) {
  const existing = movieId ? moviesCache.find((m) => m.id === movieId) : null;

  openModal(`
    <h3>${existing ? "Edit title" : "Add title"}</h3>
    <form id="movie-form">
      <div class="field">
        <label>Title</label>
        <input type="text" id="movie-title" required autofocus autocomplete="off" value="${existing ? escapeHtml(existing.title) : ""}" />
      </div>
      <div class="field">
        <label>Type</label>
        <select id="movie-type">
          <option value="movie" ${!existing || existing.media_type === "movie" ? "selected" : ""}>Movie</option>
          <option value="tv" ${existing && existing.media_type === "tv" ? "selected" : ""}>TV Show</option>
        </select>
      </div>
      <div class="field">
        <label>Rating</label>
        ${renderStarRatingEditorHtml("movie", existing ? existing.rating : 0)}
      </div>
      <div class="field">
        <label>Platforms</label>
        <div class="platform-order-list" id="movie-platform-order-list">${renderPlatformOrderListHtml(existing ? existing.platforms : [])}</div>
        <label style="margin-top:10px;">Add a platform</label>
        <div class="movie-platform-picker" id="movie-platform-add-picker">${renderPlatformAddPickerHtml(existing ? existing.platforms : [])}</div>
        <label style="margin-top:10px;">Add custom platform (press Enter)</label>
        <input type="text" id="movie-platform-custom" autocomplete="off" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        ${existing ? `<button type="button" class="btn-ghost btn-clear-all" onclick="deleteMovie('${existing.id}')">Delete</button>` : ""}
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  enhanceSelect("movie-type");
  wireStarRatingEditor("movie");
  wireMoviePlatformEditor("movie-platform");

  document.getElementById("movie-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("movie-title").value.trim();
    if (!title) return;

    const payload = {
      title,
      media_type: document.getElementById("movie-type").value,
      platforms: getPlatformOrderSelected("movie-platform"),
      rating: getStarRatingValue("movie") || null,
    };

    const { error } = existing
      ? await supabaseClient.from("movies_watchlist").update(payload).eq("id", existing.id)
      : await supabaseClient.from("movies_watchlist").insert(payload);

    if (error) {
      await uiAlert(`Failed to ${existing ? "save" : "add"} title: ` + error.message);
      return;
    }
    closeModal();
    await refreshMoviesAfterAction();
  });
}

/* ============================================
   MOBILE — one screen: filter chips + list, same shape as Guitar's mobile
   screen (no sub-screens).
   ============================================ */
async function initMoviesMobile() {
  await loadMoviesCache();
  renderMoviesMobileScreen();
}

function renderMoviesMobileScreen() {
  document.getElementById("m-topbar").innerHTML = `
    <div>
      <div class="m-title">MOVIES</div>
      <div class="m-date">${moviesCache.length} title${moviesCache.length === 1 ? "" : "s"}</div>
    </div>
  `;

  const items = filterMovies(moviesCache, movieFilter);

  document.getElementById("m-main").innerHTML = `
    <div class="m-chip-row" id="m-movies-filter-row">
      <div class="m-chip ${movieFilter === "all" ? "active" : ""}" data-filter="all">All</div>
      <div class="m-chip ${movieFilter === "movie" ? "active" : ""}" data-filter="movie">Movies</div>
      <div class="m-chip ${movieFilter === "tv" ? "active" : ""}" data-filter="tv">TV Shows</div>
    </div>

    <div class="m-set-list-label" style="display:flex;justify-content:space-between;align-items:center;">
      <span>${items.length} title${items.length === 1 ? "" : "s"}</span>
      <button type="button" class="btn-ghost" id="m-add-movie-btn" style="padding:5px 12px;font-size:11px;">+ Add title</button>
    </div>

    <div id="m-movies-list">
      ${items.length === 0
        ? `<div class="m-empty" style="padding:40px 0;height:auto;">
            <div class="big">${movieFilter === "all" ? "Watchlist is empty" : movieFilter === "movie" ? "No movies yet" : "No TV shows yet"}</div>
            <p>Tap Add title to start.</p>
          </div>`
        : items.map((m) => renderMovieRowMobile(m)).join("")}
    </div>
  `;

  wireMoviesMobileScreen();
}

function renderMovieRowMobile(movie) {
  return `
    <div class="m-guitar-swipe-wrap m-swipe-owns-gesture" data-movie-id="${movie.id}">
      <button type="button" class="m-swipe-action-btn m-swipe-action-delete">Delete</button>
      <div class="m-guitar-card">
        <div class="info">
          <div class="name movie-title-row">
            <span>${escapeHtmlMobile(movie.title)}</span>
            ${movieTypeBadgeHtml(movie.media_type)}
            ${(movie.platforms || []).map((p) => moviePlatformBadgeHtml(p)).join("")}
          </div>
          ${movie.rating ? `<div class="detail">${starRatingDisplayHtml(movie.rating)}</div>` : ""}
        </div>
        <div class="m-set-row-actions">
          <button class="m-guitar-icon-btn" data-action="edit" data-movie-id="${movie.id}" type="button">&#9998;</button>
        </div>
      </div>
    </div>`;
}

function wireMoviesMobileScreen() {
  document.querySelectorAll("#m-movies-filter-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      movieFilter = chip.dataset.filter;
      renderMoviesMobileScreen();
    });
  });

  document.getElementById("m-add-movie-btn").addEventListener("click", () => openMovieSheetMobile());

  document.querySelectorAll("#m-movies-list .m-guitar-icon-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const movie = moviesCache.find((m) => m.id === btn.dataset.movieId);
      if (movie) openMovieSheetMobile(movie);
    });
  });

  document.querySelectorAll("#m-movies-list .m-guitar-swipe-wrap").forEach((wrap) => {
    const movie = moviesCache.find((m) => m.id === wrap.dataset.movieId);
    if (movie) attachMovieSwipe(wrap, movie);
  });
}

/** Swipe right reveals Delete — same single-direction gesture as
 *  attachGuitarSongSwipe (guitar.js), just without the double-tap-to-open
 *  behavior since a watchlist title has no link to open. */
function attachMovieSwipe(wrap, movie) {
  const card = wrap.querySelector(".m-guitar-card");
  const deleteBtn = wrap.querySelector(".m-swipe-action-delete");
  const OPEN_THRESHOLD = 36;
  const ACTION_WIDTH = 88;
  const DRAG_START_THRESHOLD = 8;

  let startX = 0;
  let deltaX = 0;
  let dragging = false;
  let committed = false;
  let openState = "closed"; // 'closed' | 'delete'

  function setOpenState(next) {
    openState = next;
    card.style.transition = "transform 0.2s ease";
    card.style.transform = next === "delete" ? `translateX(${ACTION_WIDTH}px)` : "translateX(0)";
    if (next === "delete") mOpenSwipeCard = { wrap, close: () => setOpenState("closed") };
    else if (mOpenSwipeCard && mOpenSwipeCard.wrap === wrap) mOpenSwipeCard = null;
  }

  card.addEventListener("pointerdown", (e) => {
    if (mOpenSwipeCard && mOpenSwipeCard.wrap !== wrap) mOpenSwipeCard.close();
    dragging = true;
    committed = false;
    startX = e.clientX;
    deltaX = 0;
    card.style.transition = "none";
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const raw = e.clientX - startX;
    if (!committed) {
      if (Math.abs(raw) < DRAG_START_THRESHOLD) return;
      committed = true;
      card.setPointerCapture(e.pointerId);
    }
    const base = openState === "delete" ? ACTION_WIDTH : 0;
    deltaX = raw;
    const next = Math.max(0, Math.min(ACTION_WIDTH, base + raw));
    card.style.transform = `translateX(${next}px)`;
  });

  const onRelease = () => {
    if (!dragging) return;
    dragging = false;
    if (!committed) return;
    const base = openState === "delete" ? ACTION_WIDTH : 0;
    const finalPos = Math.max(0, Math.min(ACTION_WIDTH, base + deltaX));
    setOpenState(finalPos > OPEN_THRESHOLD ? "delete" : "closed");
  };

  card.addEventListener("pointerup", onRelease);
  card.addEventListener("pointercancel", onRelease);

  deleteBtn.addEventListener("click", async () => {
    const { error } = await supabaseClient.from("movies_watchlist").delete().eq("id", movie.id);
    if (error) {
      await uiAlert("Failed to delete: " + error.message);
      return;
    }
    await refreshMoviesAfterAction();
  });
}

function openMovieSheetMobile(existing) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Title</div>
          <input type="text" id="m-movie-title" autofocus autocomplete="off" value="${existing ? escapeHtmlMobile(existing.title) : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Type</div>
          <div class="m-chip-row" id="m-movie-type-row" style="margin-top:8px;">
            <div class="m-chip ${!existing || existing.media_type === "movie" ? "active" : ""}" data-type="movie">Movie</div>
            <div class="m-chip ${existing && existing.media_type === "tv" ? "active" : ""}" data-type="tv">TV Show</div>
          </div>
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Rating</div>
          <div style="margin-top:8px;">${renderStarRatingEditorHtml("m-movie", existing ? existing.rating : 0)}</div>
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Platforms</div>
          <div class="platform-order-list" id="m-movie-platform-order-list" style="margin-top:8px;">${renderPlatformOrderListHtml(existing ? existing.platforms : [])}</div>
          <div class="label" style="margin-top:10px;">Add a platform</div>
          <div class="movie-platform-picker" id="m-movie-platform-add-picker" style="margin-top:8px;">${renderPlatformAddPickerHtml(existing ? existing.platforms : [])}</div>
          <div class="label" style="margin-top:10px;">Add custom platform (press Enter)</div>
          <input type="text" id="m-movie-platform-custom" autocomplete="off"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-movie-btn" style="width:100%;max-width:none;">${existing ? "Save" : "Add Title"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  let selectedType = !existing || existing.media_type === "movie" ? "movie" : "tv";
  document.querySelectorAll("#m-movie-type-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      selectedType = chip.dataset.type;
      document.querySelectorAll("#m-movie-type-row .m-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  wireStarRatingEditor("m-movie");
  wireMoviePlatformEditor("m-movie-platform");

  document.getElementById("m-save-movie-btn").addEventListener("click", async () => {
    const titleInput = document.getElementById("m-movie-title");
    const title = titleInput.value.trim();
    if (!title) return showFieldRequired(titleInput);
    const btn = document.getElementById("m-save-movie-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const payload = {
      title,
      media_type: selectedType,
      platforms: getPlatformOrderSelected("m-movie-platform"),
      rating: getStarRatingValue("m-movie") || null,
    };

    beginMutation();
    const { error } = existing
      ? await supabaseClient.from("movies_watchlist").update(payload).eq("id", existing.id)
      : await supabaseClient.from("movies_watchlist").insert(payload);
    endMutation();

    if (error) {
      await uiAlert(`Failed to ${existing ? "save" : "add"} title: ` + error.message);
      btn.disabled = false;
      btn.textContent = existing ? "Save" : "Add Title";
      return;
    }

    overlay.remove();
    await refreshMoviesAfterAction();
  });
}
