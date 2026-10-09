/**
 * Shared backend logic for the Supabase connection.
 * Both index.html (game) and admin.html (teacher panel) use this.
 *
 * Environment variables are configured in Vercel:
 *   VITE_SUPABASE_URL      -> Supabase Project URL
 *   VITE_SUPABASE_ANON_KEY -> Supabase anon public key
 *
 * IMPORTANT: The anon key is a "public" key by design — it is safe to expose
 * in the browser. Row Level Security (RLS) in Supabase is what actually
 * protects the data. See supabase/schema.sql.
 */

export const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = () =>
  Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Small fetch-based Supabase REST client (no heavy SDK on the smartboard). */
export const supabase = {
  /**
   * SELECT rows from a table.
   * @param {string} table
   * @param {{ select?: string, eq?: [string, any][], order?: { column: string, ascending: boolean } }} opts
   */
  async from(table, { select = '*', eq = [], order } = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
    for (const [column, value] of eq) {
      url += `&${column}=eq.${encodeURIComponent(String(value))}`;
    }
    if (order) {
      url += `&order=${order.column}.${order.ascending ? 'asc' : 'desc'}`;
    }
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase ${table} failed (${res.status}): ${body}`);
    }
    return res.json();
  },

  /** INSERT rows into a table. */
  async insert(table, rows) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase insert to ${table} failed (${res.status}): ${body}`);
    }
    return res.json();
  },

  /** UPDATE a single row by id. */
  async update(table, id, patch) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase update ${table} failed (${res.status}): ${body}`);
    }
    return res.json();
  },

  /** DELETE a single row by id. */
  async delete(table, id) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase delete ${table} failed (${res.status}): ${body}`);
    }
    return true;
  },
};
