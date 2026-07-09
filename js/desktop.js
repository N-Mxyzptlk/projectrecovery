// desktop.js
// All desktop dashboard behaviour: navigation, CRUD for stations,
// view/manage for workouts, and the statistics view. Called once the user
// is authenticated and the device gate (in index.html) has decided this is
// a desktop session.

let currentUserId = null;
let stationsCache = [];   // refreshed on load, reused by routine/workout forms
let stationStatCharts = {}; // keyed by station id, so we can destroy/recreate on reload

function initDesktopApp(session) {
  currentUserId = session.user.id;
  document.getElementById("app-root").classList.remove("hidden");

  setupNav();
  document.getElementById("logout-btn").addEventListener("click", signOut);

  document.getElementById("add-station-btn").addEventListener("click", () => openStationModal());
  document.getElementById("clear-all-workouts-btn").addEventListener("click", clearAllWorkouts);
  document.getElementById("workouts-select-all").addEventListener("change", (e) => toggleSelectAllWorkouts(e.target.checked));
  document.getElementById("workouts-delete-selected-btn").addEventListener("click", deleteSelectedWorkouts);

  document.getElementById("last-deployed-text").textContent = LAST_DEPLOYED;
  runConnectivityCheck();
  setInterval(runConnectivityCheck, 60000);

  initAutoLogout();

  loadDashboard();
}

async function runConnectivityCheck() {
  await checkConnectivity(); // updates status-dot/status-text itself
}

/* ============================================
   Navigation
   ============================================ */
function setupNav() {
  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      navItems.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");
      switchView(item.dataset.view);
    });
  });
}

function switchView(viewName) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${viewName}`).classList.remove("hidden");

  if (viewName === "dashboard") loadDashboard();
  if (viewName === "stations") loadStations();
  if (viewName === "workouts") loadWorkouts();
  if (viewName === "admin") loadAdmin();
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
  await loadRecentWorkouts();
  await loadStationStats();
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

function chartBaseOptions() {
  return {
    responsive: true,
    plugins: { legend: { display: false } },
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
async function loadStationStats() {
  const box = document.getElementById("dashboard-station-stats");
  box.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("id, started_at, workout_sets(station_id, weight, stations(name))")
    .order("started_at", { ascending: true });

  if (error) {
    box.innerHTML = `<div class="empty-state">Error loading station progress</div>`;
    console.error(error);
    return;
  }

  // stationId -> { name, sessions: [{date, maxWeight}] }
  const byStation = {};
  (workouts || []).forEach((w) => {
    const perStationMax = {};
    w.workout_sets.forEach((s) => {
      if (s.weight == null) return; // bodyweight sets don't factor into a weight trend
      if (!perStationMax[s.station_id] || s.weight > perStationMax[s.station_id].weight) {
        perStationMax[s.station_id] = { weight: s.weight, name: s.stations.name };
      }
    });
    Object.entries(perStationMax).forEach(([stationId, { weight, name }]) => {
      if (!byStation[stationId]) byStation[stationId] = { name, sessions: [] };
      byStation[stationId].sessions.push({ date: w.started_at, weight });
    });
  });

  const entries = Object.entries(byStation);
  if (entries.length === 0) {
    box.innerHTML = `<div class="empty-state"><div class="big">No weighted sets yet</div><p>Log some sets with weight to see progress here.</p></div>`;
    return;
  }

  Object.values(stationStatCharts).forEach((chart) => chart.destroy());
  stationStatCharts = {};

  const ABANDONED_DAYS = 60; // no session in 2 months reads as "stopped", not "plateaued"

  box.innerHTML = entries
    .map(([stationId, data]) => {
      const sessions = data.sessions;
      const timesLogged = sessions.length;
      const lastDate = new Date(sessions[sessions.length - 1].date);
      const daysSince = Math.floor((Date.now() - lastDate) / 86400000);
      const isAbandoned = daysSince >= ABANDONED_DAYS;

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

      return `
        <div class="station-stat-card ${isAbandoned ? "abandoned" : ""}">
          <div class="header-row">
            <div class="station-name">${escapeHtml(data.name)}</div>
            <div class="trend-badge ${trendClass}">${trendLabel}</div>
          </div>
          <div class="meta-line">Logged ${timesLogged} time${timesLogged === 1 ? "" : "s"} · Last ${formatRelativeDays(daysSince)}</div>
          <canvas id="station-chart-${stationId}" height="90"></canvas>
        </div>
      `;
    })
    .join("");

  entries.forEach(([stationId, data]) => {
    const ctx = document.getElementById(`station-chart-${stationId}`);
    if (!ctx) return;
    const chart = new Chart(ctx.getContext("2d"), {
      type: "line",
      data: {
        labels: data.sessions.map((s) => new Date(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
        datasets: [{
          label: "Weight (kg)",
          data: data.sessions.map((s) => s.weight),
          borderColor: "#6c63ff",
          backgroundColor: "rgba(108,99,255,0.15)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }],
      },
      options: chartBaseOptions(),
    });
    stationStatCharts[stationId] = chart;
  });
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

  const setsHtml = workout.workout_sets
    .sort((a, b) => a.set_number - b.set_number)
    .map(
      (s) => `
      <div class="card-row">
        <div>
          <div class="title">${escapeHtml(s.stations.name)} — set ${s.set_number}</div>
          <div class="meta">${s.reps} reps${s.weight ? ` @ ${s.weight}${s.weight_unit}` : ""}</div>
        </div>
        <button class="icon-btn danger" onclick="deleteSet('${s.id}', '${workoutId}')">Delete</button>
      </div>`
    )
    .join("");

  openModal(`
    <h3>${escapeHtml(workout.name || "Workout")} — ${new Date(workout.started_at).toLocaleDateString()}</h3>
    <div style="max-height:320px;overflow-y:auto;margin-bottom:16px;">
      ${setsHtml || '<div class="empty-state" style="padding:20px;">No sets logged yet</div>'}
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