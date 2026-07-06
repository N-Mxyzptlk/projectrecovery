// mobile.js
// Mobile is deliberately narrow in scope: start a workout, log sets fast,
// glance at stats. No creating/editing stations or routines here — that
// stays on desktop. Reuses `stationsCache` and `currentUserId` declared
// in desktop.js (loaded first), and `supabaseClient` from supabase-client.js.

let mCurrentWorkout = null;
let mSelectedStationId = null;
let mRepsValue = 8;
let mWeightValue = 20;

function initMobileApp(session) {
  currentUserId = session.user.id;
  document.getElementById("mobile-app").classList.remove("hidden");

  document.getElementById("m-today-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  document.getElementById("m-stats-toggle").addEventListener("click", openStatsOverlay);
  document.getElementById("m-stats-close").addEventListener("click", closeStatsOverlay);
  document.getElementById("m-settings-toggle").addEventListener("click", openSettingsSheet);

  loadStationsForMobile().then(loadTodayWorkout);
}

async function loadStationsForMobile() {
  if (stationsCache && stationsCache.length > 0) return;
  const { data, error } = await supabaseClient.from("stations").select("*").order("name");
  if (!error) stationsCache = data || [];
}

/* ============================================
   Resume today's in-progress workout, or prompt to start one
   ============================================ */
async function loadTodayWorkout() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(*, stations(name))")
    .is("ended_at", null)
    .gte("started_at", startOfDay.toISOString())
    .order("started_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error(error);
    renderStartPrompt();
    return;
  }

  if (data && data.length > 0) {
    mCurrentWorkout = data[0];
    renderActiveSession();
  } else {
    renderStartPrompt();
  }
}

function renderStartPrompt() {
  const main = document.getElementById("m-main");
  main.innerHTML = `
    <div class="m-empty">
      <div class="big">No active workout</div>
      <p>Start one to begin logging sets.</p>
      <select class="m-routine-picker" id="m-routine-select">
        <option value="">Blank workout</option>
      </select>
      <button class="m-start-btn" id="m-start-btn">Start Workout</button>
    </div>
  `;
  loadRoutinesForPicker();
  document.getElementById("m-start-btn").addEventListener("click", startWorkout);
}

async function loadRoutinesForPicker() {
  const { data } = await supabaseClient.from("routines").select("id, name").order("name");
  const select = document.getElementById("m-routine-select");
  if (select && data) {
    data.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      select.appendChild(opt);
    });
  }
}

async function startWorkout() {
  const routineId = document.getElementById("m-routine-select").value || null;
  const btn = document.getElementById("m-start-btn");
  btn.disabled = true;
  btn.textContent = "Starting...";

  const { data, error } = await supabaseClient
    .from("workouts")
    .insert({ routine_id: routineId, started_at: new Date().toISOString() })
    .select("*, workout_sets(*, stations(name))")
    .single();

  if (error) {
    alert("Couldn't start workout: " + error.message);
    btn.disabled = false;
    btn.textContent = "Start Workout";
    return;
  }

  mCurrentWorkout = data;
  mSelectedStationId = null;
  renderActiveSession();
}

/* ============================================
   Active logging session
   ============================================ */
function renderActiveSession() {
  const main = document.getElementById("m-main");
  const chips = stationsCache.slice(0, 6);

  if (!mSelectedStationId && chips.length > 0) {
    mSelectedStationId = chips[0].id;
  }

  main.innerHTML = `
    <div class="m-session-header">
      <div>
        <div class="name">${escapeHtmlMobile(mCurrentWorkout.name || "Workout")}</div>
        <div class="meta">${mCurrentWorkout.workout_sets.length} sets logged</div>
      </div>
      <button class="m-finish-btn" id="m-finish-btn">Finish</button>
    </div>

    <div class="m-station-row" id="m-station-row">
      ${chips
        .map(
          (s) => `<div class="m-station-chip ${s.id === mSelectedStationId ? "active" : ""}" data-id="${s.id}">${escapeHtmlMobile(s.name)}</div>`
        )
        .join("")}
      <div class="m-station-chip more" id="m-more-stations">More...</div>
    </div>

    <div class="m-log-card">
      <div class="selected-station" id="m-selected-station-name">${selectedStationName()}</div>
      <div class="m-stepper-row">
        <div class="m-stepper">
          <div class="m-stepper-label">Reps</div>
          <div class="m-stepper-control">
            <button class="m-stepper-btn" id="m-reps-minus" type="button">−</button>
            <input class="m-stepper-value" id="m-reps-value" inputmode="numeric" value="${mRepsValue}" />
            <button class="m-stepper-btn" id="m-reps-plus" type="button">+</button>
          </div>
        </div>
        <div class="m-stepper">
          <div class="m-stepper-label">Weight (kg)</div>
          <div class="m-stepper-control">
            <button class="m-stepper-btn" id="m-weight-minus" type="button">−</button>
            <input class="m-stepper-value" id="m-weight-value" inputmode="decimal" value="${mWeightValue}" />
            <button class="m-stepper-btn" id="m-weight-plus" type="button">+</button>
          </div>
        </div>
      </div>
      <button class="m-log-btn" id="m-log-set-btn">Log Set</button>
    </div>

    <div class="m-set-list-label">This session</div>
    <div id="m-set-list">${renderSetList()}</div>
  `;

  wireSessionEvents();
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
    .map(
      (s) => `
    <div class="m-set-row">
      <div class="info">
        <div class="name">${escapeHtmlMobile(s.stations.name)}</div>
        <div class="detail">Set ${s.set_number} · ${s.reps} reps${s.weight ? ` @ ${s.weight}kg` : ""}</div>
      </div>
      <button class="delete-btn" data-set-id="${s.id}" type="button">✕</button>
    </div>`
    )
    .join("");
}

function wireSessionEvents() {
  document.getElementById("m-finish-btn").addEventListener("click", finishWorkout);

  document.querySelectorAll(".m-station-chip[data-id]").forEach((chip) => {
    chip.addEventListener("click", () => {
      mSelectedStationId = chip.dataset.id;
      renderActiveSession();
    });
  });

  document.getElementById("m-more-stations").addEventListener("click", openStationSheet);

  document.getElementById("m-reps-minus").addEventListener("click", () => adjustStepper("reps", -1));
  document.getElementById("m-reps-plus").addEventListener("click", () => adjustStepper("reps", 1));
  document.getElementById("m-weight-minus").addEventListener("click", () => adjustStepper("weight", -2.5));
  document.getElementById("m-weight-plus").addEventListener("click", () => adjustStepper("weight", 2.5));

  document.getElementById("m-reps-value").addEventListener("change", (e) => {
    mRepsValue = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = mRepsValue;
  });
  document.getElementById("m-weight-value").addEventListener("change", (e) => {
    mWeightValue = Math.max(0, parseFloat(e.target.value) || 0);
    e.target.value = mWeightValue;
  });

  document.getElementById("m-log-set-btn").addEventListener("click", logSet);

  document.querySelectorAll(".delete-btn[data-set-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSetMobile(btn.dataset.setId));
  });
}

function adjustStepper(type, delta) {
  if (type === "reps") {
    mRepsValue = Math.max(0, mRepsValue + delta);
    document.getElementById("m-reps-value").value = mRepsValue;
  } else {
    mWeightValue = Math.max(0, +(mWeightValue + delta).toFixed(1));
    document.getElementById("m-weight-value").value = mWeightValue;
  }
}

async function logSet() {
  if (!mSelectedStationId) {
    alert("Pick a station first.");
    return;
  }
  const btn = document.getElementById("m-log-set-btn");
  btn.disabled = true;
  btn.textContent = "Logging...";

  // Check against all-time best for this station BEFORE inserting,
  // so we can tell if this set is a new PR.
  let isNewPR = false;
  if (mWeightValue > 0) {
    const { data: bestData } = await supabaseClient
      .from("workout_sets")
      .select("weight")
      .eq("station_id", mSelectedStationId)
      .order("weight", { ascending: false })
      .limit(1);
    const priorBest = bestData && bestData.length > 0 ? bestData[0].weight : 0;
    isNewPR = mWeightValue > priorBest;
  }

  const setsForStation = mCurrentWorkout.workout_sets.filter((s) => s.station_id === mSelectedStationId);
  const nextSetNumber = setsForStation.length + 1;

  const { data, error } = await supabaseClient
    .from("workout_sets")
    .insert({
      workout_id: mCurrentWorkout.id,
      station_id: mSelectedStationId,
      set_number: nextSetNumber,
      reps: mRepsValue,
      weight: mWeightValue || null,
      client_uuid: crypto.randomUUID(),
    })
    .select("*, stations(name)")
    .single();

  if (error) {
    alert("Failed to log set: " + error.message);
    btn.disabled = false;
    btn.textContent = "Log Set";
    return;
  }

  mCurrentWorkout.workout_sets.push(data);
  renderActiveSession(); // re-render also resets the button back to normal

  if (isNewPR) {
    showPRBanner(data.stations.name, mWeightValue);
  }
}

function showPRBanner(stationName, weight) {
  const banner = document.createElement("div");
  banner.className = "m-pr-banner";
  banner.innerHTML = `🏆 <strong>NEW PR</strong> — ${escapeHtmlMobile(stationName)} @ ${weight}kg`;
  document.body.appendChild(banner);

  // trigger the enter animation on the next frame, then auto-dismiss
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 300);
  }, 2200);
}

async function deleteSetMobile(setId) {
  const { error } = await supabaseClient.from("workout_sets").delete().eq("id", setId);
  if (error) {
    alert("Failed to delete: " + error.message);
    return;
  }
  mCurrentWorkout.workout_sets = mCurrentWorkout.workout_sets.filter((s) => s.id !== setId);
  renderActiveSession();
}

async function finishWorkout() {
  if (!confirm("Finish this workout?")) return;
  const { error } = await supabaseClient
    .from("workouts")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", mCurrentWorkout.id);

  if (error) {
    alert("Failed to finish: " + error.message);
    return;
  }
  mCurrentWorkout = null;
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
      ${stationsCache.map((s) => `<div class="m-sheet-item" data-id="${s.id}">${escapeHtmlMobile(s.name)}</div>`).join("")}
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
      mSelectedStationId = item.dataset.id;
      overlay.remove();
      renderActiveSession();
    }
  });
}

/* ============================================
   Stats overlay — read-only glance, no editing controls
   ============================================ */
async function openStatsOverlay() {
  const overlay = document.getElementById("m-stats-overlay");
  overlay.classList.remove("hidden");
  const content = document.getElementById("m-stats-content");
  content.innerHTML = `<div class="m-empty"><p>Loading...</p></div>`;

  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);

  const { data: workouts, error } = await supabaseClient
    .from("workouts")
    .select("*, workout_sets(reps, weight)")
    .gte("started_at", eightWeeksAgo.toISOString());

  if (error) {
    content.innerHTML = `<div class="m-empty"><p>Couldn't load stats.</p></div>`;
    return;
  }

  const totalWorkouts = workouts.length;
  const totalSets = workouts.reduce((s, w) => s + w.workout_sets.length, 0);
  const totalVolume = workouts.reduce(
    (s, w) => s + w.workout_sets.reduce((ss, set) => ss + set.reps * (set.weight || 0), 0),
    0
  );
  const thisWeek = workouts.filter((w) => (Date.now() - new Date(w.started_at)) / 86400000 <= 7).length;

  content.innerHTML = `
    <div class="m-stat-block">
      <div class="label">Last 8 weeks</div>
      <div class="m-stat-row"><span class="k">Workouts</span><span class="v">${totalWorkouts}</span></div>
      <div class="m-stat-row"><span class="k">This week</span><span class="v">${thisWeek}</span></div>
      <div class="m-stat-row"><span class="k">Total sets</span><span class="v">${totalSets}</span></div>
      <div class="m-stat-row"><span class="k">Volume</span><span class="v">${Math.round(totalVolume).toLocaleString()} kg</span></div>
    </div>
  `;
}

function closeStatsOverlay() {
  document.getElementById("m-stats-overlay").classList.add("hidden");
}

/* ============================================
   Settings sheet — account + export + sign out ONLY.
   Deliberately no station/routine management here — mobile stays
   log-only by design.
   ============================================ */
async function openSettingsSheet() {
  const { data: userData } = await supabaseClient.auth.getUser();
  const email = userData?.user?.email || "—";

  const root = document.getElementById("m-settings-root");
  root.innerHTML = `
    <div class="m-sheet-overlay" id="m-settings-overlay">
      <div class="m-sheet">
        <div class="m-sheet-handle"></div>
        <div class="m-stat-block">
          <div class="label">Signed in as</div>
          <div class="m-stat-row"><span class="k">${escapeHtmlMobile(email)}</span></div>
        </div>
        <button class="m-start-btn" id="m-export-btn" style="width:100%;max-width:none;margin-bottom:10px;">⬇ Export my data</button>
        <button class="m-finish-btn" id="m-signout-btn" style="width:100%;padding:14px;">Sign out</button>
      </div>
    </div>
  `;

  const overlay = document.getElementById("m-settings-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) root.innerHTML = "";
  });
  document.getElementById("m-signout-btn").addEventListener("click", signOut);
  document.getElementById("m-export-btn").addEventListener("click", exportDataMobile);
}

async function exportDataMobile() {
  const btn = document.getElementById("m-export-btn");
  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const [stations, routines, workouts, sets] = await Promise.all([
      supabaseClient.from("stations").select("*"),
      supabaseClient.from("routines").select("*"),
      supabaseClient.from("workouts").select("*"),
      supabaseClient.from("workout_sets").select("*"),
    ]);

    const backup = {
      exported_at: new Date().toISOString(),
      stations: stations.data || [],
      routines: routines.data || [],
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
    alert("Export failed: " + e.message);
  }

  btn.disabled = false;
  btn.textContent = "⬇ Export my data";
}

function escapeHtmlMobile(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}