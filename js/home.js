// home.js
// The "Home" landing page — a synced to-do list, upcoming-payment
// reminders, a live clock, and shortcuts into the other apps. This is
// the default landing surface on both platforms now (not tied to any one
// app), rendered as its own view/screen alongside Workout/Finance/Admin.
// Desktop shows it as a command-center dashboard; mobile shows a compact
// equivalent. Reuses supabaseClient/escapeHtml/switchApp from desktop.js,
// escapeHtmlMobile/switchMobileApp from mobile.js, and financePaymentsCache
// + payment status/format helpers from finance.js.

let todosCache = [];
let homeClockInterval = null;

/* ============================================
   To-do CRUD — one shared `todos` table (see sql/home_schema.sql), same
   list on desktop and mobile.
   ============================================ */
async function loadTodos() {
  const { data, error } = await supabaseClient
    .from("todos")
    .select("*")
    .order("done", { ascending: true })
    .order("created_at", { ascending: true });
  if (!error) todosCache = data || [];
  return todosCache;
}

async function addTodo(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const { error } = await supabaseClient.from("todos").insert({ text: trimmed });
  if (error) {
    await uiAlert("Failed to add task: " + error.message);
    return;
  }
  await loadTodos();
}

async function toggleTodo(id) {
  const todo = todosCache.find((t) => t.id === id);
  if (!todo) return;
  const { error } = await supabaseClient.from("todos").update({ done: !todo.done }).eq("id", id);
  if (!error) await loadTodos();
}

async function deleteTodo(id) {
  const { error } = await supabaseClient.from("todos").delete().eq("id", id);
  if (!error) await loadTodos();
}

function renderTodoListHtml(escapeFn) {
  if (todosCache.length === 0) {
    return `<div class="home-empty">No tasks — you're clear.</div>`;
  }
  return todosCache
    .map(
      (t) => `
    <div class="home-todo-item ${t.done ? "done" : ""}">
      <button type="button" class="home-todo-check" data-action="toggle" data-id="${t.id}" aria-label="Toggle done">${t.done ? "✓" : ""}</button>
      <span class="home-todo-text">${escapeFn(t.text)}</span>
      <button type="button" class="home-todo-delete" data-action="delete" data-id="${t.id}" aria-label="Delete task">×</button>
    </div>`
    )
    .join("");
}

/** Wires the checkbox/delete buttons inside an already-rendered todo list
 *  container. `onChange` re-renders after a mutation completes. */
function wireTodoListEvents(container, onChange) {
  container.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      await toggleTodo(btn.dataset.id);
      onChange();
    });
  });
  container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteTodo(btn.dataset.id);
      onChange();
    });
  });
}

/* ============================================
   Reminders — payments due within 14 days (unpaid/uncancelled) AND
   recurring income due within 14 days, merged into one soonest-first list.
   Reuses finance.js's status/format helpers.
   ============================================ */
function upcomingPaymentReminders() {
  return (financePaymentsCache || [])
    .map((p) => ({ payment: p, status: computePaymentDisplayStatus(p), days: daysUntilDue(p.next_due_date) }))
    .filter((d) => d.status !== "paid" && d.status !== "cancelled" && d.days <= 14)
    .sort((a, b) => a.days - b.days);
}

/** No reminder_days_before on recurring income (unlike payments), so this
 *  just uses a fixed 3-day "coming up soon" window before due-today. */
function upcomingIncomeReminders() {
  return (financeRecurringIncomeCache || [])
    .map((r) => ({ income: r, days: daysUntilDue(r.next_due_date) }))
    .filter((d) => d.days <= 14)
    .sort((a, b) => a.days - b.days);
}

function renderReminderListHtml(paymentReminders, incomeReminders, escapeFn) {
  const merged = [
    ...paymentReminders.map((d) => ({ type: "payment", ...d })),
    ...incomeReminders.map((d) => ({ type: "income", ...d })),
  ].sort((a, b) => a.days - b.days);

  if (merged.length === 0) {
    return `<div class="home-empty">Nothing due in the next 2 weeks.</div>`;
  }

  return merged
    .map((item) => {
      const daysLabel = item.days < 0 ? `${Math.abs(item.days)}d` : item.days === 0 ? "Today" : `${item.days}d`;

      if (item.type === "income") {
        return `
      <div class="home-payment-item status-income" data-recurring-income-id="${item.income.id}" title="Tap to mark received">
        <span class="payment-status-badge status-income">Income due</span>
        <span class="home-payment-name">${escapeFn(item.income.name)}</span>
        <span class="home-payment-days">${daysLabel}</span>
        <span class="home-payment-amount income">+${formatMoney(item.income.amount)}</span>
      </div>`;
      }

      return `
    <div class="home-payment-item status-${item.status}">
      ${paymentBadgeHtml(item.payment, item.status)}
      <span class="home-payment-name">${escapeFn(item.payment.name)}</span>
      <span class="home-payment-days">${daysLabel}</span>
      <span class="home-payment-amount">${formatMoney(item.payment.amount)}</span>
    </div>`;
    })
    .join("");
}

/** Tapping/clicking an income-due reminder marks it received right from
 *  Home — that's the whole point of surfacing it here instead of making
 *  people remember to go check the Finance page. */
function wireHomeReminderIncomeClicks(container, onDone) {
  container.querySelectorAll(".home-payment-item.status-income[data-recurring-income-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      const rule = (financeRecurringIncomeCache || []).find((r) => r.id === row.dataset.recurringIncomeId);
      if (!rule) return;
      if (!(await uiConfirm(`Mark "${rule.name}" (${formatMoney(rule.amount)}) as received?`))) return;
      await markRecurringIncomeReceived(rule.id);
      await loadFinanceRecurringIncomeCache();
      onDone();
    });
  });
}

/* ============================================
   Clock
   ============================================ */
function formatHomeTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatHomeDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** (Re)starts the ticking clock targeting the given element ids — safe to
 *  call every time Home is (re)entered, since it clears any prior
 *  interval first rather than stacking them. */
function startHomeClock(clockId, dateId) {
  stopHomeClock();
  const tick = () => {
    const clockEl = document.getElementById(clockId);
    if (!clockEl) {
      stopHomeClock();
      return;
    }
    const now = new Date();
    clockEl.textContent = formatHomeTime(now);
    const dateEl = document.getElementById(dateId);
    if (dateEl) dateEl.textContent = formatHomeDate(now);
  };
  tick();
  homeClockInterval = setInterval(tick, 1000);
}

function stopHomeClock() {
  if (homeClockInterval) {
    clearInterval(homeClockInterval);
    homeClockInterval = null;
  }
}

/** Shortcut cards/buttons into the other apps. `items` is
 *  [{ app, label }]; onClick receives the app name. */
function renderHomeShortcutsHtml(items) {
  return items
    .map(
      (i) => `
    <button type="button" class="home-shortcut" data-app="${i.app}">
      <div class="home-shortcut-label">${i.label}</div>
    </button>`
    )
    .join("");
}

function wireHomeShortcuts(container, onClick) {
  container.querySelectorAll(".home-shortcut").forEach((btn) => {
    btn.addEventListener("click", () => onClick(btn.dataset.app));
  });
}

/* ============================================
   DESKTOP — command-center dashboard
   ============================================ */
async function loadHomeDashboard() {
  startHomeClock("home-clock", "home-date");

  const shortcutsEl = document.getElementById("home-shortcuts");
  shortcutsEl.innerHTML = renderHomeShortcutsHtml([
    { app: "workout", label: "Workout" },
    { app: "finance", label: "Finance" },
    { app: "guitar", label: "Guitar" },
    { app: "movies", label: "Movies" },
    { app: "admin", label: "Settings" },
  ]);
  wireHomeShortcuts(shortcutsEl, (appName) => switchApp(appName));

  document.getElementById("home-todo-list").innerHTML = `<div class="home-empty">Loading...</div>`;
  document.getElementById("home-payment-reminders").innerHTML = `<div class="home-empty">Loading...</div>`;

  await Promise.all([loadTodos(), loadFinancePaymentsCache(), loadFinanceRecurringIncomeCache()]);
  renderHomeTodoPanel();
  renderHomePaymentPanel();
  loadWeatherWidget(); // desktop-only widget, doesn't need to block the rest of the dashboard on a third-party API

  const form = document.getElementById("home-todo-form");
  form.replaceWith(form.cloneNode(true)); // avoid stacking submit listeners on repeat visits
  document.getElementById("home-todo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("home-todo-input");
    await addTodo(input.value);
    input.value = "";
    renderHomeTodoPanel();
  });
}

function renderHomeTodoPanel() {
  const listEl = document.getElementById("home-todo-list");
  if (!listEl) return;
  listEl.innerHTML = renderTodoListHtml(escapeHtml);
  wireTodoListEvents(listEl, renderHomeTodoPanel);

  const countEl = document.getElementById("home-todo-count");
  if (countEl) {
    const remaining = todosCache.filter((t) => !t.done).length;
    countEl.textContent = todosCache.length ? `${remaining} open` : "";
  }
}

function renderHomePaymentPanel() {
  const el = document.getElementById("home-payment-reminders");
  if (!el) return;
  el.innerHTML = renderReminderListHtml(upcomingPaymentReminders(), upcomingIncomeReminders(), escapeHtml);
  wireHomeReminderIncomeClicks(el, renderHomePaymentPanel);
}

/* ============================================
   DESKTOP — weather widget. Open-Meteo: free, no API key, CORS-friendly —
   the only kind of weather API that works from a static frontend with no
   backend to hide a key behind. Desktop-only per the request that spawned
   this (checking for rain from a room without a window view).
   ============================================ */
const WEATHER_RAIN_THRESHOLD = 40; // % chance in the next hour that triggers the pulse warning
const WEATHER_LOCATION_STORAGE_KEY = "np_weather_location";
const WEATHER_DEFAULT_LOCATION = { name: "Singapore", lat: 1.3521, lon: 103.8198 };
const WEATHER_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // re-check the forecast every 10 minutes while Home is open

// Which specific forecast hour's warning was dismissed (double-click) —
// keyed to that hour's own timestamp, so a dismiss only suppresses THAT
// warning; once the "next hour" rolls over to a different timestamp (or a
// refresh shows a materially different forecast for it), it's a new
// warning and can pulse again.
let weatherDismissedForHour = null;

// WMO weather codes (what Open-Meteo returns) -> icon + short label.
const WEATHER_CODE_INFO = {
  0: { icon: "☀️", label: "Clear sky" },
  1: { icon: "🌤️", label: "Mostly clear" },
  2: { icon: "⛅", label: "Partly cloudy" },
  3: { icon: "☁️", label: "Overcast" },
  45: { icon: "🌫️", label: "Fog" },
  48: { icon: "🌫️", label: "Fog" },
  51: { icon: "🌦️", label: "Light drizzle" },
  53: { icon: "🌦️", label: "Drizzle" },
  55: { icon: "🌧️", label: "Heavy drizzle" },
  61: { icon: "🌦️", label: "Light rain" },
  63: { icon: "🌧️", label: "Rain" },
  65: { icon: "🌧️", label: "Heavy rain" },
  71: { icon: "🌨️", label: "Light snow" },
  73: { icon: "🌨️", label: "Snow" },
  75: { icon: "❄️", label: "Heavy snow" },
  80: { icon: "🌦️", label: "Rain showers" },
  81: { icon: "🌧️", label: "Rain showers" },
  82: { icon: "🌧️", label: "Violent showers" },
  95: { icon: "⛈️", label: "Thunderstorm" },
  96: { icon: "⛈️", label: "Thunderstorm, hail" },
  99: { icon: "⛈️", label: "Thunderstorm, hail" },
};

function weatherCodeInfo(code) {
  return WEATHER_CODE_INFO[code] || { icon: "🌡️", label: "—" };
}

function getStoredWeatherLocation() {
  try {
    const raw = localStorage.getItem(WEATHER_LOCATION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStoredWeatherLocation(location) {
  try {
    localStorage.setItem(WEATHER_LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch {}
}

/** Stored choice wins; otherwise try browser geolocation once (never
 *  prompts again after that — the result gets cached in localStorage);
 *  falls back to a fixed default if permission is denied or unavailable. */
function resolveWeatherLocation() {
  const stored = getStoredWeatherLocation();
  if (stored) return Promise.resolve(stored);

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(WEATHER_DEFAULT_LOCATION);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const location = { name: "Current location", lat: pos.coords.latitude, lon: pos.coords.longitude };
        setStoredWeatherLocation(location);
        resolve(location);
      },
      () => resolve(WEATHER_DEFAULT_LOCATION),
      { timeout: 5000 }
    );
  });
}

async function loadWeatherWidget() {
  const body = document.getElementById("home-weather-body");
  if (!body) return;

  wireWeatherLocationSearch();
  wireWeatherAutoRefresh();

  const location = await resolveWeatherLocation();
  if (currentApp !== "home") return; // navigated away from Home while geolocation/fetch was pending

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&hourly=precipitation_probability&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderWeatherWidget(data, location.name);
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="home-empty">Couldn't load weather.</div>`;
  }
}

/** Re-checks the forecast every 10 minutes while Home is the visible app —
 *  skips the fetch entirely otherwise, so switching to another app doesn't
 *  keep hitting the weather API in the background. Wired once (guarded),
 *  not per-render, so repeat visits to Home don't stack up intervals. */
function wireWeatherAutoRefresh() {
  if (wireWeatherAutoRefresh._wired) return;
  wireWeatherAutoRefresh._wired = true;
  setInterval(() => {
    if (currentApp === "home") loadWeatherWidget();
  }, WEATHER_REFRESH_INTERVAL_MS);
}

/** Next-hour rain chance = the first hourly forecast slot at or after now.
 *  Returns the slot's own timestamp too, so a dismiss can be keyed to this
 *  specific warning rather than "rain in general." */
function nextHourRainChance(hourly) {
  if (!hourly || !hourly.time) return { chance: null, time: null };
  const now = new Date();
  const idx = hourly.time.findIndex((t) => new Date(t) >= now);
  const useIdx = idx === -1 ? 0 : idx;
  return {
    chance: hourly.precipitation_probability ? hourly.precipitation_probability[useIdx] : null,
    time: hourly.time[useIdx] || null,
  };
}

function renderWeatherWidget(data, locationName) {
  const body = document.getElementById("home-weather-body");
  const panel = document.getElementById("home-weather-panel");
  if (!body || !panel) return;

  const current = data.current;
  const info = weatherCodeInfo(current.weather_code);
  const { chance: rainChance, time: rainHour } = nextHourRainChance(data.hourly);
  const rainDetected = rainChance !== null && rainChance >= WEATHER_RAIN_THRESHOLD;
  const rainWarning = rainDetected && rainHour !== weatherDismissedForHour;

  panel.classList.toggle("rain-warning", rainWarning);
  panel.dataset.rainHour = rainHour || "";

  const locationLabel = document.getElementById("home-weather-location-label");
  if (locationLabel) locationLabel.textContent = locationName;

  body.innerHTML = `
    <div class="weather-main">
      <div class="weather-icon">${info.icon}</div>
      <div class="weather-temp">${Math.round(current.temperature_2m)}°C</div>
      <div class="weather-desc">${info.label}</div>
    </div>
    <div class="weather-metrics">
      <div class="weather-metric"><span class="label">Feels like</span><span class="value">${Math.round(current.apparent_temperature)}°C</span></div>
      <div class="weather-metric"><span class="label">Humidity</span><span class="value">${Math.round(current.relative_humidity_2m)}%</span></div>
      <div class="weather-metric"><span class="label">Wind</span><span class="value">${Math.round(current.wind_speed_10m)} km/h</span></div>
    </div>
    ${rainWarning ? `<div class="weather-rain-warning">⚠ ${Math.round(rainChance)}% chance of rain in the next hour · double-click to dismiss</div>` : ""}
  `;

  panel.ondblclick = rainWarning
    ? () => {
        weatherDismissedForHour = rainHour;
        panel.classList.remove("rain-warning");
        const warningEl = body.querySelector(".weather-rain-warning");
        if (warningEl) warningEl.remove();
      }
    : null;
}

/** Small inline search (not a modal) — toggled by the pin button in the
 *  panel header, geocodes via Open-Meteo's own free geocoding API. */
function wireWeatherLocationSearch() {
  const toggleBtn = document.getElementById("home-weather-location-btn");
  const searchBox = document.getElementById("home-weather-location-search");
  const input = document.getElementById("home-weather-location-input");
  const results = document.getElementById("home-weather-location-results");
  if (!toggleBtn || toggleBtn.dataset.wired) return;
  toggleBtn.dataset.wired = "true"; // this panel is only rendered once per app load, unlike the lists above

  toggleBtn.addEventListener("click", () => {
    searchBox.classList.toggle("hidden");
    if (!searchBox.classList.contains("hidden")) input.focus();
  });

  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      results.innerHTML = "";
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5`);
        const data = await res.json();
        const matches = data.results || [];
        results.innerHTML = matches.length
          ? matches
              .map(
                (m, i) => `<div class="home-weather-location-result" data-idx="${i}">${escapeHtml(m.name)}${m.admin1 ? ", " + escapeHtml(m.admin1) : ""}${m.country ? ", " + escapeHtml(m.country) : ""}</div>`
              )
              .join("")
          : `<div class="home-weather-location-result" style="opacity:0.5;cursor:default;">No matches</div>`;

        results.querySelectorAll(".home-weather-location-result[data-idx]").forEach((el) => {
          el.addEventListener("click", () => {
            const m = matches[parseInt(el.dataset.idx, 10)];
            setStoredWeatherLocation({ name: m.name, lat: m.latitude, lon: m.longitude });
            searchBox.classList.add("hidden");
            input.value = "";
            results.innerHTML = "";
            loadWeatherWidget();
          });
        });
      } catch (err) {
        console.error(err);
      }
    }, 350);
  });
}

/* ============================================
   MOBILE — compact home screen
   ============================================ */
async function renderHomeScreenMobile() {
  document.getElementById("m-topbar").innerHTML = `
    <div>
      <div class="m-title">HOME</div>
      <div class="m-date">${new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
    </div>
  `;

  const main = document.getElementById("m-main");
  main.innerHTML = `
    <div class="home-hero home-hero-mobile">
      <div class="home-clock" id="m-home-clock">00:00:00</div>
      <div class="home-date" id="m-home-date">—</div>
    </div>

    <div class="home-panel">
      <div class="home-panel-header">
        <h4>To-Do</h4>
        <span class="home-panel-sub" id="m-home-todo-count"></span>
      </div>
      <form id="m-home-todo-form" class="home-todo-form">
        <input type="text" id="m-home-todo-input" placeholder="Add a task..." autocomplete="off" />
        <button type="submit" class="btn-accent">Add</button>
      </form>
      <div class="home-todo-list" id="m-home-todo-list"><div class="home-empty">Loading...</div></div>
    </div>

    <div class="home-panel">
      <div class="home-panel-header">
        <h4>Payment Reminders</h4>
        <span class="home-panel-sub">Next 14 days</span>
      </div>
      <div class="home-payment-list" id="m-home-payment-reminders"><div class="home-empty">Loading...</div></div>
    </div>

    <div class="home-panel">
      <div class="home-panel-header"><h4>Shortcuts</h4></div>
      <div class="home-shortcuts" id="m-home-shortcuts"></div>
    </div>
  `;

  startHomeClock("m-home-clock", "m-home-date");

  const shortcutsEl = document.getElementById("m-home-shortcuts");
  shortcutsEl.innerHTML = renderHomeShortcutsHtml([
    { app: "workout", label: "Workout" },
    { app: "finance", label: "Finance" },
    { app: "guitar", label: "Guitar" },
    { app: "movies", label: "Movies" },
  ]);
  wireHomeShortcuts(shortcutsEl, (appName) => switchMobileApp(appName));

  document.getElementById("m-home-todo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("m-home-todo-input");
    await addTodo(input.value);
    input.value = "";
    renderMobileHomeTodoPanel();
  });

  await Promise.all([loadTodos(), loadFinancePaymentsCache(), loadFinanceRecurringIncomeCache()]);
  if (mApp !== "home") return; // user navigated away while this was loading

  renderMobileHomeTodoPanel();
  renderMobileHomePaymentPanel();
}

function renderMobileHomeTodoPanel() {
  const listEl = document.getElementById("m-home-todo-list");
  if (!listEl) return;
  listEl.innerHTML = renderTodoListHtml(escapeHtmlMobile);
  wireTodoListEvents(listEl, renderMobileHomeTodoPanel);

  const countEl = document.getElementById("m-home-todo-count");
  if (countEl) {
    const remaining = todosCache.filter((t) => !t.done).length;
    countEl.textContent = todosCache.length ? `${remaining} open` : "";
  }
}

function renderMobileHomePaymentPanel() {
  const el = document.getElementById("m-home-payment-reminders");
  if (!el) return;
  el.innerHTML = renderReminderListHtml(upcomingPaymentReminders(), upcomingIncomeReminders(), escapeHtmlMobile);
  wireHomeReminderIncomeClicks(el, renderMobileHomePaymentPanel);
}
