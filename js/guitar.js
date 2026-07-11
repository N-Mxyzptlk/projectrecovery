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
let gFilter = "all"; // 'all' | 'liked' | 'want' — shared filter state, desktop and mobile read/write the same one

async function loadGuitarSongsCache() {
  const { data, error } = await supabaseClient.from("guitar_songs").select("*").order("created_at", { ascending: false });
  if (!error) guitarSongsCache = data || [];
  return guitarSongsCache;
}

function filterGuitarSongs(songs, filter) {
  if (filter === "liked") return songs.filter((s) => s.is_liked);
  if (filter === "want") return songs.filter((s) => s.is_want_to_play);
  return songs;
}

async function toggleGuitarFlag(songId, field) {
  const song = guitarSongsCache.find((s) => s.id === songId);
  if (!song) return;
  const { error } = await supabaseClient.from("guitar_songs").update({ [field]: !song[field] }).eq("id", songId);
  if (error) return alert("Failed to update: " + error.message);
  await refreshGuitarAfterAction();
}

async function deleteGuitarSong(id) {
  if (!confirm("Delete this song from your catalogue?")) return;
  const { error } = await supabaseClient.from("guitar_songs").delete().eq("id", id);
  if (error) return alert("Failed to delete: " + error.message);
  await refreshGuitarAfterAction();
}

/** "Clear All" is scoped to whatever filter is currently showing: on the
 *  full catalogue it deletes every song outright; on Liked/Want to Play it
 *  only clears that tag, since taste changes but the catalogue itself is
 *  still worth keeping. Shared by the desktop button and the mobile one. */
async function clearAllGuitar() {
  if (gFilter === "all") {
    if (!confirm("Delete your ENTIRE song catalogue? This cannot be undone.")) return;
    const { error } = await supabaseClient.from("guitar_songs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) return alert("Failed to clear: " + error.message);
  } else {
    const field = gFilter === "liked" ? "is_liked" : "is_want_to_play";
    const label = gFilter === "liked" ? "Liked" : "Want to Play";
    if (!confirm(`Clear your entire "${label}" list? Songs stay in your catalogue.`)) return;
    const { error } = await supabaseClient.from("guitar_songs").update({ [field]: false }).eq(field, true);
    if (error) return alert("Failed to clear: " + error.message);
  }
  await refreshGuitarAfterAction();
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
  const counts = {
    all: guitarSongsCache.length,
    liked: guitarSongsCache.filter((s) => s.is_liked).length,
    want: guitarSongsCache.filter((s) => s.is_want_to_play).length,
  };
  box.innerHTML = `
    <div class="filter-tab ${gFilter === "all" ? "active" : ""}" data-filter="all">Catalogue <span class="count">${counts.all}</span></div>
    <div class="filter-tab ${gFilter === "liked" ? "active" : ""}" data-filter="liked">Liked <span class="count">${counts.liked}</span></div>
    <div class="filter-tab ${gFilter === "want" ? "active" : ""}" data-filter="want">Want to Play <span class="count">${counts.want}</span></div>
  `;
  box.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      gFilter = tab.dataset.filter;
      renderGuitarFilterTabs();
      renderGuitarSongsList();
    });
  });
}

function renderGuitarSongsList() {
  const listEl = document.getElementById("guitar-songs-list");
  if (!listEl) return;
  const songs = filterGuitarSongs(guitarSongsCache, gFilter);

  if (songs.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">${gFilter === "all" ? "No songs yet" : gFilter === "liked" ? "No liked songs" : "Nothing on your want-to-play list"}</div>
        <p>${gFilter === "all" ? "Add a song to start your catalogue." : "Tag a song from the catalogue to see it here."}</p>
        ${gFilter === "all" ? `<button class="btn-accent" onclick="openAddSongModal()">+ Add song</button>` : ""}
      </div>`;
    return;
  }

  listEl.innerHTML = songs.map((s) => renderGuitarSongRow(s)).join("");
  wireGuitarSongRows();
}

function renderGuitarSongRow(song) {
  return `
    <div class="card-row ${song.link ? "guitar-row-linked" : ""}" data-song-id="${song.id}" ${song.link ? 'title="Double-click to open link"' : ""}>
      <div>
        <div class="title">${escapeHtml(song.title)}${song.link ? ` <span class="guitar-link-icon">&#128279;</span>` : ""}</div>
        <div class="meta">${song.artist ? escapeHtml(song.artist) : "Unknown artist"}${song.note ? " · " + escapeHtml(song.note) : ""}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn guitar-toggle-liked ${song.is_liked ? "guitar-liked-active" : ""}" data-song-id="${song.id}" title="Liked">&#9825;</button>
        <button class="icon-btn guitar-toggle-want ${song.is_want_to_play ? "guitar-want-active" : ""}" data-song-id="${song.id}" title="Want to play">&#9734;</button>
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
}

function openAddSongModal(songId) {
  const existing = songId ? guitarSongsCache.find((s) => s.id === songId) : null;

  openModal(`
    <h3>${existing ? "Edit song" : "Add song"}</h3>
    <form id="song-form">
      <div class="field">
        <label>Title</label>
        <input type="text" id="song-title" required autofocus value="${existing ? escapeHtml(existing.title) : ""}" />
      </div>
      <div class="field">
        <label>Artist</label>
        <input type="text" id="song-artist" value="${existing ? escapeHtml(existing.artist || "") : ""}" />
      </div>
      <div class="field">
        <label>Link</label>
        <input type="url" id="song-link" value="${existing ? escapeHtml(existing.link || "") : ""}" />
      </div>
      <div class="field">
        <label>Note</label>
        <input type="text" id="song-note" value="${existing ? escapeHtml(existing.note || "") : ""}" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">${existing ? "Save" : "Add"}</button>
      </div>
    </form>
  `);

  document.getElementById("song-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("song-title").value.trim();
    if (!title) return;

    const payload = {
      title,
      artist: document.getElementById("song-artist").value.trim() || null,
      link: document.getElementById("song-link").value.trim() || null,
      note: document.getElementById("song-note").value.trim() || null,
    };

    const { error } = existing
      ? await supabaseClient.from("guitar_songs").update(payload).eq("id", existing.id)
      : await supabaseClient.from("guitar_songs").insert(payload);

    if (error) {
      alert(`Failed to ${existing ? "save" : "add"} song: ` + error.message);
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

  const songs = filterGuitarSongs(guitarSongsCache, gFilter);

  document.getElementById("m-main").innerHTML = `
    <div class="m-chip-row" id="m-guitar-filter-row">
      <div class="m-chip ${gFilter === "all" ? "active" : ""}" data-filter="all">Catalogue</div>
      <div class="m-chip ${gFilter === "liked" ? "active" : ""}" data-filter="liked">Liked</div>
      <div class="m-chip ${gFilter === "want" ? "active" : ""}" data-filter="want">Want to Play</div>
    </div>

    <div class="m-set-list-label" style="display:flex;justify-content:space-between;align-items:center;">
      <span>${songs.length} song${songs.length === 1 ? "" : "s"}</span>
      <div style="display:flex;gap:8px;">
        <button type="button" class="btn-ghost" id="m-guitar-add-btn" style="padding:5px 12px;font-size:11px;">+ Add Songs</button>
        ${songs.length > 0 ? `<button type="button" class="btn-ghost" id="m-guitar-clear-all-btn" style="padding:5px 12px;font-size:11px;">Clear All</button>` : ""}
      </div>
    </div>

    <div id="m-guitar-list">
      ${songs.length === 0
        ? `<div class="m-empty" style="padding:40px 0;height:auto;">
            <div class="big">${gFilter === "all" ? "No songs yet" : gFilter === "liked" ? "No liked songs" : "Nothing to play yet"}</div>
            <p>${gFilter === "all" ? "Tap Add Songs to start." : "Tag a song from the catalogue."}</p>
          </div>`
        : songs.map((s) => renderGuitarSongRowMobile(s)).join("")}
    </div>
  `;

  wireGuitarMobileScreen();
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
          <div class="detail">${song.artist ? escapeHtmlMobile(song.artist) : "Unknown artist"}${song.note ? " · " + escapeHtmlMobile(song.note) : ""}</div>
        </div>
        <div class="m-set-row-actions">
          <button class="m-guitar-icon-btn ${song.is_liked ? "liked-active" : ""}" data-action="liked" data-song-id="${song.id}" type="button">&#9825;</button>
          <button class="m-guitar-icon-btn ${song.is_want_to_play ? "want-active" : ""}" data-action="want" data-song-id="${song.id}" type="button">&#9734;</button>
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

  document.getElementById("m-guitar-add-btn").addEventListener("click", openAddSongSheetMobile);

  const clearBtn = document.getElementById("m-guitar-clear-all-btn");
  if (clearBtn) clearBtn.addEventListener("click", clearAllGuitar);

  document.querySelectorAll("#m-guitar-list .m-guitar-icon-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.action === "edit") {
        const song = guitarSongsCache.find((s) => s.id === btn.dataset.songId);
        if (song) openAddSongSheetMobile(song);
        return;
      }
      const field = btn.dataset.action === "liked" ? "is_liked" : "is_want_to_play";
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
      alert("Failed to delete: " + error.message);
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
          <input type="text" id="m-song-title" autofocus value="${existing ? escapeHtmlMobile(existing.title) : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Artist</div>
          <input type="text" id="m-song-artist" value="${existing ? escapeHtmlMobile(existing.artist || "") : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Link</div>
          <input type="url" id="m-song-link" value="${existing ? escapeHtmlMobile(existing.link || "") : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
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
    };

    beginMutation();
    const { error } = existing
      ? await supabaseClient.from("guitar_songs").update(payload).eq("id", existing.id)
      : await supabaseClient.from("guitar_songs").insert(payload);
    endMutation();

    if (error) {
      alert(`Failed to ${existing ? "save" : "add"} song: ` + error.message);
      btn.disabled = false;
      btn.textContent = existing ? "Save" : "Add Song";
      return;
    }

    overlay.remove();
    await refreshGuitarAfterAction();
  });
}
