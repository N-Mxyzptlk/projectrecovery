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

const FINANCE_PALETTE = ["#9c86d8", "#f0c9a0", "#7fc7a8", "#d98c94", "#8ec6e6", "#e0a778", "#c9a0d4", "#7fd4c1"];
function nextCategoryColor() {
  return FINANCE_PALETTE[financeCategoriesCache.length % FINANCE_PALETTE.length];
}

let financeCategoriesCache = [];
let financePaymentsCache = [];
let financeExpensesCache = []; // desktop Expenses page cache, for edit lookups
let financeBalanceEntriesCache = []; // desktop dashboard's full income + adjustment ledger
let financeRecentBalanceEntries = []; // mobile recent-feed slice, mirrors financeRecentExpenses
let mFinanceBalance = 0; // mobile's current available-balance number, refreshed alongside the recent feeds

async function loadFinanceRecentBalanceEntries() {
  const { data, error } = await supabaseClient
    .from("finance_balance_entries")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(10);
  if (!error) financeRecentBalanceEntries = data || [];
}

/** Lightweight balance-only fetch (amount column alone) for mobile, which
 *  never loads the full expense/ledger tables the way the desktop
 *  dashboard does. */
async function loadFinanceBalanceSummary() {
  const [{ data: expenseAmounts }, { data: entryAmounts }] = await Promise.all([
    supabaseClient.from("finance_expenses").select("amount"),
    supabaseClient.from("finance_balance_entries").select("amount"),
  ]);
  return computeAvailableBalance(expenseAmounts || [], entryAmounts || []);
}

async function refreshFinanceMobileFeeds() {
  await Promise.all([loadFinanceRecentExpenses(), loadFinanceRecentBalanceEntries()]);
  mFinanceBalance = await loadFinanceBalanceSummary();
}

/** Available balance = every income + adjustment entry, minus every
 *  expense — always computed over the full ledger, not just whatever
 *  slice a given view happens to have loaded. */
function computeAvailableBalance(expenses, balanceEntries) {
  const expenseTotal = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const entryTotal = balanceEntries.reduce((s, b) => s + Number(b.amount), 0);
  return entryTotal - expenseTotal;
}

function formatSignedMoney(n) {
  const num = Number(n);
  return `${num < 0 ? "-" : "+"}${formatMoney(Math.abs(num))}`;
}

function formatBalance(n) {
  const num = Number(n);
  return num < 0 ? `-${formatMoney(Math.abs(num))}` : formatMoney(num);
}

function transactionKindBadgeHtml(kind) {
  if (kind === "income") return `<span class="category-badge" style="background:#7fc7a822;color:#7fc7a8;border-color:#7fc7a855;">Income</span>`;
  return `<span class="category-badge" style="background:#f0c9a022;color:#f0c9a0;border-color:#f0c9a055;">Bal. Adjustment</span>`;
}

/** Merges expenses + balance-ledger entries into one normalized,
 *  time-sorted feed, so "recent transactions" everywhere (desktop card,
 *  mobile dashboard, mobile log screen) shows the same row shape
 *  regardless of which table it actually came from. */
function mergeTransactions(expenses, balanceEntries, limit) {
  const merged = [
    ...expenses.map((e) => ({
      id: e.id,
      table: "finance_expenses",
      kind: "expense",
      amount: -Math.abs(Number(e.amount)),
      note: e.note,
      category_id: e.category_id,
      occurred_at: e.occurred_at,
    })),
    ...balanceEntries.map((b) => ({
      id: b.id,
      table: "finance_balance_entries",
      kind: b.kind,
      amount: Number(b.amount),
      note: b.note,
      category_id: null,
      occurred_at: b.occurred_at,
    })),
  ];
  merged.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  return typeof limit === "number" ? merged.slice(0, limit) : merged;
}

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

function categoryColor(id) {
  if (!id) return "#4a4c58";
  const c = financeCategoriesCache.find((cat) => cat.id === id);
  return (c && c.color) || "#9c86d8";
}

/** Colored category pill, e.g. "Food" in its category's color — same
 *  labeled-badge treatment as the workout achievement badges. */
function categoryBadgeHtml(id) {
  const color = categoryColor(id);
  return `<span class="category-badge" style="background:${color}22;color:${color};border-color:${color}55;">${escapeHtml(categoryName(id))}</span>`;
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

/** The generic "Upcoming" badge doesn't say much once you already know it's
 *  not due/overdue — swap it for what actually matters at that point:
 *  whether it's a recurring Subscription or a one-time charge (OTC). Every
 *  other status keeps its plain label. */
function paymentBadgeHtml(payment, status) {
  if (status === "upcoming") {
    const isSubscription = payment.kind === "subscription";
    return `<span class="payment-status-badge ${isSubscription ? "status-upcoming-subscription" : "status-upcoming-onetime"}">${isSubscription ? "SUB" : "OTC"}</span>`;
  }
  return `<span class="payment-status-badge status-${status}">${paymentStatusLabel(status)}</span>`;
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
    await uiAlert("Failed to log expense: " + expError.message);
    return;
  }

  const update = payment.kind === "subscription"
    ? { next_due_date: advanceDueDate(payment.next_due_date, payment.recurrence_interval), status: "pending" }
    : { status: "paid" };

  const { error } = await supabaseClient.from("finance_payments").update(update).eq("id", payment.id);
  endMutation();

  if (error) {
    await uiAlert("Failed to update payment: " + error.message);
    return;
  }
  await refreshFinanceAfterAction();

  showFinanceUndoToast(`${payment.name} Paid`, async () => {
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
  if (error) return uiAlert("Failed to update payment: " + error.message);
  await refreshFinanceAfterAction();

  showFinanceUndoToast(`${payment.name} Overdue`, async () => {
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
  if (!(await uiConfirm(scopeMsg))) return;

  const previousStatus = payment.status;

  beginMutation();
  const { error } = await supabaseClient.from("finance_payments").update({ status: "cancelled" }).eq("id", paymentId);
  endMutation();
  if (error) return uiAlert("Failed to cancel: " + error.message);
  await refreshFinanceAfterAction();

  showFinanceUndoToast(`${payment.name} Cancelled`, async () => {
    beginMutation();
    await supabaseClient.from("finance_payments").update({ status: previousStatus }).eq("id", paymentId);
    endMutation();
    await refreshFinanceAfterAction();
  });
}

/** Re-renders whichever finance screen(s) are currently visible, desktop
 *  and/or mobile, after ANY finance action changes the underlying data —
 *  a payment status change, an expense, income, or balance adjustment.
 *  Without this, a mutation only ever updated the one narrow list it was
 *  triggered from (e.g. logging an expense from the Dashboard's own quick
 *  action only refreshed the hidden Expenses tab), leaving whatever the
 *  user was actually looking at stale until a full page reload. */
async function refreshFinanceAfterAction() {
  await loadFinancePaymentsCache();

  if (mApp === "finance") {
    await refreshFinanceMobileFeeds();
    renderFinanceMobileScreen();
    renderFabStack();
  }

  const paymentsView = document.getElementById("view-payments");
  if (paymentsView && !paymentsView.classList.contains("hidden")) {
    renderFinancePaymentsLists();
  }

  const expensesView = document.getElementById("view-expenses");
  if (expensesView && !expensesView.classList.contains("hidden")) {
    loadFinanceExpenses();
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
      const d = new Date();
      d.setMonth(d.getMonth() + parseInt(btn.dataset.months || "0", 10));
      d.setDate(d.getDate() + parseInt(btn.dataset.days || "0", 10));
      setDatePickerValue(wrap.dataset.target, toIsoDateLocal(d));
    });
  });
}

/* ============================================
   Calendar — compact month grid, dots mark due dates. Shared by the
   desktop dashboard card and the mobile dashboard screen. Supports
   cycling between months, and per-day due-item lookup (desktop hovers
   a date to preview it, mobile holds a date) — see wireFinanceCalendar.
   ============================================ */
function computeDueItemsByDay(payments, year, month) {
  const map = {};
  payments.forEach((p) => {
    const status = computePaymentDisplayStatus(p);
    if (status === "paid" || status === "cancelled") return;
    const d = new Date(p.next_due_date);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!map[day]) map[day] = [];
      map[day].push({ payment: p, status });
    }
  });
  return map;
}

/** Dot color is kind-driven (yellow = subscription, green = one-time),
 *  except overdue always wins as red regardless of kind — that's the one
 *  status urgent enough to override everything else. */
function dueDotColorClass(item) {
  if (item.status === "overdue") return "dot-overdue";
  return item.payment.kind === "subscription" ? "dot-subscription" : "dot-onetime";
}

function renderFinanceCalendarHtml(payments, year, month) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dueItemsByDay = computeDueItemsByDay(payments, year, month);
  const today = new Date();
  const MAX_DOTS = 4;

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(`<div class="fin-cal-cell empty"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const items = dueItemsByDay[day] || [];
    const hasOverdue = items.some((it) => it.status === "overdue");
    // "Danger close" — due soon but not overdue yet — gets its own pulsing
    // ring on the dot rather than a fourth base color, since the ask was
    // specifically three colors (kind x2 + overdue).
    const hasDangerClose = items.some((it) => it.status === "due-soon");
    const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();

    const visibleItems = items.slice(0, MAX_DOTS);
    const overflow = items.length - visibleItems.length;
    const dotsHtml = items.length
      ? `<div class="fin-cal-dots">
          ${visibleItems.map((it) => `<span class="fin-cal-dot ${dueDotColorClass(it)} ${it.status === "due-soon" ? "dot-danger-close" : ""}"></span>`).join("")}
          ${overflow > 0 ? `<span class="fin-cal-dot-more">+${overflow}</span>` : ""}
        </div>`
      : "";

    cells.push(`
      <div class="fin-cal-cell ${isToday ? "today" : ""} ${items.length ? "has-due" : ""} ${hasOverdue ? "cell-overdue" : hasDangerClose ? "cell-danger-close" : ""}" data-day="${day}">
        <span>${day}</span>
        ${dotsHtml}
      </div>`);
  }

  return `
    <div class="fin-cal-header">
      <button type="button" class="fin-cal-nav" data-dir="-1" aria-label="Previous month">&lsaquo;</button>
      <span>${new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
      <button type="button" class="fin-cal-nav" data-dir="1" aria-label="Next month">&rsaquo;</button>
    </div>
    <div class="fin-cal-weekdays"><div>S</div><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div></div>
    <div class="fin-cal-grid">${cells.join("")}</div>
  `;
}

/** Wires nav + per-day interaction for a rendered calendar and keeps it
 *  re-rendering in place as the user cycles months. `state` is a plain
 *  {year, month} object the caller owns, so each surface (desktop card,
 *  mobile dashboard) can cycle independently. `mode` picks the
 *  interaction: 'desktop' hovers a date (briefly, to avoid flicker while
 *  scanning across the grid) to preview what's due; 'mobile' holds a
 *  date, mirroring the payment-row long-press pattern. */
function wireFinanceCalendar(containerEl, state, mode) {
  if (!containerEl) return;

  function navigateMonth(dir) {
    state.month += dir;
    if (state.month < 0) { state.month = 11; state.year--; }
    else if (state.month > 11) { state.month = 0; state.year++; }
    rerender();
  }

  function rerender() {
    containerEl.innerHTML = renderFinanceCalendarHtml(financePaymentsCache, state.year, state.month);
    containerEl.querySelectorAll(".fin-cal-nav").forEach((btn) => {
      btn.addEventListener("click", () => navigateMonth(parseInt(btn.dataset.dir, 10)));
    });

    const dueItemsByDay = computeDueItemsByDay(financePaymentsCache, state.year, state.month);
    containerEl.querySelectorAll(".fin-cal-cell.has-due").forEach((cell) => {
      const items = dueItemsByDay[parseInt(cell.dataset.day, 10)] || [];
      if (mode === "desktop") attachCalendarDayHover(cell, items);
      else attachCalendarDayHold(cell, items);
    });
  }

  rerender();

  // Mobile also gets swipe-to-change-month, on top of the prev/next
  // buttons both modes already have. Wired once on containerEl (which
  // persists across rerenders — only its innerHTML gets replaced), not on
  // the grid itself, since the grid is a fresh element every navigation.
  if (mode === "mobile") attachCalendarSwipe(containerEl, navigateMonth);
}

/** Drags the calendar grid to change months — follows the finger, then
 *  either commits to prev/next (sliding the rest of the way off-screen,
 *  then swapping in the new month) or springs back if released short of
 *  the threshold. Cancels itself (same as attachCalendarDayHold's own
 *  guard) the moment real movement happens on a day cell, so a swipe
 *  starting on a due-date cell cancels that cell's hold-to-preview timer
 *  instead of fighting it. */
function attachCalendarSwipe(containerEl, navigateMonth) {
  const COMMIT_RATIO = 0.2; // drag past 20% of the grid's width to commit
  const VERTICAL_CANCEL = 30;
  const DRAG_START_THRESHOLD = 4;

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let committed = false;
  let containerWidth = 0;
  let gridEl = null;
  let pointerId = null;

  containerEl.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".fin-cal-grid")) return;
    dragging = true;
    committed = false;
    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
    containerWidth = containerEl.getBoundingClientRect().width || 1;
    gridEl = containerEl.querySelector(".fin-cal-grid");
  });

  containerEl.addEventListener("pointermove", (e) => {
    if (!dragging || !gridEl) return;
    const dx = e.clientX - startX;
    const dy = Math.abs(e.clientY - startY);
    if (!committed) {
      if (dy > VERTICAL_CANCEL) {
        dragging = false;
        return;
      }
      if (Math.abs(dx) < DRAG_START_THRESHOLD) return;
      committed = true;
      gridEl.style.transition = "none";
      try {
        containerEl.setPointerCapture(pointerId);
      } catch (err) {}
    }
    gridEl.style.transform = `translateX(${dx}px)`;
  });

  const onRelease = (e) => {
    if (!dragging) return;
    dragging = false;
    if (!committed || !gridEl) return;

    const dx = e.clientX - startX;
    if (Math.abs(dx) < containerWidth * COMMIT_RATIO) {
      gridEl.style.transition = "transform 0.15s ease";
      gridEl.style.transform = "translateX(0)";
      return;
    }

    const dir = dx < 0 ? 1 : -1; // dragged left -> next month, dragged right -> previous
    gridEl.style.transition = "transform 0.15s ease";
    gridEl.style.transform = `translateX(${dir > 0 ? -containerWidth : containerWidth}px)`;
    setTimeout(() => navigateMonth(dir), 150);
  };

  containerEl.addEventListener("pointerup", onRelease);
  containerEl.addEventListener("pointercancel", onRelease);
}

/* ---- Desktop: hover-and-hold a date to preview what's due ---- */
let finCalHoverTimer = null;
let finCalPopoverEl = null;

function attachCalendarDayHover(cell, items) {
  cell.addEventListener("mouseenter", () => {
    clearTimeout(finCalHoverTimer);
    finCalHoverTimer = setTimeout(() => showCalendarPopover(cell, items), 1200);
  });
  cell.addEventListener("mouseleave", () => {
    clearTimeout(finCalHoverTimer);
    hideCalendarPopover();
  });
}

function showCalendarPopover(cell, items) {
  hideCalendarPopover();
  const el = document.createElement("div");
  el.className = "fin-cal-popover";
  el.innerHTML = items
    .map(
      (it) => `
    <div class="fin-cal-popover-row">
      ${paymentBadgeHtml(it.payment, it.status)}
      <span class="name">${escapeHtml(it.payment.name)}</span>
      <span class="amount">${formatMoney(it.payment.amount)}</span>
    </div>`
    )
    .join("");
  document.body.appendChild(el);

  const cellRect = cell.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(cellRect.left, window.innerWidth - elRect.width - 8))}px`;
  el.style.top = `${cellRect.bottom + 6}px`;
  finCalPopoverEl = el;
}

function hideCalendarPopover() {
  if (finCalPopoverEl) {
    finCalPopoverEl.remove();
    finCalPopoverEl = null;
  }
}

/* ---- Mobile: hold a date to see what's due, Apple-Calendar-style ---- */
function attachCalendarDayHold(cell, items) {
  if (items.length === 0) return;
  const HOLD_MS = 450;
  const MOVE_TOLERANCE = 10;
  let timer = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  cell.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => openCalendarDaySheetMobile(cell.dataset.day, items), HOLD_MS);
  });
  cell.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE)) cancel();
  });
  cell.addEventListener("pointerup", cancel);
  cell.addEventListener("pointercancel", cancel);
}

function openCalendarDaySheetMobile(day, items) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-sheet-title">Due on the ${day}${daySuffix(parseInt(day, 10))}</div>
        <div class="m-cal-day-items">
          ${items
            .map(
              (it) => `
            <div class="m-cal-day-item">
              ${paymentBadgeHtml(it.payment, it.status)}
              <span class="name">${escapeHtmlMobile(it.payment.name)}</span>
              <span class="amount">${formatMoney(it.payment.amount)}</span>
            </div>`
            )
            .join("")}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function daySuffix(day) {
  if (day % 10 === 1 && day !== 11) return "st";
  if (day % 10 === 2 && day !== 12) return "nd";
  if (day % 10 === 3 && day !== 13) return "rd";
  return "th";
}

/* ============================================
   DESKTOP — wiring
   ============================================ */
function wireFinanceActions() {
  document.getElementById("manage-categories-btn").addEventListener("click", openCategoryManagerModal);
  document.getElementById("add-expense-btn").addEventListener("click", () => openExpenseModal());
  document.getElementById("add-payment-btn").addEventListener("click", () => openPaymentModal());
  document.getElementById("payments-clear-history-btn").addEventListener("click", clearPaymentHistory);
  document.getElementById("add-recurring-income-btn").addEventListener("click", () => openRecurringIncomeModal());
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
  const [{ data: expenses, error: expError }, { data: payments, error: payError }, { data: balanceEntries, error: balError }] = await Promise.all([
    supabaseClient.from("finance_expenses").select("*").order("occurred_at", { ascending: true }),
    supabaseClient.from("finance_payments").select("*").order("next_due_date", { ascending: true }),
    supabaseClient.from("finance_balance_entries").select("*").order("occurred_at", { ascending: true }),
  ]);

  if (expError || payError || balError) {
    tilesEl.innerHTML = `<div class="empty-state">Error loading finance data</div>`;
    console.error(expError || payError || balError);
    return;
  }

  financePaymentsCache = payments || [];
  financeBalanceEntriesCache = balanceEntries || [];
  const allExpenses = expenses || [];
  const availableBalance = computeAvailableBalance(allExpenses, financeBalanceEntriesCache);

  const now = new Date();
  const monthExpenses = allExpenses.filter((e) => {
    const d = new Date(e.occurred_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const monthTotal = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);

  const dueSoon = financePaymentsCache.filter((p) => computePaymentDisplayStatus(p) === "due-soon");
  const overdue = financePaymentsCache.filter((p) => computePaymentDisplayStatus(p) === "overdue");
  const dueSoonTotal = dueSoon.reduce((s, p) => s + Number(p.amount), 0);
  const overdueTotal = overdue.reduce((s, p) => s + Number(p.amount), 0);

  const categoryTotals = {};
  monthExpenses.forEach((e) => {
    const key = e.category_id || "none";
    categoryTotals[key] = (categoryTotals[key] || 0) + Number(e.amount);
  });
  const topEntry = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];
  const topCategoryName = topEntry ? categoryName(topEntry[0] === "none" ? null : topEntry[0]) : "—";

  tilesEl.innerHTML = `
    <div class="stat-card">
      <div class="label">Available balance</div>
      <div class="value ${availableBalance < 0 ? "danger" : ""}">${formatBalance(availableBalance)}</div>
    </div>
    <div class="stat-card">
      <div class="label">This month</div>
      <div class="value">${formatMoney(monthTotal)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Due soon</div>
      <div class="value">${formatMoney(dueSoonTotal)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Overdue</div>
      <div class="value ${overdue.length ? "danger" : ""}">${formatMoney(overdueTotal)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Top category (this month)</div>
      <div class="value stat-value-text" style="font-size:18px;">${escapeHtml(topCategoryName)}</div>
    </div>
  `;

  renderFinanceCategoryChart(monthExpenses);
  renderFinanceTrendChart(allExpenses);

  financeCalendarStateDesktop = { year: now.getFullYear(), month: now.getMonth() };
  wireFinanceCalendar(document.getElementById("finance-calendar"), financeCalendarStateDesktop, "desktop");

  const recentTransactions = mergeTransactions(allExpenses, financeBalanceEntriesCache, 8);
  const recentEl = document.getElementById("finance-dashboard-recent-expenses");
  if (recentEl) recentEl.innerHTML = renderTransactionsCompactListHtml(recentTransactions);

  await renderRecurringIncomeList();
}

let financeCalendarStateDesktop = null;
let financeCalendarStateMobile = null;

function renderTransactionsCompactListHtml(transactions) {
  if (transactions.length === 0) return `<div class="empty-state">No transactions logged</div>`;
  return transactions
    .map(
      (t) => `
    <div class="card-row">
      <div>
        <div class="title">${formatSignedMoney(t.amount)} ${t.kind === "expense" ? categoryBadgeHtml(t.category_id) : transactionKindBadgeHtml(t.kind)}</div>
        <div class="meta">${new Date(t.occurred_at).toLocaleDateString()}${t.note ? " · " + escapeHtml(t.note) : ""}</div>
      </div>
    </div>`
    )
    .join("");
}

function renderFinanceQuickActions() {
  const box = document.getElementById("finance-quick-actions");
  box.innerHTML = `
    <button class="quick-action-btn qa-gold" id="fqa-log-expense">
      <div class="label">Log Expense</div>
    </button>
    <button class="quick-action-btn qa-success" id="fqa-add-income">
      <div class="label">Add Income</div>
    </button>
    <button class="quick-action-btn qa-accent" id="fqa-manage-categories">
      <div class="label">Categories</div>
    </button>
    <button class="quick-action-btn qa-energy" id="fqa-adjust-balance">
      <div class="label">Adjust Balance</div>
    </button>
    <button class="quick-action-btn qa-success" id="fqa-new-payment">
      <div class="label">New Payment</div>
    </button>
  `;
  document.getElementById("fqa-log-expense").addEventListener("click", () => openExpenseModal());
  document.getElementById("fqa-add-income").addEventListener("click", () => openIncomeModal());
  document.getElementById("fqa-manage-categories").addEventListener("click", openCategoryManagerModal);
  document.getElementById("fqa-adjust-balance").addEventListener("click", () => openAdjustmentModal());
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
  const colors = entries.map(([id]) => (id === "none" ? "#4a4c58" : financeCategoriesCache.find((c) => c.id === id)?.color || "#9c86d8"));

  financeCharts.category = new Chart(ctx.getContext("2d"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: entries.map(([, v]) => Math.round(v * 100) / 100), backgroundColor: colors, borderColor: "#1e2027", borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: "#9992b3", boxWidth: 12, font: { size: 11 } } } },
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
        borderColor: "#f0c9a0",
        backgroundColor: "rgba(240,201,160,0.15)",
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
        <div class="title">${formatMoney(e.amount)} ${categoryBadgeHtml(e.category_id)}</div>
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
        ${datePickerFieldHtml("expense-date", dateVal)}
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

  wireDatePickerField("expense-date");
  enhanceSelect("expense-category");

  document.getElementById("expense-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      amount: parseFloat(document.getElementById("expense-amount").value),
      category_id: document.getElementById("expense-category").value || null,
      occurred_at: new Date(document.getElementById("expense-date").value).toISOString(),
      note: document.getElementById("expense-note").value.trim() || null,
    };

    let error, queued;
    if (existing) {
      ({ error, queued } = await writeWithQueue("finance_expenses", "update", payload, { match: { id: existing.id } }));
    } else {
      ({ error, queued } = await writeWithQueue("finance_expenses", "upsert", { id: crypto.randomUUID(), ...payload }));
    }

    if (error) {
      await uiAlert("Failed to save expense: " + error.message);
      return;
    }
    closeModal();
    // Queued (offline/outage): the row isn't on the server yet, so
    // re-fetching now just wouldn't show it — it'll appear once the write
    // queue syncs (see the pending-sync badge) rather than being lost.
    // Refreshes whichever finance screen is actually visible — this modal
    // opens from both the Dashboard's own quick action and the Expenses
    // tab, and only updating the Expenses list left the Dashboard's
    // balance stale until a manual reload.
    if (!queued) await refreshFinanceAfterAction();
  });
}

async function deleteExpense(id) {
  if (!(await uiConfirm("Delete this expense?"))) return;
  const { error, queued } = await writeWithQueue("finance_expenses", "delete", null, { match: { id } });
  if (error) return uiAlert("Failed to delete: " + error.message);
  if (!queued) await refreshFinanceAfterAction();
}

/* ============================================
   DESKTOP — Income / balance adjustments
   ============================================ */
function openIncomeModal() {
  openModal(`
    <h3>Add income</h3>
    <form id="income-form">
      <div class="field">
        <label>Amount (${CURRENCY})</label>
        <input type="number" step="0.01" min="0.01" id="income-amount" required autofocus />
      </div>
      <div class="field">
        <label>Note (optional)</label>
        <input type="text" id="income-note" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">Add</button>
      </div>
    </form>
  `);

  document.getElementById("income-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById("income-amount").value);
    if (!amount || amount <= 0) return;

    const { error } = await supabaseClient.from("finance_balance_entries").insert({
      kind: "income",
      amount,
      note: document.getElementById("income-note").value.trim() || null,
      occurred_at: new Date().toISOString(),
    });

    if (error) {
      await uiAlert("Failed to add income: " + error.message);
      return;
    }
    closeModal();
    await refreshFinanceAfterAction();
  });
}

function openAdjustmentModal() {
  openModal(`
    <h3>Adjust balance</h3>
    <form id="adjustment-form">
      <div class="field">
        <label>Direction</label>
        <select id="adjustment-direction">
          <option value="1" selected>Add to balance</option>
          <option value="-1">Subtract from balance</option>
        </select>
      </div>
      <div class="field">
        <label>Amount (${CURRENCY})</label>
        <input type="number" step="0.01" min="0.01" id="adjustment-amount" required autofocus />
      </div>
      <div class="field">
        <label>Note (optional)</label>
        <input type="text" id="adjustment-note" placeholder="e.g. Correcting a miscount" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  enhanceSelect("adjustment-direction");

  document.getElementById("adjustment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const magnitude = parseFloat(document.getElementById("adjustment-amount").value);
    if (!magnitude || magnitude <= 0) return;
    const sign = parseInt(document.getElementById("adjustment-direction").value, 10);

    const { error } = await supabaseClient.from("finance_balance_entries").insert({
      kind: "adjustment",
      amount: magnitude * sign,
      note: document.getElementById("adjustment-note").value.trim() || null,
      occurred_at: new Date().toISOString(),
    });

    if (error) {
      await uiAlert("Failed to save adjustment: " + error.message);
      return;
    }
    closeModal();
    await refreshFinanceAfterAction();
  });
}

async function deleteBalanceEntry(id) {
  if (!(await uiConfirm("Delete this entry?"))) return;
  const { error } = await supabaseClient.from("finance_balance_entries").delete().eq("id", id);
  if (error) return uiAlert("Failed to delete: " + error.message);
  await refreshFinanceAfterAction();
}

/* ============================================
   DESKTOP — Recurring income (allowance). Same shape/mechanics as
   subscription payments: a rule with a next_due_date that gets "collected"
   (Mark Received) rather than posting itself, since there's no server-side
   scheduler here — advanceDueDate() is reused from the payments code above.
   ============================================ */
let financeRecurringIncomeCache = [];

async function loadFinanceRecurringIncomeCache() {
  const { data, error } = await supabaseClient.from("finance_recurring_income").select("*").order("next_due_date", { ascending: true });
  if (!error) financeRecurringIncomeCache = data || [];
  return financeRecurringIncomeCache;
}

function renderRecurringIncomeListHtml() {
  if (financeRecurringIncomeCache.length === 0) {
    return `<div class="empty-state">No recurring income set up</div>`;
  }
  return financeRecurringIncomeCache
    .map(
      (r) => `
    <div class="card-row">
      <div>
        <div class="title">${escapeHtml(r.name)}</div>
        <div class="meta">${formatMoney(r.amount)} · Repeats ${r.recurrence_interval} · Next ${formatDueDate(r.next_due_date)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn action-paid" onclick="markRecurringIncomeReceived('${r.id}')">Received</button>
        <button class="icon-btn" onclick="openRecurringIncomeModal('${r.id}')">Edit</button>
        <button class="icon-btn danger" onclick="deleteRecurringIncome('${r.id}')">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

async function renderRecurringIncomeList() {
  await loadFinanceRecurringIncomeCache();
  const el = document.getElementById("finance-recurring-income-list");
  if (el) el.innerHTML = renderRecurringIncomeListHtml();
}

function openRecurringIncomeModal(id) {
  const existing = id ? financeRecurringIncomeCache.find((r) => r.id === id) : null;

  openModal(`
    <h3>${existing ? "Edit recurring income" : "New recurring income"}</h3>
    <form id="recurring-income-form">
      <div class="field">
        <label>Name</label>
        <input type="text" id="recurring-income-name" required value="${existing ? escapeHtml(existing.name) : ""}" autofocus />
      </div>
      <div class="field">
        <label>Amount (${CURRENCY})</label>
        <input type="number" step="0.01" min="0.01" id="recurring-income-amount" required value="${existing ? existing.amount : ""}" />
      </div>
      <div class="field">
        <label>Repeats</label>
        <select id="recurring-income-interval">
          <option value="weekly" ${existing && existing.recurrence_interval === "weekly" ? "selected" : ""}>Weekly</option>
          <option value="monthly" ${!existing || existing.recurrence_interval === "monthly" ? "selected" : ""}>Monthly</option>
          <option value="yearly" ${existing && existing.recurrence_interval === "yearly" ? "selected" : ""}>Yearly</option>
        </select>
      </div>
      <div class="field">
        <label>Expected Income Date</label>
        ${datePickerFieldHtml("recurring-income-due-date", existing ? existing.next_due_date : toIsoDateLocal(new Date()))}
        ${dueDateQuickPicksHtml("recurring-income-due-date")}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        ${existing ? `<button type="button" class="btn-ghost btn-clear-all" onclick="deleteRecurringIncome('${existing.id}')">Delete</button>` : ""}
        <button type="submit" class="btn-accent">Save</button>
      </div>
    </form>
  `);

  wireDatePickerField("recurring-income-due-date");
  wireDueDateQuickPicks();
  enhanceSelect("recurring-income-interval");

  document.getElementById("recurring-income-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById("recurring-income-name").value.trim(),
      amount: parseFloat(document.getElementById("recurring-income-amount").value),
      recurrence_interval: document.getElementById("recurring-income-interval").value,
      next_due_date: document.getElementById("recurring-income-due-date").value,
    };

    let error;
    if (existing) {
      ({ error } = await supabaseClient.from("finance_recurring_income").update(payload).eq("id", existing.id));
    } else {
      ({ error } = await supabaseClient.from("finance_recurring_income").insert(payload));
    }

    if (error) {
      await uiAlert("Failed to save recurring income: " + error.message);
      return;
    }
    closeModal();
    await renderRecurringIncomeList();
  });
}

/** "Received": logs an income entry to the balance ledger, then rolls the
 *  next_due_date forward — same mechanic as markPaymentPaid for
 *  subscriptions, just in the other direction (money in, not out). */
async function markRecurringIncomeReceived(id) {
  const rule = financeRecurringIncomeCache.find((r) => r.id === id);
  if (!rule) return;

  const { error: incomeError } = await supabaseClient.from("finance_balance_entries").insert({
    kind: "income",
    amount: rule.amount,
    note: rule.name,
    occurred_at: new Date().toISOString(),
  });
  if (incomeError) return uiAlert("Failed to log income: " + incomeError.message);

  const { error } = await supabaseClient
    .from("finance_recurring_income")
    .update({ next_due_date: advanceDueDate(rule.next_due_date, rule.recurrence_interval) })
    .eq("id", id);
  if (error) return uiAlert("Failed to update recurring income: " + error.message);

  await refreshAfterRecurringIncomeAction();
}

async function deleteRecurringIncome(id) {
  if (!(await uiConfirm("Delete this recurring income?"))) return;
  const { error } = await supabaseClient.from("finance_recurring_income").delete().eq("id", id);
  if (error) return uiAlert("Failed to delete: " + error.message);
  closeModal();
  await refreshAfterRecurringIncomeAction();
}

/** Re-renders whichever surface(s) — desktop dashboard and/or the mobile
 *  balance sheet — are currently showing recurring income data, same
 *  visibility-gated pattern as refreshFinanceAfterAction. */
async function refreshAfterRecurringIncomeAction() {
  await loadFinanceRecurringIncomeCache();

  const dashView = document.getElementById("view-findash");
  if (dashView && !dashView.classList.contains("hidden")) {
    const el = document.getElementById("finance-recurring-income-list");
    if (el) el.innerHTML = renderRecurringIncomeListHtml();
    loadFinanceDashboard();
  }

  if (mApp === "finance") {
    mFinanceBalance = await loadFinanceBalanceSummary();
    const listEl = document.getElementById("m-recurring-income-list");
    if (listEl) listEl.innerHTML = renderRecurringIncomeListHtmlMobile();
    else renderFinanceMobileScreen();
  }
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
      await uiAlert("Failed to add category: " + error.message);
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
        <span style="width:10px;height:10px;border-radius:50%;background:${c.color || "#9c86d8"};display:inline-block;"></span>
        <div class="title">${escapeHtml(c.name)}</div>
      </div>
      <button class="icon-btn danger" onclick="deleteCategoryDesktop('${c.id}')">Delete</button>
    </div>`
    )
    .join("");
}

async function deleteCategoryDesktop(id) {
  if (!(await uiConfirm("Delete this category? Expenses using it become Uncategorized."))) return;
  const { error } = await supabaseClient.from("finance_categories").delete().eq("id", id);
  if (error) return uiAlert("Failed to delete: " + error.message);
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

  const clearHistoryBtn = document.getElementById("payments-clear-history-btn");
  if (clearHistoryBtn) clearHistoryBtn.classList.toggle("hidden", history.length === 0);
}

/** Permanently removes every Paid/Cancelled payment from history in one
 *  go — a single confirmation, since the undo toast is what actually
 *  covers the "I didn't mean that" case (see markPaymentCancelled). */
async function clearPaymentHistory() {
  const historyRows = financePaymentsCache.filter((p) => {
    const status = computePaymentDisplayStatus(p);
    return status === "paid" || status === "cancelled";
  });
  if (historyRows.length === 0) return;

  if (!(await uiConfirm(`Clear ${historyRows.length} payment${historyRows.length === 1 ? "" : "s"} from history? This can't be undone once the Undo option disappears.`))) return;

  beginMutation();
  const { error } = await supabaseClient.from("finance_payments").delete().in("id", historyRows.map((p) => p.id));
  endMutation();
  if (error) return uiAlert("Failed to clear history: " + error.message);

  await refreshFinanceAfterAction();
  showFinanceUndoToast(`Cleared ${historyRows.length} from history`, async () => {
    beginMutation();
    await supabaseClient.from("finance_payments").insert(historyRows);
    endMutation();
    await refreshFinanceAfterAction();
  });
}

function renderPaymentRow(payment, status) {
  const actionsHtml = status === "due-soon" || status === "overdue"
    ? `
      <button class="icon-btn action-paid" onclick="markPaymentPaid('${payment.id}')">Paid</button>
      <button class="icon-btn action-overdue" onclick="markPaymentOverdue('${payment.id}')">Overdue</button>
      <button class="icon-btn action-cancel" onclick="markPaymentCancelled('${payment.id}')">Cancel</button>
    `
    : status === "upcoming"
    ? `
      <button class="icon-btn action-paid" onclick="markPaymentPaid('${payment.id}')">Paid</button>
      <button class="icon-btn action-cancel" onclick="markPaymentCancelled('${payment.id}')">Cancel</button>
    `
    : "";

  return `
    <div class="payment-row status-${status}">
      <div class="payment-row-main">
        ${paymentBadgeHtml(payment, status)}
        <div>
          <div class="payment-name">${escapeHtml(payment.name)}</div>
          <div class="payment-meta">${payment.kind === "subscription" ? `Repeats ${payment.recurrence_interval}` : "One-time"} · Due ${formatDueDate(payment.next_due_date)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;">
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
        ${datePickerFieldHtml("payment-due-date", existing ? existing.next_due_date : toIsoDateLocal(new Date()))}
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

  wireDatePickerField("payment-due-date");
  wireDueDateQuickPicks();
  enhanceSelect("payment-kind");
  enhanceSelect("payment-recurrence");

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
      await uiAlert("Failed to save payment: " + error.message);
      return;
    }
    closeModal();
    loadFinancePayments();
  });
}

async function deletePayment(id) {
  if (!(await uiConfirm("Delete this payment? This cannot be undone."))) return;
  const { error } = await supabaseClient.from("finance_payments").delete().eq("id", id);
  if (error) return uiAlert("Failed to delete: " + error.message);
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
  await refreshFinanceMobileFeeds();
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
  touchLastUpdatedMobile();
}

function renderFinanceMobileScreen() {
  if (fScreen === "due") renderFinanceDueScreen();
  else if (fScreen === "log") renderFinanceLogScreen();
  else renderFinanceDashboardScreenMobile();
}

/** `showBack` renders a small back button that returns to the Finance
 *  dashboard — an on-screen escape hatch for sub-screens, so a wrong tap
 *  doesn't strand someone with only the FAB (which needs expanding first)
 *  to get back. */
function renderFinanceTopbar(subtitle, showBack) {
  document.getElementById("m-topbar").innerHTML = `
    <div class="m-topbar-row">
      ${showBack ? `<button type="button" class="m-topbar-back-btn" id="m-fin-back-btn" aria-label="Back">&#8249;</button>` : ""}
      <div>
        <div class="m-title">FINANCE</div>
        <div class="m-date">${subtitle || new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
      </div>
    </div>
  `;
  if (showBack) document.getElementById("m-fin-back-btn").addEventListener("click", () => setFinanceMobileScreen("dashboard"));
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

  const dueSoonCount = financePaymentsCache.filter((p) => computePaymentDisplayStatus(p) === "due-soon").length;
  const overdueCount = financePaymentsCache.filter((p) => computePaymentDisplayStatus(p) === "overdue").length;

  document.getElementById("m-main").innerHTML = `
    <div class="m-dash-stats-grid">
      <div class="m-dash-stat-tile m-balance-tile" id="m-balance-tile" style="grid-column: span 2;">
        <div class="label">Available balance · tap for actions</div>
        <div class="value ${mFinanceBalance < 0 ? "danger" : ""}">${formatBalance(mFinanceBalance)}</div>
      </div>
      <div class="m-dash-stat-tile">
        <div class="label">This month</div>
        <div class="value">${formatMoney(monthTotal)}</div>
      </div>
      <div class="m-dash-stat-tile">
        <div class="label">Due soon</div>
        <div class="value">${dueSoonCount}</div>
      </div>
      <div class="m-dash-stat-tile" style="grid-column: span 2;">
        <div class="label">Overdue</div>
        <div class="value ${overdueCount ? "danger" : ""}">${overdueCount}</div>
      </div>
    </div>

    <div class="m-dash-quick-actions">
      <button type="button" class="m-dash-quick-action" id="m-dash-log-expense">Log Expense</button>
      <button type="button" class="m-dash-quick-action" id="m-dash-view-due">View Due</button>
    </div>

    <div class="m-dash-card">
      <div class="m-dash-card-title">This month</div>
      <div id="m-fin-calendar" class="m-swipe-owns-gesture"></div>
    </div>

    <div class="m-set-list-label">Recent</div>
    <div id="m-recent-expenses">${renderRecentTransactionsList()}</div>
  `;

  document.getElementById("m-dash-log-expense").addEventListener("click", () => setFinanceMobileScreen("log"));
  document.getElementById("m-dash-view-due").addEventListener("click", () => setFinanceMobileScreen("due"));
  document.getElementById("m-balance-tile").addEventListener("click", openBalanceActionsSheetMobile);
  wireRecentTransactionsDelete();

  financeCalendarStateMobile = { year: now.getFullYear(), month: now.getMonth() };
  wireFinanceCalendar(document.getElementById("m-fin-calendar"), financeCalendarStateMobile, "mobile");
}

/* ============================================
   MOBILE — Log expense
   ============================================ */
function renderFinanceLogScreen() {
  renderFinanceTopbar(undefined, true);

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
    <div id="m-recent-expenses">${renderRecentTransactionsList()}</div>
  `;

  wireFinanceLogScreen();
}

function renderRecentTransactionsList() {
  const transactions = mergeTransactions(financeRecentExpenses, financeRecentBalanceEntries, 10);
  if (transactions.length === 0) {
    return `<div class="m-empty" style="padding:30px 0;height:auto;"><p>No transactions logged yet.</p></div>`;
  }
  return transactions
    .map(
      (t) => `
    <div class="m-set-row">
      <div class="info">
        <div class="name">${formatSignedMoney(t.amount)} ${t.kind === "expense" ? categoryBadgeHtml(t.category_id) : transactionKindBadgeHtml(t.kind)}</div>
        <div class="detail">${t.note ? escapeHtmlMobile(t.note) + " · " : ""}${new Date(t.occurred_at).toLocaleDateString()}</div>
      </div>
      <div class="m-set-row-actions">
        <button class="delete-btn" data-table="${t.table}" data-id="${t.id}" type="button">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function wireRecentTransactionsDelete() {
  document.querySelectorAll("#m-recent-expenses .delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await uiConfirm("Delete this?"))) return;
      const { error } = await supabaseClient.from(btn.dataset.table).delete().eq("id", btn.dataset.id);
      if (error) {
        await uiAlert("Failed to delete: " + error.message);
        return;
      }
      await refreshFinanceMobileFeeds();
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
  wireRecentTransactionsDelete();
}

async function logExpenseMobile() {
  const amountInput = document.getElementById("m-expense-amount");
  const noteInput = document.getElementById("m-expense-note");
  const amount = parseFloat(amountInput.value);

  if (!amount || amount <= 0) {
    showFieldRequired(amountInput);
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
    await uiAlert("Failed to log expense: " + error.message);
    btn.disabled = false;
    btn.textContent = "Log Expense";
    return;
  }

  await refreshFinanceMobileFeeds();
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
    const nameInput = document.getElementById("m-new-category-name");
    const name = nameInput.value.trim();
    if (!name) return showFieldRequired(nameInput);
    const btn = document.getElementById("m-save-category-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const { data, error } = await supabaseClient
      .from("finance_categories")
      .insert({ name, color: nextCategoryColor() })
      .select()
      .single();

    if (error) {
      await uiAlert("Failed to save category: " + error.message);
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
  renderFinanceTopbar("Due & upcoming", true);

  const decorated = financePaymentsCache.map((p) => ({ payment: p, status: computePaymentDisplayStatus(p) }));
  const due = decorated.filter((d) => d.status === "due-soon" || d.status === "overdue");
  const upcoming = decorated.filter((d) => d.status === "upcoming");
  const history = decorated.filter((d) => d.status === "paid" || d.status === "cancelled");

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
    ${history.length
      ? `<div class="m-set-list-label" style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;">
          <span>History</span>
          <button type="button" class="btn-ghost" id="m-payments-clear-history-btn" style="padding:5px 12px;font-size:11px;">Clear History</button>
        </div>
        <div id="m-payments-history">${history.map((d) => renderMobilePaymentRow(d.payment, d.status)).join("")}</div>`
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

  const clearHistoryBtn = document.getElementById("m-payments-clear-history-btn");
  if (clearHistoryBtn) clearHistoryBtn.addEventListener("click", clearPaymentHistory);

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
          ${paymentBadgeHtml(payment, status)}
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
          <div style="margin-top:8px;">${datePickerFieldHtml("m-payment-due-date", toIsoDateLocal(new Date()))}</div>
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
  wireDatePickerField("m-payment-due-date");
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

    if (!name) return showFieldRequired(document.getElementById("m-payment-name"));
    if (!amount || amount <= 0) return showFieldRequired(document.getElementById("m-payment-amount"));
    if (!dueDate) return showFieldRequired(document.getElementById("m-payment-due-date"));

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
      await uiAlert("Failed to save payment: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }

    overlay.remove();
    await loadFinancePaymentsCache();
    renderFinanceMobileScreen();
  });
}

/* ============================================
   MOBILE — Balance actions: Add Income / Adjust Balance
   Reached by tapping the balance tile rather than living in the FAB stack
   or dashboard quick-actions row — these are occasional actions, so they
   get a deliberate second tap instead of permanent screen real estate.
   ============================================ */
function openBalanceActionsSheetMobile() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-sheet-title">Available balance</div>
        <div class="m-payment-sheet-amount">${formatBalance(mFinanceBalance)}</div>
        <div class="m-payment-actions" style="margin-top:18px;">
          <button type="button" class="m-payment-action-btn paid" id="m-balance-add-income">Add Income</button>
          <button type="button" class="m-payment-action-btn skip" id="m-balance-adjust">Adjust Balance</button>
        </div>
        <button type="button" class="btn-ghost" id="m-balance-recurring-income" style="width:100%;margin-top:10px;padding:9px 0;">Recurring Income</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("m-balance-add-income").addEventListener("click", () => {
    overlay.remove();
    openAddIncomeSheetMobile();
  });
  document.getElementById("m-balance-adjust").addEventListener("click", () => {
    overlay.remove();
    openAdjustBalanceSheetMobile();
  });
  document.getElementById("m-balance-recurring-income").addEventListener("click", () => {
    overlay.remove();
    openRecurringIncomeListSheetMobile();
  });
}

function openAddIncomeSheetMobile() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Amount (${CURRENCY})</div>
          <input type="number" step="0.01" min="0.01" id="m-income-amount" inputmode="decimal" autofocus
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Note (optional)</div>
          <input type="text" id="m-income-note"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-income-btn" style="width:100%;max-width:none;">Add Income</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("m-save-income-btn").addEventListener("click", async () => {
    const amountInput = document.getElementById("m-income-amount");
    const amount = parseFloat(amountInput.value);
    if (!amount || amount <= 0) return showFieldRequired(amountInput);
    const btn = document.getElementById("m-save-income-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    beginMutation();
    const { error } = await supabaseClient.from("finance_balance_entries").insert({
      kind: "income",
      amount,
      note: document.getElementById("m-income-note").value.trim() || null,
      occurred_at: new Date().toISOString(),
    });
    endMutation();

    if (error) {
      await uiAlert("Failed to add income: " + error.message);
      btn.disabled = false;
      btn.textContent = "Add Income";
      return;
    }

    overlay.remove();
    await refreshFinanceMobileFeeds();
    renderFinanceMobileScreen();
  });
}

function openAdjustBalanceSheetMobile() {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Direction</div>
          <div class="m-chip-row" id="m-adjustment-direction-row" style="margin-top:8px;">
            <div class="m-chip active" data-sign="1">Add</div>
            <div class="m-chip" data-sign="-1">Subtract</div>
          </div>
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Amount (${CURRENCY})</div>
          <input type="number" step="0.01" min="0.01" id="m-adjustment-amount" inputmode="decimal" autofocus
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Note (optional)</div>
          <input type="text" id="m-adjustment-note" placeholder="e.g. Correcting a miscount"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-adjustment-btn" style="width:100%;max-width:none;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelectorAll("#m-adjustment-direction-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      overlay.querySelectorAll("#m-adjustment-direction-row .m-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("m-save-adjustment-btn").addEventListener("click", async () => {
    const magnitudeInput = document.getElementById("m-adjustment-amount");
    const magnitude = parseFloat(magnitudeInput.value);
    if (!magnitude || magnitude <= 0) return showFieldRequired(magnitudeInput);
    const sign = parseInt(overlay.querySelector("#m-adjustment-direction-row .m-chip.active").dataset.sign, 10);
    const btn = document.getElementById("m-save-adjustment-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    beginMutation();
    const { error } = await supabaseClient.from("finance_balance_entries").insert({
      kind: "adjustment",
      amount: magnitude * sign,
      note: document.getElementById("m-adjustment-note").value.trim() || null,
      occurred_at: new Date().toISOString(),
    });
    endMutation();

    if (error) {
      await uiAlert("Failed to save adjustment: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }

    overlay.remove();
    await refreshFinanceMobileFeeds();
    renderFinanceMobileScreen();
  });
}

/* ============================================
   MOBILE — Recurring income: list (hold a row for actions), add/edit sheet.
   Same hold-for-actions philosophy as the payments Due screen — a stray
   tap in a scroll never fires Received/Delete by accident.
   ============================================ */
function renderRecurringIncomeListHtmlMobile() {
  if (financeRecurringIncomeCache.length === 0) {
    return `<div class="m-empty" style="padding:30px 0;height:auto;"><p>No recurring income set up.</p></div>`;
  }
  return financeRecurringIncomeCache
    .map(
      (r) => `
    <div class="m-payment-row status-upcoming" data-recurring-id="${r.id}">
      <div class="m-payment-row-top">
        <div class="name">${escapeHtmlMobile(r.name)}</div>
        <div class="m-payment-amount">${formatMoney(r.amount)}</div>
      </div>
      <div class="detail">Repeats ${r.recurrence_interval} · Next ${formatDueDate(r.next_due_date)}</div>
    </div>`
    )
    .join("");
}

async function openRecurringIncomeListSheetMobile() {
  await loadFinanceRecurringIncomeCache();

  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.id = "m-recurring-income-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-sheet-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>Recurring income</span>
          <button type="button" class="btn-ghost" id="m-recurring-income-add-btn" style="padding:5px 12px;font-size:11px;">+ Add</button>
        </div>
        <div id="m-recurring-income-list" style="margin-top:12px;">${renderRecurringIncomeListHtmlMobile()}</div>
        <div class="meta-line" style="text-align:center;margin-top:16px;color:var(--text-faint);font-size:11px;">Hold an entry for actions</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  wireRecurringIncomeListSheetMobile();

  document.getElementById("m-recurring-income-add-btn").addEventListener("click", () => {
    openRecurringIncomeEditSheetMobile();
  });
}

function wireRecurringIncomeListSheetMobile() {
  document.querySelectorAll("#m-recurring-income-list .m-payment-row").forEach((row) => {
    const rule = financeRecurringIncomeCache.find((r) => r.id === row.dataset.recurringId);
    if (rule) attachRecurringIncomeLongPress(row, rule);
  });
}

function attachRecurringIncomeLongPress(row, rule) {
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
    timer = setTimeout(() => openRecurringIncomeActionSheetMobile(rule), HOLD_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE)) cancel();
  });
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointercancel", cancel);
}

function openRecurringIncomeActionSheetMobile(rule) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-sheet-title">${escapeHtmlMobile(rule.name)}</div>
        <div class="m-payment-sheet-amount">${formatMoney(rule.amount)}</div>
        <div class="m-payment-actions" style="margin-top:18px;">
          <button type="button" class="m-payment-action-btn paid" data-action="received">Received</button>
          <button type="button" class="m-payment-action-btn skip" data-action="edit">Edit</button>
          <button type="button" class="m-payment-action-btn overdue" data-action="delete">Delete</button>
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
      if (btn.dataset.action === "received") await markRecurringIncomeReceived(rule.id);
      else if (btn.dataset.action === "edit") openRecurringIncomeEditSheetMobile(rule);
      else if (await uiConfirm("Delete this recurring income?")) await deleteRecurringIncome(rule.id);
    });
  });
}

function openRecurringIncomeEditSheetMobile(existing) {
  const overlay = document.createElement("div");
  overlay.className = "m-sheet-overlay";
  overlay.innerHTML = `
    <div class="m-sheet">
      <div class="m-sheet-handle"></div>
      <div class="m-sheet-body">
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Name</div>
          <input type="text" id="m-recurring-income-name" autofocus value="${existing ? escapeHtmlMobile(existing.name) : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Amount (${CURRENCY})</div>
          <input type="number" step="0.01" min="0.01" id="m-recurring-income-amount" value="${existing ? existing.amount : ""}"
                 style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-size:14px;margin-top:8px;" />
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Repeats</div>
          <div class="m-chip-row" id="m-recurring-income-interval-row" style="margin-top:8px;">
            <div class="m-chip ${existing && existing.recurrence_interval === "weekly" ? "active" : ""}" data-interval="weekly">Weekly</div>
            <div class="m-chip ${!existing || existing.recurrence_interval === "monthly" ? "active" : ""}" data-interval="monthly">Monthly</div>
            <div class="m-chip ${existing && existing.recurrence_interval === "yearly" ? "active" : ""}" data-interval="yearly">Yearly</div>
          </div>
        </div>
        <div class="m-stat-block" style="margin-bottom:14px;">
          <div class="label">Expected Income Date</div>
          <div style="margin-top:8px;">${datePickerFieldHtml("m-recurring-income-due-date", existing ? existing.next_due_date : toIsoDateLocal(new Date()))}</div>
          ${dueDateQuickPicksHtml("m-recurring-income-due-date")}
        </div>
      </div>
      <div class="m-sheet-footer">
        <button class="m-start-btn" id="m-save-recurring-income-btn" style="width:100%;max-width:none;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  wireDatePickerField("m-recurring-income-due-date");
  wireDueDateQuickPicks(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelectorAll("#m-recurring-income-interval-row .m-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      overlay.querySelectorAll("#m-recurring-income-interval-row .m-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("m-save-recurring-income-btn").addEventListener("click", async () => {
    const nameInput = document.getElementById("m-recurring-income-name");
    const amountInput = document.getElementById("m-recurring-income-amount");
    const name = nameInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const dueDate = document.getElementById("m-recurring-income-due-date").value;
    const interval = overlay.querySelector("#m-recurring-income-interval-row .m-chip.active").dataset.interval;

    if (!name) return showFieldRequired(nameInput);
    if (!amount || amount <= 0) return showFieldRequired(amountInput);

    const btn = document.getElementById("m-save-recurring-income-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const payload = { name, amount, recurrence_interval: interval, next_due_date: dueDate };

    beginMutation();
    const { error } = existing
      ? await supabaseClient.from("finance_recurring_income").update(payload).eq("id", existing.id)
      : await supabaseClient.from("finance_recurring_income").insert(payload);
    endMutation();

    if (error) {
      await uiAlert("Failed to save: " + error.message);
      btn.disabled = false;
      btn.textContent = "Save";
      return;
    }

    overlay.remove();
    await loadFinanceRecurringIncomeCache();
    const listEl = document.getElementById("m-recurring-income-list");
    if (listEl) {
      listEl.innerHTML = renderRecurringIncomeListHtmlMobile();
      wireRecurringIncomeListSheetMobile();
    }
  });
}

