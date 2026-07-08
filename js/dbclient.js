// dbclient.js
// Initializes the Supabase client and exposes small auth helpers.
// Loaded after config.js and the Supabase CDN script, before app-specific JS.

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Resolves with the current session, or null if not logged in.
 */
async function getSession() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error("Failed to get session:", error.message);
    return null;
  }
  return data.session;
}

/**
 * Signs in with username + password. Looks up the email behind the
 * username via a SECURITY DEFINER RPC (get_email_for_username), then
 * signs in normally — Supabase Auth itself still only knows email.
 * Returns { success, error }.
 */
async function signIn(username, password) {
  const { data: email, error: lookupError } = await supabaseClient.rpc("get_email_for_username", {
    uname: username.trim().toLowerCase(),
  });

  if (lookupError || !email) {
    return { success: false, error: "Invalid username or password." };
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    return { success: false, error: "Invalid username or password." };
  }
  return { success: true, session: data.session };
}

let autoLogoutTimer = null;
let autoLogoutMinutes = 0;

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}

/**
 * Reads the user's auto-logout preference from `profiles` and starts an
 * inactivity watcher if it's enabled (> 0 minutes). Shared by desktop and
 * mobile since both load dbclient.js first.
 */
async function initAutoLogout() {
  try {
    const { data } = await supabaseClient.from("profiles").select("auto_logout_minutes").single();
    autoLogoutMinutes = data?.auto_logout_minutes || 0;
  } catch (e) {
    autoLogoutMinutes = 0;
  }

  if (autoLogoutMinutes > 0) {
    resetAutoLogoutTimer();
    ["mousemove", "keydown", "touchstart", "click", "scroll"].forEach((evt) =>
      window.addEventListener(evt, resetAutoLogoutTimer, { passive: true })
    );
  }
}

function resetAutoLogoutTimer() {
  if (autoLogoutTimer) clearTimeout(autoLogoutTimer);
  if (autoLogoutMinutes > 0) {
    autoLogoutTimer = setTimeout(() => {
      signOut();
    }, autoLogoutMinutes * 60 * 1000);
  }
}

/** Call after changing the setting (e.g. from Admin/Settings) to apply immediately. */
function updateAutoLogoutMinutes(minutes) {
  autoLogoutMinutes = minutes;
  resetAutoLogoutTimer();
}

/**
 * Status light model (shared by desktop sidebar + mobile settings):
 *   green  = DB reachable, nothing in flight — ready to record
 *   yellow = a logging write is currently in flight (transient)
 *   red    = DB health check failed — can't log right now
 */
let mutationInFlight = 0;
let lastHealthOk = true;

async function checkConnectivity() {
  try {
    const { error } = await supabaseClient.from("stations").select("id", { count: "exact", head: true }).limit(1);
    lastHealthOk = !error;
  } catch (e) {
    lastHealthOk = false;
  }
  refreshStatusLights();
  return lastHealthOk;
}

/** Wrap any "recording" write with these so the light goes yellow while it runs. */
function beginMutation() {
  mutationInFlight++;
  refreshStatusLights();
}
function endMutation() {
  mutationInFlight = Math.max(0, mutationInFlight - 1);
  refreshStatusLights();
}

function refreshStatusLights() {
  let status, label;
  if (!lastHealthOk) {
    status = "red";
    label = "Database down, unable to log";
  } else if (mutationInFlight > 0) {
    status = "yellow";
    label = "Logging in progress";
  } else {
    status = "green";
    label = "All systems good, ready to record";
  }

  // Update whichever status elements currently exist in the DOM (desktop
  // sidebar and/or mobile settings sheet) — either, both, or neither.
  [
    ["status-dot", "status-text"],
    ["m-status-dot", "m-status-text"],
  ].forEach(([dotId, textId]) => {
    const dot = document.getElementById(dotId);
    const text = document.getElementById(textId);
    if (dot) dot.className = "status-dot status-" + status;
    if (text) text.textContent = label;
  });
}

/**
 * Gates the app: shows the login screen if not authenticated, otherwise
 * calls onAuthenticated(session) and keeps listening for sign-out events.
 */
function requireAuth(onAuthenticated) {
  getSession().then((session) => {
    const loginScreen = document.getElementById("login-screen");
    if (session) {
      loginScreen.classList.add("hidden");
      onAuthenticated(session);
    } else {
      showLoginScreen(onAuthenticated);
    }
  });

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      window.location.reload();
    }
  });
}

function showLoginScreen(onAuthenticated) {
  const loginScreen = document.getElementById("login-screen");
  loginScreen.classList.remove("hidden");

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;

    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    const result = await signIn(username, password);

    if (result.success) {
      loginScreen.classList.add("hidden");
      onAuthenticated(result.session);
    } else {
      errorEl.textContent = result.error;
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });
}