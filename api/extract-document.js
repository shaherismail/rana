/**
 * API: POST /api/extract-document
 *
 * Extracts plain text from an uploaded document so the AI question generator
 * can build a quiz from the actual content. Runs server-side because real
 * PDFs use Type0/CMap encodings that a browser-only parser cannot read.
 *
 * Body: multipart/form-data with field "file"  (or JSON { base64, name })
 * Header: x-admin-password
 * Returns: { text, name, pages? }
 *
 * Supported: PDF, DOCX, DOC, RTF, TXT/MD/CSV, and any text file.
 */

import { Buffer } from 'node:buffer';

// pdf.js calls `new DOMMatrix(...)` unconditionally. Browsers have it; Vercel's
// Node runtime does not, which throws "DOMMatrix is not defined".
import { installDomShims } from '../lib/dom-shim.js';

installDomShims();

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB upload cap

/* pdf-parse is loaded lazily: if the serverless bundler fails to include it,
 * the API still loads and returns a readable error instead of a module crash. */
let _PDFParse = null;
async function getPdfParser() {
  if (_PDFParse) return _PDFParse;
  let mod;
  try {
    mod = await import('pdf-parse');
  } catch (e) {
    const err = new Error('تعذّر تحميل محرك قراءة PDF على الخادم');
    err.__cause = e.message;
    err.__stage = 'import(pdf-parse)';
    throw err;
  }
  const Ctor = mod.PDFParse || mod.default?.PDFParse || mod.default;
  if (typeof Ctor !== 'function') {
    const err = new Error('محرك PDF غير متوفر (تصدير غير معروف)');
    err.__stage = 'import(pdf-parse)';
    throw err;
  }
  _PDFParse = Ctor;
  return Ctor;
}

/**
 * Extract the uploaded file from the request body.
 *
 * Vercel parses multipart/form-data automatically (req.body is an object,
 * req.body.file.data is the Buffer). Other runtimes (local node) leave a raw
 * multipart stream, so we fall back to parsing that ourselves.
 */
async function readFileUpload(req) {
  // 1) Vercel has already parsed the body into an object.
  const body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const f = body.file;
    if (f) {
      const buf = Buffer.isBuffer(f) ? f : Buffer.from(f.data || f);
      if (buf.length) return { buf, name: f.name || 'upload' };
    }
    if (body.base64) return { buf: Buffer.from(body.base64, 'base64'), name: body.name || 'upload.txt' };
  }

  // 2) Raw multipart stream (local node / other runtimes).
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.startsWith('multipart/form-data')) {
    const err = new Error('upload a file or send base64');
    err.__stage = 'body';
    throw err;
  }

  const boundary = (contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/) || [])[1]
    || (contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/) || [])[2];
  if (!boundary) {
    const err = new Error('missing multipart boundary');
    err.__stage = 'boundary';
    throw err;
  }

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BYTES) { req.destroy(); reject(new Error('الملف كبير جدًا (الحد 15 ميجابايت)')); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const section = splitMultipart(raw, boundary)
    .map(parseSection)
    .find((s) => s && s.fieldName === 'file' && s.fileName);
  if (!section) {
    const err = new Error('no "file" field in upload');
    err.__stage = 'multipart';
    throw err;
  }
  return { buf: section.body, name: section.fileName };
}

/** Naive multipart/form-data split — avoids a body-parser dependency. */
function splitMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;
  while (true) {
    const i = buf.indexOf(delim, start);
    if (i === -1) break;
    if (parts.length) parts[parts.length - 1].push(buf.slice(start, i));
    parts.push([]);
    start = i + delim.length + 2; // skip \r\n
  }
  if (parts.length) parts[parts.length - 1].push(buf.slice(start));
  return parts.map((p) => Buffer.concat(p)).filter((p) => p.length > 4);
}

/** Read the filename and payload out of one multipart section. */
function parseSection(buf) {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) return null;
  const head = buf.slice(0, headEnd).toString('utf-8');
  const body = buf.slice(headEnd + 4);
  const nameMatch = head.match(/name="([^"]*)"/);
  const fileMatch = head.match(/filename="([^"]*)"/);
  return {
    fieldName: nameMatch ? nameMatch[1] : '',
    fileName: fileMatch ? fileMatch[1] : '',
    body,
  };
}

async function extractPdf(buf) {
  // pdf.js requires Uint8Array, not a Node Buffer.
  const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const PDFParse = await getPdfParser();
  const parser = new PDFParse(data);
  const out = await parser.getText();
  const text = typeof out === 'string' ? out : (out?.text || '');
  return { text: text || '', pages: undefined };
}

function extractDocx(buf) {
  // Word files are zips; word/document.xml holds the paragraph text.
  const AdmZip = tryRequire('adm-zip');
  if (!AdmZip) throw new Error('DOCX parsing غير متاح على الخادم');
  const zip = new AdmZip(buf);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('word/document.xml غير موجود داخل ملف Word');
  const xml = entry.getData().toString('utf-8');
  const parts = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
  const text = parts.map((p) => p[1]).join(' ');
  return { text: text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'") };
}

function extractRtf(buf) {
  let out = buf.toString('utf-8');
  out = out.replace(/\\'[0-9a-fA-F]{2}/g, '');
  out = out.replace(/\\[a-zA-Z]+-?\d*\s?/g, '');
  out = out.replace(/[{}]/g, '');
  out = out.replace(/\\\\/g, '\\').replace(/\\n|\\~/g, '\n');
  return { text: out.replace(/\n{3,}/g, '\n\n').trim() };
}

function extractDoc(buf) {
  const u8 = new Uint8Array(buf);
  let out = '';
  let run = '';
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) run += String.fromCharCode(b);
    else { if (run.length >= 4) out += run + '\n'; run = ''; }
  }
  if (run.length >= 4) out += run;
  return { text: out.replace(/\n{3,}/g, '\n\n').trim() };
}

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword && req.headers['x-admin-password'] !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized: admin password required' });
  }

  try {
    let { buf, name } = await readFileUpload(req);

    if (!buf || !buf.length) {
      return res.status(400).json({ error: 'الملف فارغ' });
    }

    const lower = (name || '').toLowerCase();
    let result;
    if (lower.endsWith('.pdf')) {
      result = await extractPdf(buf);
    } else if (lower.endsWith('.docx')) {
      result = extractDocx(buf);
    } else if (lower.endsWith('.doc')) {
      result = extractDoc(buf);
    } else if (lower.endsWith('.rtf')) {
      result = extractRtf(buf);
    } else {
      result = { text: buf.toString('utf-8') };
    }

    const text = (result.text || '').replace(/\x00/g, '').trim();
    if (text.length < 20) {
      return res.status(422).json({
        error: 'لم أجد نصًا قابلًا للقراءة في الملف (قد يكون صورًا مسحوبة ضوئيًا).',
      });
    }

    return res.status(200).json({
      text: text.slice(0, 30000),
      name,
      pages: result.pages,
      chars: text.length,
    });
  } catch (err) {
    const detail = err.__stage ? ` (${err.__stage}: ${err.__cause || err.message})` : '';
    console.error('[extract-document] error:', err.__stage || 'runtime', err.message);
    return res.status(500).json({
      error: (err.message || 'فشلت قراءة الملف') + detail,
    });
  }
}
