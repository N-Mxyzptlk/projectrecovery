// guitar.js
// The Guitar app: one song catalogue with two independent flags (liked /
// want to play) rather than three separate lists to keep in sync — that's
// the fix for "other apps feel too complex here." Reuses supabaseClient,
// escapeHtml, openModal/closeModal, currentApp from desktop.js; and
// escapeHtmlMobile, beginMutation/endMutation, the .m-sheet pattern,
// mApp/renderFabStack from mobile.js. Loaded after finance.js, before
// mobile.js — functions here that reference mobile-only globals are only
// ever called after mobile.js has finished executing, so load order
// doesn't matter at call time.

let guitarSongsCache = [];
let gFilter = "all"; // 'all' | 'liked' | 'want' | 'setlist' — shared filter state, desktop and mobile read/write the same one
let gSearchQuery = ""; // live text search, shared by desktop and mobile
let gSearchByArtist = false; // toggle: off matches title+artist, on matches artist only
let gTagFilter = null; // selected tag, or null for "any tag" — combines with gFilter and search rather than replacing them

async function loadGuitarSongsCache() {
  const { data, error } = await supabaseClient.from("guitar_songs").select("*").order("created_at", { ascending: false });
  if (!error) guitarSongsCache = data || [];
  return guitarSongsCache;
}

function filterGuitarSongs(songs, filter) {
  let result = songs;
  if (filter === "liked") result = result.filter((s) => s.is_liked);
  else if (filter === "want") result = result.filter((s) => s.is_want_to_play);
  else if (filter === "setlist") result = result.filter((s) => s.in_setlist);
  if (gTagFilter) result = result.filter((s) => (s.tags || []).includes(gTagFilter));
  return result;
}

function distinctGuitarTags() {
  const tags = new Set();
  guitarSongsCache.forEach((s) => (s.tags || []).forEach((t) => tags.add(t)));
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** Multi-select tag dropdown for the Add/Edit Song form — every tag used
 *  anywhere in the catalogue shows up as a checkable option, and typing a
 *  new name into the row at the bottom + pressing Enter adds it as a fresh,
 *  already-checked option. `idPrefix` lets desktop ("song-tags") and
 *  mobile ("m-song-tags") each get their own set of element ids. */
function renderTagDropdownHtml(idPrefix, selected) {
  const selectedSet = new Set(selected || []);
  const allTags = [...new Set([...distinctGuitarTags(), ...selectedSet])].sort((a, b) => a.localeCompare(b));
  const labelText = selectedSet.size === 0 ? "Select tags" : [...selectedSet].join(", ");

  return `
    <div class="tag-dropdown" id="${idPrefix}-dropdown">
      <button type="button" class="tag-dropdown-trigger" id="${idPrefix}-trigger">
        <span id="${idPrefix}-trigger-label">${escapeHtml(labelText)}</span>
        <span class="custom-select-caret">&#9662;</span>
      </button>
      <div class="tag-dropdown-panel hidden" id="${idPrefix}-panel">
        <div class="tag-dropdown-options" id="${idPrefix}-options">
          ${allTags
            .map(
              (t) =>
                `<div class="tag-dropdown-option ${selectedSet.has(t) ? "checked" : ""}" data-tag="${escapeHtml(t)}"><span class="tag-dropdown-checkbox"></span>${escapeHtml(t)}</div>`
            )
            .join("")}
        </div>
        <div class="tag-dropdown-add-row">
          <label>New tag (press Enter to add)</label>
          <input type="text" id="${idPrefix}-new-input" autocomplete="off" />
        </div>
      </div>
    </div>`;
}

/** Wires open/close + selection for a dropdown rendered by
 *  renderTagDropdownHtml. `containerEl` is the enclosing modal/sheet
 *  element — the outside-click-closes listener lives on it (not
 *  `document`), so it's torn down for free when the modal/sheet is
 *  removed, rather than leaking a global listener on every open. */
function wireTagDropdown(idPrefix, containerEl) {
  const dropdown = document.getElementById(`${idPrefix}-dropdown`);
  const trigger = document.getElementById(`${idPrefix}-trigger`);
  const label = document.getElementById(`${idPrefix}-trigger-label`);
  const panel = document.getElementById(`${idPrefix}-panel`);
  const optionsEl = document.getElementById(`${idPrefix}-options`);
  const newInput = document.getElementById(`${idPrefix}-new-input`);

  function updateLabel() {
    const selected = getTagDropdownSelected(idPrefix);
    label.textContent = selected.length === 0 ? "Select tags" : selected.join(", ");
  }

  function wireOption(optEl) {
    optEl.addEventListener("click", () => {
      optEl.classList.toggle("checked");
      updateLabel();
    });
  }
  optionsEl.querySelectorAll(".tag-dropdown-option").forEach(wireOption);

  trigger.addEventListener("click", () => panel.classList.toggle("hidden"));
  containerEl.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) panel.classList.add("hidden");
  });

  newInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = newInput.value.trim();
    if (!name) return;
    const exists = [...optionsEl.querySelectorAll(".tag-dropdown-option")].some((o) => o.dataset.tag.toLowerCase() === name.toLowerCase());
    newInput.value = "";
    if (exists) return;

    const opt = document.createElement("div");
    opt.className = "tag-dropdown-option checked";
    opt.dataset.tag = name;
    opt.innerHTML = `<span class="tag-dropdown-checkbox"></span>${escapeHtml(name)}`;
    wireOption(opt);
    optionsEl.appendChild(opt);
    updateLabel();
  });
}

function getTagDropdownSelected(idPrefix) {
  return [...document.querySelectorAll(`#${idPrefix}-options .tag-dropdown-option.checked`)].map((o) => o.dataset.tag);
}

function applyGuitarSearch(songs, query, byArtist) {
  const q = query.trim().toLowerCase();
  if (!q) return songs;
  return songs.filter((s) =>
    byArtist ? (s.artist || "").toLowerCase().includes(q) : s.title.toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q)
  );
}

function distinctGuitarArtists(query) {
  const q = (query || "").trim().toLowerCase();
  const names = new Set();
  guitarSongsCache.forEach((s) => {
    if (s.artist) names.add(s.artist);
  });
  let list = [...names].sort((a, b) => a.localeCompare(b));
  if (q) list = list.filter((a) => a.toLowerCase().includes(q));
  return list.slice(0, 8);
}

/** Own dropdown of already-logged artist names, built and styled by us
 *  instead of the browser's native autofill-from-history suggestions
 *  (which can't be restyled and surface old, possibly stale, entries).
 *  Used on the Artist field (consistent spelling when adding songs) and on
 *  the search bar in "by artist" mode (quick pick to filter). `onlyWhen`
 *  lets a caller gate whether the dropdown should appear at all. */
function attachArtistAutocomplete(inputEl, { onlyWhen } = {}) {
  let dropdownEl = null;

  function closeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
    }
  }

  function openDropdown() {
    if (onlyWhen && !onlyWhen()) return closeDropdown();
    const matches = distinctGuitarArtists(inputEl.value);
    closeDropdown();
    if (matches.length === 0) return;

    dropdownEl = document.createElement("div");
    dropdownEl.className = "guitar-autocomplete-dropdown";
    dropdownEl.innerHTML = matches.map((name) => `<div class="guitar-autocomplete-item">${escapeHtml(name)}</div>`).join("");

    const rect = inputEl.getBoundingClientRect();
    dropdownEl.style.left = `${rect.left}px`;
    dropdownEl.style.top = `${rect.bottom + 4}px`;
    dropdownEl.style.width = `${rect.width}px`;
    document.body.appendChild(dropdownEl);

    dropdownEl.querySelectorAll(".guitar-autocomplete-item").forEach((item, i) => {
      // mousedown (not click) fires before the input's blur, so the value
      // still lands before closeDropdown tears the list down.
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        inputEl.value = matches[i];
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        closeDropdown();
      });
    });
  }

  inputEl.addEventListener("input", openDropdown);
  inputEl.addEventListener("focus", openDropdown);
  inputEl.addEventListener("blur", () => setTimeout(closeDropdown, 120));
}

/** Tag filter + search combined — the one list both desktop and mobile
 *  should actually render. */
function visibleGuitarSongs() {
  return applyGuitarSearch(filterGuitarSongs(guitarSongsCache, gFilter), gSearchQuery, gSearchByArtist);
}

async function toggleGuitarFlag(songId, field) {
  const song = guitarSongsCache.find((s) => s.id === songId);
  if (!song) return;
  const { error } = await supabaseClient.from("guitar_songs").update({ [field]: !song[field] }).eq("id", songId);
  if (error) return uiAlert("Failed to update: " + error.message);
  await refreshGuitarAfterAction();
}

async function deleteGuitarSong(id) {
  if (!(await uiConfirm("Delete this song from your catalogue?"))) return;
  const { error } = await supabaseClient.from("guitar_songs").delete().eq("id", id);
  if (error) return uiAlert("Failed to delete: " + error.message);
  await refreshGuitarAfterAction();
}

/** "Clear All" only exists on Liked/Want to Play — it clears that tag from
 *  every song showing it, songs stay in the catalogue. There's no
 *  catalogue-wide clear at all: deleting the whole catalogue outright is
 *  destructive enough that it shouldn't be a one-click action here (use
 *  per-song Delete instead). Shared by the desktop button and the mobile one. */
async function clearAllGuitar() {
  if (gFilter === "all") return;
  const field = gFilter === "liked" ? "is_liked" : gFilter === "want" ? "is_want_to_play" : "in_setlist";
  const label = gFilter === "liked" ? "Liked" : gFilter === "want" ? "Want to Play" : "Setlist";
  if (!(await uiConfirm(`Clear your entire "${label}" list? Songs stay in your catalogue.`))) return;
  const { error } = await supabaseClient.from("guitar_songs").update({ [field]: false }).eq(field, true);
  if (error) return uiAlert("Failed to clear: " + error.message);
  await refreshGuitarAfterAction();
}

/** Every song currently in the setlist, regardless of any active tag
 *  filter or search text — "Load Setlist" opens the whole thing, not just
 *  whatever happens to be visible under the current filters. */
function guitarSongsInSetlist() {
  return guitarSongsCache.filter((s) => s.in_setlist);
}

/** Opens every setlist song's link in its own new tab so a play session
 *  can just Alt/Cmd-Tab between them instead of hunting through the
 *  catalogue mid-session. */
async function loadGuitarSetlist() {
  const setlist = guitarSongsInSetlist();
  const withLinks = setlist.filter((s) => s.link);

  if (setlist.length === 0) return uiAlert("Your setlist is empty — add songs to it first.");
  if (withLinks.length === 0) return uiAlert("No songs in your setlist have a saved link yet.");

  // Browsers only ever let the FIRST window.open from one click through —
  // every one after that is silently blocked as a popup, which is exactly
  // why only the top song was opening. Anything blocked gets a one-tap
  // fallback list instead of just vanishing.
  const blocked = [];
  withLinks.forEach((s) => {
    const win = window.open(s.link, "_blank");
    if (!win) blocked.push(s);
  });

  if (blocked.length > 0) {
    showBlockedSetlistLinks(blocked);
  } else if (withLinks.length < setlist.length) {
    await uiAlert(`Opened ${withLinks.length} of ${setlist.length} songs — the rest have no link saved.`);
  }
}

function showBlockedSetlistLinks(songs) {
  openModal(`
    <h3>Finish opening your setlist</h3>
    <p style="color:var(--text-muted);font-size:13px;margin:-8px 0 16px;">Your browser blocked the rest as pop-ups — tap each to open it in a new tab.</p>
    <div class="modal-actions" style="flex-direction:column;gap:8px;">
      ${songs
        .map(
          (s) =>
            `<a class="btn-ghost" style="display:block;text-align:center;text-decoration:none;" href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>`
        )
        .join("")}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" onclick="closeModal()">Close</button>
    </div>
  `);
}

/** Re-renders whichever shell (desktop and/or mobile) is currently showing
 *  Guitar, after an action changes the underlying data — same pattern as
 *  finance.js's refreshFinanceAfterAction. */
async function refreshGuitarAfterAction() {
  await loadGuitarSongsCache();
  if (typeof currentApp !== "undefined" && currentApp === "guitar") {
    renderGuitarFilterTabs();
    renderGuitarSongsList();
  }
  if (typeof mApp !== "undefined" && mApp === "guitar") {
    renderGuitarMobileScreen();
  }
}

/* ============================================
   DESKTOP
   ============================================ */
async function loadGuitarDashboard() {
  await loadGuitarSongsCache();
  renderGuitarFilterTabs();
  renderGuitarSongsList();
}

function renderGuitarFilterTabs() {
  const box = document.getElementById("guitar-filter-tabs");
  if (!box) return;
  // Counts respect the current tag filter (via filterGuitarSongs), so
  // switching tags updates all three tab counts together.
  const counts = {
    all: filterGuitarSongs(guitarSongsCache, "all").length,
    liked: filterGuitarSongs(guitarSongsCache, "liked").length,
    want: filterGuitarSongs(guitarSongsCache, "want").length,
    setlist: filterGuitarSongs(guitarSongsCache, "setlist").length,
  };
  box.innerHTML = `
    <div class="filter-tab ${gFilter === "all" ? "active" : ""}" data-filter="all">Catalogue <span class="count">${counts.all}</span></div>
    <div class="filter-tab ${gFilter === "liked" ? "active" : ""}" data-filter="liked">Liked <span class="count">${counts.liked}</span></div>
    <div class="filter-tab ${gFilter === "want" ? "active" : ""}" data-filter="want">Want to Play <span class="count">${counts.want}</span></div>
    <div class="filter-tab ${gFilter === "setlist" ? "active" : ""}" data-filter="setlist">Setlist <span class="count">${counts.setlist}</span></div>
  `;
  const clearAllBtn = document.getElementById("guitar-clear-all-btn");
  if (clearAllBtn) clearAllBtn.classList.toggle("hidden", gFilter === "all");
  const loadSetlistBtn = document.getElementById("guitar-load-setlist-btn");
  if (loadSetlistBtn) loadSetlistBtn.classList.toggle("hidden", gFilter !== "setlist");

  box.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      gFilter = tab.dataset.filter;
      renderGuitarFilterTabs();
      renderGuitarSongsList();
    });
  });

  renderGuitarTagFilterRow();
}

/** Tag chips — an additional filter dimension that combines with the
 *  Catalogue/Liked/Want tab and the search box rather than replacing
 *  either. Clicking the active tag again clears it (toggle, same
 *  convention as the "By Artist" search toggle). */
function renderGuitarTagFilterRow() {
  const box = document.getElementById("guitar-tag-filter-row");
  if (!box) return;
  const tags = distinctGuitarTags();
  if (tags.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = tags
    .map((tag) => `<div class="filter-tag-chip ${gTagFilter === tag ? "active" : ""}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</div>`)
    .join("");
  box.querySelectorAll(".filter-tag-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      gTagFilter = gTagFilter === chip.dataset.tag ? null : chip.dataset.tag;
      renderGuitarFilterTabs();
      renderGuitarSongsList();
    });
  });
}

/** Shared empty-state copy for the song list, desktop and mobile alike. */
function guitarEmptyStateText() {
  if (gSearchQuery.trim().length > 0) return { big: "No matches", p: "Try a different search term." };
  if (gFilter === "all") return { big: "No songs yet", p: "Add a song to start your catalogue." };
  if (gFilter === "liked") return { big: "No liked songs", p: "Tag a song from the catalogue to see it here." };
  if (gFilter === "want") return { big: "Nothing on your want-to-play list", p: "Tag a song from the catalogue to see it here." };
  return { big: "Setlist is empty", p: "Tag a song from the catalogue to add it to your setlist." };
}

function renderGuitarSongsList() {
  const listEl = document.getElementById("guitar-songs-list");
  if (!listEl) return;
  const songs = visibleGuitarSongs();

  if (songs.length === 0) {
    const { big, p } = guitarEmptyStateText();
    const searching = gSearchQuery.trim().length > 0;
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">${big}</div>
        <p>${p}</p>
        ${!searching && gFilter === "all" ? `<button class="btn-accent" onclick="openAddSongModal()">+ Add song</button>` : ""}
      </div>`;
    return;
  }

  listEl.innerHTML = songs.map((s) => renderGuitarSongRow(s)).join("");
  wireGuitarSongRows();
}

/** Small muted pills for a song's tags — reused by desktop and mobile.
 *  `escapeFn` lets each caller pass its own escaper (escapeHtml vs
 *  escapeHtmlMobile). */
function guitarTagsHtml(song, escapeFn) {
  if (!song.tags || song.tags.length === 0) return "";
  return `<div class="guitar-tag-list">${song.tags.map((t) => `<span class="guitar-tag-badge">${escapeFn(t)}</span>`).join("")}</div>`;
}

function renderGuitarSongRow(song) {
  return `
    <div class="card-row ${song.link ? "guitar-row-linked" : ""}" data-song-id="${song.id}" ${song.link ? 'title="Double-click to open link"' : ""}>
      <div>
        <div class="title">${escapeHtml(song.title)}${song.link ? ` <span class="guitar-link-icon">&#128279;</span>` : ""}</div>
        <div class="meta">${song.artist ? escapeHtml(song.artist) : "Unknown artist"}${song.rating ? `<span class="rating-divider">|</span>${starRatingDisplayHtml(song.rating)}` : ""}${song.note ? " · " + escapeHtml(song.note) : ""}</div>
        ${guitarTagsHtml(song, escapeHtml)}
      </div>
      <div class="row-actions">
        <button class="icon-btn guitar-toggle-liked ${song.is_liked ? "guitar-liked-active" : ""}" data-song-id="${song.id}" title="Liked">&#9825;</button>
        <button class="icon-btn guitar-toggle-want ${song.is_want_to_play ? "guitar-want-active" : ""}" data-song-id="${song.id}" title="Want to play">&#9734;</button>
        <button class="icon-btn guitar-toggle-setlist ${song.in_setlist ? "guitar-setlist-active" : ""}" data-song-id="${song.id}" title="Setlist">&#9835;</button>
        <button class="icon-btn" onclick="event.stopPropagation(); openAddSongModal('${song.id}')">Edit</button>
        <button class="icon-btn danger" onclick="event.stopPropagation(); deleteGuitarSong('${song.id}')">Delete</button>
      </div>
    </div>`;
}

function wireGuitarSongRows() {
  document.querySelectorAll(".guitar-toggle-liked").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGuitarFlag(btn.dataset.songId, "is_liked");
    });
  });
  document.querySelectorAll(".guitar-toggle-want").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGuitarFlag(btn.dataset.songId, "is_want_to_play");
    });
  });
  document.querySelectorAll(".guitar-toggle-setlist").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGuitarFlag(btn.dataset.songId, "in_setlist");
    });
  });
  document.querySelectorAll("#guitar-songs-list .card-row[data-song-id]").forEach((row) => {
    row.addEventListener("dblclick", () => {
      const song = guitarSongsCache.find((s) => s.id === row.dataset.songId);
      if (song && song.link) window.location.href = song.link;
    });
  });
}

function wireGuitarActions() {
  document.getElementById("add-song-btn").addEventListener("click", () => openAddSongModal());
  document.getElementById("guitar-clear-all-btn").addEventListener("click", clearAllGuitar);
  document.getElementById("guitar-load-setlist-btn").addEventListener("click", loadGuitarSetlist);

  const searchInput = document.getElementById("guitar-search-input");
  searchInput.addEventListener("input", (e) => {
    gSearchQuery = e.target.value;
    renderGuitarSongsList();
  });
  attachSearchClear(searchInput, document.getElementById("guitar-search-clear-btn"), () => {
    gSearchQuery = "";
    renderGuitarSongsList();
  });
  attachArtistAutocomplete(searchInput, { onlyWhen: () => gSearchByArtist });

  const artistToggle = document.getElementById("guitar-search-artist-toggle");
  artistToggle.addEventListener("click", () => {
    gSearchByArtist = !gSearchByArtist;
    artistToggle.classList.toggle("active", gSearchByArtist);
    renderGuitarSongsList();
  });
}

function openAddSongModal(songId) {
  const existing = songId ? guitarSongsCache.find((s) => s.id === songId) : null;

  openModal(`
    <h3>${existing ? "Edit song" : "Add song"}</h3>
    <form id="song-form">
      <div class="field">
        <label>Title</label>
        <input type="text" id="song-title" required autofocus autocomplete="off" value="${existing ? escapeHtml(existing.title) : ""}" />
      </div>
      <div class="field">
        <label>Artist</label>
        <input type="text" id="song-artist" autocomplete="off" value="${existing ? escapeHtml(existing.artist || "") : ""}" />
      </div>
      <div class="field">
        <label>Rating</label>
        ${renderStarRatingEditorHtml("song", existing ? existing.rating : 0)}
      </div>
      <div class="field">
        <label>Link</label>
        <input type="url" id="song-link" autocomplete="off" value="${existing ? escapeHtml(existing.link || "") : ""}" />
      </div>
      <div class="field">
        <label>Note</label>
        <input type="text" id="song-note" autocomplete="off" value="${existing ? escapeHtml(existing.note || "") : ""}" />
      </div>
      <div class="field">
        <label>Tags</label>
        ${renderTagDropdownHtml("song-tags", existing ? existing.tags : [])}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">${existing ? "Save" : "Add"}</button>
      </div>
    </form>
  `);

  attachArtistAutocomplete(document.getElementById("song-artist"));
  wireTagDropdown("song-tags", document.getElementById("song-form"));
  wireStarRatingEditor("song");

  document.getElementById("song-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("song-title").value.trim();
    if (!title) return;

    const payload = {
      title,
      artist: document.getElementById("song-artist").value.trim() || null,
      link: document.getElementById("song-link").value.trim() || null,
      note: document.getElementById("song-note").value.trim() || null,
      tags: getTagDropdownSelected("song-tags"),
      rating: getStarRatingValue("song") || null,
    };

    const { error } = existing
      ? await supabaseClient.from("guitar_songs").update(payload).eq("id", existing.id)
      : await supabaseClient.from("guitar_songs").insert(payload);

    if (error) {
      await uiAlert(`Failed to ${existing ? "save" : "add"} song: ` + error.message);
      return;
    }
    closeModal();
    await refreshGuitarAfterAction();
  });
}

/* ============================================
   MOBILE — one screen: filter chips + list. No sub-screens — keeping this
   app to a single flat page is the whole point (see file header).
   ============================================ */
async function initGuitarMobile() {
  await loadGuitarSongsCache();
  renderGuitarMobileScreen();
}

function renderGuitarMobileScreen() {
  document.getElementById("m-topbar").innerHTML = `
    <div>
      <div class="m-title">GUITAR</div>
      <div class="m-date">${guitarSongsCache.length} song${guitarSongsCache.length === 1 ? "" : "s"}</div>
    </div>
  `;

  const songs = visibleGuitarSongs();
  const tagCount = filterGuitarSongs(guitarSongsCache, gFilter).length; // unaffected by search text — clear-all always clears the whole tag

  const tags = distinctGuitarTags();

  document.getElementById("m-main").innerHTML = `
    <div class="m-chip-row" id="m-guitar-filter-row">
      <div class="m-chip ${gFilter === "all" ? "active" : ""}" data-filter="all">Catalogue</div>
      <div class="m-chip ${gFilter === "liked" ? "active" : ""}" data-filter="liked">Liked</div>
      <div class="m-chip ${gFilter === "want" ? "active" : ""}" data-filter="want">Want to Play</div>
      <div class="m-chip ${gFilter === "setlist" ? "active" : ""}" data-filter="setlist">Setlist</div>
    </div>

    ${tags.length > 0
      ? `<div class="m-chip-row" id="m-guitar-tag-filter-row">
          ${tags.map((t) => `<div class="m-chip filter-tag-chip ${gTagFilter === t ? "active" : ""}" data-tag="${escapeHtmlMobile(t)}">${escapeHtmlMobile(t)}</div>`).join("")}
        </div>`
      : ""}

    <div class="m-stat-block" style="margin-bottom:10px;">
      <div class="label">Search</div>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <div class="search-input-wrap" style="flex:1;">
          <input type="search" id="m-guitar-search-input" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" value="${escapeHtmlMobile(gSearchQuery)}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px 32px 10px 12px;font-size:13px;" />
          <button type="button" class="search-clear-btn ${gSearchQuery ? "" : "hidden"}" id="m-guitar-search-clear-btn" aria-label="Clear search">&times;</button>
        </div>
        <button type="button" class="m-chip ${gSearchByArtist ? "active" : ""}" id="m-guitar-search-artist-toggle">By Artist</button>
      </div>
    </div>

    <div class="m-set-list-label" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
      <span>${songs.length} song${songs.length === 1 ? "" : "s"}</span>
      <div style="display:flex;gap:8px;">
        <button type="button" class="btn-ghost" id="m-guitar-add-btn" style="padding:5px 12px;font-size:11px;">+ Add Songs</button>
        ${gFilter === "setlist" ? `<button type="button" class="btn-ghost" id="m-guitar-load-setlist-btn" style="padding:5px 12px;font-size:11px;">Load Setlist</button>` : ""}
        ${tagCount > 0 && gFilter !== "all" ? `<button type="button" class="btn-ghost" id="m-guitar-clear-all-btn" style="padding:5px 12px;font-size:11px;">Clear All</button>` : ""}
      </div>
    </div>

    <div id="m-guitar-list">${renderGuitarMobileListInner(songs)}</div>
  `;

  wireGuitarMobileScreen();
}

function renderGuitarMobileListInner(songs) {
  if (songs.length === 0) {
    const { big, p } = guitarEmptyStateText();
    return `<div class="m-empty" style="padding:40px 0;height:auto;">
      <div class="big">${big}</div>
      <p>${p}</p>
    </div>`;
  }
  return songs.map((s) => renderGuitarSongRowMobile(s)).join("");
}

/** Re-renders just the song list + its count label, leaving the search
 *  input's own DOM node untouched so typing doesn't lose focus/cursor
 *  position on every keystroke. */
function renderGuitarMobileListOnly() {
  const songs = visibleGuitarSongs();
  document.getElementById("m-guitar-list").innerHTML = renderGuitarMobileListInner(songs);
  const countEl = document.querySelector("#m-main .m-set-list-label span");
  if (countEl) countEl.textContent = `${songs.length} song${songs.length === 1 ? "" : "s"}`;
  wireGuitarMobileListRows();
}

/** Swipe right reveals Delete, same gesture as the Journal cards — swiping
 *  is handled by attachGuitarSongSwipe below; a plain tap/double-tap on the
 *  card itself (not a drag) opens the song's link if it has one. */
function renderGuitarSongRowMobile(song) {
  return `
    <div class="m-guitar-swipe-wrap m-swipe-owns-gesture" data-song-id="${song.id}">
      <button type="button" class="m-swipe-action-btn m-swipe-action-delete">Delete</button>
      <div class="m-guitar-card">
        <div class="info">
          <div class="name">${escapeHtmlMobile(song.title)}${song.link ? ` <span class="guitar-link-icon">&#128279;</span>` : ""}</div>
          <div class="detail">${song.artist ? escapeHtmlMobile(song.artist) : "Unknown artist"}${song.rating ? `<span class="rating-divider">|</span>${starRatingDisplayHtml(song.rating)}` : ""}${song.note ? " · " + escapeHtmlMobile(song.note) : ""}</div>
          ${guitarTagsHtml(song, escapeHtmlMobile)}
        </div>
        <div class="m-set-row-actions">
          <button class="m-guitar-icon-btn ${song.is_liked ? "liked-active" : ""}" data-action="liked" data-song-id="${song.id}" type="button">&#9825;</button>
          <button class="m-guitar-icon-btn ${song.is_want_to_play ? "want-active" : ""}" data-action="want" data-song-id="${song.id}" type="button">&#9734;</button>
          <button class="m-guitar-icon-btn ${song.in_setlist ? "setlist-active" : ""}" data-action="setlist" data-song-id="${song.id}" type="button" title="Setlist">&#9835;</button>
          <button class="m-guitar-icon-btn" data-action="edit" data-song-id="${song.id}" type="button">&#9998;</button>
        </div>
      </div>
    </div>`;
}

function wireGuitarMobileScreen() {
  document.querySelectorAll("#m-guitar-filter-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      gFilter = chip.dataset.filter;
      renderGuitarMobileScreen();
    });
  });

  document.querySelectorAll("#m-guitar-tag-filter-row .filter-tag-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      gTagFilter = gTagFilter === chip.dataset.tag ? null : chip.dataset.tag;
      renderGuitarMobileScreen();
    });
  });

  document.getElementById("m-guitar-add-btn").addEventListener("click", openAddSongSheetMobile);

  const clearBtn = document.getElementById("m-guitar-clear-all-btn");
  if (clearBtn) clearBtn.addEventListener("click", clearAllGuitar);

  const loadSetlistBtn = document.getElementById("m-guitar-load-setlist-btn");
  if (loadSetlistBtn) loadSetlistBtn.addEventListener("click", loadGuitarSetlist);

  const searchInput = document.getElementById("m-guitar-search-input");
  searchInput.addEventListener("input", (e) => {
    gSearchQuery = e.target.value;
    renderGuitarMobileListOnly();
  });
  attachSearchClear(searchInput, document.getElementById("m-guitar-search-clear-btn"), () => {
    gSearchQuery = "";
    renderGuitarMobileListOnly();
  });
  attachArtistAutocomplete(searchInput, { onlyWhen: () => gSearchByArtist });

  const artistToggle = document.getElementById("m-guitar-search-artist-toggle");
  artistToggle.addEventListener("click", () => {
    gSearchByArtist = !gSearchByArtist;
    renderGuitarMobileScreen();
  });

  wireGuitarMobileListRows();
}

/** Row-level listeners only (like/want/edit buttons + swipe-to-delete) —
 *  split out from wireGuitarMobileScreen so a search keystroke can refresh
 *  just the list without rebuilding (and defocusing) the search input. */
function wireGuitarMobileListRows() {
  document.querySelectorAll("#m-guitar-list .m-guitar-icon-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.action === "edit") {
        const song = guitarSongsCache.find((s) => s.id === btn.dataset.songId);
        if (song) openAddSongSheetMobile(song);
        return;
      }
      const field = btn.dataset.action === "liked" ? "is_liked" : btn.dataset.action === "want" ? "is_want_to_play" : "in_setlist";
      toggleGuitarFlag(btn.dataset.songId, field);
    });
  });

  document.querySelectorAll("#m-guitar-list .m-guitar-swipe-wrap").forEach((wrap) => {
    const song = guitarSongsCache.find((s) => s.id === wrap.dataset.songId);
    if (song) attachGuitarSongSwipe(wrap, song);
  });
}

let mGuitarLastTapAt = 0;
let mGuitarLastTapSongId = null;

/** Single-direction version of attachJournalSwipe (mobile.js) — swipe
 *  right reveals Delete only, no edit action. Pointer capture is deferred
 *  until real horizontal movement is detected, so a plain tap still lets
 *  the Liked/Want-to-play buttons receive their own click normally. */
function attachGuitarSongSwipe(wrap, song) {
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

    if (!committed) {
      // A real tap, not a drag — double-tap (within 350ms, same song) opens the link.
      const now = Date.now();
      if (mGuitarLastTapSongId === song.id && now - mGuitarLastTapAt < 350) {
        mGuitarLastTapAt = 0;
        mGuitarLastTapSongId = null;
        if (song.link) window.location.href = song.link;
      } else {
        mGuitarLastTapAt = now;
        mGuitarLastTapSongId = song.id;
      }
      return;
    }

    const base = openState === "delete" ? ACTION_WIDTH : 0;
    const finalPos = Math.max(0, Math.min(ACTION_WIDTH, base + deltaX));
    setOpenState(finalPos > OPEN_THRESHOLD ? "delete" : "closed");
  };

  card.addEventListener("pointerup", onRelease);
  card.addEventListener("pointercancel", onRelease);

  deleteBtn.addEventListener("click", async () => {
    const { error } = await supabaseClient.from("guitar_songs").delete().eq("id", song.id);
    if (error) {
      await uiAlert("Failed to delete: " + error.message);
      return;
    }
    await refreshGuitarAfterAction();
  });
}

function openAddSongSheetMobile(existing) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Title</div>
          <input type="text" id="m-song-title" autofocus autocomplete="off" value="${existing ? escapeHtmlMobile(existing.title) : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Artist</div>
          <input type="text" id="m-song-artist" autocomplete="off" value="${existing ? escapeHtmlMobile(existing.artist || "") : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Rating</div>
          <div style="margin-top:8px;">${renderStarRatingEditorHtml("m-song", existing ? existing.rating : 0)}</div>
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Link</div>
          <input type="url" id="m-song-link" autocomplete="off" value="${existing ? escapeHtmlMobile(existing.link || "") : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Tags</div>
          <div style="margin-top:8px;">${renderTagDropdownHtml("m-song-tags", existing ? existing.tags : [])}</div>
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-song-btn" style="width:100%;max-width:none;">${existing ? "Save" : "Add Song"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  attachArtistAutocomplete(document.getElementById("m-song-artist"));
  wireTagDropdown("m-song-tags", overlay);
  wireStarRatingEditor("m-song");

  document.getElementById("m-save-song-btn").addEventListener("click", async () => {
    const titleInput = document.getElementById("m-song-title");
    const title = titleInput.value.trim();
    if (!title) return showFieldRequired(titleInput);
    const btn = document.getElementById("m-save-song-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const payload = {
      title,
      artist: document.getElementById("m-song-artist").value.trim() || null,
      link: document.getElementById("m-song-link").value.trim() || null,
      tags: getTagDropdownSelected("m-song-tags"),
      rating: getStarRatingValue("m-song") || null,
    };

    beginMutation();
    const { error } = existing
      ? await supabaseClient.from("guitar_songs").update(payload).eq("id", existing.id)
      : await supabaseClient.from("guitar_songs").insert(payload);
    endMutation();

    if (error) {
      await uiAlert(`Failed to ${existing ? "save" : "add"} song: ` + error.message);
      btn.disabled = false;
      btn.textContent = existing ? "Save" : "Add Song";
      return;
    }

    overlay.remove();
    await refreshGuitarAfterAction();
  });
}
