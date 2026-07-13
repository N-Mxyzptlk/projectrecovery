// admin.js
// Desktop-only admin panel: account settings, JSON backup export, and a
// danger zone for wiping workout history. Reuses supabaseClient and
// currentUserId from dbclient.js / desktop.js.

async function loadAdmin() {
  const { data: userData } = await supabaseClient.auth.getUser();
  document.getElementById("admin-user-email").textContent = userData?.user?.email || "—";

  const { data: profile } = await supabaseClient.from("profiles").select("username, auto_logout_minutes").maybeSingle();
  document.getElementById("admin-username").value = profile?.username || "";
  document.getElementById("admin-auto-logout").value = String(profile?.auto_logout_minutes ?? 30);

  wireAdminActions();
  enhanceSelect("admin-auto-logout");
  loadAdminRowCounts();
  loadAdminDatabaseSize();

  // Shared editor (uimodal.js) — mobile's Settings sheet renders the same
  // thing into its own container id, with its own refresh callback.
  renderNavModuleEditor("admin-nav-module-list", () => renderSidebarNavItems());
}

function wireAdminActions() {
  const pwBtn = document.getElementById("admin-change-password-btn");
  const exportBtn = document.getElementById("admin-export-btn");
  const wipeBtn = document.getElementById("admin-wipe-workouts-btn");
  const wipeAllBtn = document.getElementById("admin-wipe-all-btn");
  const usernameBtn = document.getElementById("admin-save-username-btn");
  const autoLogoutSelect = document.getElementById("admin-auto-logout");

  // Avoid stacking duplicate listeners if the admin view is opened more than once
  pwBtn.replaceWith(pwBtn.cloneNode(true));
  exportBtn.replaceWith(exportBtn.cloneNode(true));
  wipeBtn.replaceWith(wipeBtn.cloneNode(true));
  wipeAllBtn.replaceWith(wipeAllBtn.cloneNode(true));
  usernameBtn.replaceWith(usernameBtn.cloneNode(true));
  autoLogoutSelect.replaceWith(autoLogoutSelect.cloneNode(true));

  document.getElementById("admin-change-password-btn").addEventListener("click", changePassword);
  document.getElementById("admin-export-btn").addEventListener("click", exportAllData);
  document.getElementById("admin-wipe-workouts-btn").addEventListener("click", wipeWorkoutHistory);
  document.getElementById("admin-wipe-all-btn").addEventListener("click", wipeAllData);
  document.getElementById("admin-save-username-btn").addEventListener("click", saveUsername);
  document.getElementById("admin-auto-logout").addEventListener("change", saveAutoLogout);
}

async function saveUsername() {
  const msg = document.getElementById("admin-username-msg");
  const username = document.getElementById("admin-username").value.trim().toLowerCase();
  msg.style.color = "var(--danger)";
  msg.textContent = "";

  if (!username || !/^[a-z0-9_]{3,20}$/.test(username)) {
    msg.textContent = "Use 3-20 characters: lowercase letters, numbers, underscores.";
    return;
  }

  const { error } = await supabaseClient
    .from("profiles")
    .upsert({ id: currentUserId, username }, { onConflict: "id" });

  if (error) {
    msg.textContent = error.message.includes("duplicate") ? "That username is taken." : error.message;
    return;
  }

  msg.style.color = "var(--success)";
  msg.textContent = "Username saved. Use it to sign in next time.";
}

async function saveAutoLogout() {
  const minutes = parseInt(document.getElementById("admin-auto-logout").value, 10);
  const { error } = await supabaseClient
    .from("profiles")
    .upsert({ id: currentUserId, auto_logout_minutes: minutes }, { onConflict: "id" });

  if (!error && typeof updateAutoLogoutMinutes === "function") {
    updateAutoLogoutMinutes(minutes);
  }
}

async function changePassword() {
  const input = document.getElementById("admin-new-password");
  const msg = document.getElementById("admin-password-msg");
  const password = input.value;

  msg.textContent = "";
  msg.style.color = "var(--danger)";

  if (password.length < 6) {
    msg.textContent = "Password must be at least 6 characters.";
    return;
  }

  const { error } = await supabaseClient.auth.updateUser({ password });
  if (error) {
    msg.textContent = error.message;
    return;
  }

  msg.style.color = "var(--success)";
  msg.textContent = "Password updated.";
  input.value = "";
}

async function loadAdminDatabaseSize() {
  const el = document.getElementById("admin-db-size");
  if (!el) return;
  const { data, error } = await supabaseClient.rpc("get_database_size");
  if (error || data == null) {
    el.textContent = "Unavailable — run the latest sql/home_schema.sql migration.";
    return;
  }
  el.textContent = formatBytes(Number(data));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function loadAdminRowCounts() {
  const el = document.getElementById("admin-row-counts");
  const tables = ["stations", "workouts", "workout_sets", "finance_categories", "finance_payments", "finance_expenses", "finance_balance_entries", "finance_recurring_income", "todos", "guitar_songs"];

  try {
    const counts = await Promise.all(
      tables.map((t) => supabaseClient.from(t).select("*", { count: "exact", head: true }))
    );
    const parts = tables.map((t, i) => `${t}: ${counts[i].count ?? "?"}`);
    el.textContent = parts.join("  ·  ");
  } catch (e) {
    el.textContent = "Couldn't load counts.";
  }
}

async function exportAllData() {
  const btn = document.getElementById("admin-export-btn");
  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const [stations, workouts, sets, financeCategories, financePayments, financeExpenses, financeBalanceEntries, financeRecurringIncome, todos, guitarSongs] = await Promise.all([
      supabaseClient.from("stations").select("*"),
      supabaseClient.from("workouts").select("*"),
      supabaseClient.from("workout_sets").select("*"),
      supabaseClient.from("finance_categories").select("*"),
      supabaseClient.from("finance_payments").select("*"),
      supabaseClient.from("finance_expenses").select("*"),
      supabaseClient.from("finance_balance_entries").select("*"),
      supabaseClient.from("finance_recurring_income").select("*"),
      supabaseClient.from("todos").select("*"),
      supabaseClient.from("guitar_songs").select("*"),
    ]);

    const backup = {
      exported_at: new Date().toISOString(),
      stations: stations.data || [],
      workouts: workouts.data || [],
      workout_sets: sets.data || [],
      finance_categories: financeCategories.data || [],
      finance_payments: financePayments.data || [],
      todos: todos.data || [],
      finance_expenses: financeExpenses.data || [],
      finance_balance_entries: financeBalanceEntries.data || [],
      finance_recurring_income: financeRecurringIncome.data || [],
      guitar_songs: guitarSongs.data || [],
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nlab-environment-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    await uiAlert("Export failed: " + e.message);
  }

  btn.disabled = false;
  btn.textContent = "Export JSON";
}

async function wipeWorkoutHistory() {
  const typed = await uiPrompt('This deletes ALL workouts and sets permanently. Type "DELETE" to confirm.');
  if (typed !== "DELETE") return;

  const btn = document.getElementById("admin-wipe-workouts-btn");
  btn.disabled = true;
  btn.textContent = "Deleting...";

  // workout_sets cascade-deletes with their parent workout (see schema:
  // "on delete cascade"), so deleting workouts is enough.
  const { error } = await supabaseClient.from("workouts").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  if (error) {
    await uiAlert("Failed to delete: " + error.message);
  } else {
    await uiAlert("Workout history deleted.");
    loadAdminRowCounts();
  }

  btn.disabled = false;
  btn.textContent = "Delete";
}

/** Deletes every row in every app table (not the tables themselves, and
 *  never auth.users — sign-in is untouched). Meant for clearing out mock/
 *  test data before going to production, so it's deliberately harder to
 *  trigger by accident than the single-app wipe above: two confirmations,
 *  the second requiring an exact typed phrase that names what's about to
 *  happen rather than a generic "DELETE". */
async function wipeAllData() {
  if (!(await uiConfirm("This deletes EVERYTHING in every app — stations, workouts, sets, finance data, to-dos, and your guitar catalogue. Your login is not affected. Continue?"))) return;

  const typed = await uiPrompt('Type "WIPE ALL DATA" (exactly, all caps) to confirm. This cannot be undone.');
  if (typed !== "WIPE ALL DATA") {
    if (typed !== null) await uiAlert("Text didn't match — nothing was deleted.");
    return;
  }

  const btn = document.getElementById("admin-wipe-all-btn");
  btn.disabled = true;
  btn.textContent = "Wiping...";

  // workout_sets, finance_expenses (via source_payment_id), and other
  // child rows cascade-delete with their parents (see each sql/*.sql
  // schema), so deleting these top-level tables is enough.
  const tables = ["workouts", "stations", "finance_payments", "finance_categories", "finance_expenses", "finance_balance_entries", "finance_recurring_income", "todos", "guitar_songs"];
  const results = await Promise.all(tables.map((t) => supabaseClient.from(t).delete().neq("id", "00000000-0000-0000-0000-000000000000")));
  const failed = results.map((r, i) => (r.error ? tables[i] : null)).filter(Boolean);

  btn.disabled = false;
  btn.textContent = "Wipe All";

  if (failed.length > 0) {
    await uiAlert("Some tables failed to clear: " + failed.join(", ") + ". Check the console for details.");
    console.error(results.filter((r) => r.error).map((r) => r.error));
  } else {
    await uiAlert("All data wiped. Your login is unchanged.");
  }

  loadAdminRowCounts();
}