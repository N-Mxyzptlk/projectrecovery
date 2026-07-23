/* ============================================
   Offline write queue — a Supabase outage (or a dead connection) used to
   mean a logged/created row just vanished: the insert failed, the alert
   said so, and there was nothing left to retry, so the data had to be
   re-entered from memory later (and sometimes wasn't, which is what
   actually happened). writeWithQueue() gives write call-sites a way to
   fail SAFE instead: a network-shaped failure gets persisted to
   localStorage and retried automatically once the connection (or
   Supabase) is back, instead of being dropped.

   Deliberately NOT wrapping every possible Supabase call blind — a
   genuine validation/permission/constraint error will just fail again
   identically on replay, and silently retrying that forever would hide a
   real bug instead of surfacing it (see isRetryableWriteError). Only
   network-shaped failures get queued.
   ============================================ */

const WRITE_QUEUE_KEY = "nlab-write-queue-v1";
let writeQueueDrainTimer = null;
let writeQueueDraining = false;

function loadWriteQueue() {
  try {
    return JSON.parse(localStorage.getItem(WRITE_QUEUE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function saveWriteQueue(queue) {
  localStorage.setItem(WRITE_QUEUE_KEY, JSON.stringify(queue));
  renderWriteQueueBadge(queue.length);
}

/** Network/outage failures have no Postgres error code and a fetch-level
 *  message; real server-side errors (RLS, constraint violations, bad
 *  columns) always carry a `.code`. That's the signal used to decide
 *  whether a retry could plausibly succeed later. */
function isRetryableWriteError(error) {
  if (!error) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (error.code) return false;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network request failed") ||
    msg.includes("load failed") ||
    msg.includes("timeout")
  );
}

/**
 * Runs a Supabase write. On success, returns { data, error: null, queued:
 * false } exactly like a normal call. On a retryable (network/outage)
 * failure, the write is queued for automatic replay and this returns
 * { data: null, error: null, queued: true } — callers should treat
 * `queued` as "not confirmed synced yet" and proceed optimistically rather
 * than as a failure, since the row IS going to land once connectivity
 * returns.
 *
 * `payload` must include a client-generated `id` (crypto.randomUUID())
 * for insert/upsert so a queued retry is naturally idempotent — replaying
 * an insert that actually already succeeded (e.g. the response just never
 * came back) becomes a harmless no-op upsert onto the same row instead of
 * a duplicate.
 */
async function writeWithQueue(table, method, payload, options = {}) {
  const { data, error } = await runQueuedWrite(table, method, payload, options);
  if (!error) return { data, error: null, queued: false };

  if (isRetryableWriteError(error)) {
    enqueueWrite({ table, method, payload, match: options.match, upsertOptions: options.upsertOptions });
    // No `data` — the write hasn't reached Supabase. Callers pass their
    // own client-generated id in `payload` up front specifically so they
    // can build their own optimistic local row instead of waiting for one.
    return { data: null, error: null, queued: true };
  }
  return { data: null, error, queued: false };
}

/** `select`/`single` only make sense (and are only applied) on the initial
 *  live attempt — a queued replay running later in the background has
 *  nothing awaiting its return value. */
async function runQueuedWrite(table, method, payload, options = {}) {
  let query = supabaseClient.from(table);
  if (method === "delete") query = query.delete().match(options.match);
  else if (method === "update") query = query.update(payload).match(options.match);
  else query = query.upsert(payload, options.upsertOptions || { onConflict: "id" });
  if (options.select) query = query.select(options.select);
  if (options.single) query = query.single();
  return await query;
}

function enqueueWrite(entry) {
  const queue = loadWriteQueue();
  queue.push({ ...entry, queuedId: crypto.randomUUID(), queuedAt: Date.now() });
  saveWriteQueue(queue);
  scheduleWriteQueueDrain(4000);
}

function scheduleWriteQueueDrain(delay) {
  clearTimeout(writeQueueDrainTimer);
  writeQueueDrainTimer = setTimeout(drainWriteQueue, delay);
}

async function drainWriteQueue() {
  if (writeQueueDraining) return;
  let queue = loadWriteQueue();
  if (queue.length === 0) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    scheduleWriteQueueDrain(10000);
    return;
  }

  writeQueueDraining = true;
  try {
    while (queue.length > 0) {
      const entry = queue[0];
      const { error } = await runQueuedWrite(entry.table, entry.method, entry.payload, {
        match: entry.match,
        upsertOptions: entry.upsertOptions,
      });
      if (error) {
        if (isRetryableWriteError(error)) {
          scheduleWriteQueueDrain(10000);
          return; // still down — stop here, keep the rest queued in order
        }
        console.error("Write queue: dropping an entry that can't be synced (not a connectivity issue):", entry, error);
      }
      queue = queue.slice(1);
      saveWriteQueue(queue);
    }
  } finally {
    writeQueueDraining = false;
  }
}

/** Small persistent pill, bottom-left so it never collides with the FAB
 *  stack (bottom-right) or the drawer handle (left edge, vertical
 *  middle) — only exists in the DOM while something is actually pending. */
function renderWriteQueueBadge(count) {
  let el = document.getElementById("write-queue-badge");
  if (count <= 0) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "write-queue-badge";
    document.body.appendChild(el);
  }
  el.textContent = count === 1 ? "Syncing 1 change…" : `Syncing ${count} changes…`;
  refreshStatusLights();
}

window.addEventListener("online", () => scheduleWriteQueueDrain(500));
setInterval(() => scheduleWriteQueueDrain(0), 60000);
renderWriteQueueBadge(loadWriteQueue().length);
scheduleWriteQueueDrain(2000);
