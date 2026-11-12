'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mie-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.MAX_VIOLATIONS = '3';
// Quiz "quiz" privado para las pruebas: mismas preguntas que el banco de ejemplo, pero sin ser público.
const SAMPLE_IDS = ['triangulo', 'oomycete', 'cultural', 'patogenos', 'ciclo', 'incidencia', 'severidad', 'audpc',
  'umbral_grafico', 'simulador_fungicida', 'resistencia_fungicidas', 'resistencia_horizontal', 'resistencia_vertical',
  'elementos_mie', 'monociclica'];
process.env.QUESTIONS_JSON_B64 = Buffer.from(JSON.stringify({
  title: 'Quiz privado (tests)', durationMinutes: 45, questions: SAMPLE_IDS.map((builtin) => ({ builtin })),
})).toString('base64');
const Q = require('../lib/questions');
const { server } = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(p, { method = 'GET', body, token, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Password'] = admin;
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

const student = (n) => ({ name: `Ana María Pérez ${n}`, email: `ana${n}@unal.edu.co`, document: `10000000${n}` });

/** Construye las respuestas correctas a partir de la semilla (solo posible en pruebas). */
function correctAnswers(seed) {
  const out = {};
  for (const q of Q.buildQuestions(seed)) {
    const k = q.key;
    if (q.type === 'single' || q.type === 'truefalse') out[q.id] = k.answer;
    else if (q.type === 'multiple') out[q.id] = k.answers;
    else if (q.type === 'numeric') out[q.id] = String(Math.round(k.answer * 10) / 10);
    else if (q.type === 'graph_click') out[q.id] = Math.round(k.answer * 2) / 2;
    else if (q.type === 'simulator') out[q.id] = k.answer;
    else if (q.type === 'text') out[q.id] = 'Resistencia horizontal';
    else if (q.type === 'ordering') out[q.id] = k.order;
    else if (q.type === 'matching') out[q.id] = k.pairs;
  }
  return out;
}

test('la calificación da el puntaje completo con respuestas correctas y cero sin respuestas', () => {
  const seed = 'semilla-1';
  const qs = Q.buildQuestions(seed);
  assert.equal(Q.gradeAttempt(qs, correctAnswers(seed)).score, qs.length);
  assert.equal(Q.gradeAttempt(qs, {}).score, 0);
});

test('las preguntas paramétricas cambian entre intentos y las claves no se publican', () => {
  const a = Q.buildQuestions('a').find((q) => q.id === 'incidencia');
  assert.equal(Q.DEFAULT_EXAM, 'quiz');
  const b = Q.buildQuestions('b').find((q) => q.id === 'audpc');
  const a2 = Q.buildQuestions('zzz').find((q) => q.id === 'audpc');
  assert.notEqual(b.prompt, a2.prompt);
  for (const q of Q.buildQuestions('a')) assert.equal(JSON.stringify(Q.publicView(q)).includes('"key"'), false);
  assert.ok(a.key.answer > 0);
});

test('validación del ingreso', async () => {
  let r = await call('/api/login', { method: 'POST', body: { ...student(1), email: 'ana@gmail.com' } });
  assert.equal(r.status, 400);
  r = await call('/api/login', { method: 'POST', body: { ...student(1), document: '12ab' } });
  assert.equal(r.status, 400);
  r = await call('/api/login', { method: 'POST', body: { ...student(1), name: 'Ana' } });
  assert.equal(r.status, 400);
});

test('flujo completo: iniciar, responder, enviar', async () => {
  const s = student(2);
  const login = await call('/api/login', { method: 'POST', body: s });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal(login.body.status, 'ready');

  const start = await call('/api/start', { method: 'POST', token });
  assert.equal(start.body.status, 'in_progress');
  assert.ok(start.body.questions.length >= 10);
  assert.equal(JSON.stringify(start.body).includes('"key"'), false);

  const bad = await call('/api/answer', { method: 'POST', token, body: { id: start.body.questions[0].id, value: 'zzz' } });
  assert.equal(bad.status, 200); // valor inválido se descarta sin guardar

  const submitted = await call('/api/submit', { method: 'POST', token });
  assert.equal(submitted.body.status, 'submitted');
  assert.equal(submitted.body.score, 0);

  const again = await call('/api/login', { method: 'POST', body: s });
  assert.equal(again.body.status, 'submitted');
  assert.equal(again.body.token, null);
});

test('retroalimentación: solo tras enviar, con respuesta correcta y explicación', async () => {
  const s = student(6);
  const token = (await call('/api/login', { method: 'POST', body: s })).body.token;
  const started = (await call('/api/start', { method: 'POST', token })).body;
  assert.equal(started.review, undefined); // durante el intento no se ve nada

  const q0 = started.questions.find((q) => q.type === 'single');
  await call('/api/answer', { method: 'POST', token, body: { id: q0.id, value: q0.data.options[0].id } });
  const hidden = (await call('/api/submit', { method: 'POST', token })).body;

  // Por defecto el estudiante solo ve su nota; el profesor decide cuándo liberar.
  assert.equal(hidden.review, undefined);
  assert.equal(hidden.feedbackReleased, false);
  assert.equal((await call('/api/login', { method: 'POST', body: s })).body.review, undefined);

  // El profesor necesita clave para liberar.
  assert.equal((await call('/api/admin/feedback', { method: 'POST', body: { released: true } })).status, 401);
  assert.equal((await call('/api/admin/feedback', { method: 'POST', admin: 'clave-de-prueba', body: { released: 'si' } })).status, 400);
  const rel = await call('/api/admin/feedback', { method: 'POST', admin: 'clave-de-prueba', body: { released: true } });
  assert.equal(rel.body.settings.feedbackReleased, true);

  const done = (await call('/api/login', { method: 'POST', body: s })).body;
  assert.equal(done.feedbackReleased, true);
  assert.equal(done.review.length, started.questions.length);
  for (const r of done.review) {
    assert.ok(r.explain && r.explain.length > 20, `sin explicación: ${r.id}`);
    assert.ok(r.correct && Object.keys(r.correct).length, `sin respuesta correcta: ${r.id}`);
    assert.ok(r.fraction >= 0 && r.fraction <= 1);
  }
  const mine = done.review.find((r) => r.id === q0.id);
  assert.equal(mine.answer, q0.data.options[0].id);
  assert.equal(mine.fraction, mine.correct.answer === mine.answer ? 1 : 0);

  // La suma de la revisión coincide con la nota.
  const sum = done.review.reduce((a, r) => a + r.fraction, 0);
  assert.ok(Math.abs(sum - done.score) < 0.011);

  // Al volver a ingresar se puede consultar de nuevo.
  // Si el profesor la oculta de nuevo, deja de verse.
  await call('/api/admin/feedback', { method: 'POST', admin: 'clave-de-prueba', body: { released: false } });
  const again = (await call('/api/login', { method: 'POST', body: s })).body;
  assert.equal(again.review, undefined);
});

test('un intento anulado no muestra revisión', async () => {
  const s = student(7);
  const token = (await call('/api/login', { method: 'POST', body: s })).body.token;
  await call('/api/start', { method: 'POST', token });
  let last;
  for (let i = 0; i < 3; i++) last = (await call('/api/violation', { method: 'POST', token, body: { type: 'tab_hidden' } })).body;
  assert.equal(last.status, 'annulled');
  assert.equal(last.review, undefined);
});

test('el profesor ve la revisión de un estudiante, con clave', async () => {
  const doc = student(6).document;
  assert.equal((await call(`/api/admin/review?document=${doc}`)).status, 401);
  const ok = await call(`/api/admin/review?document=${doc}`, { admin: 'clave-de-prueba' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.review.length >= 10);
  const t = (await call('/api/login', { method: 'POST', body: student(8) })).body.token;
  await call('/api/start', { method: 'POST', token: t });
  const pending = await call(`/api/admin/review?document=${student(8).document}`, { admin: 'clave-de-prueba' });
  assert.equal(pending.status, 409);
  assert.equal((await call('/api/admin/review?document=0', { admin: 'clave-de-prueba' })).status, 404);
});

test('un correo distinto para el mismo documento se rechaza', async () => {
  const s = student(3);
  await call('/api/login', { method: 'POST', body: s });
  const r = await call('/api/login', { method: 'POST', body: { ...s, email: 'otra@unal.edu.co' } });
  assert.equal(r.status, 403);
});

test('una infracción reinicia el intento y cambia las preguntas; la tercera lo anula', async () => {
  const s = student(4);
  const { body: l } = await call('/api/login', { method: 'POST', body: s });
  const token = l.token;
  const first = (await call('/api/start', { method: 'POST', token })).body;
  const q1 = first.questions.map((q) => q.id).join();
  await call('/api/answer', { method: 'POST', token, body: { id: first.questions[0].id, value: first.questions[0].data.options?.[0]?.id ?? true } });

  const v1 = (await call('/api/violation', { method: 'POST', token, body: { type: 'tab_hidden' } })).body;
  assert.equal(v1.status, 'in_progress');
  assert.equal(v1.violations, 1);
  assert.equal(v1.restarts, 1);
  assert.deepEqual(v1.answers, {});
  assert.notEqual(v1.questions.map((q) => q.id).join(), q1);

  await call('/api/violation', { method: 'POST', token, body: { type: 'window_blur' } });
  const v3 = (await call('/api/violation', { method: 'POST', token, body: { type: 'fullscreen_exit' } })).body;
  assert.equal(v3.status, 'annulled');
  assert.equal(v3.grade, 0);
});

test('un segundo ingreso desplaza la sesión anterior y reinicia', async () => {
  const s = student(5);
  const a = (await call('/api/login', { method: 'POST', body: s })).body;
  await call('/api/start', { method: 'POST', token: a.token });
  const b = (await call('/api/login', { method: 'POST', body: s })).body;
  assert.notEqual(a.token, b.token);
  assert.equal(b.violations, 1);
  assert.equal(b.restarts, 1);
  const old = await call('/api/heartbeat', { method: 'POST', token: a.token });
  assert.equal(old.status, 401);
  assert.equal(old.body.displaced, true);
});

test('panel del profesor: protegido por clave', async () => {
  assert.equal((await call('/api/admin/results')).status, 401);
  assert.equal((await call('/api/admin/results', { admin: 'mala' })).status, 401);
  const ok = await call('/api/admin/results', { admin: 'clave-de-prueba' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.rows.length >= 4);
  const reset = await call('/api/admin/reset', { method: 'POST', admin: 'clave-de-prueba', body: { document: student(4).document } });
  assert.equal(reset.status, 200);
});

test('ruta de salud para el monitoreo del hosting', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('archivos estáticos: sin recorrido de rutas y con cabeceras de seguridad', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const trav = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(trav.status, 200);
  const trav2 = await fetch(`${base}/%2e%2e/server.js`);
  assert.notEqual(trav2.status, 200);
});

/* ---------------- quiz privado cargado desde variable de entorno ---------------- */
const { execFileSync } = require('node:child_process');

test('el quiz privado se carga desde QUESTIONS_JSON_B64 y se califica en el servidor', () => {
  const exam = {
    questions: [
      { type: 'single', prompt: 'P1', options: ['a', 'b', 'c'], answer: 2, explain: 'porque c' },
      { type: 'multiple', prompt: 'P2', options: ['a', 'b', 'c'], answers: [0, 2] },
      { type: 'truefalse', prompt: 'P3', answer: true },
      { type: 'numeric', prompt: 'P4', answer: 2.5, tol: 0.1 },
      { type: 'ordering', prompt: 'P5', items: ['uno', 'dos', 'tres'] },
      { type: 'matching', prompt: 'P6', pairs: [['x', 'X'], ['y', 'Y']] },
      { builtin: 'audpc' },
    ],
    shuffleQuestions: false,
  };
  const script = `
    const Q = require('./lib/questions');
    const qs = Q.buildQuestions('semilla');
    const ans = {};
    for (const q of qs) {
      const k = q.key;
      ans[q.id] = q.type === 'single' || q.type === 'truefalse' ? k.answer : q.type === 'multiple' ? k.answers
        : q.type === 'numeric' ? String(k.answer) : q.type === 'ordering' ? k.order : k.pairs;
    }
    console.log(JSON.stringify({ source: Q.EXAMS[Q.DEFAULT_EXAM].source, order: qs.map((q) => q.id).join(), n: qs.length, score: Q.gradeAttempt(qs, ans).score,
      none: Q.gradeAttempt(qs, {}).score, pub: JSON.stringify(qs.map(Q.publicView)).includes('porque c') }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, QUESTIONS_JSON_B64: Buffer.from(JSON.stringify(exam)).toString('base64') },
  }).toString();
  const r = JSON.parse(out);
  assert.equal(r.source, 'private');
  assert.equal(r.n, 7);
  assert.match(r.order, /^p1,p2,p3,p4,p5,p6,audpc$/); // orden fijo si shuffleQuestions es false
  assert.equal(r.score, 7);
  assert.equal(r.none, 0);
  assert.equal(r.pub, false); // la explicación no viaja al navegador durante el intento
});

test('un quiz mal escrito da errores claros', () => {
  assert.throws(() => Q.parseExam('{no es json'), /JSON válido/);
  assert.throws(() => Q.parseExam('{"questions":[]}'), /al menos una pregunta/);
  assert.throws(() => Q.parseExam('{"questions":[{"type":"single","prompt":"x","options":["a","b"],"answer":5}]}'), /answer/);
  assert.throws(() => Q.parseExam('{"questions":[{"type":"raro","prompt":"x"}]}'), /desconocido/);
  assert.throws(() => Q.parseExam('{"questions":[{"builtin":"no_existe"}]}'), /builtin/);
  assert.throws(() => Q.parseExam('{"questions":[{"id":"a","type":"truefalse","prompt":"x","answer":true},{"id":"a","type":"truefalse","prompt":"y","answer":false}]}'), /repetido/);
});

/* ---------------- dos exámenes conviviendo: prueba (público) y quiz (privado) ---------------- */

test('/prueba y / sirven la aplicación y cada ruta muestra su título', async () => {
  assert.equal((await fetch(`${base}/prueba`)).status, 200);
  assert.equal((await fetch(`${base}/quiz`)).status, 200);
  assert.equal((await fetch(`${base}/no-existe`)).status, 404);
  const a = await call('/api/config');
  const b = await call('/api/config?exam=prueba');
  assert.equal(a.body.title, 'Quiz privado (tests)');
  assert.match(b.body.title, /Quiz de prueba/);
  assert.equal(b.body.label, 'Quiz');
  assert.equal((await call('/api/config?exam=zzz')).status, 404);
});

test('el quiz de prueba muestra la retroalimentación al terminar; el quiz privado no', async () => {
  const s = student(20);
  // prueba
  const pr = await call('/api/login', { method: 'POST', body: { ...s, exam: 'prueba' } });
  assert.equal(pr.body.exam, 'prueba');
  await call('/api/start', { method: 'POST', token: pr.body.token });
  const prDone = (await call('/api/submit', { method: 'POST', token: pr.body.token })).body;
  assert.equal(prDone.feedbackReleased, true);
  assert.equal(prDone.review.length, 15);
  assert.equal(prDone.durationMs, 30 * 60 * 1000); // DURATION_MINUTES por defecto

  // quiz privado (mismo estudiante, intento independiente)
  const pa = await call('/api/login', { method: 'POST', body: s });
  assert.equal(pa.body.exam, 'quiz');
  assert.equal(pa.body.status, 'ready'); // el intento de prueba no cuenta aquí
  assert.equal(pa.body.durationMs, 45 * 60 * 1000); // durationMinutes propio del quiz
  assert.equal(pa.body.examTitle, 'Quiz privado (tests)');
  await call('/api/start', { method: 'POST', token: pa.body.token });
  const paDone = (await call('/api/submit', { method: 'POST', token: pa.body.token })).body;
  assert.equal(paDone.feedbackReleased, false);
  assert.equal(paDone.review, undefined);
});

test('los dos exámenes se pueden presentar a la vez sin desplazarse las sesiones', async () => {
  const s = student(21);
  const a = (await call('/api/login', { method: 'POST', body: { ...s, exam: 'prueba' } })).body;
  await call('/api/start', { method: 'POST', token: a.token });
  const b = (await call('/api/login', { method: 'POST', body: s })).body;
  await call('/api/start', { method: 'POST', token: b.token });
  assert.equal((await call('/api/heartbeat', { method: 'POST', token: a.token })).status, 200);
  assert.equal((await call('/api/heartbeat', { method: 'POST', token: b.token })).status, 200);
});

test('el panel separa los resultados por quiz y no permite ocultar la retroalimentación pública', async () => {
  const admin = 'clave-de-prueba';
  const privado = await call('/api/admin/results', { admin });
  const prueba = await call('/api/admin/results?exam=prueba', { admin });
  assert.equal(privado.body.exam, 'quiz');
  assert.equal(prueba.body.exam, 'prueba');
  assert.deepEqual(privado.body.exams.map((e) => e.id).sort(), ['prueba', 'quiz']);
  assert.ok(prueba.body.rows.some((r) => r.document === student(20).document));
  assert.ok(!prueba.body.rows.some((r) => r.document === student(2).document)); // solo hizo el quiz
  assert.equal(prueba.body.settings.alwaysVisible, true);
  const no = await call('/api/admin/feedback', { method: 'POST', admin, body: { exam: 'prueba', released: false } });
  assert.equal(no.status, 400);
  // revisión por quiz
  const rv = await call(`/api/admin/review?exam=prueba&document=${student(20).document}`, { admin });
  assert.equal(rv.status, 200);
  assert.equal((await call(`/api/admin/review?exam=quiz&document=${student(20).document}`, { admin })).status, 200);
  assert.equal((await call('/api/admin/review?exam=zzz&document=1', { admin })).status, 404);
});

test('el quiz privado también se carga comprimido (QUESTIONS_JSON_GZ_B64)', () => {
  const zlib = require('node:zlib');
  const exam = { durationMinutes: 60, questions: [{ type: 'truefalse', prompt: 'P1', answer: true }, { type: 'single', prompt: 'P2', options: ['a', 'b'], answer: 1 }] };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(exam))).toString('base64');
  const env = { ...process.env, QUESTIONS_JSON_GZ_B64: gz };
  delete env.QUESTIONS_JSON_B64;
  const out = execFileSync(process.execPath, ['-e',
    "const Q=require('./lib/questions');const e=Q.getExam('quiz');console.log(JSON.stringify({d:Q.DEFAULT_EXAM,n:e.bank.length,m:e.durationMinutes}))"], {
    cwd: path.join(__dirname, '..'), env }).toString();
  assert.deepEqual(JSON.parse(out), { d: 'quiz', n: 2, m: 60 });
});

test('QUIZ_TITLE sobrescribe el título del quiz privado', () => {
  const env = { ...process.env, QUIZ_TITLE: 'Quiz: Título nuevo', QUESTIONS_JSON_B64: Buffer.from(JSON.stringify({ title: 'Parcial: viejo', questions: [{ type: 'truefalse', prompt: 'x', answer: true }] })).toString('base64') };
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', "console.log(require('./lib/questions').getExam('quiz').title)"], { cwd: path.join(__dirname, '..'), env }).toString().trim();
  assert.equal(out, 'Quiz: Título nuevo');
});
