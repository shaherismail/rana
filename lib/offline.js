/**
 * Offline-first data layer.
 *
 * Strategy: localStorage is the single source of truth during a lesson.
 * On load we try to pull fresh data from Supabase and update the cache.
 * All writes go to localStorage immediately, then sync to Supabase in the
 * background. If the network is down, everything still works; a pending-sync
 * queue retries automatically when connectivity returns.
 */

import { supabase, isSupabaseConfigured } from './supabase.js';

const LS_KEY = 'mc_questions_v1';
const PENDING_KEY = 'mc_pending_sync_v1';

/* ------------------------------------------------------------------ */
/* localStorage helpers                                                */
/* ------------------------------------------------------------------ */

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveLocal(questions) {
  localStorage.setItem(LS_KEY, JSON.stringify(questions));
  // Notify any open tabs (game ↔ admin) that data changed.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mc:data-changed'));
  }
}

/* ------------------------------------------------------------------ */
/* Merge helpers: keep local-only questions that aren't in the cloud   */
/* ------------------------------------------------------------------ */

/**
 * Merge cloud rows into the local cache without clobbering questions that
 * exist only locally (created offline and not yet synced).
 */
function mergeIntoLocal(cloudRows) {
  const local = loadLocal();
  if (!cloudRows.length) return local;
  const cloudIds = new Set(cloudRows.map((q) => q.id));
  const localOnly = local.filter((q) => !cloudIds.has(q.id));
  const merged = [...cloudRows, ...localOnly];
  saveLocal(merged);
  return merged;
}

/* ------------------------------------------------------------------ */
/* Pending sync queue (for offline writes)                             */
/* ------------------------------------------------------------------ */

export function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function savePending(queue) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(queue));
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/**
 * Pull the full question bank from Supabase into the local cache.
 * Returns the merged list. Safe to call when unconfigured (no-op).
 */
export async function syncFromCloud() {
  if (!isSupabaseConfigured()) return loadLocal();
  try {
    const rows = await supabase.from('questions', {
      select: 'id,grade,unit,difficulty,question,option_a,option_b,option_c,option_d,correct_option,explanation,image_url,audio_text,created_at',
      order: { column: 'created_at', ascending: true },
    });
    return mergeIntoLocal(rows);
  } catch (err) {
    console.warn('[sync] pull failed, using local cache:', err.message);
    return loadLocal();
  }
}

/**
 * Push a batch of new questions to the cloud.
 *
 * The browser only holds the anon key, and Row Level Security blocks anon
 * writes on purpose (anyone with the public URL could otherwise edit the
 * bank). So writes go through the /api/questions serverless function, which
 * uses the service-role key.
 */
export async function pushToCloud(questions) {
  if (!isSupabaseConfigured() || !questions.length) return [];
  const rows = questions.map((q) => ({
    id: q.id,
    grade: q.grade,
    unit: q.unit,
    difficulty: q.difficulty,
    question: q.question,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct_option: q.correct_option,
    explanation: q.explanation || '',
    image_url: q.image_url || '',
    audio_text: q.audio_text || '',
    created_at: q.created_at || new Date().toISOString(),
  }));
  const adminPassword = typeof localStorage !== 'undefined'
    ? localStorage.getItem('mc_admin_password') || ''
    : '';
  const res = await fetch('/api/questions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(adminPassword ? { 'x-admin-password': adminPassword } : {}),
    },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Save to cloud failed (${res.status}): ${body}`);
  }
  return rows;
}

/** Add the change to the pending queue and try to flush it. */
export function queueForSync(op) {
  const queue = loadPending();
  queue.push({ ...op, queuedAt: Date.now() });
  savePending(queue);
  flushPending(); // fire and forget
}

/**
 * Flush the pending queue. Returns the number of successfully synced ops.
 * Runs automatically on connectivity events; safe to call manually.
 */
/** Send a single write (update/delete) through the serverless function. */
async function writeCloud(method, id, patch) {
  const adminPassword = typeof localStorage !== 'undefined'
    ? localStorage.getItem('mc_admin_password') || ''
    : '';
  const url = `/api/questions?id=${encodeURIComponent(String(id))}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(adminPassword ? { 'x-admin-password': adminPassword } : {}),
    },
    body: patch ? JSON.stringify({ patch }) : undefined,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloud ${method} failed (${res.status}): ${body}`);
  }
}

/** Log wrong answers to the analytics table (best effort, never throws). */
export async function logErrorsToCloud(rows) {
  if (!isSupabaseConfigured() || !rows.length) return;
  const adminPassword = typeof localStorage !== 'undefined'
    ? localStorage.getItem('mc_admin_password') || ''
    : '';
  try {
    await fetch('/api/questions/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminPassword ? { 'x-admin-password': adminPassword } : {}),
      },
      body: JSON.stringify({ rows }),
    });
  } catch (err) {
    console.warn('[sync] error logging failed:', err.message);
  }
}

export async function flushPending() {
  if (!isSupabaseConfigured()) return 0;
  let queue = loadPending();
  if (!queue.length) return 0;

  const stillPending = [];
  let synced = 0;
  for (const op of queue) {
    try {
      if (op.type === 'insert') {
        if (op.question) await pushToCloud([op.question]);
        if (op.questions) await pushToCloud(op.questions);
      } else if (op.type === 'update') {
        await writeCloud('PATCH', op.id, op.patch);
      } else if (op.type === 'delete') {
        await writeCloud('DELETE', op.id);
      }
      synced++;
    } catch (err) {
      console.warn('[sync] op failed, will retry:', err.message);
      stillPending.push(op);
    }
  }
  savePending(stillPending);
  if (synced > 0) console.log(`[sync] synced ${synced} change(s); ${stillPending.length} pending.`);
  return synced;
}

/* Listen for connectivity returning. */
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[sync] back online — flushing pending changes.');
    flushPending();
  });
}
