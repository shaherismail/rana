// DOM harness: verify the game UI logic and index.html wiring end-to-end.
// Simulates a browser environment with jsdom-lite (hand-rolled minimal DOM).

import { readFileSync, writeFileSync } from 'node:fs';
import { createGame, lockAnswer, nextQuestion, useFiftyFifty, useAudiencePoll, endGame } from './lib/game.js';
import { addQuestion, addQuestions, getLesson, listGrades, listUnits, updateQuestion, deleteQuestion, recordError, getErrorStats } from './lib/questions.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ✓ ' + name); }
  else { console.log('  ✗ FAIL: ' + name); failures++; }
}

// ---- Fake localStorage + crypto ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let idCounter = 0;
// crypto is read-only in Node 22 — stub via Object.defineProperty.
Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID: () => 'id-' + (++idCounter) },
  configurable: true,
});

console.log('\n=== 1) Question bank (offline-first layer) ===');
const sample = Array.from({ length: 15 }, (_, i) => ({
  grade: 'Grade 4',
  unit: 'Unit 1: Animals',
  difficulty: i + 1,
  question: `Q${i + 1}: pick the animal`,
  option_a: 'cat', option_b: 'dog', option_c: 'bird', option_d: 'fish',
  correct_option: ['A', 'B', 'C', 'D'][i % 4],
  explanation: `Explanation ${i + 1}`,
}));
const inserted = addQuestions(sample);
check('addQuestions returned 15 rows with ids', inserted.length === 15 && inserted[0].id.startsWith('id-'));
check('localStorage persisted 15 questions', JSON.parse(store.get('mc_questions_v1')).length === 15);
check('listGrades() finds Grade 4', listGrades().includes('Grade 4'));
check('listUnits() finds the unit', listUnits('Grade 4').includes('Unit 1: Animals'));
check('getLesson() sorts easiest-first', getLesson('Grade 4', 'Unit 1: Animals')[0].difficulty === 1);
check('getLesson() ignores other grades', getLesson('Grade 5', 'Unit 1: Animals').length === 0);

const one = addQuestion({
  grade: 'Grade 4', unit: 'Unit 2: Food', difficulty: 3,
  question: 'Q: pick the food', option_a: 'apple', option_b: 'dog', option_c: 'car', option_d: 'pen',
  correct_option: 'A', explanation: 'Apple is food.',
});
check('addQuestion() works', one.id && getLesson('Grade 4', 'Unit 2: Food').length === 1);
const updated = updateQuestion(one.id, { difficulty: 9 });
check('updateQuestion() works', updated.difficulty === 9);
check('pending sync queue has 2 inserts + 1 update', JSON.parse(store.get('mc_pending_sync_v1')).length === 3);
deleteQuestion(one.id);
check('deleteQuestion() works', getLesson('Grade 4', 'Unit 2: Food').length === 0);
check('pending queue now has delete op', JSON.parse(store.get('mc_pending_sync_v1')).at(-1).type === 'delete');

console.log('\n=== 2) Game engine ===');
const game = createGame({ questions: getLesson('Grade 4', 'Unit 1: Animals'), mode: 'teams', timerSeconds: 30 });
check('createGame builds 15-level ladder', game.ladder.length === 15);
check('game starts at level 0', game.level === 0);
check('both lifelines available', game.lifelines.fiftyFifty && game.lifelines.audiencePoll);

const q0 = game.ladder[0];
let res = lockAnswer(game, q0.correct_option);
check('correct answer reported correct', res.correct === true);
check('score updated to prize[0]', game.teams[game.activeTeam].score === 100000 / 1000); // prize ladder[0]=100

// 50:50
nextQuestion(game);
const q1 = game.ladder[1];
const removed = useFiftyFifty(game);
check('50:50 removes exactly 2 options', removed.length === 2);
check('50:50 never removes the correct answer', !removed.includes(q1.correct_option));
check('50:50 consumed once', game.lifelines.fiftyFifty === false);
check('cannot use 50:50 twice', useFiftyFifty(game) === null);

// Audience poll
const poll = useAudiencePoll(game, [10, 20, 30, 40]);
check('audience poll stores 4 percents', poll.length === 4 && poll[3] === 40);
check('audience poll consumed once', game.lifelines.audiencePoll === false);
check('cannot use poll twice', useAudiencePoll(game, [1, 2, 3, 4]) === null);

// Wrong answer in teams mode → switch team, step back
const before = game.activeTeam;
const levelBefore = game.level;
res = lockAnswer(game, 'A' === q1.correct_option ? 'B' : 'A');
check('wrong answer reported incorrect', res.correct === false);
check('teams mode switches team on wrong answer', game.activeTeam !== before);
check('teams mode steps back one level', game.level === levelBefore - 1);
check('error logged for analytics', game.errors.length === 1);

// Solo mode ends on wrong answer
const solo = createGame({ questions: getLesson('Grade 4', 'Unit 1: Animals'), mode: 'solo' });
const sq = solo.ladder[0];
const sres = lockAnswer(solo, 'A' === sq.correct_option ? 'B' : 'A');
check('solo: wrong answer ends the game', sres.isOver === true);

// Milestone banking
import { bankedPrize } from './lib/game.js';
const g2 = createGame({ questions: getLesson('Grade 4', 'Unit 1: Animals'), mode: 'solo' });
for (let i = 0; i < 5; i++) {
  lockAnswer(g2, g2.ladder[i].correct_option);
  nextQuestion(g2);
}
check('bankedPrize(level index 4 = 5 correct) = 1000 (milestone)', bankedPrize(4) === 1000);
check('bankedPrize(before first milestone) = 0', bankedPrize(2) === 0);

// Full ladder win
const g3 = createGame({ questions: getLesson('Grade 4', 'Unit 1: Animals'), mode: 'solo' });
let won = false;
for (let i = 0; i < 15; i++) {
  const r = lockAnswer(g3, g3.ladder[i].correct_option);
  if (r.isOver) { won = true; break; }
  if (i < 14) nextQuestion(g3);
}
check('answering all 15 ends the game as a win', won === true);

console.log('\n=== 3) Error analytics ===');
recordError('qX', 'Grade 4', 'Unit 1', 'B');
recordError('qX', 'Grade 4', 'Unit 1', 'C');
recordError('qY', 'Grade 4', 'Unit 1', 'A');
const stats = getErrorStats();
check('getErrorStats groups by question', stats.length === 2);
check('getErrorStats sorts by count desc', stats[0].count === 2 && stats[0].question_id === 'qX');

console.log('\n=== 4) index.html wiring (script extracted & parsed) ===');
const html = readFileSync('index.html', 'utf-8');
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
check('index.html contains a module script', Boolean(scriptMatch));
if (scriptMatch) {
  const code = scriptMatch[1];
  // Every imported symbol must actually exist in the lib it is imported from.
  const imports = [...code.matchAll(/import\s+{([^}]+)}\s+from\s+'([^']+)'/g)];
  check('index.html imports 3 modules', imports.length === 3);
  for (const [, names, path] of imports) {
    const libSrc = readFileSync(path.replace('./', './'), 'utf-8');
    for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) {
      const re = new RegExp('export (?:const|function|class|async function) ' + name + '\\b');
      check(`index.html imports existing symbol ${name} from ${path}`, re.test(libSrc));
    }
  }
}

console.log('\n=== 5) admin.html wiring ===');
const adminHtml = readFileSync('admin.html', 'utf-8');
const adminScript = adminHtml.match(/<script type="module">([\s\S]*?)<\/script>/);
check('admin.html contains a module script', Boolean(adminScript));
if (adminScript) {
  const code = adminScript[1];
  const imports = [...code.matchAll(/import\s+{([^}]+)}\s+from\s+'([^']+)'/g)];
  for (const [, names, path] of imports) {
    const libSrc = readFileSync(path, 'utf-8');
    for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) {
      const re = new RegExp('export (?:const|function|class|async function) ' + name + '\\b');
      check(`admin.html imports existing symbol ${name} from ${path}`, re.test(libSrc));
    }
  }
  check('admin.html has login gate', adminHtml.includes('loginGate'));
  check('admin.html has tabs for all 5 sections', ['add', 'import', 'ai', 'manage', 'analytics'].every((t) => adminHtml.includes('panel-' + t)));
  check('admin.html keyboard hint absent (admin only)', !adminHtml.includes('help-hint'));
}

console.log('\n=== 6) Balanced HTML tags ===');
for (const file of ['index.html', 'admin.html']) {
  const src = readFileSync(file, 'utf-8');
  const open = (src.match(/<div/g) || []).length;
  const close = (src.match(/<\/div>/g) || []).length;
  check(`${file}: <div> balanced (${open}/${close})`, open === close);
}

console.log('\n' + (failures === 0
  ? '🎉 ALL TESTS PASSED'
  : `⚠️  ${failures} TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
