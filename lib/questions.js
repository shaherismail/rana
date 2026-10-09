/**
 * Question bank helpers shared by the game and the admin panel.
 */

import { loadLocal, saveLocal, queueForSync } from './offline.js';

/** Generate a UUIDv4 (works in all modern browsers and Vercel). */
export function makeId() {
  return crypto.randomUUID();
}

/**
 * Persist a brand-new question: local first (instant), cloud queued.
 * @param {object} q  { grade, unit, difficulty, question, option_a..d, correct_option, explanation, image_url, audio_text }
 * @returns the saved question (with id + created_at)
 */
export function addQuestion(q) {
  const question = {
    id: makeId(),
    grade: q.grade,
    unit: q.unit,
    difficulty: Number(q.difficulty) || 1,
    question: q.question,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct_option: ['A', 'B', 'C', 'D'].includes(q.correct_option) ? q.correct_option : 'A',
    explanation: q.explanation || '',
    image_url: q.image_url || '',
    audio_text: q.audio_text || '',
    created_at: new Date().toISOString(),
  };
  const all = loadLocal();
  all.push(question);
  saveLocal(all);
  queueForSync({ type: 'insert', question });
  return question;
}

/** Persist a batch of new questions (from Excel import / AI generation). */
export function addQuestions(list) {
  const rows = list.map((q) => ({
    id: makeId(),
    grade: q.grade,
    unit: q.unit,
    difficulty: Number(q.difficulty) || 1,
    question: q.question,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct_option: ['A', 'B', 'C', 'D'].includes(q.correct_option) ? q.correct_option : 'A',
    explanation: q.explanation || '',
    image_url: q.image_url || '',
    audio_text: q.audio_text || '',
    created_at: new Date().toISOString(),
  }));
  const all = loadLocal();
  all.push(...rows);
  saveLocal(all);
  queueForSync({ type: 'insert', questions: rows });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Filtering & grouping                                                */
/* ------------------------------------------------------------------ */

/** Return questions for one grade+unit, ordered by difficulty (easiest first). */
export function getLesson(grade, unit) {
  return loadLocal()
    .filter((q) => String(q.grade) === String(grade) && String(q.unit) === String(unit))
    .sort((a, b) => Number(a.difficulty) - Number(b.difficulty));
}

/** Distinct grades present in the bank, sorted naturally. */
export function listGrades() {
  const set = new Set(loadLocal().map((q) => String(q.grade)));
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Distinct units for one grade. */
export function listUnits(grade) {
  const set = new Set(
    loadLocal().filter((q) => String(q.grade) === String(grade)).map((q) => String(q.unit))
  );
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

/** Update a question in place (local first, cloud queued). */
export function updateQuestion(id, patch) {
  const all = loadLocal();
  const idx = all.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch };
  saveLocal(all);
  queueForSync({ type: 'update', id, patch });
  return all[idx];
}

/** Delete a question (local first, cloud queued). */
export function deleteQuestion(id) {
  const all = loadLocal();
  const next = all.filter((q) => q.id !== id);
  saveLocal(next);
  queueForSync({ type: 'delete', id });
  return next;
}

/**
 * Record a wrong answer for the classroom error analytics dashboard.
 * Stored locally; a separate table in Supabase is optional (see schema.sql).
 */
export function recordError(questionId, grade, unit, pickedOption) {
  try {
    const raw = localStorage.getItem('mc_error_log_v1');
    const log = raw ? JSON.parse(raw) : [];
    log.push({
      id: makeId(),
      question_id: questionId,
      grade,
      unit,
      picked_option: pickedOption,
      at: new Date().toISOString(),
    });
    // Keep the log bounded (last 500 answers).
    localStorage.setItem('mc_error_log_v1', JSON.stringify(log.slice(-500)));
  } catch (err) {
    console.warn('[analytics] could not record error:', err.message);
  }
}

/** Return wrong-answer counts grouped by question id. */
export function getErrorStats() {
  try {
    const raw = localStorage.getItem('mc_error_log_v1');
    if (!raw) return [];
    const log = JSON.parse(raw);
    const byId = new Map();
    for (const entry of log) {
      const key = entry.question_id;
      if (!byId.has(key)) byId.set(key, { question_id: key, count: 0, ...entry });
      byId.get(key).count++;
    }
    return [...byId.values()].sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}

