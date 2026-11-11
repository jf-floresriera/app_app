'use strict';
/**
 * Servidor del quiz de Manejo Integrado de Enfermedades.
 * Sin dependencias externas: solo Node.js >= 18.
 *
 * Variables de entorno:
 *   PORT                 puerto (por defecto 3000)
 *   ADMIN_PASSWORD       clave del panel del profesor (si no se define, el panel queda desactivado)
 *   DURATION_MINUTES     duración del quiz (por defecto 30)
 *   MAX_VIOLATIONS       infracciones antes de anular el intento; 0 = ilimitado (por defecto 3)
 *   ALLOWED_EMAIL_DOMAIN dominio del correo institucional (por defecto unal.edu.co)
 *   SHOW_FEEDBACK        'true' para que la retroalimentación nazca visible (por defecto false: la libera el profesor desde /admin)
 *   DATA_DIR             carpeta donde se guardan los resultados (por defecto ./data)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Q = require('./lib/questions');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DURATION_MS = (Number(process.env.DURATION_MINUTES) || 30) * 60 * 1000;
const MAX_VIOLATIONS = process.env.MAX_VIOLATIONS === undefined ? 3 : Number(process.env.MAX_VIOLATIONS);
const SHOW_FEEDBACK = String(process.env.SHOW_FEEDBACK || 'false').toLowerCase() === 'true';
const EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'unal.edu.co').toLowerCase();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'results.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACTIVE_WINDOW_MS = 20 * 1000; // una sesión con latido reciente se considera abierta

const VIOLATION_TYPES = new Set([
  'tab_hidden', 'window_blur', 'fullscreen_exit', 'second_session', 'devtools_key', 'print', 'other',
]);

/* ------------------------------ persistencia ----------------------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { students: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!db.students) db.students = {};
} catch (err) {
  if (err.code !== 'ENOENT') console.error('No se pudo leer', DATA_FILE, err.message);
}

// Ajustes que cambia el profesor desde /admin (se guardan junto con los resultados).
if (!db.settings) db.settings = { feedbackReleased: SHOW_FEEDBACK };

const tokenIndex = new Map(); // token -> documento
for (const s of Object.values(db.students)) if (s.session) tokenIndex.set(s.session.token, s.document);

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 500);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveNow(); process.exit(0); });
}

/* ------------------------------- utilidades ------------------------------ */

const newSeed = () => crypto.randomBytes(12).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const toGrade = (score, total) => Math.round((score / total) * 5 * 100) / 100;

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

function questionsFor(student) {
  return Q.buildQuestions(student.attempt.seed);
}

function newAttempt() {
  return {
    seed: newSeed(),
    status: 'ready', // ready | in_progress | submitted | annulled
    startedAt: null,
    deadline: null,
    answers: {},
    restarts: 0,
    violations: [],
    score: null,
    total: null,
    grade: null,
    detail: null,
    submittedAt: null,
  };
}

function submit(student, status = 'submitted') {
  const a = student.attempt;
  const qs = questionsFor(student);
  const res = Q.gradeAttempt(qs, a.answers);
  a.status = status;
  a.submittedAt = Date.now();
  a.total = res.total;
  a.detail = res.detail;
  a.score = status === 'annulled' ? 0 : res.score;
  a.grade = toGrade(a.score, a.total);
  saveNow();
}

/** Cierra automáticamente el intento si venció el tiempo. */
function expireIfNeeded(student) {
  const a = student.attempt;
  if (a.status === 'in_progress' && Date.now() > a.deadline) submit(student);
}

function restartAttempt(student) {
  const a = student.attempt;
  a.seed = newSeed();
  a.answers = {};
  a.restarts += 1;
}

function recordViolation(student, type) {
  const a = student.attempt;
  a.violations.push({ type, at: Date.now() });
  if (MAX_VIOLATIONS > 0 && a.violations.length >= MAX_VIOLATIONS) {
    submit(student, 'annulled');
  } else {
    restartAttempt(student);
    saveNow();
  }
}

/** Revisión pregunta por pregunta: respuesta del estudiante, correcta y explicación. */
function buildReview(student) {
  const a = student.attempt;
  return questionsFor(student).map((q) => {
    const answer = a.answers[q.id] === undefined ? null : a.answers[q.id];
    return {
      ...Q.publicView(q),
      answer,
      fraction: Math.round(Q.gradeQuestion(q, answer ?? undefined) * 1000) / 1000,
      correct: Q.correctView(q),
      explain: q.explain,
    };
  });
}

function attemptState(student) {
  const a = student.attempt;
  const base = {
    status: a.status,
    name: student.name,
    restarts: a.restarts,
    violations: a.violations.length,
    maxViolations: MAX_VIOLATIONS,
    durationMs: DURATION_MS,
  };
  if (a.status === 'in_progress') {
    return {
      ...base,
      remainingMs: Math.max(0, a.deadline - Date.now()),
      answers: a.answers,
      questions: questionsFor(student).map(Q.publicView),
    };
  }
  if (a.status === 'submitted' || a.status === 'annulled') {
    const done = { ...base, score: a.score, total: a.total, grade: a.grade };
    done.feedbackReleased = db.settings.feedbackReleased;
    // Solo se muestra la revisión en intentos enviados (no en los anulados) y cuando el profesor la libera.
    if (a.status === 'submitted' && db.settings.feedbackReleased) done.review = buildReview(student);
    return done;
  }
  return base;
}

/* --------------------------------- HTTP ---------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

function authStudent(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return { error: 'no_session' };
  const doc = tokenIndex.get(m[1]);
  const student = doc && db.students[doc];
  if (!student || !student.session || student.session.token !== m[1]) return { error: 'displaced' };
  return { student };
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  return safeEqual(req.headers['x-admin-password'] || '', ADMIN_PASSWORD);
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function validateLogin(body) {
  const name = cleanName(body.name);
  const email = String(body.email || '').trim().toLowerCase();
  const document = String(body.document || '').replace(/[\s.]/g, '');
  if (name.length < 5 || name.split(' ').length < 2 || name.length > 100) return { error: 'Escriba su nombre completo (nombres y apellidos).' };
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || !email.endsWith(`@${EMAIL_DOMAIN}`)) {
    return { error: `Use su correo institucional (@${EMAIL_DOMAIN}).` };
  }
  if (!/^\d{5,12}$/.test(document)) return { error: 'El documento debe tener entre 5 y 12 dígitos, sin puntos ni letras.' };
  return { name, email, document };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  /* ---- estudiantes ---- */
  if (route === 'POST /api/login') {
    const v = validateLogin(await readBody(req));
    if (v.error) return json(res, 400, { error: v.error });

    let student = db.students[v.document];
    if (!student) {
      student = db.students[v.document] = {
        document: v.document, name: v.name, email: v.email, createdAt: Date.now(), session: null, attempt: newAttempt(),
      };
    } else if (student.email !== v.email) {
      return json(res, 403, { error: 'El correo no coincide con el registrado para este documento. Si es un error, avise al profesor.' });
    }

    expireIfNeeded(student);
    const a = student.attempt;
    if (a.status === 'submitted' || a.status === 'annulled') {
      return json(res, 200, { token: null, ...attemptState(student) });
    }

    // Segunda sesión mientras hay una activa: infracción y reinicio.
    const wasActive = a.status === 'in_progress' && student.session && Date.now() - student.session.lastSeen < ACTIVE_WINDOW_MS;
    if (student.session) tokenIndex.delete(student.session.token);
    student.session = { token: newToken(), lastSeen: Date.now() };
    tokenIndex.set(student.session.token, student.document);

    if (wasActive) {
      // Abrir una pestaña nueva en el mismo navegador ya generó una infracción
      // de "pestaña oculta" en la sesión anterior; no se cuenta dos veces.
      const last = a.violations[a.violations.length - 1];
      if (last && Date.now() - last.at < ACTIVE_WINDOW_MS) restartAttempt(student);
      else recordViolation(student, 'second_session');
    } else if (a.status === 'in_progress') {
      restartAttempt(student); // volvió a entrar tras cerrar: nuevas variantes, mismo reloj
    }
    saveNow();
    return json(res, 200, { token: student.session.token, ...attemptState(student) });
  }

  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/admin/')) {
    const { student, error } = authStudent(req);
    if (error) return json(res, 401, { error, displaced: error === 'displaced' });
    expireIfNeeded(student);
    student.session.lastSeen = Date.now();
    const a = student.attempt;

    if (route === 'GET /api/attempt') return json(res, 200, attemptState(student));

    if (route === 'POST /api/heartbeat') {
      return json(res, 200, { status: a.status, remainingMs: a.status === 'in_progress' ? Math.max(0, a.deadline - Date.now()) : 0 });
    }

    if (route === 'POST /api/start') {
      if (a.status === 'ready') {
        a.status = 'in_progress';
        a.startedAt = Date.now();
        a.deadline = a.startedAt + DURATION_MS;
        saveNow();
      }
      return json(res, 200, attemptState(student));
    }

    if (route === 'POST /api/answer') {
      if (a.status !== 'in_progress') return json(res, 409, { error: 'not_in_progress', ...attemptState(student) });
      const body = await readBody(req);
      const q = questionsFor(student).find((x) => x.id === body.id);
      if (!q) return json(res, 400, { error: 'Pregunta desconocida.' });
      const clean = Q.sanitizeAnswer(q, body.value);
      if (clean === undefined) delete a.answers[q.id];
      else a.answers[q.id] = clean;
      saveSoon();
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/violation') {
      const body = await readBody(req);
      if (a.status === 'in_progress') {
        recordViolation(student, VIOLATION_TYPES.has(body.type) ? body.type : 'other');
      }
      return json(res, 200, attemptState(student));
    }

    if (route === 'POST /api/submit') {
      if (a.status === 'in_progress') submit(student);
      return json(res, 200, attemptState(student));
    }
  }

  /* ---- profesor ---- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (!ADMIN_PASSWORD) return json(res, 503, { error: 'Panel desactivado: defina ADMIN_PASSWORD en el servidor.' });
    if (!isAdmin(req)) return json(res, 401, { error: 'Clave incorrecta.' });

    if (route === 'GET /api/admin/results') {
      Object.values(db.students).forEach(expireIfNeeded);
      const rows = Object.values(db.students).map((s) => ({
        document: s.document, name: s.name, email: s.email,
        status: s.attempt.status, score: s.attempt.score, total: s.attempt.total, grade: s.attempt.grade,
        restarts: s.attempt.restarts,
        violations: s.attempt.violations,
        startedAt: s.attempt.startedAt, submittedAt: s.attempt.submittedAt,
        detail: s.attempt.detail,
      }));
      return json(res, 200, { rows, questionIds: Q.BANK.map((b) => b.id), settings: db.settings });
    }

    if (route === 'POST /api/admin/feedback') {
      const body = await readBody(req);
      if (typeof body.released !== 'boolean') return json(res, 400, { error: 'Falta el valor released (true o false).' });
      db.settings.feedbackReleased = body.released;
      saveNow();
      return json(res, 200, { settings: db.settings });
    }

    if (route === 'GET /api/admin/review') {
      const s = db.students[String(url.searchParams.get('document') || '')];
      if (!s) return json(res, 404, { error: 'Documento no encontrado.' });
      if (s.attempt.status !== 'submitted' && s.attempt.status !== 'annulled') {
        return json(res, 409, { error: 'El estudiante aún no ha enviado la evaluación.' });
      }
      return json(res, 200, {
        name: s.name, email: s.email, status: s.attempt.status,
        score: s.attempt.score, total: s.attempt.total, grade: s.attempt.grade,
        review: buildReview(s),
      });
    }

    if (route === 'POST /api/admin/reset') {
      const body = await readBody(req);
      const s = db.students[String(body.document || '')];
      if (!s) return json(res, 404, { error: 'Documento no encontrado.' });
      s.attempt = newAttempt();
      saveNow();
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: 'No encontrado.' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Prohibido');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'No encontrado');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    return serveStatic(req, res, url);
  } catch (err) {
    if (err.message === 'bad_json' || err.message === 'too_large') return json(res, 400, { error: 'Solicitud inválida.' });
    console.error(err);
    return json(res, 500, { error: 'Error interno.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Quiz MIE escuchando en http://localhost:${PORT}`);
    if (!ADMIN_PASSWORD) console.log('Aviso: ADMIN_PASSWORD no definido; el panel del profesor está desactivado.');
  });
}

module.exports = { server };
