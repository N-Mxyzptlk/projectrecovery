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
  loadAdminRowCounts();
}

function wireAdminActions() {
  const pwBtn = document.getElementById("admin-change-password-btn");
  const exportBtn = document.getElementById("admin-export-btn");
  const wipeBtn = document.getElementById("admin-wipe-workouts-btn");
  const usernameBtn = document.getElementById("admin-save-username-btn");
  const autoLogoutSelect = document.getElementById("admin-auto-logout");

  // Avoid stacking duplicate listeners if the admin view is opened more than once
  pwBtn.replaceWith(pwBtn.cloneNode(true));
  exportBtn.replaceWith(exportBtn.cloneNode(true));
  wipeBtn.replaceWith(wipeBtn.cloneNode(true));
  usernameBtn.replaceWith(usernameBtn.cloneNode(true));
  autoLogoutSelect.replaceWith(autoLogoutSelect.cloneNode(true));

  document.getElementById("admin-change-password-btn").addEventListener("click", changePassword);
  document.getElementById("admin-export-btn").addEventListener("click", exportAllData);
  document.getElementById("admin-wipe-workouts-btn").addEventListener("click", wipeWorkoutHistory);
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

async function loadAdminRowCounts() {
  const el = document.getElementById("admin-row-counts");
  const tables = ["stations", "workouts", "workout_sets", "finance_categories", "finance_payments", "finance_expenses"];

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
    const [stations, workouts, sets, financeCategories, financePayments, financeExpenses] = await Promise.all([
      supabaseClient.from("stations").select("*"),
      supabaseClient.from("workouts").select("*"),
      supabaseClient.from("workout_sets").select("*"),
      supabaseClient.from("finance_categories").select("*"),
      supabaseClient.from("finance_payments").select("*"),
      supabaseClient.from("finance_expenses").select("*"),
    ]);

    const backup = {
      exported_at: new Date().toISOString(),
      stations: stations.data || [],
      workouts: workouts.data || [],
      workout_sets: sets.data || [],
      finance_categories: financeCategories.data || [],
      finance_payments: financePayments.data || [],
      finance_expenses: financeExpenses.data || [],
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nul-systems-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Export failed: " + e.message);
  }

  btn.disabled = false;
  btn.textContent = "Export JSON";
}

async function wipeWorkoutHistory() {
  const typed = prompt('This deletes ALL workouts and sets permanently. Type "DELETE" to confirm.');
  if (typed !== "DELETE") return;

  const btn = document.getElementById("admin-wipe-workouts-btn");
  btn.disabled = true;
  btn.textContent = "Deleting...";

  // workout_sets cascade-deletes with their parent workout (see schema:
  // "on delete cascade"), so deleting workouts is enough.
  const { error } = await supabaseClient.from("workouts").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  if (error) {
    alert("Failed to delete: " + error.message);
  } else {
    alert("Workout history deleted.");
    loadAdminRowCounts();
  }

  btn.disabled = false;
  btn.textContent = "Delete";
}