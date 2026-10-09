/**
 * DOM integration harness — runs index.html's actual game script against a
 * hand-rolled DOM stub (no browser needed) and simulates a full lesson:
 *   seed questions → setup screen → start game → correct answer → next →
 *   wrong answer → explanation → ... → end screen.
 *
 * This exercises the real UI wiring (event handlers, render functions),
 * not just the pure lib logic covered by test.mjs.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.cwd();

/* ---------------- minimal DOM ---------------- */

function makeNode(tag, attrs = {}) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    id: attrs.id || '',
    className: attrs.class || '',
    attributes: {},
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    checked: false,
    src: '',
    listeners: {},
    _innerNodes: [],
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') continue;
    if (k === 'id') continue;
    if (k.startsWith('data-')) { node.dataset[k.slice(5)] = v; continue; }
    node.attributes[k] = v;
  }
  const classSet = () => new Set(node.className.split(/\s+/).filter(Boolean));
  node.classList = {
    add: (...c) => { const s = classSet(); c.forEach((x) => s.add(x)); node.className = [...s].join(' '); },
    remove: (...c) => { const s = classSet(); c.forEach((x) => s.delete(x)); node.className = [...s].join(' '); },
    toggle: (c, force) => {
      const s = classSet();
      const on = force !== undefined ? force : !s.has(c);
      on ? s.add(c) : s.delete(c);
      node.className = [...s].join(' ');
    },
    contains: (c) => classSet().has(c),
  };
  node.appendChild = (child) => { child.parentNode = node; node.children.push(child); return child; };
  node.addEventListener = (type, fn) => { (node.listeners[type] ||= []).push(fn); };
  node.removeEventListener = (type, fn) => { node.listeners[type] = (node.listeners[type] || []).filter((f) => f !== fn); };
  node.dispatchEvent = (ev) => { (node.listeners[ev.type] || []).forEach((fn) => fn(ev)); };
  node.click = () => {
    // Real browsers fire both the onclick property handler and listeners.
    if (typeof node.onclick === 'function') { node.onclick({ type: 'click', target: node }); }
    node.dispatchEvent({ type: 'click', target: node });
  };
  node.append = (...kids) => kids.forEach((k) => node.appendChild(k));
  // Canvas: stubbed 2d context so confettiBurst works headless.
  // (The harness auto-creates nodes as DIVs, so expose getContext on all.)
  const ctx2d = {
    clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
    fillStyle: '', fillRect() {}, strokeRect() {},
  };
  node.getContext = () => ctx2d;
  if (String(node.tagName).toLowerCase() === 'canvas') {
    node.width = 1280;
    node.height = 800;
  }
  node.remove = () => {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
  };
  // Real innerHTML: parse into children so querySelector works on the result.
  Object.defineProperty(node, 'innerHTML', {
    configurable: true,
    get() { return node._html || ''; },
    set(html) {
      node._html = String(html);
      node.children = [];
      node.textContent = '';
      const parsed = parseFragment(String(html), node);
      // collect visible text for textContent checks
      const texts = [];
      const walk = (n) => {
        if (n.nodeType === 1) { (n.children || []).forEach(walk); }
        else if (n.textContent) texts.push(n.textContent);
        if (n.nodeType === 1 && n.textContent) texts.push(n.textContent);
      };
      parsed.forEach(walk);
      node.textContent = texts.join(' ');
    },
  });
  node.querySelectorAll = (sel) => querySelectorAllIn(node, sel);
  node.querySelector = (sel) => querySelectorAllIn(node, sel)[0] || null;
  // Real innerHTML: parse into children so querySelector works on the result.
  Object.defineProperty(node, 'innerHTML', {
    configurable: true,
    get() { return node._html || ''; },
    set(html) {
      node._html = String(html);
      node.textContent = '';
      // Replace children wholesale (like a real browser).
      node.children = [];
      parseFragment(String(html), node);
      // Collect visible text for textContent checks (descendants first).
      const texts = [];
      const walk = (n) => {
        if (n.nodeType !== 1) return;
        (n.children || []).forEach(walk);
        if (n.textContent) texts.push(n.textContent);
      };
      node.children.forEach(walk);
      node.textContent = texts.join(' ');
    },
  });
  node.closest = (sel) => {
    let cur = node;
    while (cur) { if (matchesSimple(cur, sel)) return cur; cur = cur.parentNode; }
    return null;
  };
  node.setAttribute = (k, v) => { node.attributes[k] = v; };
  node.getAttribute = (k) => node.attributes[k] ?? null;
  Object.defineProperty(node, 'offsetWidth', { get: () => 100 });
  return node;
}

const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link']);

/** Parse a fragment of HTML into child nodes (nested supported). */
function parseFragment(html, parentRef) {
  const stack = [parentRef];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  // Start from existing children so previously parsed nodes survive
  // (the stub's node.children array IS the live child list).
  if (parentRef) stack[0] = parentRef;
  let m;
  while ((m = re.exec(html))) {
    const [full, tag, attrText, text] = m;
    if (text !== undefined) {
      const cur = stack[stack.length - 1];
      if (text.trim()) cur.textContent += text.trim();
      continue;
    }
    const closing = full.startsWith('</');
    if (closing) {
      const idx = stack.findIndex((n) => n.tagName === tag.toUpperCase());
      if (idx > 0) stack.length = idx;
      continue;
    }
    const attrs = parseAttrs(attrText || '');
    const node = makeNode(tag, attrs);
    const parent = stack[stack.length - 1];
    if (parent) parent.appendChild(node);
    if (!VOID.has(tag.toLowerCase())) stack.push(node);
  }
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|)/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1]] = m[2] ?? m[3] ?? '';
  return attrs;
}

function matchesSimple(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  // simple selector: tag, .cls, #id, [attr], [attr="val"], or a chain of these
  const parts = selector.match(/[.#]?[a-zA-Z_-][\w-]*|\[[^\]]+\]/g) || [];
  for (const part of parts) {
    if (part.startsWith('.')) { if (!node.classList.contains(part.slice(1))) return false; }
    else if (part.startsWith('#')) { if (node.id !== part.slice(1)) return false; }
    else if (part.startsWith('[')) {
      const mm = part.match(/\[([\w-]+)(?:="([^"]*)")?\]/);
      const name = mm[1];
      const val = mm[2];
      if (name === 'data-letter' || name.startsWith('data-')) {
        const key = name.slice(5);
        if (val !== undefined && String(node.dataset[key]) !== val) return false;
        if (val === undefined && !(key in node.dataset)) return false;
      } else {
        if (val !== undefined && node.attributes[name] !== val) return false;
        if (val === undefined && !(name in node.attributes)) return false;
      }
    } else if (node.tagName !== part.toUpperCase()) return false;
  }
  return true;
}

function querySelectorAllIn(root, selector) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType !== 1) return;
    // support comma-separated + descendant combinator
    for (const branch of selector.split(',')) {
      const chain = branch.trim().split(/\s+/);
      if (chain.length === 1) {
        if (matchesSimple(n, chain[0])) out.push(n);
      } else if (matchesSimple(n, chain[chain.length - 1])) {
        // check ancestors against the earlier part of the chain
        let cur = n.parentNode, ok = true, ci = chain.length - 2;
        while (ci >= 0) {
          while (cur && !matchesSimple(cur, chain[ci])) cur = cur.parentNode;
          if (!cur) { ok = false; break; }
          ci--; cur = cur.parentNode;
        }
        if (ok) out.push(n);
      }
    }
    (n.children || []).forEach(walk);
  };
  walk(root);
  return out;
}

/* ---------------- document + window stubs ---------------- */

const nodesById = new Map();

const documentStub = {
  getElementById: (id) => {
    if (nodesById.has(id)) return nodesById.get(id);
    const n = makeNode('div', { id });
    nodesById.set(id, n);
    // Attach to the root tree so document.querySelectorAll can find it.
    documentRoot.appendChild(n);
    return n;
  },
  createElement: (tag) => makeNode(tag),
  querySelectorAll: (sel) => querySelectorAllIn(documentRoot, sel),
  querySelector: (sel) => querySelectorAllIn(documentRoot, sel)[0] || null,
  addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
  body: makeNode('body'),
};
const documentRoot = makeNode('div');
const docListeners = {};

function keydown(key) {
  const ev = { key, bubbles: true };
  (docListeners.keydown || []).forEach((fn) => fn(ev));
}

const windowStub = {
  localStorage: null, // set below
  speechSynthesis: { cancel() {}, speak() {} },
  SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  AudioContext: class {
    createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    get currentTime() { return 0; }
    get destination() { return {}; }
  },
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1280,
  innerHeight: 800,
  requestAnimationFrame: () => 0,
};

/* ---------------- run the game script ---------------- */

let failures = 0;
function check(name, cond) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ FAIL: ' + name); failures++; }
}

// Seed localStorage with 15 questions BEFORE the game script boots.
const store = new Map();
windowStub.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let idc = 0;
Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID: () => 'qid-' + (++idc) },
  configurable: true,
});

// Load the questions lib in the same "browser-ish" global context.
globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.localStorage = windowStub.localStorage; // bare `localStorage` reference
// navigator is read-only in Node 22 — stub it too.
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
});
globalThis.fetch = async () => { throw new Error('no network in test'); };
// Bare `innerWidth`/`innerHeight` are used by confettiBurst at top level.
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
// Confetti animation loop runs headless as a no-op.
globalThis.requestAnimationFrame = () => {};
globalThis.SpeechSynthesisUtterance = windowStub.SpeechSynthesisUtterance;

const { addQuestions, getLesson } = await import(pathToFileURL(path.join(ROOT, 'lib/questions.js')).href);
addQuestions(Array.from({ length: 15 }, (_, i) => ({
  grade: 'Grade 4', unit: 'Unit 1: Animals', difficulty: i + 1,
  question: `Question ${i + 1}: choose the animal`,
  option_a: 'cat', option_b: 'dog', option_c: 'bird', option_d: 'fish',
  correct_option: 'ABCD'[i % 4],
  explanation: `Explanation for ${i + 1}`,
})));
check('seeded 15 questions into local store', JSON.parse(store.get('mc_questions_v1')).length === 15);

// Extract and adapt index.html's module script for Node.
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
let code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
code = code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
code = code.replace(/from '\.\/lib\/([^']+)'/g, (m, f) => `from '${pathToFileURL(path.join(ROOT, 'lib', f)).href}'`);

const dataUrl = 'data:text/javascript;base64,' + Buffer.from(
  'globalThis.__VITE_ENV__ = {};\n' + code
).toString('base64');
await import(dataUrl);

// Allow the async boot to run.
await new Promise((r) => setTimeout(r, 50));

check('setup screen populated with Grade 4', documentStub.getElementById('gradeSel').textContent.includes('Grade 4'));

// Choose grade + unit as the teacher would.
const gradeSel = documentStub.getElementById('gradeSel');
gradeSel.value = 'Grade 4';
gradeSel.dispatchEvent({ type: 'change', target: gradeSel });
await new Promise((r) => setTimeout(r, 10));
check('units populated after picking grade', documentStub.getElementById('unitSel').textContent.includes('Unit 1'));
const unitSel = documentStub.getElementById('unitSel');
unitSel.value = 'Unit 1: Animals';
unitSel.dispatchEvent({ type: 'change', target: unitSel });
await new Promise((r) => setTimeout(r, 10));
check('start button enabled after picking lesson', documentStub.getElementById('startBtn').disabled === false);

// Start the game.
documentStub.getElementById('startBtn').click();
await new Promise((r) => setTimeout(r, 10));
check('game screen visible', documentStub.getElementById('game').classList.contains('on'));
check('question text rendered', documentStub.getElementById('questionCard').textContent.includes('Question 1'));
check('4 option buttons rendered', documentStub.querySelectorAll('.option-btn').length === 4);
check('prize ladder has 15 steps', documentStub.getElementById('ladder').querySelectorAll('.step').length === 15);
check('ladder highlights current step (level 1)', documentStub.getElementById('ladder').querySelectorAll('.step.current').length === 1);

// Answer correctly via keyboard (Clicker Mode): the correct letter for Q1 is A.
keydown('a');
await new Promise((r) => setTimeout(r, 10));
check('A locked in (locked class)', documentStub.querySelectorAll('.option-btn.locked').length === 1);
await new Promise((r) => setTimeout(r, 600));
check('correct answer turns green', documentStub.querySelectorAll('.option-btn.correct').length >= 1);
await new Promise((r) => setTimeout(r, 800));
check('explanation overlay opens', documentStub.getElementById('explainOverlay').classList.contains('on'));
check('explanation text shown', documentStub.getElementById('explainText').textContent.includes('Explanation for 1'));

// Advance.
keydown('Enter');
await new Promise((r) => setTimeout(r, 20));
check('advanced to question 2', documentStub.getElementById('questionCard').textContent.includes('Question 2'));
check('explanation overlay closed', !documentStub.getElementById('explainOverlay').classList.contains('on'));

// 50:50 lifeline via keyboard "1".
keydown('1');
await new Promise((r) => setTimeout(r, 10));
check('50:50 eliminated 2 options', documentStub.querySelectorAll('.option-btn.eliminated').length === 2);
check('50:50 button marked used', documentStub.getElementById('fiftyBtn').classList.contains('used'));

// Speak via keyboard "s" (should not throw).
keydown('s');
await new Promise((r) => setTimeout(r, 10));
check('speak button still functional', typeof nodesById.get('speakBtn').onclick === 'function');

// Correct letter for Q2 (used to pick a deliberately wrong answer).
const gameQ = getLesson('Grade 4', 'Unit 1: Animals')[1];

// Answer Q2 WRONG on purpose: pick the first option that is NOT eliminated
// and NOT the correct one (50:50 may have removed some letters).
const liveBtns = () => [...documentStub.querySelectorAll('.option-btn')];
let wrongLetter = null;
for (const b of liveBtns()) {
  const L = b.dataset.letter;
  if (!b.disabled && L !== gameQ.correct_option) { wrongLetter = L; break; }
}
if (!wrongLetter) {
  // 50:50 left only correct + one other; use the other.
  wrongLetter = liveBtns().find((b) => !b.disabled && b.dataset.letter !== gameQ.correct_option)?.dataset.letter;
}
console.log('DEBUG: answering wrong with letter', wrongLetter);
keydown(wrongLetter.toLowerCase());
await new Promise((r) => setTimeout(r, 700));
check('wrong answer marks the picked option', documentStub.querySelectorAll('.option-btn.wrong').length >= 1);
await new Promise((r) => setTimeout(r, 800));
check('explanation shown after wrong answer', documentStub.getElementById('explainOverlay').classList.contains('on'));
keydown('Enter');
await new Promise((r) => setTimeout(r, 20));

// Quit to the end screen via the topbar button.
documentStub.getElementById('quitBtn').click();
await new Promise((r) => setTimeout(r, 30));
check('end screen visible', documentStub.getElementById('endScreen').style.display !== 'none' || nodesById.get('endScreen').classList.contains('on'));
check('game screen hidden after end', !documentStub.getElementById('game').classList.contains('on'));

// Play again returns to setup.
documentStub.getElementById('againBtn').click();
await new Promise((r) => setTimeout(r, 20));
check('setup screen shown again', documentStub.getElementById('setup').style.display !== 'none');

console.log('\n' + (failures === 0 ? '🎉 DOM SIMULATION: ALL PASSED' : `⚠️  DOM SIMULATION: ${failures} FAILED`));
process.exit(failures === 0 ? 0 : 1);
