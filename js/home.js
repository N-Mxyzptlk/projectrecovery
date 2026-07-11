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
    alert("Failed to add task: " + error.message);
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
   Payment reminders — anything due within 14 days that isn't already
   paid/cancelled, soonest first. Reuses finance.js's status/format helpers.
   ============================================ */
function upcomingPaymentReminders() {
  return (financePaymentsCache || [])
    .map((p) => ({ payment: p, status: computePaymentDisplayStatus(p), days: daysUntilDue(p.next_due_date) }))
    .filter((d) => d.status !== "paid" && d.status !== "cancelled" && d.days <= 14)
    .sort((a, b) => a.days - b.days);
}

function renderPaymentReminderListHtml(reminders, escapeFn) {
  if (reminders.length === 0) {
    return `<div class="home-empty">Nothing due in the next 2 weeks.</div>`;
  }
  return reminders
    .map(
      ({ payment, status, days }) => `
    <div class="home-payment-item">
      <span class="payment-status-badge status-${status}">${paymentStatusLabel(status)}</span>
      <span class="home-payment-name">${escapeFn(payment.name)}</span>
      <span class="home-payment-days">${days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `${days}d`}</span>
      <span class="home-payment-amount">${formatMoney(payment.amount)}</span>
    </div>`
    )
    .join("");
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
 *  [{ app, label, desc }]; onClick receives the app name. */
function renderHomeShortcutsHtml(items) {
  return items
    .map(
      (i) => `
    <button type="button" class="home-shortcut" data-app="${i.app}">
      <div class="home-shortcut-label">${i.label}</div>
      ${i.desc ? `<div class="home-shortcut-desc">${i.desc}</div>` : ""}
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
    { app: "workout", label: "Workout", desc: "Log sessions, track progress" },
    { app: "finance", label: "Finance", desc: "Expenses & payments" },
    { app: "admin", label: "Admin", desc: "Account & backups" },
  ]);
  wireHomeShortcuts(shortcutsEl, (appName) => switchApp(appName));

  document.getElementById("home-todo-list").innerHTML = `<div class="home-empty">Loading...</div>`;
  document.getElementById("home-payment-reminders").innerHTML = `<div class="home-empty">Loading...</div>`;

  await Promise.all([loadTodos(), loadFinancePaymentsCache()]);
  renderHomeTodoPanel();
  renderHomePaymentPanel();

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
  el.innerHTML = renderPaymentReminderListHtml(upcomingPaymentReminders(), escapeHtml);
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
    { app: "workout", label: "Workout", desc: "Log & track" },
    { app: "finance", label: "Finance", desc: "Spend & pay" },
  ]);
  wireHomeShortcuts(shortcutsEl, (appName) => switchMobileApp(appName));

  document.getElementById("m-home-todo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("m-home-todo-input");
    await addTodo(input.value);
    input.value = "";
    renderMobileHomeTodoPanel();
  });

  await Promise.all([loadTodos(), loadFinancePaymentsCache()]);
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
  el.innerHTML = renderPaymentReminderListHtml(upcomingPaymentReminders(), escapeHtmlMobile);
}
