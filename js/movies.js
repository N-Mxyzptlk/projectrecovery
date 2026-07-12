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
  "Hulu": "#1CE783",
  "Paramount+": "#0064FF",
  "YouTube": "#FF0000",
  "Crunchyroll": "#F47521",
  "Peacock": "#6E46AE",
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

/** Chip picker shared by the desktop modal and mobile sheet — presets
 *  first, then any custom platforms already on this title that aren't one
 *  of the presets, so editing an existing title doesn't drop them. */
function renderMoviePlatformPickerHtml(selected) {
  const selectedSet = new Set(selected || []);
  const customExtras = [...selectedSet].filter((p) => !MOVIE_PLATFORM_PRESETS.includes(p));
  return [...MOVIE_PLATFORM_PRESETS, ...customExtras]
    .map(
      (p) =>
        `<div class="movie-platform-chip ${selectedSet.has(p) ? "active" : ""}" data-platform="${escapeHtml(p)}" style="${moviePlatformBadgeStyle(p)}">${escapeHtml(p)}</div>`
    )
    .join("");
}

function wireMoviePlatformPicker(pickerEl, customInputEl) {
  const wireChip = (chip) => chip.addEventListener("click", () => chip.classList.toggle("active"));
  pickerEl.querySelectorAll(".movie-platform-chip").forEach(wireChip);

  customInputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = customInputEl.value.trim();
    if (!name) return;
    const exists = [...pickerEl.querySelectorAll(".movie-platform-chip")].some(
      (c) => c.dataset.platform.toLowerCase() === name.toLowerCase()
    );
    customInputEl.value = "";
    if (exists) return;

    const chip = document.createElement("div");
    chip.className = "movie-platform-chip active";
    chip.dataset.platform = name;
    chip.style.cssText = moviePlatformBadgeStyle(name);
    chip.textContent = name;
    wireChip(chip);
    pickerEl.appendChild(chip);
  });
}

function getSelectedMoviePlatforms(pickerEl) {
  return [...pickerEl.querySelectorAll(".movie-platform-chip.active")].map((c) => c.dataset.platform);
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
        <div class="title">${escapeHtml(movie.title)} ${movieTypeBadgeHtml(movie.media_type)}</div>
        ${movie.platforms && movie.platforms.length
          ? `<div class="movie-platform-list">${movie.platforms.map((p) => moviePlatformBadgeHtml(p)).join("")}</div>`
          : `<div class="meta">No platform set</div>`}
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
        <label>Platforms</label>
        <div class="movie-platform-picker" id="movie-platform-picker">${renderMoviePlatformPickerHtml(existing ? existing.platforms : [])}</div>
        <input type="text" id="movie-platform-custom" autocomplete="off" placeholder="Add another platform and press Enter" style="margin-top:8px;" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        ${existing ? `<button type="button" class="btn-ghost btn-clear-all" onclick="deleteMovie('${existing.id}')">Delete</button>` : ""}
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  enhanceSelect("movie-type");
  wireMoviePlatformPicker(document.getElementById("movie-platform-picker"), document.getElementById("movie-platform-custom"));

  document.getElementById("movie-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("movie-title").value.trim();
    if (!title) return;

    const payload = {
      title,
      media_type: document.getElementById("movie-type").value,
      platforms: getSelectedMoviePlatforms(document.getElementById("movie-platform-picker")),
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
          <div class="name">${escapeHtmlMobile(movie.title)} ${movieTypeBadgeHtml(movie.media_type)}</div>
          ${movie.platforms && movie.platforms.length
            ? `<div class="movie-platform-list">${movie.platforms.map((p) => moviePlatformBadgeHtml(p)).join("")}</div>`
            : `<div class="detail">No platform set</div>`}
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
          <div class="label">Platforms</div>
          <div class="movie-platform-picker" id="m-movie-platform-picker" style="margin-top:8px;">${renderMoviePlatformPickerHtml(existing ? existing.platforms : [])}</div>
          <input type="text" id="m-movie-platform-custom" autocomplete="off" placeholder="Add another platform and press Enter"
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

  wireMoviePlatformPicker(document.getElementById("m-movie-platform-picker"), document.getElementById("m-movie-platform-custom"));

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
      platforms: getSelectedMoviePlatforms(document.getElementById("m-movie-platform-picker")),
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
