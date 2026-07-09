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
let autoLogoutMinutes = 30; // sensible default until we know the user's actual preference
const INACTIVITY_WARNING_SECONDS = 60; // grace window after the warning appears

let inactivityCountdownInterval = null;

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}

/**
 * Reads the user's auto-logout preference from `profiles` and starts an
 * inactivity watcher if it's enabled (> 0 minutes). Shared by desktop and
 * mobile since both load dbclient.js first. Falls back to a 30-minute
 * default if the profile can't be read at all, rather than silently
 * disabling the safeguard.
 */
async function initAutoLogout() {
  try {
    const { data } = await supabaseClient.from("profiles").select("auto_logout_minutes").maybeSingle();
    autoLogoutMinutes = data?.auto_logout_minutes ?? 30;
  } catch (e) {
    autoLogoutMinutes = 30;
  }

  resetAutoLogoutTimer();
  // Any real interaction resets the timer AND dismisses an active warning —
  // someone mid-set who taps a stepper is clearly still there.
  ["mousemove", "keydown", "touchstart", "click", "scroll"].forEach((evt) =>
    window.addEventListener(evt, handleUserActivity, { passive: true })
  );
}

function handleUserActivity() {
  if (document.getElementById("inactivity-warning-overlay")) {
    dismissInactivityWarning();
  }
  resetAutoLogoutTimer();
}

function resetAutoLogoutTimer() {
  if (autoLogoutTimer) clearTimeout(autoLogoutTimer);
  if (autoLogoutMinutes > 0) {
    autoLogoutTimer = setTimeout(showInactivityWarning, autoLogoutMinutes * 60 * 1000);
  }
}

/** Shown instead of a silent logout — gives a countdown and a way to stay signed in. */
function showInactivityWarning() {
  if (document.getElementById("inactivity-warning-overlay")) return;

  let secondsLeft = INACTIVITY_WARNING_SECONDS;

  const overlay = document.createElement("div");
  overlay.id = "inactivity-warning-overlay";
  overlay.innerHTML = `
    <div class="inactivity-modal">
      <div class="inactivity-icon">⏱</div>
      <h3>Are you still there?</h3>
      <p>You'll be signed out in <span id="inactivity-countdown">${secondsLeft}</span>s due to inactivity.</p>
      <button id="inactivity-stay-btn" class="btn-primary">I'm still here</button>
      <button id="inactivity-logout-btn" class="btn-ghost">Log out now</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("inactivity-stay-btn").addEventListener("click", () => {
    dismissInactivityWarning();
    resetAutoLogoutTimer();
  });
  document.getElementById("inactivity-logout-btn").addEventListener("click", signOut);

  inactivityCountdownInterval = setInterval(() => {
    secondsLeft--;
    const el = document.getElementById("inactivity-countdown");
    if (el) el.textContent = secondsLeft;
    if (secondsLeft <= 0) {
      clearInterval(inactivityCountdownInterval);
      signOut();
    }
  }, 1000);
}

function dismissInactivityWarning() {
  const overlay = document.getElementById("inactivity-warning-overlay");
  if (overlay) overlay.remove();
  if (inactivityCountdownInterval) clearInterval(inactivityCountdownInterval);
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
    label = "Status: Systems Down";
  } else if (mutationInFlight > 0) {
    status = "yellow";
    label = "Status: Logging";
  } else {
    status = "green";
    label = "Status: Running";
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