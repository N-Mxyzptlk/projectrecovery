// desktop.js
// All desktop dashboard behaviour: navigation, CRUD for stations/routines/
// workouts, and the statistics view. Called once the user is authenticated
// and the device gate (in index.html) has decided this is a desktop session.

let currentUserId = null;
let stationsCache = [];   // refreshed on load, reused by routine/workout forms
let dashboardVolumeChart = null;
let statsVolumeChart = null;
let statsFrequencyChart = null;

function initDesktopApp(session) {
  currentUserId = session.user.id;
  document.getElementById("app-root").classList.remove("hidden");

  setupNav();
  document.getElementById("logout-btn").addEventListener("click", signOut);

  document.getElementById("add-station-btn").addEventListener("click", () => openStationModal());
  document.getElementById("add-routine-btn").addEventListener("click", () => openRoutineModal());
  document.getElementById("add-workout-btn").addEventListener("click", () => openStartWorkoutModal());

  document.getElementById("last-deployed-text").textContent = LAST_DEPLOYED;
  runConnectivityCheck();
  setInterval(runConnectivityCheck, 60000);

  initAutoLogout();

  loadDashboard();
}

async function runConnectivityCheck() {
  const { status, ms } = await checkConnectivity();
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  dot.className = "status-dot status-" + status;
  const label = status === "green" ? "Connected" : status === "yellow" ? "Slow" : "Offline";
  text.textContent = `${label} (${ms}ms)`;
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
  if (viewName === "routines") loadRoutines();
  if (viewName === "workouts") loadWorkouts();
  if (viewName === "stats") loadStats();
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
  const statsGrid = document.getElementById("dashboard-stats");
  const recentBox = document.getElementById("dashboard-recent");
  statsGrid.innerHTML = `<div class="stat-card"><div class="label">Loading...</div></div>`;
  recentBox.innerHTML = "";

  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);

  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(reps, weight, created_at)")
    .gte("started_at", eightWeeksAgo.toISOString())
    .order("started_at", { ascending: false });

  if (error) {
    statsGrid.innerHTML = `<div class="stat-card"><div class="label">Error loading data</div></div>`;
    console.error(error);
    return;
  }

  const totalWorkouts = workouts.length;
  const totalSets = workouts.reduce((sum, w) => sum + w.workout_sets.length, 0);
  const totalVolume = workouts.reduce(
    (sum, w) => sum + w.workout_sets.reduce((s, set) => s + (set.reps * (set.weight || 0)), 0),
    0
  );
  const thisWeekCount = workouts.filter((w) => {
    const daysAgo = (Date.now() - new Date(w.started_at)) / (1000 * 60 * 60 * 24);
    return daysAgo <= 7;
  }).length;

  statsGrid.innerHTML = `
    <div class="stat-card">
      <div class="label">Workouts (8wk)</div>
      <div class="value">${totalWorkouts}</div>
    </div>
    <div class="stat-card">
      <div class="label">This week</div>
      <div class="value">${thisWeekCount}</div>
    </div>
    <div class="stat-card">
      <div class="label">Total sets (8wk)</div>
      <div class="value">${totalSets}</div>
    </div>
    <div class="stat-card">
      <div class="label">Volume (8wk)</div>
      <div class="value">${Math.round(totalVolume).toLocaleString()}<span class="unit">kg</span></div>
    </div>
  `;

  renderWeeklyVolumeChart("dashboard-volume-chart", workouts, (chart) => {
    if (dashboardVolumeChart) dashboardVolumeChart.destroy();
    dashboardVolumeChart = chart;
  });

  const recent = workouts.slice(0, 5);
  if (recent.length === 0) {
    recentBox.innerHTML = `<div class="empty-state"><div class="big">No workouts yet</div><p>Start one to see it here.</p></div>`;
  } else {
    recentBox.innerHTML = recent
      .map((w) => {
        const volume = w.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);
        return `
        <div class="card-row">
          <div>
            <div class="title">${escapeHtml(w.name || "Workout")}</div>
            <div class="meta">${new Date(w.started_at).toLocaleDateString()} · ${w.workout_sets.length} sets · ${Math.round(volume)}kg volume</div>
          </div>
        </div>`;
      })
      .join("");
  }
}

function renderWeeklyVolumeChart(canvasId, workouts, onCreate) {
  const weekBuckets = {};
  for (let i = 7; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    const key = `Wk ${8 - i}`;
    weekBuckets[key] = 0;
  }
  const labels = Object.keys(weekBuckets);

  workouts.forEach((w) => {
    const daysAgo = Math.floor((Date.now() - new Date(w.started_at)) / (1000 * 60 * 60 * 24));
    const weekIndex = Math.min(7, Math.floor(daysAgo / 7));
    const label = labels[7 - weekIndex];
    const volume = w.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);
    if (label) weekBuckets[label] += volume;
  });

  const ctx = document.getElementById(canvasId).getContext("2d");
  const chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Volume (kg)",
        data: Object.values(weekBuckets),
        backgroundColor: "#6c63ff",
        borderRadius: 4,
      }],
    },
    options: chartBaseOptions(),
  });
  onCreate(chart);
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
        <button class="icon-btn" onclick="openStationModal('${s.id}')" title="Edit">✎</button>
        <button class="icon-btn danger" onclick="deleteStation('${s.id}')" title="Delete">✕</button>
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
   ROUTINES
   ============================================ */
async function loadRoutines() {
  const listEl = document.getElementById("routines-list");
  listEl.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data, error } = await supabaseClient
    .from("routines")
    .select("*, routine_stations(*, stations(name))")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    listEl.innerHTML = `<div class="empty-state">Error loading routines</div>`;
    return;
  }

  if (data.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">No routines yet</div>
        <p>Group stations into a reusable template, like "Push Day".</p>
        <button class="btn-accent" onclick="openRoutineModal()">+ New routine</button>
      </div>`;
    return;
  }

  listEl.innerHTML = data
    .map((r) => {
      const stationNames = r.routine_stations
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((rs) => escapeHtml(rs.stations.name))
        .join(", ");
      return `
      <div class="card-row">
        <div>
          <div class="title">${escapeHtml(r.name)}</div>
          <div class="meta">${stationNames || "No stations added"}</div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" onclick="openRoutineModal('${r.id}')" title="Edit">✎</button>
          <button class="icon-btn danger" onclick="deleteRoutine('${r.id}')" title="Delete">✕</button>
        </div>
      </div>`;
    })
    .join("");
}

async function openRoutineModal(routineId) {
  if (stationsCache.length === 0) {
    const { data } = await supabaseClient.from("stations").select("*").order("name");
    stationsCache = data || [];
  }

  if (stationsCache.length === 0) {
    alert("Add at least one station first, then build a routine from it.");
    return;
  }

  let existing = null;
  let existingLinks = [];
  if (routineId) {
    const { data } = await supabaseClient
      .from("routines")
      .select("*, routine_stations(*)")
      .eq("id", routineId)
      .single();
    existing = data;
    existingLinks = (data.routine_stations || []).sort((a, b) => a.sort_order - b.sort_order);
  }

  openModal(`
    <h3>${existing ? "Edit routine" : "New routine"}</h3>
    <form id="routine-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="routine-name" required value="${existing ? escapeHtml(existing.name) : ""}" />
      </div>
      <div class="field">
        <label>Description</label>
        <input type="text" id="routine-description" value="${existing ? escapeHtml(existing.description) : ""}" />
      </div>
      <div class="field">
        <label>Stations</label>
        <div id="routine-stations-editor"></div>
        <button type="button" class="btn-ghost" id="routine-add-station-row" style="width:100%;margin-top:6px;">+ Add station</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  const editor = document.getElementById("routine-stations-editor");

  function addStationRow(prefill) {
    const rowId = "row-" + Math.random().toString(36).slice(2, 9);
    const row = document.createElement("div");
    row.className = "routine-station-item";
    row.id = rowId;
    row.innerHTML = `
      <select class="rs-station station-name">
        ${stationsCache.map((s) => `<option value="${s.id}" ${prefill && prefill.station_id === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
      </select>
      <input type="number" class="rs-sets" placeholder="sets" style="width:60px" value="${prefill ? prefill.target_sets ?? "" : ""}" />
      <input type="number" class="rs-reps" placeholder="reps" style="width:60px" value="${prefill ? prefill.target_reps ?? "" : ""}" />
      <button type="button" class="icon-btn danger" onclick="document.getElementById('${rowId}').remove()">✕</button>
    `;
    editor.appendChild(row);
  }

  if (existingLinks.length > 0) {
    existingLinks.forEach((link) => addStationRow(link));
  } else {
    addStationRow();
  }

  document.getElementById("routine-add-station-row").addEventListener("click", () => addStationRow());

  document.getElementById("routine-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("routine-name").value.trim();
    const description = document.getElementById("routine-description").value.trim() || null;

    const rows = Array.from(editor.querySelectorAll(".routine-station-item")).map((row, idx) => ({
      station_id: row.querySelector(".rs-station").value,
      target_sets: row.querySelector(".rs-sets").value || null,
      target_reps: row.querySelector(".rs-reps").value || null,
      sort_order: idx,
    }));

    let routineIdToUse = existing ? existing.id : null;

    if (existing) {
      const { error } = await supabaseClient
        .from("routines")
        .update({ name, description })
        .eq("id", existing.id);
      if (error) return alert("Failed to update routine: " + error.message);

      await supabaseClient.from("routine_stations").delete().eq("routine_id", existing.id);
    } else {
      const { data, error } = await supabaseClient
        .from("routines")
        .insert({ name, description })
        .select()
        .single();
      if (error) return alert("Failed to create routine: " + error.message);
      routineIdToUse = data.id;
    }

    const linkRows = rows.map((r) => ({ ...r, routine_id: routineIdToUse }));
    const { error: linkError } = await supabaseClient.from("routine_stations").insert(linkRows);
    if (linkError) return alert("Failed to save routine stations: " + linkError.message);

    closeModal();
    loadRoutines();
  });
}

async function deleteRoutine(routineId) {
  if (!confirm("Delete this routine? This cannot be undone.")) return;
  const { error } = await supabaseClient.from("routines").delete().eq("id", routineId);
  if (error) {
    alert("Failed to delete: " + error.message);
    return;
  }
  loadRoutines();
}

/* ============================================
   WORKOUTS
   ============================================ */
async function loadWorkouts() {
  const listEl = document.getElementById("workouts-list");
  listEl.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    listEl.innerHTML = `<div class="empty-state">Error loading workouts</div>`;
    return;
  }

  if (data.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">No workouts logged</div>
        <p>Start one, or log sets from your phone at the gym.</p>
        <button class="btn-accent" onclick="openStartWorkoutModal()">+ Start workout</button>
      </div>`;
    return;
  }

  listEl.innerHTML = data
    .map((w) => {
      const volume = w.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);
      return `
      <div class="card-row">
        <div>
          <div class="title">${escapeHtml(w.name || "Workout")}</div>
          <div class="meta">${new Date(w.started_at).toLocaleString()} · ${w.workout_sets.length} sets · ${Math.round(volume)}kg volume</div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" onclick="openWorkoutDetail('${w.id}')" title="View / add sets">▤</button>
          <button class="icon-btn danger" onclick="deleteWorkout('${w.id}')" title="Delete">✕</button>
        </div>
      </div>`;
    })
    .join("");
}

async function openStartWorkoutModal() {
  const { data: routines } = await supabaseClient.from("routines").select("id, name").order("name");

  openModal(`
    <h3>Start workout</h3>
    <form id="start-workout-form">
      <div class="field">
        <label>Name (optional)</label>
        <input type="text" id="workout-name" placeholder="e.g. Push Day" />
      </div>
      <div class="field">
        <label>Based on routine (optional)</label>
        <select id="workout-routine">
          <option value="">— none —</option>
          ${(routines || []).map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("")}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">Start</button>
      </div>
    </form>
  `);

  document.getElementById("start-workout-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("workout-name").value.trim() || null;
    const routineId = document.getElementById("workout-routine").value || null;

    const { data, error } = await supabaseClient
      .from("workouts")
      .insert({ name, routine_id: routineId, started_at: new Date().toISOString() })
      .select()
      .single();

    if (error) return alert("Failed to start workout: " + error.message);
    closeModal();
    loadWorkouts();
    openWorkoutDetail(data.id);
  });
}

async function openWorkoutDetail(workoutId) {
  const { data: workout, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .eq("id", workoutId)
    .single();

  if (error) return alert("Failed to load workout: " + error.message);

  if (stationsCache.length === 0) {
    const { data } = await supabaseClient.from("stations").select("*").order("name");
    stationsCache = data || [];
  }

  const setsHtml = workout.workout_sets
    .sort((a, b) => a.set_number - b.set_number)
    .map(
      (s) => `
      <div class="card-row">
        <div>
          <div class="title">${escapeHtml(s.stations.name)} — set ${s.set_number}</div>
          <div class="meta">${s.reps} reps${s.weight ? ` @ ${s.weight}${s.weight_unit}` : ""}</div>
        </div>
        <button class="icon-btn danger" onclick="deleteSet('${s.id}', '${workoutId}')" title="Delete set">✕</button>
      </div>`
    )
    .join("");

  openModal(`
    <h3>${escapeHtml(workout.name || "Workout")} — ${new Date(workout.started_at).toLocaleDateString()}</h3>
    <div style="max-height:240px;overflow-y:auto;margin-bottom:16px;">
      ${setsHtml || '<div class="empty-state" style="padding:20px;">No sets logged yet</div>'}
    </div>
    <h3 style="font-size:13px;color:var(--text-muted);">Add set</h3>
    <form id="add-set-form">
      <div class="field">
        <label>Station</label>
        <select id="set-station" required>
          ${stationsCache.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Reps</label>
          <input type="number" id="set-reps" required min="1" />
        </div>
        <div class="field">
          <label>Weight (kg)</label>
          <input type="number" id="set-weight" step="0.5" min="0" />
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Close</button>
        <button type="submit" class="btn-accent">Add set</button>
      </div>
    </form>
  `);

  document.getElementById("add-set-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const stationId = document.getElementById("set-station").value;
    const reps = parseInt(document.getElementById("set-reps").value, 10);
    const weight = document.getElementById("set-weight").value
      ? parseFloat(document.getElementById("set-weight").value)
      : null;

    const setsForStation = workout.workout_sets.filter((s) => s.station_id === stationId);
    const nextSetNumber = setsForStation.length + 1;

    const { error: insertError } = await supabaseClient.from("workout_sets").insert({
      workout_id: workoutId,
      station_id: stationId,
      set_number: nextSetNumber,
      reps,
      weight,
      client_uuid: crypto.randomUUID(),
    });

    if (insertError) return alert("Failed to add set: " + insertError.message);
    loadWorkouts();
    openWorkoutDetail(workoutId); // refresh modal with new set
  });
}

async function deleteSet(setId, workoutId) {
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

/* ============================================
   STATISTICS
   ============================================ */
async function loadStats() {
  const twelveWeeksAgo = new Date();
  twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);

  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .gte("started_at", twelveWeeksAgo.toISOString())
    .order("started_at");

  if (error) {
    console.error(error);
    return;
  }

  renderStatsVolumeChart(workouts);
  renderStatsFrequencyChart(workouts);
  renderPRTable(workouts);
}

function renderStatsVolumeChart(workouts) {
  const buckets = {};
  for (let i = 11; i >= 0; i--) {
    buckets[`Wk ${12 - i}`] = 0;
  }
  const labels = Object.keys(buckets);

  workouts.forEach((w) => {
    const daysAgo = Math.floor((Date.now() - new Date(w.started_at)) / (1000 * 60 * 60 * 24));
    const weekIndex = Math.min(11, Math.floor(daysAgo / 7));
    const label = labels[11 - weekIndex];
    const volume = w.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);
    if (label) buckets[label] += volume;
  });

  const ctx = document.getElementById("stats-volume-chart").getContext("2d");
  if (statsVolumeChart) statsVolumeChart.destroy();
  statsVolumeChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Volume (kg)",
        data: Object.values(buckets),
        borderColor: "#6c63ff",
        backgroundColor: "rgba(108,99,255,0.15)",
        fill: true,
        tension: 0.3,
      }],
    },
    options: chartBaseOptions(),
  });
}

function renderStatsFrequencyChart(workouts) {
  const buckets = {};
  for (let i = 11; i >= 0; i--) {
    buckets[`Wk ${12 - i}`] = 0;
  }
  const labels = Object.keys(buckets);

  workouts.forEach((w) => {
    const daysAgo = Math.floor((Date.now() - new Date(w.started_at)) / (1000 * 60 * 60 * 24));
    const weekIndex = Math.min(11, Math.floor(daysAgo / 7));
    const label = labels[11 - weekIndex];
    if (label) buckets[label] += 1;
  });

  const ctx = document.getElementById("stats-frequency-chart").getContext("2d");
  if (statsFrequencyChart) statsFrequencyChart.destroy();
  statsFrequencyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Workouts",
        data: Object.values(buckets),
        backgroundColor: "#4ade80",
        borderRadius: 4,
      }],
    },
    options: chartBaseOptions(),
  });
}

function renderPRTable(workouts) {
  const prs = {}; // station name -> { weight, reps, date }

  workouts.forEach((w) => {
    w.workout_sets.forEach((s) => {
      if (!s.weight) return;
      const name = s.stations.name;
      if (!prs[name] || s.weight > prs[name].weight) {
        prs[name] = { weight: s.weight, reps: s.reps, date: w.started_at };
      }
    });
  });

  const rows = Object.entries(prs);
  const el = document.getElementById("stats-prs");

  if (rows.length === 0) {
    el.innerHTML = `<div class="empty-state">No weighted sets logged in the last 12 weeks yet.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="card-row" style="border-bottom:1px solid var(--border);font-size:11px;color:var(--text-muted);text-transform:uppercase;">
      <div style="flex:1;">Station</div>
      <div style="width:160px;">Best set (12wk)</div>
    </div>
    ${rows
      .map(
        ([name, pr]) => `
      <div class="card-row">
        <div class="title">${escapeHtml(name)}</div>
        <div class="meta">${pr.weight}kg × ${pr.reps} — ${new Date(pr.date).toLocaleDateString()}</div>
      </div>`
      )
      .join("")}
  `;
}