// mobile.js
// Mobile is deliberately narrow in scope: start a workout, log sets fast,
// browse the journal, glance at settings. No creating/editing stations or
// routines here — that stays on desktop. Reuses `stationsCache` and
// `currentUserId` from desktop.js (loaded first), `supabaseClient` /
// `checkConnectivity` / `signOut` from dbclient.js.

let mCurrentWorkout = null;
let mSessionNumber = null;
let mSessionTimerInterval = null;

let mSelectedStationId = null;
let mRepsValue = 8;
let mWeightValue = 20;
let mWeightIncrement = 2.5;
let mStationHistory = null; // { lastSets: [...], lastDate, prWeight }
let mIsPRAttemptMode = false;
let mPendingPRSetId = null; // set awaiting a Success/Failure tag

let mFinishConfirmPending = false;
let mFinishConfirmTimeout = null;

let mScreen = "log"; // 'log' | 'journal'
let mJournalDate = new Date();

/* ============================================
   Boot
   ============================================ */
function initMobileApp(session) {
  currentUserId = session.user.id;
  document.getElementById("mobile-app").classList.remove("hidden");

  document.getElementById("m-journal-fab").addEventListener("click", toggleJournalScreen);
  document.getElementById("m-settings-fab").addEventListener("click", openSettingsSheet);

  loadStationsForMobile().then(loadActiveWorkout);
}

async function loadStationsForMobile() {
  if (stationsCache && stationsCache.length > 0) return;
  const { data, error } = await supabaseClient.from("stations").select("*").order("name");
  if (!error) stationsCache = data || [];
}

function toggleJournalScreen() {
  mScreen = mScreen === "journal" ? "log" : "journal";
  document.getElementById("m-journal-fab").classList.toggle("active", mScreen === "journal");
  if (mScreen === "journal") {
    mJournalDate = new Date();
    renderJournalScreen();
  } else {
    if (mCurrentWorkout) renderActiveSession();
    else renderStartPrompt();
  }
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

  const { count } = await supabaseClient.from("workouts").select("id", { count: "exact", head: true });
  const nextSessionNumber = (count || 0) + 1;

  const { data, error } = await supabaseClient
    .from("workouts")
    .insert({
      routine_id: routineId,
      started_at: new Date().toISOString(),
      name: `Session ${nextSessionNumber}`,
    })
    .select("*, workout_sets(*, stations(name))")
    .single();

  if (error) {
    alert("Couldn't start workout: " + error.message);
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
      <div class="m-session-timer" id="m-session-timer">00:00</div>
      <button class="m-finish-btn" id="m-finish-btn">Finish</button>
    </div>
  `;

  document.getElementById("m-finish-btn").addEventListener("click", handleFinishClick);

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
        <button class="m-pr-toggle ${mIsPRAttemptMode ? "active" : ""}" id="m-pr-toggle" type="button">🎯 PR Attempt</button>
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
        prBadge = s.pr_result === "success" ? `<span class="m-pr-tag success">🎯 PR ✅</span>`
          : s.pr_result === "failure" ? `<span class="m-pr-tag failure">🎯 PR ❌</span>`
          : `<span class="m-pr-tag pending">🎯 PR ⏳</span>`;
      }
      return `
    <div class="m-set-row">
      <div class="info">
        <div class="name">${escapeHtmlMobile(s.stations.name)} ${prBadge}</div>
        <div class="detail">Set ${s.set_number} · ${s.reps} reps${s.weight ? ` @ ${s.weight}kg` : ""}</div>
      </div>
      <button class="delete-btn" data-set-id="${s.id}" type="button">✕</button>
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
  });
  document.getElementById("m-weight-value").addEventListener("change", (e) => {
    mWeightValue = Math.max(0, parseFloat(e.target.value) || 0);
    e.target.value = mWeightValue;
  });

  document.getElementById("m-pr-toggle").addEventListener("click", () => {
    mIsPRAttemptMode = !mIsPRAttemptMode;
    renderActiveSession();
  });

  document.getElementById("m-log-set-btn").addEventListener("click", logSet);

  document.querySelectorAll(".delete-btn[data-set-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSetMobile(btn.dataset.setId));
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

function adjustStepper(type, delta) {
  if (type === "reps") {
    mRepsValue = Math.max(0, mRepsValue + delta);
    document.getElementById("m-reps-value").value = mRepsValue;
  } else {
    mWeightValue = Math.max(0, +(mWeightValue + delta).toFixed(2));
    document.getElementById("m-weight-value").value = mWeightValue;
  }
}

/* ============================================
   Continuity — "where did I leave off" for the selected station
   ============================================ */
async function loadStationHistory(stationId) {
  const slot = document.getElementById("m-continuity-slot");
  if (!slot || !stationId) return;
  slot.innerHTML = "";

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
  // person can just tap Log Set to repeat, or nudge from there.
  const lastSet = lastSets[lastSets.length - 1];
  if (lastSet) {
    mRepsValue = lastSet.reps;
    mWeightValue = lastSet.weight || mWeightValue;
    const repsInput = document.getElementById("m-reps-value");
    const weightInput = document.getElementById("m-weight-value");
    if (repsInput) repsInput.value = mRepsValue;
    if (weightInput) weightInput.value = mWeightValue;
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

  const lastLine = lastSets && lastSets.length > 0
    ? lastSets.map((s) => `${s.reps}${s.weight ? `×${s.weight}kg` : ""}`).join(", ")
    : null;

  slot.innerHTML = `
    <div class="m-continuity-card">
      ${lastLine ? `<div class="m-continuity-row"><span class="k">Last time</span><span class="v">${escapeHtmlMobile(lastLine)}</span></div>` : ""}
      ${lastDate ? `<div class="m-continuity-row"><span class="k">Date</span><span class="v">${new Date(lastDate).toLocaleDateString()}</span></div>` : ""}
      ${prWeight ? `<div class="m-continuity-row"><span class="k">🏆 PR</span><span class="v">${prWeight}kg</span></div>` : ""}
    </div>
  `;
}

/* ============================================
   Logging a set — auto PR detection + optional manual PR-attempt tagging
   ============================================ */
async function logSet() {
  if (!mSelectedStationId) {
    alert("Pick a station first.");
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

  const { data, error } = await supabaseClient
    .from("workout_sets")
    .insert({
      workout_id: mCurrentWorkout.id,
      station_id: mSelectedStationId,
      set_number: nextSetNumber,
      reps: mRepsValue,
      weight: mWeightValue || null,
      client_uuid: crypto.randomUUID(),
      is_pr_attempt: wasPRAttempt,
    })
    .select("*, stations(name)")
    .single();

  if (error) {
    alert("Failed to log set: " + error.message);
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
        <button class="m-pr-result-btn success" data-result="success">✅ Success</button>
        <button class="m-pr-result-btn failure" data-result="failure">❌ Failure</button>
      </div>
    </div>
  `;
  slot.querySelectorAll(".m-pr-result-btn").forEach((btn) => {
    btn.addEventListener("click", () => markPRResult(setId, btn.dataset.result));
  });
}

async function markPRResult(setId, result) {
  const { error } = await supabaseClient.from("workout_sets").update({ pr_result: result }).eq("id", setId);
  if (!error) {
    const set = mCurrentWorkout.workout_sets.find((s) => s.id === setId);
    if (set) set.pr_result = result;
    mPendingPRSetId = null;
    document.getElementById("m-pr-tag-slot").innerHTML = "";
    document.getElementById("m-set-list").innerHTML = renderSetList();
    document.querySelectorAll(".delete-btn[data-set-id]").forEach((btn) => {
      btn.addEventListener("click", () => deleteSetMobile(btn.dataset.setId));
    });

    if (result === "success") {
      const set2 = mCurrentWorkout.workout_sets.find((s) => s.id === setId);
      if (set2) showPRBanner(set2.stations.name, set2.weight);
    }
  }
}

function showPRBanner(stationName, weight) {
  const banner = document.createElement("div");
  banner.className = "m-pr-banner";
  banner.innerHTML = `🏆 <strong>NEW PR</strong> — ${escapeHtmlMobile(stationName)} @ ${weight}kg`;
  document.body.appendChild(banner);

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
  document.getElementById("m-set-list").innerHTML = renderSetList();
  document.querySelectorAll(".delete-btn[data-set-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSetMobile(btn.dataset.setId));
  });
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
  const { error } = await supabaseClient
    .from("workouts")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", mCurrentWorkout.id);

  if (error) {
    alert("Failed to finish: " + error.message);
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
      <button class="m-journal-nav-btn" id="m-journal-prev" type="button">◀</button>
      <div class="m-journal-date-display" id="m-journal-date-display">
        ${isToday ? "Today" : mJournalDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        <input type="date" id="m-journal-date-input" value="${toDateInputValue(mJournalDate)}" />
      </div>
      <button class="m-journal-nav-btn" id="m-journal-next" type="button" ${isToday ? "disabled" : ""}>▶</button>
    </div>
  `;

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

async function loadJournalDay() {
  const main = document.getElementById("m-main");
  main.innerHTML = `<div class="m-empty"><p>Loading...</p></div>`;

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
}

function renderJournalWorkoutCard(workout) {
  const volume = workout.workout_sets.reduce((s, set) => s + set.reps * (set.weight || 0), 0);
  const grouped = {};
  workout.workout_sets
    .sort((a, b) => a.set_number - b.set_number)
    .forEach((s) => {
      const name = s.stations.name;
      if (!grouped[name]) grouped[name] = [];
      grouped[name].push(s);
    });

  const stationBlocks = Object.entries(grouped)
    .map(
      ([name, sets]) => `
      <div class="m-journal-station-block">
        <div class="m-journal-station-name">${escapeHtmlMobile(name)}</div>
        <div class="m-journal-station-sets">
          ${sets
            .map((s) => {
              let tag = "";
              if (s.is_pr_attempt) {
                tag = s.pr_result === "success" ? " 🎯✅" : s.pr_result === "failure" ? " 🎯❌" : " 🎯⏳";
              }
              return `${s.reps}${s.weight ? `×${s.weight}kg` : ""}${tag}`;
            })
            .join(" · ")}
        </div>
      </div>`
    )
    .join("");

  const duration = workout.ended_at
    ? formatDuration(new Date(workout.ended_at) - new Date(workout.started_at))
    : "in progress";

  return `
    <div class="m-journal-card">
      <div class="m-journal-card-header">
        <div class="name">${escapeHtmlMobile(workout.name || "Workout")}</div>
        <div class="meta">${new Date(workout.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${duration} · ${Math.round(volume)}kg volume</div>
      </div>
      ${stationBlocks}
    </div>
  `;
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
  const { data: userData } = await supabaseClient.auth.getUser();
  const { data: profile } = await supabaseClient.from("profiles").select("username, auto_logout_minutes").single();
  const email = userData?.user?.email || "—";

  const root = document.getElementById("m-settings-root");
  root.innerHTML = `
    <div class="m-sheet-overlay" id="m-settings-overlay">
      <div class="m-sheet">
        <div class="m-sheet-handle"></div>

        <div class="m-status-line">
          <span class="status-dot" id="m-status-dot"></span>
          <span id="m-status-text">Checking...</span>
          <span class="m-status-deployed">Last deployed: ${LAST_DEPLOYED}</span>
        </div>

        <div class="m-stat-block">
          <div class="label">Signed in as</div>
          <div class="m-stat-row"><span class="k">${escapeHtmlMobile(profile?.username || email)}</span></div>
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

        <button class="m-start-btn" id="m-export-btn" style="width:100%;max-width:none;margin-bottom:10px;">⬇ Export my data</button>
        <button class="m-finish-btn" id="m-signout-btn" style="width:100%;padding:14px;">Sign out</button>
      </div>
    </div>
  `;

  document.getElementById("m-auto-logout-select").value = String(profile?.auto_logout_minutes ?? 0);
  runMobileConnectivityCheck();

  const overlay = document.getElementById("m-settings-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) root.innerHTML = "";
  });
  document.getElementById("m-signout-btn").addEventListener("click", signOut);
  document.getElementById("m-export-btn").addEventListener("click", exportDataMobile);
  document.getElementById("m-auto-logout-select").addEventListener("change", async (e) => {
    const minutes = parseInt(e.target.value, 10);
    await supabaseClient.from("profiles").upsert({ id: currentUserId, auto_logout_minutes: minutes }, { onConflict: "id" });
    if (typeof updateAutoLogoutMinutes === "function") updateAutoLogoutMinutes(minutes);
  });
}

async function runMobileConnectivityCheck() {
  const { status, ms } = await checkConnectivity();
  const dot = document.getElementById("m-status-dot");
  const text = document.getElementById("m-status-text");
  if (!dot || !text) return;
  dot.className = "status-dot status-" + status;
  const label = status === "green" ? "Connected" : status === "yellow" ? "Slow" : "Offline";
  text.textContent = `${label} (${ms}ms)`;
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