// desktop.js
// All desktop dashboard behaviour: navigation, CRUD for stations,
// view/manage for workouts, and the statistics view. Called once the user
// is authenticated and the device gate (in index.html) has decided this is
// a desktop session.

let currentUserId = null;
let stationsCache = [];   // refreshed on load, reused by routine/workout forms
let stationStatCharts = {}; // keyed by station id, so we can destroy/recreate on reload
let currentApp = "workout"; // 'workout' | 'finance' | 'admin' — which app the sidebar/top-tabs are pointed at

// Default landing page per app, and the load function each top-tab view maps to.
const APP_DEFAULT_VIEW = { workout: "dashboard", finance: "findash" };
const VIEW_LOADERS = {
  dashboard: loadDashboard,
  stations: loadStations,
  progress: loadStationStats,
  workouts: loadWorkouts,
  findash: () => loadFinanceDashboard(),
  expenses: () => loadFinanceExpenses(),
  payments: () => loadFinancePayments(),
};

function initDesktopApp(session) {
  currentUserId = session.user.id;
  document.getElementById("app-root").classList.remove("hidden");

  setupNav();
  document.getElementById("logout-btn").addEventListener("click", signOut);
  document.getElementById("refresh-btn").addEventListener("click", refreshCurrentView);

  document.getElementById("add-station-btn").addEventListener("click", () => openStationModal());
  document.getElementById("clear-all-workouts-btn").addEventListener("click", clearAllWorkouts);
  document.getElementById("workouts-select-all").addEventListener("change", (e) => toggleSelectAllWorkouts(e.target.checked));
  document.getElementById("workouts-delete-selected-btn").addEventListener("click", deleteSelectedWorkouts);

  wireFinanceActions(); // defined in finance.js

  document.getElementById("last-deployed-text").textContent = LAST_DEPLOYED;
  runConnectivityCheck();
  setInterval(runConnectivityCheck, 60000);

  initAutoLogout();

  switchApp("workout");
}

async function runConnectivityCheck() {
  await checkConnectivity(); // updates status-dot/status-text itself
}

/* ============================================
   Navigation — the sidebar switches between "apps" (Workout / Finance /
   the app-agnostic Admin); each app's own pages live in a top tab bar.
   ============================================ */
function setupNav() {
  document.querySelectorAll(".app-nav-item").forEach((item) => {
    item.addEventListener("click", () => switchApp(item.dataset.app));
  });

  document.querySelectorAll(".top-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });
}

function switchApp(appName) {
  currentApp = appName;

  document.querySelectorAll(".app-nav-item").forEach((i) => i.classList.toggle("active", i.dataset.app === appName));
  document.getElementById("top-tabs-workout").classList.toggle("hidden", appName !== "workout");
  document.getElementById("top-tabs-finance").classList.toggle("hidden", appName !== "finance");
  document.getElementById("app-views-workout").classList.toggle("hidden", appName !== "workout");
  document.getElementById("app-views-finance").classList.toggle("hidden", appName !== "finance");

  if (appName === "admin") {
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    document.getElementById("view-admin").classList.remove("hidden");
    return loadAdmin();
  }

  switchView(APP_DEFAULT_VIEW[appName]);
}

function switchView(viewName) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${viewName}`).classList.remove("hidden");
  document.querySelectorAll(".top-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === viewName));

  const loader = VIEW_LOADERS[viewName];
  if (loader) return loader();
}

/** Re-fetches whatever view is currently showing, without a page reload —
 *  a hard refresh (F5) would sign the user out now that sessions aren't
 *  persisted, so this is the safe way to pull fresh data. */
async function refreshCurrentView() {
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";

  if (currentApp === "admin") {
    await Promise.all([loadAdmin(), runConnectivityCheck()]);
  } else {
    const activeTab = document.querySelector(`#top-tabs-${currentApp} .top-tab.active`);
    const viewName = activeTab ? activeTab.dataset.view : APP_DEFAULT_VIEW[currentApp];
    await Promise.all([switchView(viewName), runConnectivityCheck()]);
  }

  btn.disabled = false;
  btn.textContent = "Refresh";
}

/* ============================================
   Modal helper
   ============================================ */
function openModal(innerHtml) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal">${innerHtml}</div></div>`;
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ============================================
   DASHBOARD
   ============================================ */
async function loadDashboard() {
  renderQuickActions();
  await Promise.all([loadDashboardStats(), loadRecentWorkouts()]);
}

/** Real signal, not just a mirror of the Workouts list: how much you've
 *  actually been training and where you're improving, at a glance. Shared
 *  by the desktop dashboard and the mobile compact dashboard. */
async function computeWorkoutDashboardStats() {
  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("id, started_at, workout_sets(reps, weight, station_id, stations(name))")
    .order("started_at", { ascending: true });

  if (error) {
    console.error(error);
    return null;
  }

  const all = workouts || [];
  const totalWorkouts = all.length;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const thisWeekSessions = all.filter((w) => new Date(w.started_at) >= weekAgo).length;

  // Day streak: consecutive calendar days (walking back from today) with
  // at least one workout — today not having one yet doesn't break a streak
  // that's still active as of yesterday.
  const trainedDays = new Set(all.map((w) => new Date(w.started_at).toDateString()));
  let streak = 0;
  const cursor = new Date();
  if (!trainedDays.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
  while (trainedDays.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // Biggest gain: compare each station's last two sessions, only counting
  // ones still recent enough (30d) to read as "current progress".
  const byStation = {};
  all.forEach((w) => {
    const perStationMax = {};
    w.workout_sets.forEach((s) => {
      if (s.weight == null) return;
      if (!perStationMax[s.station_id] || s.weight > perStationMax[s.station_id].weight) {
        perStationMax[s.station_id] = { weight: s.weight, name: s.stations.name };
      }
    });
    Object.entries(perStationMax).forEach(([stationId, { weight, name }]) => {
      if (!byStation[stationId]) byStation[stationId] = { name, sessions: [] };
      byStation[stationId].sessions.push({ date: w.started_at, weight });
    });
  });

  let biggestGain = null;
  Object.values(byStation).forEach(({ name, sessions }) => {
    if (sessions.length < 2) return;
    const last = sessions[sessions.length - 1];
    const prev = sessions[sessions.length - 2];
    if ((now - new Date(last.date)) / 86400000 > 30) return;
    const delta = last.weight - prev.weight;
    if (delta > 0 && (!biggestGain || delta > biggestGain.delta)) biggestGain = { name, delta };
  });

  return { totalWorkouts, thisWeekSessions, streak, biggestGain };
}

async function loadDashboardStats() {
  const el = document.getElementById("dashboard-stats");
  el.innerHTML = `<div class="empty-state">Loading...</div>`;

  const stats = await computeWorkoutDashboardStats();
  if (!stats) {
    el.innerHTML = `<div class="empty-state">Error loading stats</div>`;
    return;
  }

  el.innerHTML = `
    <div class="stat-card">
      <div class="label">Total workouts</div>
      <div class="value">${stats.totalWorkouts}</div>
    </div>
    <div class="stat-card">
      <div class="label">This week</div>
      <div class="value">${stats.thisWeekSessions} session${stats.thisWeekSessions === 1 ? "" : "s"}</div>
    </div>
    <div class="stat-card">
      <div class="label">Day streak</div>
      <div class="value">${stats.streak}</div>
    </div>
    <div class="stat-card">
      <div class="label">Biggest gain (30d)</div>
      <div class="value" style="font-size:19px;">${stats.biggestGain ? `${escapeHtml(stats.biggestGain.name)} +${Math.round(stats.biggestGain.delta * 10) / 10}kg` : "—"}</div>
    </div>
  `;
}

function renderQuickActions() {
  const box = document.getElementById("dashboard-quick-actions");
  box.innerHTML = `
    <button class="quick-action-btn qa-gold" id="qa-new-station">
      <div class="label">New Station</div>
    </button>
    <button class="quick-action-btn qa-success" id="qa-export">
      <div class="label">Export Data</div>
    </button>
  `;
  document.getElementById("qa-new-station").addEventListener("click", () => openStationModal());
  document.getElementById("qa-export").addEventListener("click", () => {
    if (typeof exportAllData === "function") exportAllData();
  });
}

async function loadRecentWorkouts() {
  const recentBox = document.getElementById("dashboard-recent");
  recentBox.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(id)")
    .order("started_at", { ascending: false })
    .limit(5);

  if (error) {
    recentBox.innerHTML = `<div class="empty-state">Error loading recent workouts</div>`;
    console.error(error);
    return;
  }

  if (!workouts || workouts.length === 0) {
    recentBox.innerHTML = `<div class="empty-state"><div class="big">No workouts yet</div><p>Log one on your phone to see it here.</p></div>`;
    return;
  }

  recentBox.innerHTML = workouts
    .map(
      (w) => `
      <div class="card-row">
        <div>
          <div class="title">${escapeHtml(w.name || "Workout")}</div>
          <div class="meta">${new Date(w.started_at).toLocaleDateString()} · ${w.workout_sets.length} set${w.workout_sets.length === 1 ? "" : "s"}${!w.ended_at ? " · in progress" : ""}</div>
        </div>
      </div>`
    )
    .join("");
}

function chartBaseOptions(tooltipFooter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: tooltipFooter ? { display: true, labels: { color: "#8b8b9e", boxWidth: 12, font: { size: 11 } } } : { display: false },
      tooltip: tooltipFooter ? { callbacks: { footer: (items) => tooltipFooter(items[0].dataIndex) } } : {},
    },
    scales: {
      x: { grid: { color: "#2a2a38" }, ticks: { color: "#8b8b9e" } },
      y: { grid: { color: "#2a2a38" }, ticks: { color: "#8b8b9e" } },
    },
  };
}

function formatRelativeDays(days) {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/* ============================================
   Station Progress (formerly the separate Statistics tab) — per-station
   weight-lifted trend, since "did I get stronger on this exercise" is
   the actually useful question, not an aggregate volume number.
   ============================================ */
const ABANDONED_DAYS = 60; // no session in 2 months reads as "stopped", not "plateaued"
const DENSE_SESSION_THRESHOLD = 10; // beyond this, one-point-per-session no longer fits legibly at card width

let stationStatsCache = {}; // stationId -> decorated entry, so a zoom toggle can re-render one chart without refetching
let zoomedStations = new Set(); // stationIds currently in "every session" scroll mode (default is the fit-to-width overview)

async function loadStationStats() {
  const box = document.getElementById("dashboard-station-stats");
  const toggleBox = document.getElementById("dashboard-station-stats-toggle");
  box.innerHTML = `<div class="empty-state">Loading...</div>`;
  toggleBox.innerHTML = "";

  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("id, started_at, workout_sets(station_id, weight, reps, stations(name))")
    .order("started_at", { ascending: true });

  if (error) {
    box.innerHTML = `<div class="empty-state">Error loading station progress</div>`;
    console.error(error);
    return;
  }

  // stationId -> { name, sessions: [{date, weight, reps}] } — the heaviest
  // set of the session represents that session's data point.
  const byStation = {};
  (workouts || []).forEach((w) => {
    const perStationMax = {};
    w.workout_sets.forEach((s) => {
      if (s.weight == null) return; // bodyweight sets don't factor into a weight trend
      if (!perStationMax[s.station_id] || s.weight > perStationMax[s.station_id].weight) {
        perStationMax[s.station_id] = { weight: s.weight, reps: s.reps, name: s.stations.name };
      }
    });
    Object.entries(perStationMax).forEach(([stationId, { weight, reps, name }]) => {
      if (!byStation[stationId]) byStation[stationId] = { name, sessions: [] };
      byStation[stationId].sessions.push({ date: w.started_at, weight, reps });
    });
  });

  const entries = Object.entries(byStation);
  if (entries.length === 0) {
    box.innerHTML = `<div class="empty-state"><div class="big">No weighted sets yet</div><p>Log some sets with weight to see progress here.</p></div>`;
    return;
  }

  Object.values(stationStatCharts).forEach((chart) => chart.destroy());
  stationStatCharts = {};

  const decorated = entries.map(([stationId, data]) => {
    const daysSince = Math.floor((Date.now() - new Date(data.sessions[data.sessions.length - 1].date)) / 86400000);
    return { stationId, data, daysSince, isAbandoned: daysSince >= ABANDONED_DAYS };
  });

  stationStatsCache = {};
  decorated.forEach((e) => (stationStatsCache[e.stationId] = e));
  zoomedStations = new Set(); // reset on reload — start every card back on the overview

  // Abandoned stations are hidden by default — a station you tried once 8
  // months ago and never touched again shouldn't take up the same visual
  // weight as what you're actually training right now. They're one click
  // away, not gone.
  const activeEntries = decorated.filter((e) => !e.isAbandoned);
  const abandonedEntries = decorated.filter((e) => e.isAbandoned);

  box.innerHTML = activeEntries.length > 0
    ? activeEntries.map(renderStationStatCard).join("")
    : `<div class="empty-state"><div class="big">No active stations</div><p>Everything you've logged is inactive — see below.</p></div>`;
  renderStationCharts(activeEntries);

  if (abandonedEntries.length > 0) {
    toggleBox.innerHTML = `<button class="btn-ghost" id="show-inactive-stations-btn">Show ${abandonedEntries.length} inactive station${abandonedEntries.length === 1 ? "" : "s"}</button>`;
    document.getElementById("show-inactive-stations-btn").addEventListener("click", () => {
      box.innerHTML += abandonedEntries.map(renderStationStatCard).join("");
      renderStationCharts(abandonedEntries);
      toggleBox.innerHTML = "";
    });
  }
}

// Epley formula — standard estimated-1RM approximation from a weight/reps
// pair, used so the card can surface strength progress even though every
// set is logged at whatever rep count was actually done that day.
function estimate1RM(weight, reps) {
  if (!reps || reps <= 1) return weight;
  return weight * (1 + reps / 30);
}

function renderStationStatCard({ stationId, data, daysSince, isAbandoned }) {
  const sessions = data.sessions;
  const timesLogged = sessions.length;

  let trendClass = "same";
  let trendLabel = "First session";
  if (sessions.length >= 2) {
    const last = sessions[sessions.length - 1].weight;
    const prev = sessions[sessions.length - 2].weight;
    if (last > prev) {
      trendClass = "up";
      trendLabel = `↑ +${Math.round((last - prev) * 10) / 10}kg`;
    } else if (last < prev) {
      trendClass = "down";
      trendLabel = `↓ ${Math.round((last - prev) * 10) / 10}kg`;
    } else {
      trendClass = "same";
      trendLabel = "→ Same";
    }
  }

  // Abandoned overrides the up/down/same trend read — "you got stronger
  // last time you did this" is misleading framing for a station you
  // haven't touched in 2 months.
  if (isAbandoned) {
    trendClass = "abandoned";
    trendLabel = timesLogged === 1 ? "Not repeated" : "Inactive";
  }

  const bestWeight = Math.max(...sessions.map((s) => s.weight));
  const best1RM = Math.max(...sessions.map((s) => estimate1RM(s.weight, s.reps)));

  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const changeSinceFirst = last.weight - first.weight;
  const pctSinceFirst = first.weight ? (changeSinceFirst / first.weight) * 100 : 0;
  const changeClass = changeSinceFirst > 0 ? "up" : changeSinceFirst < 0 ? "down" : "";

  const spanDays = Math.max(1, (new Date(last.date) - new Date(first.date)) / 86400000);
  const perMonth = timesLogged / Math.max(1, spanDays / 30);

  return `
    <div class="station-stat-card ${isAbandoned ? "abandoned" : `trend-${trendClass}`}">
      <div class="header-row">
        <div class="station-name">${escapeHtml(data.name)}</div>
        <div class="trend-badge ${trendClass}">${trendLabel}</div>
      </div>
      <div class="meta-line">Logged ${timesLogged} time${timesLogged === 1 ? "" : "s"} · Last ${formatRelativeDays(daysSince)}</div>

      <div class="stat-mini-grid">
        <div class="stat-mini">
          <div class="stat-mini-value">${Math.round(bestWeight * 10) / 10}kg</div>
          <div class="stat-mini-label">Best set</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-value">${Math.round(best1RM * 10) / 10}kg</div>
          <div class="stat-mini-label">Est. 1RM</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-value ${changeClass}">${changeSinceFirst > 0 ? "+" : ""}${Math.round(changeSinceFirst * 10) / 10}kg</div>
          <div class="stat-mini-label">Since first (${Math.round(pctSinceFirst)}%)</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-value">${perMonth.toFixed(1)}</div>
          <div class="stat-mini-label">Sessions / mo</div>
        </div>
      </div>

      <div class="chart-wrap" id="chart-wrap-${stationId}">
        <div class="chart-inner" id="chart-inner-${stationId}"><canvas id="station-chart-${stationId}"></canvas></div>
      </div>
      ${timesLogged > DENSE_SESSION_THRESHOLD
        ? `<div class="chart-footer">
             <span class="meta-line">${zoomedStations.has(stationId) ? "Scroll to see every session" : "Showing overall trend — zoom in to see individual sessions"}</span>
             <button type="button" class="btn-ghost chart-zoom-btn" data-station-id="${stationId}">${zoomedStations.has(stationId) ? "Overview" : "Zoom in"}</button>
           </div>`
        : ""}
    </div>
  `;
}

const CHART_PX_PER_SESSION = 46; // fixed point spacing so dense history stays readable instead of squeezing

function renderStationCharts(decoratedEntries) {
  decoratedEntries.forEach((entry) => {
    renderOneStationChart(entry);
    document.querySelector(`.chart-zoom-btn[data-station-id="${entry.stationId}"]`)
      ?.addEventListener("click", () => toggleStationZoom(entry.stationId));
  });
}

// Overview mode (default): the chart fits the card width so the whole
// history reads as one trend line at a glance — that's the actual point of
// the Progress page. Zoomed mode: fixed pixel spacing per session in a
// horizontally-scrolling wrap, for when you want to pick out one day.
function renderOneStationChart({ stationId, data }) {
  const ctx = document.getElementById(`station-chart-${stationId}`);
  if (!ctx) return;

  const inner = document.getElementById(`chart-inner-${stationId}`);
  const wrap = document.getElementById(`chart-wrap-${stationId}`);
  const isZoomed = zoomedStations.has(stationId);

  if (inner && wrap) {
    const neededWidth = data.sessions.length * CHART_PX_PER_SESSION;
    inner.style.width = isZoomed && neededWidth > wrap.clientWidth ? `${neededWidth}px` : "100%";
  }

  const dense = data.sessions.length > DENSE_SESSION_THRESHOLD;
  const reps = data.sessions.map((s) => s.reps);

  if (stationStatCharts[stationId]) stationStatCharts[stationId].destroy();

  const chart = new Chart(ctx.getContext("2d"), {
    type: "line",
    data: {
      labels: data.sessions.map((s) => new Date(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
      datasets: [
        {
          label: "Weight (kg)",
          data: data.sessions.map((s) => s.weight),
          borderColor: "#6c63ff",
          backgroundColor: "rgba(108,99,255,0.15)",
          fill: true,
          tension: 0.3,
          // Overview mode on a dense history hides point markers so the
          // line itself (the overall trend) stays legible instead of
          // turning into a wall of overlapping dots.
          pointRadius: dense && !isZoomed ? 0 : 4,
          pointHoverRadius: 6,
        },
        {
          label: "Est. 1RM (kg)",
          data: data.sessions.map((s) => Math.round(estimate1RM(s.weight, s.reps) * 10) / 10),
          borderColor: "#f5c542",
          backgroundColor: "transparent",
          borderDash: [4, 3],
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: chartBaseOptions((i) => `${reps[i] || "?"} reps`),
  });
  stationStatCharts[stationId] = chart;

  if (wrap && isZoomed) wrap.scrollLeft = wrap.scrollWidth; // land on the most recent sessions by default
}

function toggleStationZoom(stationId) {
  const entry = stationStatsCache[stationId];
  if (!entry) return;

  if (zoomedStations.has(stationId)) zoomedStations.delete(stationId);
  else zoomedStations.add(stationId);

  const footer = document.querySelector(`.chart-zoom-btn[data-station-id="${stationId}"]`)?.closest(".chart-footer");
  if (footer) {
    const isZoomed = zoomedStations.has(stationId);
    footer.querySelector(".meta-line").textContent = isZoomed ? "Scroll to see every session" : "Showing overall trend — zoom in to see individual sessions";
    footer.querySelector(".chart-zoom-btn").textContent = isZoomed ? "Overview" : "Zoom in";
  }

  renderOneStationChart(entry);
}

/* ============================================
   STATIONS
   ============================================ */
async function loadStations() {
  const listEl = document.getElementById("stations-list");
  listEl.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data, error } = await supabaseClient.from("stations").select("*").order("name");
  if (error) {
    console.error(error);
    listEl.innerHTML = `<div class="empty-state">Error loading stations</div>`;
    return;
  }
  stationsCache = data;

  if (data.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">No stations yet</div>
        <p>Add the exercises you train — bench press, squat, lat pulldown, etc.</p>
        <button class="btn-accent" onclick="openStationModal()">+ New station</button>
      </div>`;
    return;
  }

  listEl.innerHTML = data
    .map(
      (s) => `
    <div class="card-row">
      <div>
        <div class="title">${escapeHtml(s.name)}</div>
        <div class="meta">
          ${s.category ? `<span class="tag-pill">${escapeHtml(s.category)}</span>` : ""}
          ${s.equipment ? `<span class="tag-pill">${escapeHtml(s.equipment)}</span>` : ""}
        </div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" onclick="openStationModal('${s.id}')">Edit</button>
        <button class="icon-btn danger" onclick="deleteStation('${s.id}')">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function openStationModal(stationId) {
  const existing = stationId ? stationsCache.find((s) => s.id === stationId) : null;

  openModal(`
    <h3>${existing ? "Edit station" : "New station"}</h3>
    <form id="station-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="station-name" required value="${existing ? escapeHtml(existing.name) : ""}" autofocus />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  document.getElementById("station-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById("station-name").value.trim(),
    };

    let error;
    if (existing) {
      ({ error } = await supabaseClient.from("stations").update(payload).eq("id", existing.id));
    } else {
      ({ error } = await supabaseClient.from("stations").insert(payload));
    }

    if (error) {
      alert("Failed to save station: " + error.message);
      return;
    }
    closeModal();
    loadStations();
  });
}

async function deleteStation(stationId) {
  if (!confirm("Delete this station? This cannot be undone.")) return;
  const { error } = await supabaseClient.from("stations").delete().eq("id", stationId);
  if (error) {
    alert("Failed to delete: " + error.message);
    return;
  }
  loadStations();
}

/* ============================================
   WORKOUTS — desktop is view/manage only. Starting a workout and logging
   sets happens on the phone (that's the whole point of the mobile logging
   flow); desktop's job is reviewing and cleaning up what's already there.
   ============================================ */
let workoutsCache = [];
let selectedWorkoutIds = new Set();

async function loadWorkouts() {
  const listEl = document.getElementById("workouts-list");
  listEl.innerHTML = `<div class="empty-state">Loading...</div>`;
  selectedWorkoutIds = new Set();

  const { data, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    listEl.innerHTML = `<div class="empty-state">Error loading workouts</div>`;
    renderWorkoutsBulkBar();
    return;
  }

  workoutsCache = data;

  if (data.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">No workouts logged</div>
        <p>Start one and log sets from your phone at the gym.</p>
      </div>`;
    renderWorkoutsBulkBar();
    return;
  }

  listEl.innerHTML = data
    .map((w) => {
      const volume = w.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);
      return `
      <div class="card-row">
        <div class="row-left">
          <label class="row-checkbox">
            <input type="checkbox" class="workout-select" data-id="${w.id}" />
          </label>
          <div>
            <div class="title">${escapeHtml(w.name || "Workout")}</div>
            <div class="meta">${new Date(w.started_at).toLocaleString()} · ${w.workout_sets.length} sets · ${Math.round(volume)}kg volume</div>
          </div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" onclick="openWorkoutDetail('${w.id}')">View</button>
          <button class="icon-btn danger" onclick="deleteWorkout('${w.id}')">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  listEl.querySelectorAll(".workout-select").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedWorkoutIds.add(cb.dataset.id);
      else selectedWorkoutIds.delete(cb.dataset.id);
      renderWorkoutsBulkBar();
    });
  });

  renderWorkoutsBulkBar();
}

function renderWorkoutsBulkBar() {
  const bar = document.getElementById("workouts-bulk-bar");
  const selectAll = document.getElementById("workouts-select-all");
  const countEl = document.getElementById("workouts-selected-count");
  const deleteBtn = document.getElementById("workouts-delete-selected-btn");

  const total = workoutsCache.length;
  const selected = selectedWorkoutIds.size;

  bar.classList.toggle("hidden", total === 0);
  countEl.textContent = selected > 0 ? `${selected} selected` : "";
  deleteBtn.disabled = selected === 0;
  selectAll.checked = total > 0 && selected === total;
  selectAll.indeterminate = selected > 0 && selected < total;
}

function toggleSelectAllWorkouts(checked) {
  selectedWorkoutIds = checked ? new Set(workoutsCache.map((w) => w.id)) : new Set();
  document.querySelectorAll(".workout-select").forEach((cb) => {
    cb.checked = selectedWorkoutIds.has(cb.dataset.id);
  });
  renderWorkoutsBulkBar();
}

async function deleteSelectedWorkouts() {
  const ids = [...selectedWorkoutIds];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} selected workout${ids.length === 1 ? "" : "s"} and all their logged sets?`)) return;

  const btn = document.getElementById("workouts-delete-selected-btn");
  btn.disabled = true;
  btn.textContent = "Deleting...";

  const { error } = await supabaseClient.from("workouts").delete().in("id", ids);

  btn.textContent = "Delete Selected";

  if (error) return alert("Failed to delete: " + error.message);
  loadWorkouts();
}

async function openWorkoutDetail(workoutId) {
  const { data: workout, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .eq("id", workoutId)
    .single();

  if (error) return alert("Failed to load workout: " + error.message);

  // Grouped by station and labeled the same way mobile's Journal does
  // ("Set N · reps reps @ weightkg") — this is a list to scan, not an
  // edit form, so it reads by station the way you'd actually recall a
  // session ("what did I do on bench, then squat...") rather than as a
  // flat insertion-order list of sets.
  const grouped = {};
  workout.workout_sets
    .sort((a, b) => a.set_number - b.set_number)
    .forEach((s) => {
      if (!grouped[s.station_id]) grouped[s.station_id] = { name: s.stations.name, sets: [] };
      grouped[s.station_id].sets.push(s);
    });

  const stationsHtml = Object.values(grouped)
    .map((group) => {
      const setsHtml = group.sets
        .map((s) => {
          let prBadge = "";
          if (s.is_pr_attempt) {
            prBadge = s.pr_result === "success" ? `<span class="wd-pr-tag success">ATTEMPT SUCCESS</span>`
              : s.pr_result === "failure" ? `<span class="wd-pr-tag failure">ATTEMPT FAILED</span>`
              : `<span class="wd-pr-tag pending">ATTEMPT PENDING</span>`;
          }
          return `
          <div class="wd-set-row">
            <span class="wd-set-label">Set ${s.set_number} · ${s.reps} reps${s.weight ? ` @ ${s.weight}kg` : ""} ${prBadge}</span>
            <button class="icon-btn danger" onclick="deleteSet('${s.id}', '${workoutId}')">Delete</button>
          </div>`;
        })
        .join("");
      return `
        <div class="wd-station-block">
          <div class="wd-station-name">${escapeHtml(group.name)}</div>
          ${setsHtml}
        </div>`;
    })
    .join("");

  const volume = workout.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);

  openModal(`
    <h3>${escapeHtml(workout.name || "Workout")}</h3>
    <div class="wd-meta">${new Date(workout.started_at).toLocaleString()} · ${workout.workout_sets.length} sets · ${Math.round(volume)}kg volume</div>
    <div class="wd-station-list">
      ${stationsHtml || '<div class="empty-state" style="padding:20px;">No sets logged yet</div>'}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" onclick="closeModal()">Close</button>
    </div>
  `);
}

async function deleteSet(setId, workoutId) {
  if (!confirm("Delete this set?")) return;
  const { error } = await supabaseClient.from("workout_sets").delete().eq("id", setId);
  if (error) return alert("Failed to delete set: " + error.message);
  loadWorkouts();
  openWorkoutDetail(workoutId);
}

async function deleteWorkout(workoutId) {
  if (!confirm("Delete this workout and all its logged sets?")) return;
  const { error } = await supabaseClient.from("workouts").delete().eq("id", workoutId);
  if (error) return alert("Failed to delete: " + error.message);
  loadWorkouts();
}

/** Small, destructive shortcut living on the Workouts view itself (Admin's
 *  Danger Zone has the same underlying wipe — this just saves the trip). */
async function clearAllWorkouts() {
  if (!confirm("Delete ALL workouts and every logged set? This cannot be undone.")) return;

  const btn = document.getElementById("clear-all-workouts-btn");
  btn.disabled = true;
  btn.textContent = "Clearing...";

  const { error } = await supabaseClient.from("workouts").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  btn.disabled = false;
  btn.textContent = "Clear All";

  if (error) return alert("Failed to clear: " + error.message);
  loadWorkouts();
}