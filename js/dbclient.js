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
 * Signs in with email + password. Returns { success, error }.
 */
async function signIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, session: data.session };
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
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
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    const result = await signIn(email, password);

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