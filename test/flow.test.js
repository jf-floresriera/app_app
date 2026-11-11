'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mie-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.MAX_VIOLATIONS = '3';
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
