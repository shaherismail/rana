/**
 * API: POST /api/generate-questions
 * AI Question Generator with automatic provider fallback.
 *
 * Two modes:
 *   1. Topic mode:  { grade, unit, count? }
 *   2. Content mode: { grade, content } — text extracted from an uploaded file.
 *      The AI must cover ALL of the content and invent a unit name from it.
 *
 * Body: { grade, unit?, content?, count? }
 * Returns: { questions: [...], provider, unit }
 *
 * Providers are tried in order until one succeeds:
 *   1. Gemini      (GEMINI_API_KEY)   — best quality, free tier
 *   2. NVIDIA NIM  (NVIDIA_API_KEY)   — OpenAI-compatible
 *   3. Atria       (ATRIA_API_KEY)    — last resort
 *
 * All keys live in Vercel env vars and never reach the browser.
 * Protected by the admin password (x-admin-password header).
 */

const VALID_OPTIONS = ['A', 'B', 'C', 'D'];

/** Strict JSON-only instruction for topic mode. */
function buildTopicPrompt(grade, unit, count) {
  return `
You are an English-language curriculum designer for young learners (Egyptian primary/middle school).
Generate exactly ${count} multiple-choice English questions for:
- Grade: "${grade}"
- Lesson/Unit: "${unit}"

Rules:
1. Questions must progress in difficulty from 1 (easiest) to ${count} (hardest).
2. Exactly 4 options per question (A, B, C, D). Only ONE correct answer.
3. Every question has a short, simple English explanation of why the correct answer is right (kid-friendly, 1-2 sentences).
4. Vocabulary and grammar must suit the grade level. Use clear, everyday words.
5. Mix question types: vocabulary, grammar, spelling, and (where the unit allows) simple listening-style prompts (put the spoken sentence in "audio_text").
6. "audio_text" = the English sentence to be spoken aloud by text-to-speech. Leave "" if not needed.

Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{
  "unit": "Unit 1: Animals",
  "questions": [
    {
      "difficulty": 1,
      "question": "Choose the correct word: The ___ is barking.",
      "option_a": "cat",
      "option_b": "dog",
      "option_c": "bird",
      "option_d": "fish",
      "correct_option": "B",
      "explanation": "Dogs bark. 'The dog is barking.' is correct.",
      "audio_text": ""
    }
  ]
}
`.trim();
}

/** Strict JSON-only instruction for uploaded-content mode. */
function buildContentPrompt(grade, content, hint) {
  return `
You are an English-language curriculum designer for young learners (Egyptian primary/middle school).
A teacher uploaded the document below for grade "${grade}". Study it carefully, then build a
multiple-choice quiz that COVERS THE WHOLE DOCUMENT — every section, vocabulary list, and grammar point must appear.

Document content:
"""
${content}
"""

Rules:
1. Decide the number of questions yourself based on the document's size and breadth: enough to cover ALL of the content. Use at least 10 for a short document and up to 30 for a long one.
2. Number every question "difficulty" from 1 (easiest) to N (hardest), in order.
3. Exactly 4 options per question (A, B, C, D). Only ONE correct answer.
4. Every question has a short, simple English explanation of why the correct answer is right (kid-friendly, 1-2 sentences).
5. Vocabulary and grammar must suit the stated grade level.
6. Mix question types: vocabulary, grammar, spelling, and (where the content allows) simple listening-style prompts (put the spoken sentence in "audio_text").
7. Invent a short, descriptive English unit/lesson title for this document (2-5 words, e.g. "Unit 3: My Family"). If the teacher gave a hint, use it. Put it in "unit".

Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{
  "unit": "Unit 3: My Family",
  "questions": [
    {
      "difficulty": 1,
      "question": "Choose the correct word: The ___ is barking.",
      "option_a": "cat",
      "option_b": "dog",
      "option_c": "bird",
      "option_d": "fish",
      "correct_option": "B",
      "explanation": "Dogs bark. 'The dog is barking.' is correct.",
      "audio_text": ""
    }
  ]
}
`.trim();
}

/** Pull the JSON object out of a model reply (it sometimes wraps in ```json). */
function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenceMatch ? fenceMatch[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Could not find JSON in AI response');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/** Shape one raw question object into our schema. */
function shapeQuestion(q, maxDifficulty) {
  return {
    difficulty: Math.min(Math.max(Number(q.difficulty) || 1, 1), Math.max(maxDifficulty, 1)),
    question: String(q.question || ''),
    option_a: String(q.option_a || ''),
    option_b: String(q.option_b || ''),
    option_c: String(q.option_c || ''),
    option_d: String(q.option_d || ''),
    correct_option: VALID_OPTIONS.includes(q.correct_option) ? q.correct_option : 'A',
    explanation: String(q.explanation || ''),
    audio_text: String(q.audio_text || ''),
  };
}

/* ------------------------------------------------------------------ */
/* Providers — each returns raw assistant text or throws.             */
/* ------------------------------------------------------------------ */

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = 'gemini-2.5-flash'; // 1.5/2.0 were retired by Google
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

async function callNvidia(prompt) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY not set');
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'meta/llama-3.2-90b-vision-instruct',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 8000,
    }),
  });
  if (!res.ok) throw new Error(`NVIDIA ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('NVIDIA returned an empty response');
  return text;
}

async function callAtria(prompt) {
  const key = process.env.ATRIA_API_KEY;
  if (!key) throw new Error('ATRIA_API_KEY not set');
  const res = await fetch('https://api.atria-asi.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'Atria-Dawn-Preview',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 8000,
    }),
  });
  if (!res.ok) throw new Error(`Atria ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  // Atria is a reasoning model: the answer may be in content or reasoning_content.
  const msg = data?.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content;
  if (!text) throw new Error('Atria returned an empty response');
  return text;
}

const PROVIDERS = [
  { name: 'Gemini', call: callGemini },
  { name: 'NVIDIA', call: callNvidia },
  { name: 'Atria', call: callAtria },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Admin password gate.
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const sent = req.headers['x-admin-password'];
    if (sent !== adminPassword) {
      return res.status(401).json({ error: 'Unauthorized: admin password required' });
    }
  }

  const { grade, unit, content } = req.body || {};
  if (!grade) {
    return res.status(400).json({ error: 'grade is required' });
  }

  // Content mode: the AI reads the uploaded document and names the lesson.
  const hasContent = typeof content === 'string' && content.trim().length >= 20;
  if (hasContent && !unit) {
    return runWithFallback(
      res,
      buildContentPrompt(grade, content.trim(), ''),
      (parsed) => {
        const unitName = String(parsed.unit || '').trim();
        return { unit: unitName };
      },
    );
  }

  // Topic mode: teacher gave (or we require) a unit name.
  if (!unit) {
    return res.status(400).json({ error: 'unit is required (or upload a document)' });
  }
  const count = Math.min(Math.max(Number(req.body?.count) || 15, 1), 30);
  return runWithFallback(res, buildTopicPrompt(grade, unit.trim(), count), () => ({}));
}

/**
 * Try each provider until one returns usable questions.
 * @param {Function} extra - pull extra fields (e.g. the auto unit name) from the parsed JSON.
 */
async function runWithFallback(res, prompt, extra) {
  const failures = [];
  for (const provider of PROVIDERS) {
    try {
      const text = await provider.call(prompt);
      const parsed = extractJson(text);
      const questions = (parsed.questions || []).map((q) =>
        shapeQuestion(q, questionsLength(parsed)),
      );
      if (!questions.length) {
        failures.push(`${provider.name}: returned no questions`);
        continue;
      }
      const meta = extra(parsed);
      return res.status(200).json({
        questions,
        provider: provider.name,
        unit: meta.unit || '',
      });
    } catch (err) {
      console.warn(`[generate-questions] ${provider.name} failed:`, err.message);
      failures.push(`${provider.name}: ${err.message}`);
      continue; // try the next provider
    }
  }
  return res.status(502).json({ error: 'All AI providers failed', details: failures });
}

function questionsLength(parsed) {
  return Array.isArray(parsed.questions) ? parsed.questions.length : 15;
}
