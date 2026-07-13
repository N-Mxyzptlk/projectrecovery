// mobile.js
// Mobile is deliberately narrow in scope: start a workout, log sets fast,
// browse the journal, glance at settings. No creating/editing stations here
// — that stays on desktop. Reuses `stationsCache` and
// `currentUserId` from desktop.js (loaded first), `supabaseClient` /
// `checkConnectivity` / `signOut` from dbclient.js.

let mCurrentWorkout = null;
let mSessionNumber = null;
let mSessionTimerInterval = null;

let mSelectedStationId = null;
let mRepsValue = 8;
let mWeightValue = 20;
let mWeightIncrement = 2.5;
let mBaselineReps = null; // last time's final set, for the increase/decrease tint
let mBaselineWeight = null;
let mStationHistory = null; // { lastSets: [...], lastDate, prWeight }
let mIsPRAttemptMode = false;
let mPendingPRSetId = null; // set awaiting a Success/Failure tag

/* ============================================
   Screen Wake Lock — keeps the phone from dimming/locking while the active
   workout logging screen is up (same idea as a video player keeping the
   screen on mid-playback), and nowhere else in the app. The browser
   auto-releases the lock whenever the tab is hidden (app backgrounded,
   phone locked) and does NOT auto-reacquire it — the visibilitychange
   listener at the bottom of this section is what re-requests it if the
   user comes back mid-session.
   ============================================ */
let mWakeLock = null;

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || mWakeLock) return;
  try {
    mWakeLock = await navigator.wakeLock.request("screen");
    mWakeLock.addEventListener("release", () => {
      mWakeLock = null;
    });
  } catch (e) {
    // Not supported, or denied (e.g. low battery) — logging still works
    // fine without it, so this is silently non-fatal.
  }
}

function releaseWakeLock() {
  if (mWakeLock) mWakeLock.release();
  mWakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && mApp === "workout" && mScreen === "log" && mCurrentWorkout) {
    acquireWakeLock();
  }
});

let mFinishConfirmPending = false;
let mFinishConfirmTimeout = null;

let mScreen = "log"; // 'dashboard' | 'log' | 'journal'
let mJournalDate = new Date();

let mApp = "home"; // 'home' | 'workout' | 'finance' | 'guitar' — which app the mobile shell is showing
let mLastUpdatedAt = null; // stamped whenever a screen (re)loads its data — shown in the Settings sheet

/** Mirrors desktop's touchLastUpdated, but mobile has no single switchView
 *  chokepoint to hang it off — called explicitly wherever a screen finishes
 *  loading fresh data instead. */
function touchLastUpdatedMobile() {
  mLastUpdatedAt = new Date();
  const el = document.getElementById("m-settings-last-updated-text");
  if (el) el.textContent = "Last updated: " + formatLastUpdated(mLastUpdatedAt);
}

/* ============================================
   Boot
   ============================================ */
async function initMobileApp(session) {
  currentUserId = session.user.id;
  document.getElementById("mobile-app").classList.remove("hidden");
  document.getElementById("m-fab-stack").classList.remove("hidden");
  document.getElementById("m-drawer-handle").classList.remove("hidden");

  await loadNavAppsPref(); // defined in dbclient.js — shared with the desktop sidebar and Settings' editor
  renderFabStack();
  wireAppDrawer();
  document.getElementById("m-fab-hidden-nub").addEventListener("click", showFabStackFromNub);

  loadStationsForMobile(); // preload for when the user switches into Workout

  renderHomeScreenMobile(); // defined in home.js — Home is the default landing screen
  touchLastUpdatedMobile();

  checkConnectivity();
  setInterval(checkConnectivity, 60000);
  initAutoLogout();
}

let mFabToggleLongPressed = false;

function toggleFabStack() {
  if (mFabToggleLongPressed) {
    // The pointerup that ends a long-press also fires a click right after —
    // swallow that one click so it doesn't immediately re-expand what the
    // long-press just hid.
    mFabToggleLongPressed = false;
    return;
  }
  document.getElementById("m-fab-stack").classList.toggle("collapsed");
}

function collapseFabStack() {
  document.getElementById("m-fab-stack").classList.add("collapsed");
}

/** Long-press the toggle to hide the whole stack, not just collapse it —
 *  for when it's sitting over something the user actually needs to tap.
 *  A small nub (bottom-right, see index.html) is always there to bring it
 *  back, so hiding it can never strand anyone without quick actions. */
function wireFabToggleLongPress(toggleBtn) {
  const HOLD_MS = 500;
  const MOVE_TOLERANCE = 10;
  let timer = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  toggleBtn.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      mFabToggleLongPressed = true;
      hideFabStackFully();
    }, HOLD_MS);
  });
  toggleBtn.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE)) cancel();
  });
  toggleBtn.addEventListener("pointerup", cancel);
  toggleBtn.addEventListener("pointercancel", cancel);
}

function hideFabStackFully() {
  document.getElementById("m-fab-stack").classList.add("fully-hidden");
  document.getElementById("m-fab-hidden-nub").classList.remove("hidden");
}

function showFabStackFromNub() {
  const stack = document.getElementById("m-fab-stack");
  stack.classList.remove("fully-hidden");
  stack.classList.add("collapsed");
  document.getElementById("m-fab-hidden-nub").classList.add("hidden");
}

/** Shows a small red "Field required" hint right under an input — used
 *  wherever a sheet used to just silently no-op on submit if a required
 *  field was empty, which left people thinking the app was broken rather
 *  than realizing what they'd missed. Self-clears on the next keystroke. */
function showFieldRequired(inputEl) {
  if (!inputEl) return;
  clearFieldRequired(inputEl);
  const msg = document.createElement("div");
  msg.className = "m-field-error";
  msg.textContent = "Field required";
  inputEl.insertAdjacentElement("afterend", msg);
  inputEl.classList.add("m-field-invalid");
  inputEl.focus();
  const clear = () => {
    clearFieldRequired(inputEl);
    inputEl.removeEventListener("input", clear);
  };
  inputEl.addEventListener("input", clear);
}

function clearFieldRequired(inputEl) {
  if (!inputEl) return;
  inputEl.classList.remove("m-field-invalid");
  const next = inputEl.nextElementSibling;
  if (next && next.classList.contains("m-field-error")) next.remove();
}

/** FAB contents are per-app: rebuilt on boot and on every app switch,
 *  rather than static markup, since Workout and Finance need different
 *  quick actions. The toggle is always first in the DOM so column-reverse
 *  anchors it at the bottom corner (see index.html's m-fab-stack comment). */
function renderFabStack() {
  const stack = document.getElementById("m-fab-stack");
  const extraFabs =
    mApp === "workout"
      ? `
      <button class="m-fab ${mScreen === "dashboard" ? "active" : ""}" id="m-dashboard-fab" aria-label="Dashboard">▦</button>
      <button class="m-fab ${mScreen === "journal" ? "active" : ""}" id="m-journal-fab" aria-label="Journal">▤</button>
      <button class="m-fab" id="m-add-station-fab" aria-label="Add station">+</button>
    `
      : mApp === "finance"
      ? `
      <button class="m-fab ${fScreen === "dashboard" ? "active" : ""}" id="m-fin-dashboard-fab" aria-label="Dashboard">▦</button>
      <button class="m-fab ${fScreen === "due" ? "active" : ""}" id="m-payments-due-fab" aria-label="Payments due">▤</button>
      <button class="m-fab ${fScreen === "log" ? "active" : ""}" id="m-log-expense-fab" aria-label="Log expense">+</button>
    `
      : mApp === "guitar"
      ? `
      <button class="m-fab" id="m-add-song-fab" aria-label="Add song">+</button>
    `
      : mApp === "movies"
      ? `
      <button class="m-fab" id="m-add-movie-fab" aria-label="Add title">+</button>
    `
      : ""; // home has no sub-screens — just the toggle + settings below

  stack.innerHTML = `
    <button class="m-fab m-fab-toggle" id="m-fab-toggle" aria-label="More">⋯</button>
    <button class="m-fab" id="m-settings-fab" aria-label="Settings">⚙</button>
    ${extraFabs}
  `;

  const fabToggleBtn = document.getElementById("m-fab-toggle");
  fabToggleBtn.addEventListener("click", toggleFabStack);
  wireFabToggleLongPress(fabToggleBtn);
  document.getElementById("m-settings-fab").addEventListener("click", () => {
    collapseFabStack();
    openSettingsSheet();
  });

  if (mApp === "workout") {
    document.getElementById("m-dashboard-fab").addEventListener("click", () => {
      collapseFabStack();
      setWorkoutMobileScreen("dashboard");
    });
    document.getElementById("m-journal-fab").addEventListener("click", () => {
      collapseFabStack();
      setWorkoutMobileScreen("journal");
    });
    document.getElementById("m-add-station-fab").addEventListener("click", () => {
      collapseFabStack();
      openAddStationSheet();
    });
  } else if (mApp === "finance") {
    document.getElementById("m-fin-dashboard-fab").addEventListener("click", () => {
      collapseFabStack();
      setFinanceMobileScreen("dashboard"); // defined in finance.js
    });
    document.getElementById("m-payments-due-fab").addEventListener("click", () => {
      collapseFabStack();
      setFinanceMobileScreen("due"); // defined in finance.js
    });
    document.getElementById("m-log-expense-fab").addEventListener("click", () => {
      collapseFabStack();
      setFinanceMobileScreen("log"); // defined in finance.js
    });
  } else if (mApp === "guitar") {
    document.getElementById("m-add-song-fab").addEventListener("click", () => {
      collapseFabStack();
      openAddSongSheetMobile(); // defined in guitar.js
    });
  } else if (mApp === "movies") {
    document.getElementById("m-add-movie-fab").addEventListener("click", () => {
      collapseFabStack();
      openMovieSheetMobile(); // defined in movies.js
    });
  }
}

/* ============================================
   App-switcher drawer — tap the edge handle, or drag right from most of
   the screen width, to open it; drag left (or tap the backdrop) to close.
   ============================================ */
/** Renders the drawer's app list from resolvedNavApps() (dbclient.js) —
 *  called at boot and again after the Settings editor saves a change, same
 *  as desktop's renderSidebarNavItems. */
function renderDrawerNavItems() {
  const box = document.getElementById("m-drawer-nav-items");
  box.innerHTML = resolvedNavApps()
    .map(
      (m) => `
    <div class="m-drawer-app-item ${m.app === mApp ? "active" : ""}" data-app="${m.app}">
      <div class="m-drawer-app-name">${escapeHtmlMobile(m.label)}</div>
    </div>`
    )
    .join("");
  box.querySelectorAll(".m-drawer-app-item").forEach((item) => {
    item.addEventListener("click", () => switchMobileApp(item.dataset.app));
  });
}

function wireAppDrawer() {
  document.getElementById("m-drawer-handle").addEventListener("click", openAppDrawer);
  document.getElementById("m-app-drawer-overlay").addEventListener("click", (e) => {
    if (e.target.id === "m-app-drawer-overlay") closeAppDrawer();
  });
  renderDrawerNavItems();
  attachEdgeSwipeDrawer();

  document.getElementById("m-drawer-refresh-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add("refreshing");
    btn.textContent = "Refreshing...";

    await loadNavAppsPref(); // defined in dbclient.js — re-pulls profiles.nav_apps (e.g. after changing it on another device)
    renderDrawerNavItems();
    if (mApp === "home") renderHomeScreenMobile(); // Shortcuts widget reflects it too, if currently visible

    btn.textContent = "↻ Refresh";
    setTimeout(() => btn.classList.remove("refreshing"), 400);
  });
}

function openAppDrawer() {
  const overlay = document.getElementById("m-app-drawer-overlay");
  document.querySelectorAll(".m-drawer-app-item").forEach((i) => i.classList.toggle("active", i.dataset.app === mApp));
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function closeAppDrawer() {
  const overlay = document.getElementById("m-app-drawer-overlay");
  overlay.classList.remove("open");
  setTimeout(() => overlay.classList.add("hidden"), 220); // matches CSS transition duration
}

function switchMobileApp(appName) {
  if (appName === mApp) return closeAppDrawer();
  mApp = appName;
  if (appName !== "home") stopHomeClock();
  if (appName !== "workout") releaseWakeLock();
  closeAppDrawer();
  renderFabStack();

  if (mApp === "workout") {
    if (mScreen === "dashboard") renderWorkoutDashboardMobile();
    else if (mScreen === "journal") renderJournalScreen();
    else loadActiveWorkout(); // re-check for an active session and re-render
  } else if (mApp === "finance") {
    initFinanceMobile(); // defined in finance.js
  } else if (mApp === "guitar") {
    initGuitarMobile(); // defined in guitar.js
  } else if (mApp === "movies") {
    initMoviesMobile(); // defined in movies.js
  } else {
    renderHomeScreenMobile(); // defined in home.js
  }
  touchLastUpdatedMobile();
}

/** Drags the drawer open/closed live, following the finger the whole way
 *  (not just watching for a threshold and then snapping) — same direct
 *  transform-while-dragging + CSS-transition-on-release pattern as
 *  attachGuitarSongSwipe (guitar.js). Two entry points share the drag
 *  logic: `#mobile-app` starts an "opening" drag (closed -> open), and the
 *  drawer overlay itself starts a "closing" drag (open -> closed) — they
 *  have to be separate listeners because the overlay isn't a descendant of
 *  #mobile-app, so pointer events on one never bubble to the other. */
function attachEdgeSwipeDrawer() {
  // Fraction of screen width, not a fixed px count, so the reachable
  // swipe-start zone scales with device size. Computed fresh per
  // pointerdown so rotating the device is picked up automatically.
  const OPEN_ZONE_RATIO = 0.8;
  const VERTICAL_CANCEL = 40; // px of vertical drift that cancels it (it's a scroll, not a swipe)
  const DRAG_START_THRESHOLD = 4; // px before a pointerdown is treated as a drag rather than a tap
  const COMMIT_RATIO = 0.35; // drag past 35% of the drawer's width before release keeps it open/closed

  // Elements that own their own horizontal swipe gesture (e.g. the journal
  // card's swipe-to-reveal-actions) must win over the drawer swipe.
  const SWIPE_OWNER_SELECTOR = ".m-swipe-owns-gesture";

  const mainRoot = document.getElementById("mobile-app");
  const overlay = document.getElementById("m-app-drawer-overlay");
  const drawer = document.getElementById("m-app-drawer");

  let startX = null;
  let startY = null;
  let dragging = false;
  let committed = false;
  let mode = null; // 'opening' | 'closing'
  let activeRoot = null;
  let pointerId = null;
  let drawerWidth = 0;
  let rafId = null;
  let pendingProgress = null;

  // Coalesces to one style write per animation frame instead of one per
  // pointermove (touch input can fire faster than the display refreshes) —
  // this is what actually made the drag track the finger smoothly instead
  // of feeling laggy/janky, on top of the touch-action fix above.
  function setLiveProgress(progress) {
    pendingProgress = Math.max(0, Math.min(1, progress));
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      drawer.style.transition = "none";
      overlay.style.transition = "none";
      drawer.style.transform = `translateX(${(pendingProgress - 1) * 100}%)`;
      overlay.style.opacity = String(pendingProgress);
    });
  }

  /** Hands off from the live drag to a real transition, animating from
   *  wherever the drag left off rather than snapping — openAppDrawer/
   *  closeAppDrawer defer the "open" class by a frame (needed when starting
   *  from display:none), which would show a one-frame flash back to fully
   *  closed here since the overlay is already visible mid-drag. */
  function settle(open) {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    drawer.style.transition = "";
    overlay.style.transition = "";
    if (open) {
      overlay.classList.remove("hidden");
      overlay.classList.add("open");
      document.querySelectorAll(".m-drawer-app-item").forEach((i) => i.classList.toggle("active", i.dataset.app === mApp));
    } else {
      overlay.classList.remove("open");
      setTimeout(() => overlay.classList.add("hidden"), 220); // matches CSS transition duration
    }
    drawer.style.transform = "";
    overlay.style.opacity = "";
  }

  function startDrag(e, dragMode, rootEl) {
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    committed = false;
    mode = dragMode;
    activeRoot = rootEl;
    pointerId = e.pointerId;
    drawerWidth = drawer.getBoundingClientRect().width || window.innerWidth * 0.78;
  }

  function handleMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = Math.abs(e.clientY - startY);
    if (!committed) {
      if (dy > VERTICAL_CANCEL) {
        dragging = false;
        return;
      }
      if (Math.abs(dx) < DRAG_START_THRESHOLD) return;
      committed = true;
      if (mode === "opening") overlay.classList.remove("hidden");
      try {
        activeRoot.setPointerCapture(pointerId);
      } catch (err) {}
    }
    const progress = mode === "opening" ? dx / drawerWidth : 1 + dx / drawerWidth;
    setLiveProgress(progress);
  }

  function handleRelease(e) {
    if (!dragging) return;
    dragging = false;
    if (!committed) {
      startX = null;
      return;
    }
    const dx = e.clientX - startX;
    const progress = mode === "opening" ? dx / drawerWidth : 1 + dx / drawerWidth;
    settle(progress > COMMIT_RATIO);
    startX = null;
  }

  mainRoot.addEventListener("pointerdown", (e) => {
    if (overlay.classList.contains("open")) return; // the overlay's own listener owns this state
    if (e.target.closest(SWIPE_OWNER_SELECTOR)) return;
    const edgeZonePx = window.innerWidth * OPEN_ZONE_RATIO;
    if (e.clientX > edgeZonePx) return;
    startDrag(e, "opening", mainRoot);
  });
  mainRoot.addEventListener("pointermove", handleMove);
  mainRoot.addEventListener("pointerup", handleRelease);
  mainRoot.addEventListener("pointercancel", handleRelease);

  overlay.addEventListener("pointerdown", (e) => {
    if (!overlay.classList.contains("open")) return;
    startDrag(e, "closing", overlay);
  });
  overlay.addEventListener("pointermove", handleMove);
  overlay.addEventListener("pointerup", handleRelease);
  overlay.addEventListener("pointercancel", handleRelease);
}

async function loadStationsForMobile() {
  if (stationsCache && stationsCache.length > 0) return;
  const { data, error } = await supabaseClient.from("stations").select("*").order("name");
  if (!error) stationsCache = data || [];
}

/** Tapping a screen's FAB while already on that screen returns to the
 *  default 'log' screen — the same toggle behavior the Journal FAB always
 *  had, generalized now that there's a third screen (Dashboard). */
function setWorkoutMobileScreen(target) {
  mScreen = mScreen === target ? "log" : target;
  if (mScreen !== "log") releaseWakeLock();
  renderFabStack();

  if (mScreen === "dashboard") {
    renderWorkoutDashboardMobile();
  } else if (mScreen === "journal") {
    mJournalDate = new Date();
    renderJournalScreen();
  } else {
    if (mCurrentWorkout) renderActiveSession();
    else renderStartPrompt();
  }
  touchLastUpdatedMobile();
}

/** Compact mirror of the desktop dashboard: same stats, same shared
 *  computeWorkoutDashboardStats() query, laid out for one thumb. */
async function renderWorkoutDashboardMobile() {
  document.getElementById("m-topbar").innerHTML = `
    <div class="m-topbar-row">
      <button type="button" class="m-topbar-back-btn" id="m-workout-dash-back-btn" aria-label="Back">&#8249;</button>
      <div>
        <div class="m-title">WORKOUT</div>
        <div class="m-date">${new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
      </div>
    </div>
  `;
  document.getElementById("m-workout-dash-back-btn").addEventListener("click", () => setWorkoutMobileScreen("log"));

  const main = document.getElementById("m-main");
  main.innerHTML = `<div class="m-empty" style="padding:40px 0;height:auto;"><p>Loading...</p></div>`;

  const [stats, recentWorkouts] = await Promise.all([
    computeWorkoutDashboardStats(), // defined in desktop.js
    loadRecentWorkoutsForDashboard(),
  ]);
  if (mScreen !== "dashboard") return; // user navigated away while this was loading

  if (!stats) {
    main.innerHTML = `<div class="m-empty" style="padding:40px 0;height:auto;"><p>Error loading stats.</p></div>`;
    return;
  }

  main.innerHTML = `
    <div class="m-dash-stats-grid">
      <div class="m-dash-stat-tile">
        <div class="label">Days since last log</div>
        <div class="value">${formatDaysSinceLog(stats.daysSinceLastLog)}</div>
      </div>
      <div class="m-dash-stat-tile">
        <div class="label">Best improved</div>
        <div class="value" style="font-size:14px;">${stats.bestImprovedStation ? `${escapeHtmlMobile(stats.bestImprovedStation.name)} +${Math.round(stats.bestImprovedStation.pct)}%` : "—"}</div>
      </div>
      <div class="m-dash-stat-tile" style="grid-column: span 2;">
        <div class="label">Biggest gain (30d)</div>
        <div class="value" style="font-size:15px;">${stats.biggestGain ? `${escapeHtmlMobile(stats.biggestGain.name)} +${Math.round(stats.biggestGain.delta * 10) / 10}kg` : "—"}</div>
      </div>
    </div>

    <div class="m-dash-quick-actions">
      <button type="button" class="m-dash-quick-action" id="m-dash-start-workout">${mCurrentWorkout ? "Continue Workout" : "Start Workout"}</button>
      <button type="button" class="m-dash-quick-action" id="m-dash-view-journal">View Journal</button>
    </div>

    <div class="m-set-list-label">Recent sessions</div>
    <div id="m-dash-recent-workouts">${renderRecentWorkoutsListMobile(recentWorkouts)}</div>
    ${recentWorkouts.length > 0 ? `<div class="meta-line" style="text-align:center;margin-top:10px;color:var(--text-faint);font-size:11px;">Hold a session for details</div>` : ""}
  `;

  document.getElementById("m-dash-start-workout").addEventListener("click", () => setWorkoutMobileScreen("log"));
  document.getElementById("m-dash-view-journal").addEventListener("click", () => setWorkoutMobileScreen("journal"));

  document.querySelectorAll("#m-dash-recent-workouts .m-dash-recent-row").forEach((row) => {
    const workout = recentWorkouts.find((w) => w.id === row.dataset.workoutId);
    if (workout) attachRecentWorkoutHold(row, workout);
  });
}

/** Last 5 sessions, sets included — fills the dead space below the quick
 *  actions and gives holding a row somewhere to go (same detail sheet the
 *  Journal already uses, so no new UI to maintain). */
async function loadRecentWorkoutsForDashboard() {
  const { data, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .order("started_at", { ascending: false })
    .limit(5);
  return error ? [] : data || [];
}

function renderRecentWorkoutsListMobile(workouts) {
  if (workouts.length === 0) {
    return `<div class="m-empty" style="padding:20px 0;height:auto;"><p>No sessions logged yet.</p></div>`;
  }
  return workouts
    .map((w) => {
      const stationCount = new Set(w.workout_sets.map((s) => s.station_id)).size;
      const setCount = w.workout_sets.length;
      return `
      <div class="m-dash-recent-row" data-workout-id="${w.id}">
        <div class="info">
          <div class="name">${escapeHtmlMobile(w.name || "Workout")}</div>
          <div class="detail">${new Date(w.started_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${stationCount} station${stationCount === 1 ? "" : "s"} · ${setCount} set${setCount === 1 ? "" : "s"}</div>
        </div>
      </div>`;
    })
    .join("");
}

/** Hold a row to open the same detail sheet the Journal uses — same
 *  HOLD_MS/tolerance pattern as attachPaymentLongPress. */
function attachRecentWorkoutHold(row, workout) {
  const HOLD_MS = 450;
  const MOVE_TOLERANCE = 10;
  let timer = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  row.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => openJournalDetailSheet(workout), HOLD_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE)) cancel();
  });
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointercancel", cancel);
}

/* ============================================
   Resume an in-progress workout (any date — sessions run until
   explicitly finished), or prompt to start one.
   ============================================ */
async function loadActiveWorkout() {
  const { data, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error(error);
    renderStartPrompt();
    return;
  }

  if (data && data.length > 0) {
    mCurrentWorkout = data[0];
    mSessionNumber = await computeSessionNumberFor(mCurrentWorkout.id);
    renderActiveSession();
  } else {
    renderStartPrompt();
  }
}

/** Session number = how many workouts (including this one) existed at the
 *  time it was created — i.e. its 1-based position in all-time order. */
async function computeSessionNumberFor(workoutId) {
  const { count } = await supabaseClient
    .from("workouts")
    .select("id", { count: "exact", head: true })
    .lte("started_at", mCurrentWorkout.started_at);
  return count || 1;
}

/* ============================================
   IDLE STATE — no active workout
   ============================================ */
function renderStartPrompt() {
  releaseWakeLock(); // no active session — nothing here needs the screen kept on
  document.getElementById("m-topbar").innerHTML = `
    <div>
      <div class="m-title">WORKOUT</div>
      <div class="m-date">${new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
    </div>
  `;

  document.getElementById("m-main").innerHTML = `
    <div class="m-empty">
      <div class="big">No active workout</div>
      <p>Start one to begin logging sets.</p>
      <button class="m-start-btn" id="m-start-btn">Start Workout</button>
    </div>
  `;
  document.getElementById("m-start-btn").addEventListener("click", startWorkout);
}

async function startWorkout() {
  const btn = document.getElementById("m-start-btn");
  btn.disabled = true;
  btn.textContent = "Starting...";

  const { count } = await supabaseClient.from("workouts").select("id", { count: "exact", head: true });
  const nextSessionNumber = (count || 0) + 1;

  beginMutation();
  const { data, error } = await supabaseClient
    .from("workouts")
    .insert({
      started_at: new Date().toISOString(),
      name: `Session ${nextSessionNumber}`,
    })
    .select("*, workout_sets(*, stations(name))")
    .single();
  endMutation();

  if (error) {
    await uiAlert("Couldn't start workout: " + error.message);
    btn.disabled = false;
    btn.textContent = "Start Workout";
    return;
  }

  mCurrentWorkout = data;
  mSessionNumber = nextSessionNumber;
  mSelectedStationId = null;
  mStationHistory = null;
  renderActiveSession();
}

/* ============================================
   ACTIVE SESSION — top bar + logging UI
   ============================================ */
function renderSessionTopbar() {
  document.getElementById("m-topbar").innerHTML = `
    <div class="m-session-bar">
      <div class="m-session-bar-left">
        <span class="m-session-pulse"></span>
        <span class="m-session-label">SESSION #${mSessionNumber}</span>
      </div>
      <span class="status-dot m-session-status-dot" id="m-session-status-dot"></span>
      <div class="m-session-timer" id="m-session-timer">00:00</div>
      <button class="m-finish-btn" id="m-finish-btn">Finish</button>
    </div>
  `;

  document.getElementById("m-finish-btn").addEventListener("click", handleFinishClick);
  refreshStatusLights(); // this is the moment the status light actually matters — show it now, not just in Settings

  if (mSessionTimerInterval) clearInterval(mSessionTimerInterval);
  updateSessionTimer();
  mSessionTimerInterval = setInterval(updateSessionTimer, 1000);
}

function updateSessionTimer() {
  const el = document.getElementById("m-session-timer");
  if (!el || !mCurrentWorkout) return;
  const elapsedMs = Date.now() - new Date(mCurrentWorkout.started_at);
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  el.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function renderActiveSession() {
  acquireWakeLock(); // keep the screen on while actively logging, same idea as a video player mid-playback
  renderSessionTopbar();

  const main = document.getElementById("m-main");
  const chips = stationsCache.slice(0, 6);

  if (!mSelectedStationId && chips.length > 0) {
    mSelectedStationId = chips[0].id;
  }

  main.innerHTML = `
    <div class="m-station-row" id="m-station-row">
      ${chips
        .map(
          (s) => `<div class="m-station-chip ${s.id === mSelectedStationId ? "active" : ""}" data-id="${s.id}">${escapeHtmlMobile(s.name)}</div>`
        )
        .join("")}
      <div class="m-station-chip more" id="m-more-stations">More...</div>
    </div>

    <div id="m-continuity-slot"></div>

    <div class="m-log-card">
      <div class="selected-station" id="m-selected-station-name">${selectedStationName()}</div>

      <div class="m-stepper-full">
        <div class="m-stepper-label">Reps</div>
        <div class="m-stepper-control">
          <button class="m-stepper-btn" id="m-reps-minus" type="button">−</button>
          <input class="m-stepper-value" id="m-reps-value" inputmode="numeric" value="${mRepsValue}" />
          <button class="m-stepper-btn" id="m-reps-plus" type="button">+</button>
        </div>
      </div>

      <div class="m-stepper-full">
        <div class="m-stepper-label">Weight (kg)</div>
        <div class="m-stepper-control">
          <button class="m-stepper-btn" id="m-weight-minus" type="button">−</button>
          <input class="m-stepper-value" id="m-weight-value" inputmode="decimal" value="${mWeightValue}" />
          <button class="m-stepper-btn" id="m-weight-plus" type="button">+</button>
        </div>
        <div class="m-increment-row" id="m-increment-row">
          ${[1, 2.5, 5, 10]
            .map(
              (v) => `<button type="button" class="m-increment-chip ${v === mWeightIncrement ? "active" : ""}" data-inc="${v}">±${v}</button>`
            )
            .join("")}
        </div>
      </div>

      <div class="m-log-actions">
        <button class="m-pr-toggle ${mIsPRAttemptMode ? "active" : ""}" id="m-pr-toggle" type="button">PR Attempt</button>
        <button class="m-log-btn" id="m-log-set-btn">${mIsPRAttemptMode ? "Log PR Attempt" : "Log Set"}</button>
      </div>
    </div>

    <div id="m-pr-tag-slot"></div>

    <div class="m-set-list-label">This session</div>
    <div id="m-set-list">${renderSetList()}</div>
  `;

  wireSessionEvents();
  loadStationHistory(mSelectedStationId);
}

function selectedStationName() {
  const s = stationsCache.find((st) => st.id === mSelectedStationId);
  return s ? escapeHtmlMobile(s.name) : "Pick a station";
}

function renderSetList() {
  const sets = [...mCurrentWorkout.workout_sets].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (sets.length === 0) {
    return `<div class="m-empty" style="padding:30px 0;height:auto;"><p>No sets yet — log your first one above.</p></div>`;
  }
  return sets
    .map((s) => {
      let prBadge = "";
      if (s.is_pr_attempt) {
        prBadge = s.pr_result === "success" ? `<span class="m-pr-tag success">ATTEMPT SUCCESS</span>`
          : s.pr_result === "failure" ? `<span class="m-pr-tag failure">ATTEMPT FAILED</span>`
          : `<span class="m-pr-tag pending">ATTEMPT PENDING</span>`;
      }
      return `
    <div class="m-set-row">
      <div class="info">
        <div class="name">${escapeHtmlMobile(s.stations.name)} ${prBadge}</div>
        <div class="detail">Set ${s.set_number} · ${s.reps} reps${s.weight ? ` @ ${s.weight}kg` : ""}</div>
      </div>
      <div class="m-set-row-actions">
        <button class="edit-btn" data-set-id="${s.id}" type="button">Edit</button>
        <button class="delete-btn" data-set-id="${s.id}" type="button">Delete</button>
      </div>
    </div>`;
    })
    .join("");
}

function wireSessionEvents() {
  document.querySelectorAll(".m-station-chip[data-id]").forEach((chip) => {
    chip.addEventListener("click", () => selectStation(chip.dataset.id));
  });

  document.getElementById("m-more-stations").addEventListener("click", openStationSheet);

  document.getElementById("m-reps-minus").addEventListener("click", () => adjustStepper("reps", -1));
  document.getElementById("m-reps-plus").addEventListener("click", () => adjustStepper("reps", 1));
  document.getElementById("m-weight-minus").addEventListener("click", () => adjustStepper("weight", -mWeightIncrement));
  document.getElementById("m-weight-plus").addEventListener("click", () => adjustStepper("weight", mWeightIncrement));

  document.querySelectorAll(".m-increment-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      mWeightIncrement = parseFloat(chip.dataset.inc);
      if (mSelectedStationId) saveWeightIncrementPref(mSelectedStationId, mWeightIncrement);
      document.querySelectorAll(".m-increment-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("m-reps-value").addEventListener("change", (e) => {
    mRepsValue = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = mRepsValue;
    updateStepperTints();
  });
  document.getElementById("m-weight-value").addEventListener("change", (e) => {
    mWeightValue = Math.max(0, parseFloat(e.target.value) || 0);
    e.target.value = mWeightValue;
    updateStepperTints();
  });

  document.getElementById("m-pr-toggle").addEventListener("click", () => {
    mIsPRAttemptMode = !mIsPRAttemptMode;
    renderActiveSession();
  });

  document.getElementById("m-log-set-btn").addEventListener("click", logSet);

  wireSetListButtons();
}

/** Attaches delete + edit-pencil handlers to whatever is currently in
 *  #m-set-list. Called after every full or partial re-render of that list. */
function wireSetListButtons() {
  document.querySelectorAll("#m-set-list .delete-btn[data-set-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSetMobile(btn.dataset.setId));
  });
  document.querySelectorAll("#m-set-list .edit-btn[data-set-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const set = mCurrentWorkout.workout_sets.find((s) => s.id === btn.dataset.setId);
      if (!set) return;
      openSetEditSheet(set, {
        onSaved: (updated) => {
          set.reps = updated.reps;
          set.weight = updated.weight;
          document.getElementById("m-set-list").innerHTML = renderSetList();
          wireSetListButtons();
        },
      });
    });
  });
}

function selectStation(stationId) {
  mSelectedStationId = stationId;
  mWeightIncrement = getWeightIncrementPref(stationId);
  renderActiveSession();
}

/* ============================================
   Per-station weight increment memory (device-local preference —
   real workout data always lives in Supabase, this is just a UX nicety)
   ============================================ */
function getWeightIncrementPref(stationId) {
  const saved = localStorage.getItem(`wt-increment-${stationId}`);
  return saved ? parseFloat(saved) : 2.5;
}

function saveWeightIncrementPref(stationId, value) {
  localStorage.setItem(`wt-increment-${stationId}`, String(value));
}

/* ============================================
   Edit an already-logged set — reps/weight only, via the same
   stepper + increment-chip pattern used for logging. Works both mid-
   session and from the Journal (any set, any time).
   ============================================ */
function openSetEditSheet(set, options) {
  let editReps = set.reps;
  let editWeight = set.weight || 0;
  let editIncrement = getWeightIncrementPref(set.station_id);
  const stationName = set.stations?.name || "";

  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block">
          <div class="label">Edit set — ${escapeHtmlMobile(stationName)}</div>
        </div>

        <div class="m-stepper-full">
          <div class="m-stepper-label">Reps</div>
          <div class="m-stepper-control">
            <button class="m-stepper-btn" id="m-edit-reps-minus" type="button">−</button>
            <input class="m-stepper-value" id="m-edit-reps-value" inputmode="numeric" value="${editReps}" />
            <button class="m-stepper-btn" id="m-edit-reps-plus" type="button">+</button>
          </div>
        </div>

        <div class="m-stepper-full">
          <div class="m-stepper-label">Weight (kg)</div>
          <div class="m-stepper-control">
            <button class="m-stepper-btn" id="m-edit-weight-minus" type="button">−</button>
            <input class="m-stepper-value" id="m-edit-weight-value" inputmode="decimal" value="${editWeight}" />
            <button class="m-stepper-btn" id="m-edit-weight-plus" type="button">+</button>
          </div>
          <div class="m-increment-row">
            ${[1, 2.5, 5, 10]
              .map((v) => `<button type="button" class="m-increment-chip ${v === editIncrement ? "active" : ""}" data-inc="${v}">±${v}</button>`)
              .join("")}
          </div>
        </div>
      </div>

      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-edit-set-save-btn" style="width:100%;max-width:none;margin-bottom:10px;">Save Changes</button>
        <button class="m-finish-btn" id="m-edit-set-cancel-btn" style="width:100%;padding:12px;">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("m-edit-reps-minus").addEventListener("click", () => {
    editReps = Math.max(0, editReps - 1);
    document.getElementById("m-edit-reps-value").value = editReps;
  });
  document.getElementById("m-edit-reps-plus").addEventListener("click", () => {
    editReps = editReps + 1;
    document.getElementById("m-edit-reps-value").value = editReps;
  });
  document.getElementById("m-edit-weight-minus").addEventListener("click", () => {
    editWeight = Math.max(0, +(editWeight - editIncrement).toFixed(2));
    document.getElementById("m-edit-weight-value").value = editWeight;
  });
  document.getElementById("m-edit-weight-plus").addEventListener("click", () => {
    editWeight = +(editWeight + editIncrement).toFixed(2);
    document.getElementById("m-edit-weight-value").value = editWeight;
  });

  overlay.querySelectorAll(".m-increment-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      editIncrement = parseFloat(chip.dataset.inc);
      saveWeightIncrementPref(set.station_id, editIncrement);
      overlay.querySelectorAll(".m-increment-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("m-edit-reps-value").addEventListener("change", (e) => {
    editReps = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = editReps;
  });
  document.getElementById("m-edit-weight-value").addEventListener("change", (e) => {
    editWeight = Math.max(0, parseFloat(e.target.value) || 0);
    e.target.value = editWeight;
  });

  document.getElementById("m-edit-set-cancel-btn").addEventListener("click", () => overlay.remove());

  document.getElementById("m-edit-set-save-btn").addEventListener("click", async () => {
    const btn = document.getElementById("m-edit-set-save-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    beginMutation();
    // NOT `editWeight || null` — same bug as logSet(): 0 is a real,
    // intentional bodyweight value, and `0 || null` was silently
    // corrupting it back to null on every edit too.
    const { error } = await supabaseClient
      .from("workout_sets")
      .update({ reps: editReps, weight: editWeight })
      .eq("id", set.id);
    endMutation();

    if (error) {
      await uiAlert("Failed to save: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save Changes";
      return;
    }

    overlay.remove();
    if (options && options.onSaved) options.onSaved({ reps: editReps, weight: editWeight });
  });
}

function adjustStepper(type, delta) {
  if (type === "reps") {
    mRepsValue = Math.max(0, mRepsValue + delta);
    document.getElementById("m-reps-value").value = mRepsValue;
  } else {
    mWeightValue = Math.max(0, +(mWeightValue + delta).toFixed(2));
    document.getElementById("m-weight-value").value = mWeightValue;
  }
  updateStepperTints();
}

/** Tints the reps/weight inputs green when above, red when below, what was
 *  logged last time for this station — a quiet guard against an accidental
 *  extra tap on the stepper going unnoticed. */
function updateStepperTints() {
  const repsInput = document.getElementById("m-reps-value");
  const weightInput = document.getElementById("m-weight-value");

  if (repsInput) {
    repsInput.classList.remove("increase", "decrease");
    if (mBaselineReps != null && mRepsValue !== mBaselineReps) {
      repsInput.classList.add(mRepsValue > mBaselineReps ? "increase" : "decrease");
    }
  }
  if (weightInput) {
    weightInput.classList.remove("increase", "decrease");
    if (mBaselineWeight != null && mWeightValue !== mBaselineWeight) {
      weightInput.classList.add(mWeightValue > mBaselineWeight ? "increase" : "decrease");
    }
  }
}

/* ============================================
   Continuity — "where did I leave off" for the selected station
   ============================================ */
async function loadStationHistory(stationId) {
  const slot = document.getElementById("m-continuity-slot");
  if (!slot || !stationId) return;
  slot.innerHTML = "";
  mBaselineReps = null;
  mBaselineWeight = null;
  updateStepperTints();

  const [lastWorkoutRes, prRes] = await Promise.all([
    supabaseClient
      .from("workout_sets")
      .select("*, workouts!inner(id, started_at)")
      .eq("station_id", stationId)
      .neq("workout_id", mCurrentWorkout.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabaseClient.from("workout_sets").select("weight").eq("station_id", stationId).order("weight", { ascending: false }).limit(1),
  ]);

  const prWeight = prRes.data && prRes.data.length > 0 ? prRes.data[0].weight : null;

  if (!lastWorkoutRes.data || lastWorkoutRes.data.length === 0) {
    mStationHistory = { lastSets: [], prWeight };
    if (prWeight) renderContinuityCard();
    return;
  }

  const mostRecentWorkoutId = lastWorkoutRes.data[0].workouts.id;
  const lastSets = lastWorkoutRes.data
    .filter((s) => s.workouts.id === mostRecentWorkoutId)
    .sort((a, b) => a.set_number - b.set_number);

  mStationHistory = {
    lastSets,
    lastDate: lastSets[0]?.workouts?.started_at,
    prWeight,
  };

  // Speed win: prefill reps/weight with the last time's final set so the
  // person can just tap Log Set to repeat, or nudge from there. That value
  // also becomes the baseline the stepper tints against.
  const lastSet = lastSets[lastSets.length - 1];
  if (lastSet) {
    mRepsValue = lastSet.reps;
    mWeightValue = lastSet.weight != null ? lastSet.weight : mWeightValue;
    mBaselineReps = lastSet.reps;
    mBaselineWeight = lastSet.weight != null ? lastSet.weight : null;
    const repsInput = document.getElementById("m-reps-value");
    const weightInput = document.getElementById("m-weight-value");
    if (repsInput) repsInput.value = mRepsValue;
    if (weightInput) weightInput.value = mWeightValue;
    updateStepperTints();
  }

  renderContinuityCard();
}

function renderContinuityCard() {
  const slot = document.getElementById("m-continuity-slot");
  if (!slot || !mStationHistory) return;

  const { lastSets, lastDate, prWeight } = mStationHistory;
  if ((!lastSets || lastSets.length === 0) && !prWeight) {
    slot.innerHTML = "";
    return;
  }

  // Sets as individual chips instead of one dense comma-joined string —
  // a wall of "12×20kg, 10×20kg, 8×22.5kg, ..." gets unreadable fast once
  // there are more than 2-3 sets. The heaviest set is highlighted so the
  // "how strong was I last time" question has one obvious answer at a
  // glance instead of making the user scan and compare every number.
  let lastSetsHtml = "";
  if (lastSets && lastSets.length > 0) {
    const maxWeight = Math.max(...lastSets.map((s) => s.weight || 0));
    const chips = lastSets
      .map((s) => {
        const isTop = maxWeight > 0 && s.weight === maxWeight;
        const label = s.weight ? `${s.reps} × ${s.weight}kg` : `${s.reps} reps`;
        return `<span class="m-continuity-chip ${isTop ? "top" : ""}">${label}</span>`;
      })
      .join("");
    lastSetsHtml = `
      <div class="m-continuity-label">Last time</div>
      <div class="m-continuity-chips">${chips}</div>
    `;
  }

  slot.innerHTML = `
    <div class="m-continuity-card">
      ${lastSetsHtml}
      <div class="m-continuity-meta-row">
        ${lastDate ? `<span class="m-continuity-meta">${new Date(lastDate).toLocaleDateString()}</span>` : ""}
        ${prWeight ? `<span class="m-continuity-meta"><span class="m-pr-label">BEST</span> ${prWeight}kg</span>` : ""}
      </div>
    </div>
  `;
}

/* ============================================
   Logging a set — auto PR detection + optional manual PR-attempt tagging
   ============================================ */
async function logSet() {
  if (!mSelectedStationId) {
    await uiAlert("Pick a station first.");
    return;
  }
  const btn = document.getElementById("m-log-set-btn");
  btn.disabled = true;
  btn.textContent = "Logging...";

  const priorBest = mStationHistory?.prWeight || 0;
  const isNewPR = mWeightValue > 0 && mWeightValue > priorBest;

  const setsForStation = mCurrentWorkout.workout_sets.filter((s) => s.station_id === mSelectedStationId);
  const nextSetNumber = setsForStation.length + 1;
  const wasPRAttempt = mIsPRAttemptMode;

  beginMutation();
  const { data, error } = await supabaseClient
    .from("workout_sets")
    .insert({
      workout_id: mCurrentWorkout.id,
      station_id: mSelectedStationId,
      set_number: nextSetNumber,
      reps: mRepsValue,
      // NOT `mWeightValue || null` — 0 is a real, intentional value (a
      // bodyweight set like pushups), and `0 || null` was silently turning
      // it into null, making those sets vanish from station progress
      // entirely instead of being graphed by reps.
      weight: mWeightValue,
      client_uuid: crypto.randomUUID(),
      is_pr_attempt: wasPRAttempt,
    })
    .select("*, stations(name)")
    .single();
  endMutation();

  if (error) {
    await uiAlert("Failed to log set: " + error.message);
    btn.disabled = false;
    btn.textContent = mIsPRAttemptMode ? "Log PR Attempt" : "Log Set";
    return;
  }

  mCurrentWorkout.workout_sets.push(data);
  if (mStationHistory) mStationHistory.prWeight = Math.max(priorBest, mWeightValue);
  mIsPRAttemptMode = false;

  if (wasPRAttempt) {
    mPendingPRSetId = data.id;
  }

  renderActiveSession();

  if (wasPRAttempt) {
    renderPRTagPrompt(data.id);
  } else if (isNewPR) {
    showPRBanner(data.stations.name, mWeightValue);
  }
}

function renderPRTagPrompt(setId) {
  const slot = document.getElementById("m-pr-tag-slot");
  if (!slot) return;
  slot.innerHTML = `
    <div class="m-pr-tag-prompt">
      <div class="label">How'd the PR attempt go?</div>
      <div class="m-pr-tag-buttons">
        <button class="m-pr-result-btn success" data-result="success">Success</button>
        <button class="m-pr-result-btn failure" data-result="failure">Failure</button>
      </div>
    </div>
  `;
  slot.querySelectorAll(".m-pr-result-btn").forEach((btn) => {
    btn.addEventListener("click", () => markPRResult(setId, btn.dataset.result));
  });
}

async function markPRResult(setId, result) {
  beginMutation();
  const { error } = await supabaseClient.from("workout_sets").update({ pr_result: result }).eq("id", setId);
  endMutation();
  if (!error) {
    const set = mCurrentWorkout.workout_sets.find((s) => s.id === setId);
    if (set) set.pr_result = result;
    mPendingPRSetId = null;
    document.getElementById("m-pr-tag-slot").innerHTML = "";
    document.getElementById("m-set-list").innerHTML = renderSetList();
    wireSetListButtons();

    if (result === "success") {
      const set2 = mCurrentWorkout.workout_sets.find((s) => s.id === setId);
      if (set2) showPRBanner(set2.stations.name, set2.weight);
    }
  }
}

function showPRBanner(stationName, weight) {
  const banner = document.createElement("div");
  banner.className = "m-pr-banner";
  banner.innerHTML = `<strong>NEW BEST</strong> — ${escapeHtmlMobile(stationName)} @ ${weight}kg`;
  document.body.appendChild(banner);

  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 300);
  }, 2200);
}

async function deleteSetMobile(setId) {
  beginMutation();
  const { error } = await supabaseClient.from("workout_sets").delete().eq("id", setId);
  endMutation();
  if (error) {
    await uiAlert("Failed to delete: " + error.message);
    return;
  }
  mCurrentWorkout.workout_sets = mCurrentWorkout.workout_sets.filter((s) => s.id !== setId);
  document.getElementById("m-set-list").innerHTML = renderSetList();
  wireSetListButtons();
}

/* ============================================
   Finish workout — double-tap confirm, no blocking browser dialog
   ============================================ */
function handleFinishClick() {
  const btn = document.getElementById("m-finish-btn");
  if (!mFinishConfirmPending) {
    mFinishConfirmPending = true;
    btn.textContent = "Tap to confirm";
    btn.classList.add("confirming");
    mFinishConfirmTimeout = setTimeout(() => {
      mFinishConfirmPending = false;
      btn.textContent = "Finish";
      btn.classList.remove("confirming");
    }, 3500);
  } else {
    clearTimeout(mFinishConfirmTimeout);
    mFinishConfirmPending = false;
    finishWorkout();
  }
}

async function finishWorkout() {
  beginMutation();
  const { error } = await supabaseClient
    .from("workouts")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", mCurrentWorkout.id);
  endMutation();

  if (error) {
    await uiAlert("Failed to finish: " + error.message);
    return;
  }

  if (mSessionTimerInterval) clearInterval(mSessionTimerInterval);
  mCurrentWorkout = null;
  mSessionNumber = null;
  mStationHistory = null;
  mPendingPRSetId = null;
  renderStartPrompt();
}

/* ============================================
   Bottom sheet — full station list (selection only, no editing)
   ============================================ */
function openStationSheet() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.id = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        ${stationsCache.map((s) => `<div class="m-sheet-item" data-id="${s.id}">${escapeHtmlMobile(s.name)}</div>`).join("")}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
      return;
    }
    const item = e.target.closest(".m-sheet-item");
    if (item) {
      overlay.remove();
      selectStation(item.dataset.id);
    }
  });
}

/* ============================================
   JOURNAL — browse past sessions, top bar is the date selector
   ============================================ */
function renderJournalScreen() {
  renderJournalTopbar();
  loadJournalDay();
}

function renderJournalTopbar() {
  const isToday = isSameDay(mJournalDate, new Date());
  document.getElementById("m-topbar").innerHTML = `
    <div class="m-journal-bar">
      <button type="button" class="m-topbar-back-btn" id="m-journal-back-btn" aria-label="Back">&#8249;</button>
      <button class="m-journal-nav-btn" id="m-journal-prev" type="button">Prev</button>
      <div class="m-journal-date-display" id="m-journal-date-display">
        ${isToday ? "Today" : mJournalDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        <input type="date" id="m-journal-date-input" value="${toDateInputValue(mJournalDate)}" />
      </div>
      <button class="m-journal-nav-btn" id="m-journal-next" type="button" ${isToday ? "disabled" : ""}>Next</button>
    </div>
  `;

  document.getElementById("m-journal-back-btn").addEventListener("click", () => setWorkoutMobileScreen("log"));
  document.getElementById("m-journal-prev").addEventListener("click", () => changeJournalDate(-1));
  document.getElementById("m-journal-next").addEventListener("click", () => changeJournalDate(1));
  document.getElementById("m-journal-date-input").addEventListener("change", (e) => {
    if (!e.target.value) return;
    const [y, m, d] = e.target.value.split("-").map(Number);
    mJournalDate = new Date(y, m - 1, d);
    renderJournalScreen();
  });
}

function changeJournalDate(deltaDays) {
  const next = new Date(mJournalDate);
  next.setDate(next.getDate() + deltaDays);
  if (next > new Date()) return; // no future browsing
  mJournalDate = next;
  renderJournalScreen();
}

function toDateInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

let mOpenSwipeCard = null; // { wrap, card } of the currently revealed card, if any

async function loadJournalDay() {
  const main = document.getElementById("m-main");
  main.innerHTML = `<div class="m-empty"><p>Loading...</p></div>`;
  mOpenSwipeCard = null;

  const startOfDay = new Date(mJournalDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(mJournalDate);
  endOfDay.setHours(23, 59, 59, 999);

  const { data, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .gte("started_at", startOfDay.toISOString())
    .lte("started_at", endOfDay.toISOString())
    .order("started_at", { ascending: false });

  if (error) {
    main.innerHTML = `<div class="m-empty"><p>Couldn't load that day.</p></div>`;
    return;
  }

  if (!data || data.length === 0) {
    main.innerHTML = `<div class="m-empty"><div class="big">No workout logged</div><p>Nothing recorded on this day.</p></div>`;
    return;
  }

  main.innerHTML = data.map((w) => renderJournalWorkoutCard(w)).join("");

  main.querySelectorAll(".m-journal-swipe-wrap").forEach((wrap) => {
    const workout = data.find((w) => w.id === wrap.dataset.workoutId);
    attachJournalSwipe(wrap, workout);
  });

  main.addEventListener("pointerdown", (e) => {
    if (mOpenSwipeCard && !mOpenSwipeCard.wrap.contains(e.target)) {
      mOpenSwipeCard.close();
    }
  });
}

/** Collapsed summary only — tap opens the detail sheet, swipe reveals
 *  real action buttons that stay open until tapped (or dismissed). */
function renderJournalWorkoutCard(workout) {
  const stationCount = new Set(workout.workout_sets.map((s) => s.station_id)).size;
  const setCount = workout.workout_sets.length;
  const duration = workout.ended_at
    ? formatDuration(new Date(workout.ended_at) - new Date(workout.started_at))
    : "in progress";

  return `
    <div class="m-journal-swipe-wrap m-swipe-owns-gesture" data-workout-id="${workout.id}">
      <button type="button" class="m-swipe-action-btn m-swipe-action-delete">Delete</button>
      <button type="button" class="m-swipe-action-btn m-swipe-action-edit">Edit</button>
      <div class="m-journal-card" data-workout-id="${workout.id}">
        <div class="m-journal-card-header">
          <div class="name">${escapeHtmlMobile(workout.name || "Workout")}</div>
          <div class="meta">${new Date(workout.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${duration} · ${stationCount} station${stationCount === 1 ? "" : "s"} · ${setCount} set${setCount === 1 ? "" : "s"}</div>
        </div>
        <div class="m-journal-tap-hint">Tap for details</div>
      </div>
    </div>
  `;
}

/** Swipe reveals a fixed-width action button and HOLDS there — nothing
 *  fires until the person explicitly taps Delete or Edit. Prevents
 *  misclick actions from a fast/careless swipe. */
function attachJournalSwipe(wrap, workout) {
  const card = wrap.querySelector(".m-journal-card");
  const deleteBtn = wrap.querySelector(".m-swipe-action-delete");
  const editBtn = wrap.querySelector(".m-swipe-action-edit");
  const OPEN_THRESHOLD = 36; // drag distance needed to commit to "revealed" on release
  const ACTION_WIDTH = 88; // must match the CSS width of .m-swipe-action-btn
  const tapTolerance = 8;

  let startX = 0;
  let deltaX = 0;
  let dragging = false;
  let openState = "closed"; // 'closed' | 'delete' | 'edit'

  function setOpenState(next) {
    openState = next;
    card.style.transition = "transform 0.2s ease";
    if (next === "delete") {
      card.style.transform = `translateX(${ACTION_WIDTH}px)`;
      mOpenSwipeCard = { wrap, close: () => setOpenState("closed") };
    } else if (next === "edit") {
      card.style.transform = `translateX(-${ACTION_WIDTH}px)`;
      mOpenSwipeCard = { wrap, close: () => setOpenState("closed") };
    } else {
      card.style.transform = "translateX(0)";
      if (mOpenSwipeCard && mOpenSwipeCard.wrap === wrap) mOpenSwipeCard = null;
    }
  }

  card.addEventListener("pointerdown", (e) => {
    // Closing whatever else was open keeps only one card revealed at a time.
    if (mOpenSwipeCard && mOpenSwipeCard.wrap !== wrap) mOpenSwipeCard.close();

    dragging = true;
    startX = e.clientX;
    deltaX = 0;
    card.style.transition = "none";
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const raw = e.clientX - startX;
    // Dragging always starts from wherever the card currently sits (0 or ±ACTION_WIDTH).
    const base = openState === "delete" ? ACTION_WIDTH : openState === "edit" ? -ACTION_WIDTH : 0;
    deltaX = raw;
    const next = Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, base + raw));
    card.style.transform = `translateX(${next}px)`;
  });

  const onRelease = () => {
    if (!dragging) return;
    dragging = false;
    const base = openState === "delete" ? ACTION_WIDTH : openState === "edit" ? -ACTION_WIDTH : 0;
    const finalPos = Math.max(-ACTION_WIDTH, Math.min(ACTION_WIDTH, base + deltaX));

    if (Math.abs(deltaX) < tapTolerance && openState === "closed") {
      setOpenState("closed");
      openJournalDetailSheet(workout);
      return;
    }

    if (finalPos > OPEN_THRESHOLD) {
      setOpenState("delete");
    } else if (finalPos < -OPEN_THRESHOLD) {
      setOpenState("edit");
    } else {
      setOpenState("closed");
    }
  };

  card.addEventListener("pointerup", onRelease);
  card.addEventListener("pointercancel", onRelease);

  deleteBtn.addEventListener("click", () => confirmDeleteJournalWorkout(workout));
  editBtn.addEventListener("click", () => {
    setOpenState("closed");
    openJournalEditSheet(workout);
  });
}

async function confirmDeleteJournalWorkout(workout) {
  // The swipe-then-tap gesture already is the confirmation — no extra
  // blocking dialog needed on top of that.
  beginMutation();
  const { error } = await supabaseClient.from("workouts").delete().eq("id", workout.id);
  endMutation();
  if (error) {
    await uiAlert("Failed to delete: " + error.message);
  }
  loadJournalDay();
}

/** Reached from the detail sheet's Delete button — no swipe gesture backs
 *  this one up, so it needs its own explicit confirmation. */
async function deleteJournalWorkoutWithConfirm(workout, overlay) {
  if (!(await uiConfirm("Delete this workout and all its logged sets? This cannot be undone."))) return;

  beginMutation();
  const { error } = await supabaseClient.from("workouts").delete().eq("id", workout.id);
  endMutation();

  if (error) {
    await uiAlert("Failed to delete: " + error.message);
    return;
  }
  overlay.remove();
  loadJournalDay();
}

/* ---- Edit sheet: session name + notes ---- */
function openJournalEditSheet(workout) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block">
          <div class="label">Session name</div>
          <input type="text" id="m-edit-name" value="${escapeHtmlMobile(workout.name || "")}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block">
          <div class="label">Notes</div>
          <textarea id="m-edit-notes" rows="4"
                    style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;font-family:var(--font-mono);">${escapeHtmlMobile(workout.notes || "")}</textarea>
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-edit-save-btn" style="width:100%;max-width:none;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("m-edit-save-btn").addEventListener("click", async () => {
    const name = document.getElementById("m-edit-name").value.trim() || null;
    const notes = document.getElementById("m-edit-notes").value.trim() || null;
    const btn = document.getElementById("m-edit-save-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    beginMutation();
    const { error } = await supabaseClient.from("workouts").update({ name, notes }).eq("id", workout.id);
    endMutation();

    if (error) {
      await uiAlert("Failed to save: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }
    overlay.remove();
    loadJournalDay();
  });
}

/* ---- Detail sheet: stations/sets, improvement vs last time, PR markers, notes ---- */
async function openJournalDetailSheet(workout) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block">
          <div class="label">${escapeHtmlMobile(workout.name || "Workout")}</div>
          <div class="m-stat-row"><span class="k">${new Date(workout.started_at).toLocaleString()}</span></div>
        </div>
        <div id="m-detail-stations"><div class="m-empty" style="height:auto;padding:20px;"><p>Loading comparisons...</p></div></div>
        ${workout.notes ? `<div class="m-stat-block"><div class="label">Notes</div><div class="m-stat-row"><span class="k">${escapeHtmlMobile(workout.notes)}</span></div></div>` : ""}
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-detail-edit-btn" style="width:100%;max-width:none;margin-bottom:10px;">Edit session</button>
        <button class="m-finish-btn m-delete-session-btn" id="m-detail-delete-btn" style="width:100%;padding:12px;">Delete session</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.getElementById("m-detail-edit-btn").addEventListener("click", () => {
    overlay.remove();
    openJournalEditSheet(workout);
  });
  document.getElementById("m-detail-delete-btn").addEventListener("click", () => deleteJournalWorkoutWithConfirm(workout, overlay));

  const grouped = {};
  workout.workout_sets
    .sort((a, b) => a.set_number - b.set_number)
    .forEach((s) => {
      if (!grouped[s.station_id]) grouped[s.station_id] = { name: s.stations.name, sets: [] };
      grouped[s.station_id].sets.push(s);
    });

  const blocks = await Promise.all(
    Object.entries(grouped).map(async ([stationId, group]) => {
      const thisBest = Math.max(...group.sets.map((s) => s.weight || 0));

      const [comparison, allTimePR] = await Promise.all([
        computeStationComparison(stationId, workout.started_at),
        supabaseClient.from("workout_sets").select("weight").eq("station_id", stationId).order("weight", { ascending: false }).limit(1),
      ]);

      const prWeight = allTimePR.data && allTimePR.data.length > 0 ? allTimePR.data[0].weight : null;

      let comparisonLine = "First time logging this station";
      if (comparison && comparison.bestWeight != null) {
        const delta = Math.round((thisBest - comparison.bestWeight) * 10) / 10;
        if (delta > 0) comparisonLine = `↑ Improved — ${delta}kg heavier vs ${new Date(comparison.date).toLocaleDateString()}`;
        else if (delta < 0) comparisonLine = `↓ Declined — ${Math.abs(delta)}kg lighter vs ${new Date(comparison.date).toLocaleDateString()}`;
        else comparisonLine = `→ Same weight as ${new Date(comparison.date).toLocaleDateString()}`;
      }

      const setsHtml = group.sets
        .map((s, idx) => {
          let tag = "";
          if (s.weight && prWeight && s.weight >= prWeight) tag += ` <span class="m-pr-label">BEST</span>`;
          if (s.is_pr_attempt) {
            tag += s.pr_result === "success" ? ` <span class="m-pr-tag success">ATTEMPT SUCCESS</span>`
              : s.pr_result === "failure" ? ` <span class="m-pr-tag failure">ATTEMPT FAILED</span>`
              : ` <span class="m-pr-tag pending">ATTEMPT PENDING</span>`;
          }
          // Reps and weight as two separate labeled metrics rather than a
          // concatenated "12×20kg" string — easier to scan a column of
          // sets at a glance instead of parsing each row's shorthand.
          return `
            <div class="m-journal-set-row">
              <span class="m-journal-set-num">${s.set_number || idx + 1}</span>
              <span class="m-journal-set-metric"><strong>${s.reps}</strong><small>reps</small></span>
              <span class="m-journal-set-metric m-journal-set-weight"><strong>${s.weight || "—"}</strong><small>${s.weight ? "kg" : ""}</small></span>
              <span class="m-journal-set-tags">${tag}</span>
              <button type="button" class="m-journal-set-edit-btn" data-set-id="${s.id}">Edit</button>
            </div>`;
        })
        .join("");

      return `
        <div class="m-journal-station-block">
          <div class="m-journal-station-name">${escapeHtmlMobile(group.name)}</div>
          <div class="m-journal-station-sets">${setsHtml}</div>
          <div class="m-journal-comparison">${comparisonLine}</div>
        </div>
      `;
    })
  );

  const slot = document.getElementById("m-detail-stations");
  if (!slot) return; // the sheet was dismissed while the comparison data was still loading

  slot.innerHTML = blocks.join("");

  slot.querySelectorAll(".m-journal-set-edit-btn[data-set-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const set = workout.workout_sets.find((s) => s.id === btn.dataset.setId);
      if (!set) return;
      openSetEditSheet(set, {
        onSaved: (updated) => {
          set.reps = updated.reps;
          set.weight = updated.weight;
          overlay.remove();
          openJournalDetailSheet(workout); // re-render with the updated value
        },
      });
    });
  });
}

/** Finds the most recent PRIOR workout (before this one) that used this
 *  station, and returns its best (heaviest) set for comparison. */
async function computeStationComparison(stationId, beforeStartedAt) {
  const { data } = await supabaseClient
    .from("workout_sets")
    .select("*, workouts!inner(id, started_at)")
    .eq("station_id", stationId)
    .order("created_at", { ascending: false })
    .limit(60);

  if (!data) return null;
  const priorSets = data.filter((s) => new Date(s.workouts.started_at) < new Date(beforeStartedAt));
  if (priorSets.length === 0) return null;

  const mostRecentWorkoutId = priorSets[0].workouts.id;
  const priorSessionSets = priorSets.filter((s) => s.workouts.id === mostRecentWorkoutId);
  const bestWeight = Math.max(...priorSessionSets.map((s) => s.weight || 0));

  return { bestWeight, date: priorSessionSets[0].workouts.started_at };
}

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ============================================
   Settings sheet — account, auto-logout, status light, export, sign out.
   Deliberately no station/routine management here — mobile stays
   log-only by design.
   ============================================ */
async function openSettingsSheet() {
  const root = document.getElementById("m-settings-root");
  root.innerHTML = `
    <div class="m-sheet-overlay" id="m-settings-overlay">
      <div class="m-sheet">
        <div class="m-sheet-handle"></div>
        <div class="m-sheet-body">
          <div class="m-empty" style="height:auto;padding:30px;"><p>Loading settings...</p></div>
        </div>
      </div>
    </div>
  `;
  const overlay = document.getElementById("m-settings-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) root.innerHTML = "";
  });

  try {
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError) throw userError;

    const { data: profile, error: profileError } = await supabaseClient
      .from("profiles")
      .select("username, auto_logout_minutes")
      .maybeSingle();
    if (profileError) throw profileError;

    const email = userData?.user?.email || "—";
    renderSettingsSheetBody(profile, email);
  } catch (err) {
    console.error("Settings failed to load:", err);
    const body = overlay.querySelector(".m-sheet-body");
    if (body) {
      body.innerHTML = `
        <div class="m-empty" style="height:auto;padding:30px;">
          <div class="big">Couldn't load settings</div>
          <p>${escapeHtmlMobile(err.message || "Unknown error")}</p>
        </div>
      `;
    }
  }
}

function renderSettingsSheetBody(profile, email) {
  const overlay = document.getElementById("m-settings-overlay");
  if (!overlay) return;

  overlay.querySelector(".m-sheet").innerHTML = `
    <div class="m-sheet-handle"></div>
    <div class="m-sheet-body">
      <div class="m-status-line">
        <span class="status-dot" id="m-status-dot"></span>
        <span id="m-status-text">Checking...</span>
        <span class="m-status-deployed" id="m-settings-last-updated-text">${mLastUpdatedAt ? "Last updated: " + formatLastUpdated(mLastUpdatedAt) : ""}</span>
      </div>

      <div class="m-stat-block">
        <div class="label">Username (used to sign in)</div>
        <input type="text" id="m-settings-username" value="${escapeHtmlMobile(profile?.username || "")}"
               placeholder="e.g. nathan" autocapitalize="off" autocorrect="off"
               style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        <div class="error-text" id="m-settings-username-msg" style="margin-top:6px;"></div>
        <button class="btn-ghost" id="m-settings-username-save" style="width:100%;margin-top:8px;">Save username</button>
      </div>

      <div class="m-stat-block">
        <div class="label">Signed in with</div>
        <div class="m-stat-row"><span class="k">${escapeHtmlMobile(email)}</span></div>
      </div>

      <div class="m-stat-block">
        <div class="label">Auto-logout after inactivity</div>
        <select class="m-routine-picker" id="m-auto-logout-select" style="max-width:none;">
          <option value="0">Never</option>
          <option value="5">5 minutes</option>
          <option value="15">15 minutes</option>
          <option value="30">30 minutes</option>
          <option value="60">1 hour</option>
        </select>
      </div>

      <div class="m-stat-block">
        <div class="label">App modules</div>
        <div class="nav-module-list" id="m-nav-module-list" style="margin-top:8px;"></div>
      </div>

      <div class="m-stat-block">
        <div class="label">Change password</div>
        <input type="password" id="m-settings-new-password" placeholder="At least 6 characters"
               style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        <div class="error-text" id="m-settings-password-msg" style="margin-top:6px;"></div>
        <button class="btn-ghost" id="m-settings-password-save" style="width:100%;margin-top:8px;">Update password</button>
      </div>
    </div>

    <div class="m-sheet-footer">
      <button class="m-start-btn" id="m-export-btn" style="width:100%;max-width:none;margin-bottom:10px;">Export my data</button>
      <button class="m-finish-btn" id="m-signout-btn" style="width:100%;padding:14px;">Sign out</button>
    </div>
  `;

  document.getElementById("m-auto-logout-select").value = String(profile?.auto_logout_minutes ?? 30);
  enhanceSelect("m-auto-logout-select");
  refreshStatusLights(); // instant reflection of current known state
  runMobileConnectivityCheck(); // then verify freshness

  // Shared editor (uimodal.js) — desktop's Settings page renders the same
  // thing into its own container id, with its own refresh callback.
  renderNavModuleEditor("m-nav-module-list", () => {
    renderDrawerNavItems();
    if (mApp === "home") renderHomeScreenMobile(); // Shortcuts widget reflects the change too
  });

  document.getElementById("m-signout-btn").addEventListener("click", signOut);
  document.getElementById("m-export-btn").addEventListener("click", exportDataMobile);

  document.getElementById("m-auto-logout-select").addEventListener("change", async (e) => {
    const minutes = parseInt(e.target.value, 10);
    await supabaseClient.from("profiles").upsert({ id: currentUserId, auto_logout_minutes: minutes }, { onConflict: "id" });
    if (typeof updateAutoLogoutMinutes === "function") updateAutoLogoutMinutes(minutes);
  });

  document.getElementById("m-settings-username-save").addEventListener("click", saveUsernameMobile);
  document.getElementById("m-settings-password-save").addEventListener("click", changePasswordMobile);
}

async function saveUsernameMobile() {
  const msg = document.getElementById("m-settings-username-msg");
  const username = document.getElementById("m-settings-username").value.trim().toLowerCase();
  msg.style.color = "var(--danger)";
  msg.textContent = "";

  if (!username || !/^[a-z0-9_]{3,20}$/.test(username)) {
    msg.textContent = "Use 3-20 characters: lowercase letters, numbers, underscores.";
    return;
  }

  const btn = document.getElementById("m-settings-username-save");
  btn.disabled = true;
  btn.textContent = "Saving...";

  beginMutation();
  const { error } = await supabaseClient.from("profiles").upsert({ id: currentUserId, username }, { onConflict: "id" });
  endMutation();

  btn.disabled = false;
  btn.textContent = "Save username";

  if (error) {
    msg.textContent = error.message.includes("duplicate") ? "That username is taken." : error.message;
    return;
  }
  msg.style.color = "var(--success)";
  msg.textContent = "Saved. Use it to sign in next time.";
}

async function changePasswordMobile() {
  const msg = document.getElementById("m-settings-password-msg");
  const input = document.getElementById("m-settings-new-password");
  const password = input.value;
  msg.style.color = "var(--danger)";
  msg.textContent = "";

  if (password.length < 6) {
    msg.textContent = "Password must be at least 6 characters.";
    return;
  }

  const btn = document.getElementById("m-settings-password-save");
  btn.disabled = true;
  btn.textContent = "Updating...";

  const { error } = await supabaseClient.auth.updateUser({ password });

  btn.disabled = false;
  btn.textContent = "Update password";

  if (error) {
    msg.textContent = error.message;
    return;
  }
  msg.style.color = "var(--success)";
  msg.textContent = "Password updated.";
  input.value = "";
}

async function runMobileConnectivityCheck() {
  await checkConnectivity(); // updates m-status-dot/m-status-text itself
}

async function exportDataMobile() {
  const btn = document.getElementById("m-export-btn");
  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const [stations, workouts, sets] = await Promise.all([
      supabaseClient.from("stations").select("*"),
      supabaseClient.from("workouts").select("*"),
      supabaseClient.from("workout_sets").select("*"),
    ]);

    const backup = {
      exported_at: new Date().toISOString(),
      stations: stations.data || [],
      workouts: workouts.data || [],
      workout_sets: sets.data || [],
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workout-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    await uiAlert("Export failed: " + e.message);
  }

  btn.disabled = false;
  btn.textContent = "Export my data";
}

/* ============================================
   Add Station — quick, name-only (mirrors desktop's simplified form)
   ============================================ */
function openAddStationSheet() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.id = "m-add-station-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">New station</div>
          <input type="text" id="m-new-station-name" autofocus
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;
                        color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-station-btn" style="width:100%;max-width:none;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("m-save-station-btn").addEventListener("click", async () => {
    const name = document.getElementById("m-new-station-name").value.trim();
    if (!name) return;
    const btn = document.getElementById("m-save-station-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const { error } = await supabaseClient.from("stations").insert({ name });
    if (error) {
      await uiAlert("Failed to save station: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }

    stationsCache = [];
    await loadStationsForMobile();
    overlay.remove();
    if (mCurrentWorkout && mScreen === "log") renderActiveSession();
  });
}

function escapeHtmlMobile(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}