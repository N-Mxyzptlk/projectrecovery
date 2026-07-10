// finance.js
// The Finance app: desktop dashboard/expenses/payments CRUD + charts, and
// the mobile compact-dashboard/log-expense/payments-due screens. Reuses
// supabaseClient, escapeHtml, openModal/closeModal, chartBaseOptions from
// desktop.js; and escapeHtmlMobile, beginMutation/endMutation, the
// .m-sheet pattern, mApp/renderFabStack from mobile.js. Loaded after
// desktop.js/admin.js, before mobile.js — functions here that reference
// mobile-only globals are only ever called after mobile.js has finished
// executing, so load order doesn't matter at call time.

const CURRENCY = "SGD";
function formatMoney(n) {
  return `S$${Number(n).toFixed(2)}`;
}

/** "24 January" for the current year, "24 January 2027" otherwise —
 *  reads faster than dd/mm/yyyy and sidesteps region ambiguity entirely. */
function formatDueDate(dateStr) {
  const d = new Date(dateStr);
  const opts = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function daysUntilDue(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

const FINANCE_PALETTE = ["#6c63ff", "#f5c542", "#4ade80", "#f87171", "#38bdf8", "#fb923c", "#a78bfa", "#34d399"];
function nextCategoryColor() {
  return FINANCE_PALETTE[financeCategoriesCache.length % FINANCE_PALETTE.length];
}

let financeCategoriesCache = [];
let financePaymentsCache = [];
let financeExpensesCache = []; // desktop Expenses page cache, for edit lookups

async function loadFinanceCategories() {
  const { data, error } = await supabaseClient.from("finance_categories").select("*").order("name");
  if (!error) financeCategoriesCache = data || [];
  return financeCategoriesCache;
}

function categoryName(id) {
  if (!id) return "Uncategorized";
  const c = financeCategoriesCache.find((cat) => cat.id === id);
  return c ? c.name : "Uncategorized";
}

/* ============================================
   Payment status — display status is computed from next_due_date /
   reminder_days_before / stored status; the stored status only changes on
   explicit user action (Mark Paid / Overdue / Cancel).
   ============================================ */
function computePaymentDisplayStatus(payment) {
  if (payment.status === "paid") return "paid";
  if (payment.status === "cancelled") return "cancelled";
  if (payment.status === "overdue") return "overdue";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(payment.next_due_date);
  const reminderStart = new Date(due);
  reminderStart.setDate(reminderStart.getDate() - payment.reminder_days_before);

  if (due < today) return "overdue";
  if (reminderStart <= today) return "due-soon";
  return "upcoming";
}

function paymentStatusLabel(status) {
  return { upcoming: "Upcoming", "due-soon": "Due soon", overdue: "Overdue", paid: "Paid", cancelled: "Cancelled" }[status];
}

function advanceDueDate(dateStr, interval) {
  const d = new Date(dateStr);
  if (interval === "weekly") d.setDate(d.getDate() + 7);
  else if (interval === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1); // monthly is the default/fallback
  return d.toISOString().slice(0, 10);
}

async function loadFinancePaymentsCache() {
  const { data, error } = await supabaseClient.from("finance_payments").select("*").order("next_due_date", { ascending: true });
  if (!error) financePaymentsCache = data || [];
  return financePaymentsCache;
}

/* ============================================
   Undo toast — shared by desktop and mobile. Every mutating payment
   action shows one; Undo reverts the exact DB change.
   ============================================ */
let financeToastTimeout = null;
function showFinanceUndoToast(message, undoFn) {
  let toast = document.getElementById("finance-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "finance-toast";
    toast.className = "finance-toast";
    document.body.appendChild(toast);
  }

  toast.innerHTML = `<span class="msg">${escapeHtml(message)}</span><span class="divider">|</span><button type="button" class="undo-btn">UNDO</button>`;

  clearTimeout(financeToastTimeout);
  requestAnimationFrame(() => toast.classList.add("open"));

  const dismiss = () => toast.classList.remove("open");
  toast.querySelector(".undo-btn").addEventListener("click", async () => {
    dismiss();
    clearTimeout(financeToastTimeout);
    await undoFn();
  });

  financeToastTimeout = setTimeout(dismiss, 6000);
}

/** Mark Paid: logs a linked expense, then rolls a subscription's due date
 *  forward or archives a one-time payment as paid. */
async function markPaymentPaid(paymentId) {
  const payment = financePaymentsCache.find((p) => p.id === paymentId);
  if (!payment) return;

  const previousStatus = payment.status;
  const previousDueDate = payment.next_due_date;

  beginMutation();
  const { data: expenseRow, error: expError } = await supabaseClient
    .from("finance_expenses")
    .insert({
      category_id: payment.category_id,
      amount: payment.amount,
      occurred_at: new Date().toISOString(),
      note: payment.name,
      source_payment_id: payment.id,
    })
    .select()
    .single();

  if (expError) {
    endMutation();
    alert("Failed to log expense: " + expError.message);
    return;
  }

  const update = payment.kind === "subscription"
    ? { next_due_date: advanceDueDate(payment.next_due_date, payment.recurrence_interval), status: "pending" }
    : { status: "paid" };

  const { error } = await supabaseClient.from("finance_payments").update(update).eq("id", payment.id);
  endMutation();

  if (error) {
    alert("Failed to update payment: " + error.message);
    return;
  }
  await refreshFinanceAfterAction();

  showFinanceUndoToast(`${payment.name} has been marked PAID`, async () => {
    beginMutation();
    await supabaseClient.from("finance_expenses").delete().eq("id", expenseRow.id);
    await supabaseClient.from("finance_payments").update({ status: previousStatus, next_due_date: previousDueDate }).eq("id", payment.id);
    endMutation();
    await refreshFinanceAfterAction();
  });
}

/** Mark Overdue: flags it so it stands out, but takes no other action —
 *  stays in the "needs action" queue until Paid or Cancelled. */
async function markPaymentOverdue(paymentId) {
  const payment = financePaymentsCache.find((p) => p.id === paymentId);
  if (!payment) return;
  const previousStatus = payment.status;

  beginMutation();
  const { error } = await supabaseClient.from("finance_payments").update({ status: "overdue" }).eq("id", paymentId);
  endMutation();
  if (error) return alert("Failed to update payment: " + error.message);
  await refreshFinanceAfterAction();

  showFinanceUndoToast(`${payment.name} has been marked OVERDUE`, async () => {
    beginMutation();
    await supabaseClient.from("finance_payments").update({ status: previousStatus }).eq("id", paymentId);
    endMutation();
    await refreshFinanceAfterAction();
  });
}

/** Cancel: stops it for good. For a subscription this stops every future
 *  occurrence (no more due-date rollovers); requires two confirmations
 *  since it's the hardest action here to walk back once the undo window
 *  passes. */
async function markPaymentCancelled(paymentId) {
  const payment = financePaymentsCache.find((p) => p.id === paymentId);
  if (!payment) return;

  const scopeMsg = payment.kind === "subscription"
    ? `Cancel "${payment.name}"? This stops all future occurrences of this subscription.`
    : `Cancel "${payment.name}"?`;
  if (!confirm(scopeMsg)) return;
  if (!confirm("Are you sure? This can't be undone once the Undo option disappears.")) return;

  const previousStatus = payment.status;

  beginMutation();
  const { error } = await supabaseClient.from("finance_payments").update({ status: "cancelled" }).eq("id", paymentId);
  endMutation();
  if (error) return alert("Failed to cancel: " + error.message);
  await refreshFinanceAfterAction();

  showFinanceUndoToast(`${payment.name} has been Cancelled`, async () => {
    beginMutation();
    await supabaseClient.from("finance_payments").update({ status: previousStatus }).eq("id", paymentId);
    endMutation();
    await refreshFinanceAfterAction();
  });
}

/** Re-renders whichever finance screen(s) are currently visible, desktop
 *  and/or mobile, after a payment action changes the underlying data. */
async function refreshFinanceAfterAction() {
  await loadFinancePaymentsCache();

  if (mApp === "finance") {
    renderFinanceMobileScreen();
    renderFabStack();
  }

  const paymentsView = document.getElementById("view-payments");
  if (paymentsView && !paymentsView.classList.contains("hidden")) {
    renderFinancePaymentsLists();
  }

  const dashView = document.getElementById("view-findash");
  if (dashView && !dashView.classList.contains("hidden")) {
    loadFinanceDashboard();
  }
}

/* ============================================
   Due-date quick picks — shared by the desktop Payment modal and the
   mobile New Payment sheet.
   ============================================ */
function dueDateQuickPicksHtml(inputId) {
  return `
    <div class="date-quick-picks" data-target="${inputId}">
      <button type="button" class="date-quick-pick" data-days="0">Today</button>
      <button type="button" class="date-quick-pick" data-days="1">Tomorrow</button>
      <button type="button" class="date-quick-pick" data-days="7">1 week</button>
      <button type="button" class="date-quick-pick" data-months="1">1 month</button>
    </div>`;
}

function wireDueDateQuickPicks(root) {
  (root || document).querySelectorAll(".date-quick-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wrap = btn.closest(".date-quick-picks");
      const input = document.getElementById(wrap.dataset.target);
      const d = new Date();
      d.setMonth(d.getMonth() + parseInt(btn.dataset.months || "0", 10));
      d.setDate(d.getDate() + parseInt(btn.dataset.days || "0", 10));
      input.value = d.toISOString().slice(0, 10);
    });
  });
}

/* ============================================
   Calendar — compact month grid, dots mark due dates. Shared by the
   desktop dashboard card and the mobile dashboard screen.
   ============================================ */
function renderFinanceCalendarHtml(payments) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dueDays = {};
  payments.forEach((p) => {
    const status = computePaymentDisplayStatus(p);
    if (status === "paid" || status === "cancelled") return;
    const d = new Date(p.next_due_date);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!dueDays[day] || statusPriority(status) > statusPriority(dueDays[day])) dueDays[day] = status;
    }
  });

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(`<div class="fin-cal-cell"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const status = dueDays[day];
    const isToday = day === now.getDate();
    cells.push(`
      <div class="fin-cal-cell ${isToday ? "today" : ""} ${status ? `has-due status-${status}` : ""}">
        <span>${day}</span>
        ${status ? `<span class="fin-cal-dot"></span>` : ""}
      </div>`);
  }

  return `
    <div class="fin-cal-header">${new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
    <div class="fin-cal-weekdays"><div>S</div><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div></div>
    <div class="fin-cal-grid">${cells.join("")}</div>
  `;
}

function statusPriority(status) {
  return { upcoming: 1, "due-soon": 2, overdue: 3 }[status] || 0;
}

/* ============================================
   DESKTOP — wiring
   ============================================ */
function wireFinanceActions() {
  document.getElementById("manage-categories-btn").addEventListener("click", openCategoryManagerModal);
  document.getElementById("add-expense-btn").addEventListener("click", () => openExpenseModal());
  document.getElementById("add-payment-btn").addEventListener("click", () => openPaymentModal());
}

/* ============================================
   DESKTOP — Dashboard
   ============================================ */
let financeCharts = {}; // 'category' | 'trend' -> Chart instance

async function loadFinanceDashboard() {
  renderFinanceQuickActions();

  const tilesEl = document.getElementById("finance-stat-tiles");
  tilesEl.innerHTML = `<div class="empty-state">Loading...</div>`;

  await loadFinanceCategories();
  const [{ data: expenses, error: expError }, { data: payments, error: payError }] = await Promise.all([
    supabaseClient.from("finance_expenses").select("*").order("occurred_at", { ascending: true }),
    supabaseClient.from("finance_payments").select("*").order("next_due_date", { ascending: true }),
  ]);

  if (expError || payError) {
    tilesEl.innerHTML = `<div class="empty-state">Error loading finance data</div>`;
    console.error(expError || payError);
    return;
  }

  financePaymentsCache = payments || [];
  const allExpenses = expenses || [];

  const now = new Date();
  const monthExpenses = allExpenses.filter((e) => {
    const d = new Date(e.occurred_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const monthTotal = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);

  const dueSoonOrOverdue = financePaymentsCache.filter((p) => {
    const status = computePaymentDisplayStatus(p);
    return status === "due-soon" || status === "overdue";
  });
  const hasOverdue = dueSoonOrOverdue.some((p) => computePaymentDisplayStatus(p) === "overdue");
  const dueSoonTotal = dueSoonOrOverdue.reduce((s, p) => s + Number(p.amount), 0);

  const categoryTotals = {};
  monthExpenses.forEach((e) => {
    const key = e.category_id || "none";
    categoryTotals[key] = (categoryTotals[key] || 0) + Number(e.amount);
  });
  const topEntry = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];
  const topCategoryName = topEntry ? categoryName(topEntry[0] === "none" ? null : topEntry[0]) : "—";

  tilesEl.innerHTML = `
    <div class="stat-card">
      <div class="label">This month</div>
      <div class="value">${formatMoney(monthTotal)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Due soon / overdue</div>
      <div class="value ${hasOverdue ? "danger" : ""}">${formatMoney(dueSoonTotal)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Top category (this month)</div>
      <div class="value" style="font-size:18px;">${escapeHtml(topCategoryName)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Logged expenses</div>
      <div class="value">${allExpenses.length}</div>
    </div>
  `;

  renderFinanceCategoryChart(monthExpenses);
  renderFinanceTrendChart(allExpenses);

  const calEl = document.getElementById("finance-calendar");
  if (calEl) calEl.innerHTML = renderFinanceCalendarHtml(financePaymentsCache);
}

function renderFinanceQuickActions() {
  const box = document.getElementById("finance-quick-actions");
  box.innerHTML = `
    <button class="quick-action-btn qa-gold" id="fqa-log-expense">
      <div class="label">Log Expense</div>
    </button>
    <button class="quick-action-btn qa-accent" id="fqa-manage-categories">
      <div class="label">Categories</div>
    </button>
    <button class="quick-action-btn qa-success" id="fqa-new-payment">
      <div class="label">New Payment</div>
    </button>
  `;
  document.getElementById("fqa-log-expense").addEventListener("click", () => openExpenseModal());
  document.getElementById("fqa-manage-categories").addEventListener("click", openCategoryManagerModal);
  document.getElementById("fqa-new-payment").addEventListener("click", () => openPaymentModal());
}

function renderFinanceCategoryChart(expenses) {
  const ctx = document.getElementById("finance-category-chart");
  if (!ctx) return;
  if (financeCharts.category) financeCharts.category.destroy();

  const totals = {};
  expenses.forEach((e) => {
    const key = e.category_id || "none";
    totals[key] = (totals[key] || 0) + Number(e.amount);
  });
  const entries = Object.entries(totals);
  if (entries.length === 0) return;

  const labels = entries.map(([id]) => (id === "none" ? "Uncategorized" : categoryName(id)));
  const colors = entries.map(([id]) => (id === "none" ? "#5c5c6e" : financeCategoriesCache.find((c) => c.id === id)?.color || "#6c63ff"));

  financeCharts.category = new Chart(ctx.getContext("2d"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: entries.map(([, v]) => Math.round(v * 100) / 100), backgroundColor: colors, borderColor: "#1a1a24", borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: "#8b8b9e", boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function renderFinanceTrendChart(allExpenses) {
  const ctx = document.getElementById("finance-trend-chart");
  if (!ctx) return;
  if (financeCharts.trend) financeCharts.trend.destroy();

  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleDateString(undefined, { month: "short" }), total: 0 });
  }
  allExpenses.forEach((e) => {
    const d = new Date(e.occurred_at);
    const bucket = months.find((m) => m.year === d.getFullYear() && m.month === d.getMonth());
    if (bucket) bucket.total += Number(e.amount);
  });

  financeCharts.trend = new Chart(ctx.getContext("2d"), {
    type: "line",
    data: {
      labels: months.map((m) => m.label),
      datasets: [{
        label: "Spend",
        data: months.map((m) => Math.round(m.total * 100) / 100),
        borderColor: "#f5c542",
        backgroundColor: "rgba(245,197,66,0.15)",
        fill: true,
        tension: 0.3,
        pointRadius: 4,
      }],
    },
    options: chartBaseOptions(),
  });
}

/* ============================================
   DESKTOP — Expenses
   ============================================ */
async function loadFinanceExpenses() {
  const listEl = document.getElementById("expenses-list");
  listEl.innerHTML = `<div class="empty-state">Loading...</div>`;

  await loadFinanceCategories();
  const { data, error } = await supabaseClient
    .from("finance_expenses")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(200);

  if (error) {
    listEl.innerHTML = `<div class="empty-state">Error loading expenses</div>`;
    console.error(error);
    return;
  }

  financeExpensesCache = data || [];

  if (financeExpensesCache.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="big">No expenses logged</div>
        <p>Log spending from here or from your phone.</p>
        <button class="btn-accent" onclick="openExpenseModal()">+ Log expense</button>
      </div>`;
    return;
  }

  listEl.innerHTML = financeExpensesCache
    .map(
      (e) => `
    <div class="card-row">
      <div>
        <div class="title">${formatMoney(e.amount)} — ${escapeHtml(categoryName(e.category_id))}</div>
        <div class="meta">${new Date(e.occurred_at).toLocaleDateString()}${e.note ? " · " + escapeHtml(e.note) : ""}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" onclick="openExpenseModal('${e.id}')">Edit</button>
        <button class="icon-btn danger" onclick="deleteExpense('${e.id}')">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function openExpenseModal(expenseId) {
  const existing = expenseId ? financeExpensesCache.find((e) => e.id === expenseId) : null;
  const dateVal = existing ? new Date(existing.occurred_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

  openModal(`
    <h3>${existing ? "Edit expense" : "Log expense"}</h3>
    <form id="expense-form">
      <div class="field">
        <label>Amount (${CURRENCY})</label>
        <input type="number" step="0.01" min="0" id="expense-amount" required value="${existing ? existing.amount : ""}" autofocus />
      </div>
      <div class="field">
        <label>Category</label>
        <select id="expense-category">
          <option value="">Uncategorized</option>
          ${financeCategoriesCache.map((c) => `<option value="${c.id}" ${existing && existing.category_id === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Date</label>
        <input type="date" id="expense-date" required value="${dateVal}" />
      </div>
      <div class="field">
        <label>Note (optional)</label>
        <input type="text" id="expense-note" value="${existing ? escapeHtml(existing.note || "") : ""}" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">${existing ? "Save" : "Log"}</button>
      </div>
    </form>
  `);

  document.getElementById("expense-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      amount: parseFloat(document.getElementById("expense-amount").value),
      category_id: document.getElementById("expense-category").value || null,
      occurred_at: new Date(document.getElementById("expense-date").value).toISOString(),
      note: document.getElementById("expense-note").value.trim() || null,
    };

    let error;
    if (existing) {
      ({ error } = await supabaseClient.from("finance_expenses").update(payload).eq("id", existing.id));
    } else {
      ({ error } = await supabaseClient.from("finance_expenses").insert(payload));
    }

    if (error) {
      alert("Failed to save expense: " + error.message);
      return;
    }
    closeModal();
    loadFinanceExpenses();
  });
}

async function deleteExpense(id) {
  if (!confirm("Delete this expense?")) return;
  const { error } = await supabaseClient.from("finance_expenses").delete().eq("id", id);
  if (error) return alert("Failed to delete: " + error.message);
  loadFinanceExpenses();
}

/* ============================================
   DESKTOP — Categories
   ============================================ */
function openCategoryManagerModal() {
  openModal(`
    <h3>Categories</h3>
    <div class="card" id="category-manager-list" style="margin-bottom:16px;"></div>
    <form id="category-add-form">
      <div class="field" style="display:flex;gap:10px;align-items:flex-end;margin:0;">
        <div style="flex:1;">
          <label>New category</label>
          <input type="text" id="category-add-name" autofocus />
        </div>
        <button type="submit" class="btn-accent">Add</button>
      </div>
    </form>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" onclick="closeModal()">Done</button>
    </div>
  `);

  renderCategoryManagerList();

  document.getElementById("category-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("category-add-name");
    const name = input.value.trim();
    if (!name) return;

    const { error } = await supabaseClient.from("finance_categories").insert({ name, color: nextCategoryColor() });
    if (error) {
      alert("Failed to add category: " + error.message);
      return;
    }

    input.value = "";
    await loadFinanceCategories();
    renderCategoryManagerList();
  });
}

function renderCategoryManagerList() {
  const el = document.getElementById("category-manager-list");
  if (!el) return;

  if (financeCategoriesCache.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:16px;">No categories yet</div>`;
    return;
  }

  el.innerHTML = financeCategoriesCache
    .map(
      (c) => `
    <div class="card-row">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${c.color || "#6c63ff"};display:inline-block;"></span>
        <div class="title">${escapeHtml(c.name)}</div>
      </div>
      <button class="icon-btn danger" onclick="deleteCategoryDesktop('${c.id}')">Delete</button>
    </div>`
    )
    .join("");
}

async function deleteCategoryDesktop(id) {
  if (!confirm("Delete this category? Expenses using it become Uncategorized.")) return;
  const { error } = await supabaseClient.from("finance_categories").delete().eq("id", id);
  if (error) return alert("Failed to delete: " + error.message);
  await loadFinanceCategories();
  renderCategoryManagerList();
}

/* ============================================
   DESKTOP — Payments
   ============================================ */
async function loadFinancePayments() {
  document.getElementById("payments-due-section").innerHTML = `<div class="empty-state">Loading...</div>`;
  document.getElementById("payments-upcoming-section").innerHTML = "";
  document.getElementById("payments-history-section").innerHTML = "";

  await loadFinancePaymentsCache();
  renderFinancePaymentsLists();
}

function renderFinancePaymentsLists() {
  const decorated = financePaymentsCache.map((p) => ({ payment: p, status: computePaymentDisplayStatus(p) }));

  const due = decorated.filter((d) => d.status === "due-soon" || d.status === "overdue");
  const upcoming = decorated.filter((d) => d.status === "upcoming");
  const history = decorated.filter((d) => d.status === "paid" || d.status === "cancelled");

  document.getElementById("payments-due-section").innerHTML =
    `<div class="payments-section-title">Needs action</div>` +
    (due.length
      ? due.map((d) => renderPaymentRow(d.payment, d.status)).join("")
      : `<div class="empty-state" style="padding:16px;">Nothing due right now</div>`);

  document.getElementById("payments-upcoming-section").innerHTML = upcoming.length
    ? `<div class="payments-section-title">Upcoming</div>${upcoming.map((d) => renderPaymentRow(d.payment, d.status)).join("")}`
    : "";

  document.getElementById("payments-history-section").innerHTML = history.length
    ? `<div class="payments-section-title">History</div>${history.map((d) => renderPaymentRow(d.payment, d.status)).join("")}`
    : "";
}

function renderPaymentRow(payment, status) {
  const actionsHtml = status === "due-soon" || status === "overdue"
    ? `
      <button class="icon-btn" onclick="markPaymentPaid('${payment.id}')">Paid</button>
      <button class="icon-btn" onclick="markPaymentOverdue('${payment.id}')">Overdue</button>
      <button class="icon-btn" onclick="markPaymentCancelled('${payment.id}')">Cancel</button>
    `
    : status === "upcoming"
    ? `<button class="icon-btn" onclick="markPaymentCancelled('${payment.id}')">Cancel</button>`
    : "";

  return `
    <div class="payment-row status-${status}">
      <div>
        <div class="payment-name">${escapeHtml(payment.name)}</div>
        <div class="payment-meta">${payment.kind === "subscription" ? `Repeats ${payment.recurrence_interval}` : "One-time"} · Due ${formatDueDate(payment.next_due_date)}</div>
      </div>
      <div style="display:flex;align-items:center;">
        <span class="payment-status-badge status-${status}">${paymentStatusLabel(status)}</span>
        <span class="payment-amount">${formatMoney(payment.amount)}</span>
        <div class="payment-actions">
          ${actionsHtml}
          <button class="icon-btn" onclick="openPaymentModal('${payment.id}')">Edit</button>
        </div>
      </div>
    </div>`;
}

function openPaymentModal(paymentId) {
  const existing = paymentId ? financePaymentsCache.find((p) => p.id === paymentId) : null;

  openModal(`
    <h3>${existing ? "Edit payment" : "New payment"}</h3>
    <form id="payment-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="payment-name" required value="${existing ? escapeHtml(existing.name) : ""}" autofocus />
      </div>
      <div class="field">
        <label>Amount (${CURRENCY})</label>
        <input type="number" step="0.01" min="0" id="payment-amount" required value="${existing ? existing.amount : ""}" />
      </div>
      <div class="field">
        <label>Type</label>
        <select id="payment-kind">
          <option value="subscription" ${!existing || existing.kind === "subscription" ? "selected" : ""}>Subscription</option>
          <option value="one_time" ${existing && existing.kind === "one_time" ? "selected" : ""}>One-time</option>
        </select>
      </div>
      <div class="field" id="payment-recurrence-field">
        <label>Repeats</label>
        <select id="payment-recurrence">
          <option value="weekly" ${existing && existing.recurrence_interval === "weekly" ? "selected" : ""}>Weekly</option>
          <option value="monthly" ${!existing || existing.recurrence_interval === "monthly" ? "selected" : ""}>Monthly</option>
          <option value="yearly" ${existing && existing.recurrence_interval === "yearly" ? "selected" : ""}>Yearly</option>
        </select>
      </div>
      <div class="field">
        <label>Next due date</label>
        <input type="date" id="payment-due-date" required value="${existing ? existing.next_due_date : new Date().toISOString().slice(0, 10)}" />
        ${dueDateQuickPicksHtml("payment-due-date")}
      </div>
      <div class="field">
        <label>Remind me</label>
        <input type="number" min="0" max="60" id="payment-reminder-days" required value="${existing ? existing.reminder_days_before : 3}" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        ${existing ? `<button type="button" class="btn-ghost btn-clear-all" onclick="deletePayment('${existing.id}')">Delete</button>` : ""}
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  wireDueDateQuickPicks();

  const kindSelect = document.getElementById("payment-kind");
  const recurrenceField = document.getElementById("payment-recurrence-field");
  const syncRecurrenceVisibility = () => recurrenceField.classList.toggle("hidden", kindSelect.value !== "subscription");
  syncRecurrenceVisibility();
  kindSelect.addEventListener("change", syncRecurrenceVisibility);

  document.getElementById("payment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = kindSelect.value;
    const payload = {
      name: document.getElementById("payment-name").value.trim(),
      amount: parseFloat(document.getElementById("payment-amount").value),
      kind,
      recurrence_interval: kind === "subscription" ? document.getElementById("payment-recurrence").value : null,
      next_due_date: document.getElementById("payment-due-date").value,
      reminder_days_before: parseInt(document.getElementById("payment-reminder-days").value, 10),
    };

    let error;
    if (existing) {
      ({ error } = await supabaseClient.from("finance_payments").update(payload).eq("id", existing.id));
    } else {
      ({ error } = await supabaseClient.from("finance_payments").insert(payload));
    }

    if (error) {
      alert("Failed to save payment: " + error.message);
      return;
    }
    closeModal();
    loadFinancePayments();
  });
}

async function deletePayment(id) {
  if (!confirm("Delete this payment? This cannot be undone.")) return;
  const { error } = await supabaseClient.from("finance_payments").delete().eq("id", id);
  if (error) return alert("Failed to delete: " + error.message);
  closeModal();
  loadFinancePayments();
}

/* ============================================
   MOBILE — screens: 'dashboard' (default) | 'log' | 'due'
   ============================================ */
let fScreen = "dashboard";
let fSelectedCategoryId = null;
let financeRecentExpenses = [];

async function initFinanceMobile() {
  await loadFinanceCategories();
  await loadFinancePaymentsCache();
  await loadFinanceRecentExpenses();
  if (!fSelectedCategoryId && financeCategoriesCache.length > 0) {
    fSelectedCategoryId = financeCategoriesCache[0].id;
  }
  renderFinanceMobileScreen();
}

async function loadFinanceRecentExpenses() {
  const { data, error } = await supabaseClient
    .from("finance_expenses")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(10);
  if (!error) financeRecentExpenses = data || [];
}

function setFinanceMobileScreen(screen) {
  fScreen = screen;
  renderFabStack();
  renderFinanceMobileScreen();
}

function renderFinanceMobileScreen() {
  if (fScreen === "due") renderFinanceDueScreen();
  else if (fScreen === "log") renderFinanceLogScreen();
  else renderFinanceDashboardScreenMobile();
}

function renderFinanceTopbar(subtitle) {
  document.getElementById("m-topbar").innerHTML = `
    <div>
      <div class="m-title">FINANCE</div>
      <div class="m-date">${subtitle || new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
    </div>
  `;
}

/* ============================================
   MOBILE — compact dashboard
   ============================================ */
function renderFinanceDashboardScreenMobile() {
  renderFinanceTopbar();

  const now = new Date();
  const monthExpenses = financeRecentExpenses.filter((e) => {
    const d = new Date(e.occurred_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const monthTotal = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);

  const dueSoonOrOverdue = financePaymentsCache.filter((p) => {
    const status = computePaymentDisplayStatus(p);
    return status === "due-soon" || status === "overdue";
  });

  document.getElementById("m-main").innerHTML = `
    <div class="m-dash-stats-grid">
      <div class="m-dash-stat-tile">
        <div class="label">This month</div>
        <div class="value">${formatMoney(monthTotal)}</div>
      </div>
      <div class="m-dash-stat-tile">
        <div class="label">Due soon</div>
        <div class="value ${dueSoonOrOverdue.length ? "danger" : ""}">${dueSoonOrOverdue.length}</div>
      </div>
    </div>

    <div class="m-dash-quick-actions">
      <button type="button" class="m-dash-quick-action" id="m-dash-log-expense">Log Expense</button>
      <button type="button" class="m-dash-quick-action" id="m-dash-view-due">View Due</button>
    </div>

    <div class="m-dash-card">
      <div class="m-dash-card-title">This month</div>
      ${renderFinanceCalendarHtml(financePaymentsCache)}
    </div>

    <div class="m-set-list-label">Recent</div>
    <div id="m-recent-expenses">${renderRecentExpensesList()}</div>
  `;

  document.getElementById("m-dash-log-expense").addEventListener("click", () => setFinanceMobileScreen("log"));
  document.getElementById("m-dash-view-due").addEventListener("click", () => setFinanceMobileScreen("due"));
  wireRecentExpensesDelete();
}

/* ============================================
   MOBILE — Log expense
   ============================================ */
function renderFinanceLogScreen() {
  renderFinanceTopbar();

  document.getElementById("m-main").innerHTML = `
    <div class="m-stepper-label" style="text-align:left;">Category</div>
    <div class="m-chip-row" id="m-category-row">
      ${financeCategoriesCache
        .map((c) => `<div class="m-chip ${c.id === fSelectedCategoryId ? "active" : ""}" data-id="${c.id}">${escapeHtmlMobile(c.name)}</div>`)
        .join("")}
      <div class="m-chip more" id="m-add-category-chip">+ New</div>
    </div>

    <div class="m-log-card">
      <div class="selected-station">Log expense</div>
      <div class="m-stepper-full">
        <div class="m-stepper-label">Amount (${CURRENCY})</div>
        <input class="m-amount-input" id="m-expense-amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" />
      </div>
      <div class="m-stepper-full">
        <div class="m-stepper-label">Note (optional)</div>
        <input class="m-amount-note" id="m-expense-note" type="text" />
      </div>
      <div class="m-log-actions">
        <button class="m-log-btn" id="m-log-expense-btn" type="button">Log Expense</button>
      </div>
    </div>

    <div class="m-set-list-label">Recent</div>
    <div id="m-recent-expenses">${renderRecentExpensesList()}</div>
  `;

  wireFinanceLogScreen();
}

function renderRecentExpensesList() {
  if (financeRecentExpenses.length === 0) {
    return `<div class="m-empty" style="padding:30px 0;height:auto;"><p>No expenses logged yet.</p></div>`;
  }
  return financeRecentExpenses
    .map(
      (e) => `
    <div class="m-set-row">
      <div class="info">
        <div class="name">${formatMoney(e.amount)}</div>
        <div class="detail">${escapeHtmlMobile(categoryName(e.category_id))}${e.note ? " · " + escapeHtmlMobile(e.note) : ""} · ${new Date(e.occurred_at).toLocaleDateString()}</div>
      </div>
      <div class="m-set-row-actions">
        <button class="delete-btn" data-expense-id="${e.id}" type="button">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function wireRecentExpensesDelete() {
  document.querySelectorAll("#m-recent-expenses .delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this expense?")) return;
      const { error } = await supabaseClient.from("finance_expenses").delete().eq("id", btn.dataset.expenseId);
      if (error) {
        alert("Failed to delete: " + error.message);
        return;
      }
      await loadFinanceRecentExpenses();
      renderFinanceMobileScreen();
    });
  });
}

function wireFinanceLogScreen() {
  document.querySelectorAll("#m-category-row .m-chip[data-id]").forEach((chip) => {
    chip.addEventListener("click", () => {
      fSelectedCategoryId = chip.dataset.id;
      document.querySelectorAll("#m-category-row .m-chip[data-id]").forEach((c) => c.classList.toggle("active", c.dataset.id === fSelectedCategoryId));
    });
  });

  document.getElementById("m-add-category-chip").addEventListener("click", openAddCategorySheetMobile);
  document.getElementById("m-log-expense-btn").addEventListener("click", logExpenseMobile);
  wireRecentExpensesDelete();
}

async function logExpenseMobile() {
  const amountInput = document.getElementById("m-expense-amount");
  const noteInput = document.getElementById("m-expense-note");
  const amount = parseFloat(amountInput.value);

  if (!amount || amount <= 0) {
    amountInput.focus();
    return;
  }

  const btn = document.getElementById("m-log-expense-btn");
  btn.disabled = true;
  btn.textContent = "Logging...";

  beginMutation();
  const { error } = await supabaseClient.from("finance_expenses").insert({
    amount,
    category_id: fSelectedCategoryId || null,
    note: noteInput.value.trim() || null,
    occurred_at: new Date().toISOString(),
  });
  endMutation();

  if (error) {
    alert("Failed to log expense: " + error.message);
    btn.disabled = false;
    btn.textContent = "Log Expense";
    return;
  }

  await loadFinanceRecentExpenses();
  renderFinanceLogScreen();
}

/** Same lightweight bottom-sheet pattern as openAddStationSheet in
 *  mobile.js, so a missing category never blocks fast logging. */
function openAddCategorySheetMobile() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.id = "m-add-category-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">New category</div>
          <input type="text" id="m-new-category-name" autofocus
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;
                        color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-category-btn" style="width:100%;max-width:none;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("m-save-category-btn").addEventListener("click", async () => {
    const name = document.getElementById("m-new-category-name").value.trim();
    if (!name) return;
    const btn = document.getElementById("m-save-category-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const { data, error } = await supabaseClient
      .from("finance_categories")
      .insert({ name, color: nextCategoryColor() })
      .select()
      .single();

    if (error) {
      alert("Failed to save category: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }

    await loadFinanceCategories();
    fSelectedCategoryId = data.id;
    overlay.remove();
    renderFinanceLogScreen();
  });
}

/* ============================================
   MOBILE — Payments due screen
   ============================================ */
function renderFinanceDueScreen() {
  renderFinanceTopbar("Due & upcoming");

  const decorated = financePaymentsCache.map((p) => ({ payment: p, status: computePaymentDisplayStatus(p) }));
  const due = decorated.filter((d) => d.status === "due-soon" || d.status === "overdue");
  const upcoming = decorated.filter((d) => d.status === "upcoming");

  document.getElementById("m-main").innerHTML = `
    <div class="m-set-list-label" style="display:flex;justify-content:space-between;align-items:center;">
      <span>Needs action</span>
      <button type="button" class="btn-ghost" id="m-add-payment-btn" style="padding:5px 12px;font-size:11px;">+ New payment</button>
    </div>
    <div id="m-payments-due">
      ${due.length
        ? due.map((d) => renderMobilePaymentRow(d.payment, d.status)).join("")
        : `<div class="m-empty" style="padding:30px 0;height:auto;"><p>Nothing due right now.</p></div>`}
    </div>
    ${upcoming.length
      ? `<div class="m-set-list-label" style="margin-top:20px;">Upcoming</div>
         <div id="m-payments-upcoming">${upcoming.map((d) => renderMobilePaymentRow(d.payment, d.status)).join("")}</div>`
      : ""}
    <div class="meta-line" style="text-align:center;margin-top:16px;color:var(--text-faint);font-size:11px;">Hold a payment for actions</div>
  `;

  wireFinanceDueScreen();
}

function renderMobilePaymentRow(payment, status) {
  return `
    <div class="m-payment-row status-${status}" data-payment-id="${payment.id}">
      <div class="m-payment-row-top">
        <div class="name">${escapeHtmlMobile(payment.name)}</div>
        <div class="m-payment-amount">${formatMoney(payment.amount)}</div>
      </div>
      <div class="detail">${payment.kind === "subscription" ? `Repeats ${payment.recurrence_interval}` : "One-time"} · Due ${formatDueDate(payment.next_due_date)}</div>
    </div>`;
}

function wireFinanceDueScreen() {
  document.getElementById("m-add-payment-btn").addEventListener("click", openAddPaymentSheetMobile);

  document.querySelectorAll(".m-payment-row").forEach((row) => {
    const payment = financePaymentsCache.find((p) => p.id === row.dataset.paymentId);
    if (payment) attachPaymentLongPress(row, payment);
  });
}

/** Hold to reveal Paid/Overdue/Cancel — deliberate friction so a stray tap
 *  in a scrolling list never fires an action by accident (same philosophy
 *  as the journal's swipe-then-tap delete). */
function attachPaymentLongPress(row, payment) {
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
    timer = setTimeout(() => openPaymentActionSheetMobile(payment), HOLD_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE)) cancel();
  });
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointercancel", cancel);
}

function openPaymentActionSheetMobile(payment) {
  const status = computePaymentDisplayStatus(payment);
  const days = daysUntilDue(payment.next_due_date);

  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.id = "m-payment-action-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-sheet-title">${escapeHtmlMobile(payment.name)}</div>
        <div class="m-payment-sheet-meta">
          <span class="payment-status-badge status-${status}">${paymentStatusLabel(status)}</span>
          <span>Days Due: ${days}</span>
        </div>
        <div class="m-payment-sheet-amount">${formatMoney(payment.amount)}</div>
        <div class="m-payment-actions" style="margin-top:18px;">
          <button type="button" class="m-payment-action-btn paid" data-action="paid">Paid</button>
          <button type="button" class="m-payment-action-btn overdue" data-action="overdue">Overdue</button>
          <button type="button" class="m-payment-action-btn skip" data-action="cancel">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelectorAll(".m-payment-action-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      overlay.remove();
      if (btn.dataset.action === "paid") await markPaymentPaid(payment.id);
      else if (btn.dataset.action === "overdue") await markPaymentOverdue(payment.id);
      else await markPaymentCancelled(payment.id);
    });
  });
}

/** Mobile payment creation — same fields as the desktop modal, in sheet
 *  form. No category (payments don't carry one; only expenses do). */
function openAddPaymentSheetMobile() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.id = "m-add-payment-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Name</div>
          <input type="text" id="m-payment-name" autofocus style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Amount (${CURRENCY})</div>
          <input type="number" step="0.01" min="0" id="m-payment-amount" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Type</div>
          <div class="m-chip-row" id="m-payment-kind-row" style="margin-top:8px;">
            <div class="m-chip active" data-kind="subscription">Subscription</div>
            <div class="m-chip" data-kind="one_time">One-time</div>
          </div>
        </div>
        <div class="m-stat-block" id="m-payment-recurrence-block" style="margin-bottom:14px;">
          <div class="label">Repeats</div>
          <div class="m-chip-row" id="m-payment-recurrence-row" style="margin-top:8px;">
            <div class="m-chip" data-interval="weekly">Weekly</div>
            <div class="m-chip active" data-interval="monthly">Monthly</div>
            <div class="m-chip" data-interval="yearly">Yearly</div>
          </div>
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Next due date</div>
          <input type="date" id="m-payment-due-date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
          ${dueDateQuickPicksHtml("m-payment-due-date")}
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Remind me</div>
          <input type="number" min="0" max="60" id="m-payment-reminder-days" value="3" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-payment-btn" style="width:100%;max-width:none;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  wireDueDateQuickPicks(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelectorAll("#m-payment-kind-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      overlay.querySelectorAll("#m-payment-kind-row .m-chip").forEach((c) => c.classList.toggle("active", c === chip));
      overlay.querySelector("#m-payment-recurrence-block").classList.toggle("hidden", chip.dataset.kind !== "subscription");
    });
  });
  overlay.querySelectorAll("#m-payment-recurrence-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      overlay.querySelectorAll("#m-payment-recurrence-row .m-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("m-save-payment-btn").addEventListener("click", async () => {
    const name = document.getElementById("m-payment-name").value.trim();
    const amount = parseFloat(document.getElementById("m-payment-amount").value);
    const dueDate = document.getElementById("m-payment-due-date").value;
    const reminderDays = parseInt(document.getElementById("m-payment-reminder-days").value, 10);
    const kind = overlay.querySelector("#m-payment-kind-row .m-chip.active").dataset.kind;
    const interval = overlay.querySelector("#m-payment-recurrence-row .m-chip.active").dataset.interval;

    if (!name || !amount || amount <= 0 || !dueDate) return;

    const btn = document.getElementById("m-save-payment-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    beginMutation();
    const { error } = await supabaseClient.from("finance_payments").insert({
      name,
      amount,
      kind,
      recurrence_interval: kind === "subscription" ? interval : null,
      next_due_date: dueDate,
      reminder_days_before: reminderDays,
    });
    endMutation();

    if (error) {
      alert("Failed to save payment: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }

    overlay.remove();
    await loadFinancePaymentsCache();
    renderFinanceMobileScreen();
  });
}
