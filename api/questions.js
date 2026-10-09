/**
 * API: /api/questions
 *
 * The ONLY write path to the database. The browser (admin panel) holds the
 * anon key, which Row Level Security blocks for writes — that is deliberate,
 * so that anyone holding the public URL cannot add/edit/delete questions.
 *
 * All writes come here instead, carrying the teacher's admin password in the
 * `x-admin-password` header. This function uses the service-role key, which
 * never reaches the browser.
 *
 *   POST   /api/questions            { rows: [...] }                      -> insert
 *   PATCH  /api/questions?id=<uuid>  { patch: {...} }                     -> update one
 *   DELETE /api/questions?id=<uuid>                                       -> delete one
 *   POST   /api/questions/errors     { rows: [...] }                      -> log errors
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function unauthorized(res) {
  return res.status(401).json({ error: 'Unauthorized: admin password required' });
}

function notConfigured(res) {
  return res.status(500).json({ error: 'Supabase service role is not configured on the server' });
}

/** Forward a write to the PostgREST API with the service-role key. */
async function rest(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON reply */ }
  return { ok: res.ok, status: res.status, body: json, text };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return notConfigured(res);
  if (ADMIN_PASSWORD && req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return unauthorized(res);
  }

  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');

  try {
    // ---- Error logging (answer_errors) -------------------------------
    if (url.pathname.endsWith('/errors')) {
      const rows = req.body?.rows || [];
      if (!rows.length) return res.status(400).json({ error: 'rows required' });
      const out = await rest('answer_errors', { method: 'POST', body: rows });
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      return res.status(201).json({ inserted: Array.isArray(out.body) ? out.body.length : 0 });
    }

    // ---- Insert many --------------------------------------------------
    if (req.method === 'POST') {
      const rows = req.body?.rows || [];
      if (!rows.length) return res.status(400).json({ error: 'rows required' });
      const out = await rest('questions', { method: 'POST', body: rows });
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      return res.status(201).json({ inserted: Array.isArray(out.body) ? out.body.length : 0 });
    }

    // ---- Update one ---------------------------------------------------
    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'id query param required' });
      const patch = req.body?.patch || req.body || {};
      const out = await rest(`questions?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      return res.status(200).json({ updated: Array.isArray(out.body) ? out.body.length : 0 });
    }

    // ---- Delete one ---------------------------------------------------
    if (!id) return res.status(400).json({ error: 'id query param required' });
    const out = await rest(`questions?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!out.ok) return res.status(out.status).json({ error: out.text });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    console.error('[questions] error:', err);
    return res.status(500).json({ error: err.message || 'Write failed' });
  }
}
