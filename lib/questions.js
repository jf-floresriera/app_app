'use strict';
/**
 * Banco de preguntas – Manejo Integrado de Enfermedades (MIE).
 *
 * Cada pregunta es { id, make(rng) }. `make` devuelve:
 *   type, topic, prompt, data (visible para el estudiante), key (SOLO servidor).
 * El `rng` está sembrado por intento, de modo que:
 *   - las preguntas paramétricas tienen valores distintos para cada estudiante,
 *   - las opciones se barajan por estudiante,
 *   - las respuestas correctas nunca viajan al navegador.
 *
 * Tipos: single, multiple, truefalse, numeric, text, ordering, matching,
 *        graph_click (gráfico interactivo), simulator (dinámica con simulador).
 */
const crypto = require('node:crypto');

/* ------------------------------ utilidades ------------------------------ */

function hashSeed(str) {
  return crypto.createHash('sha256').update(String(str)).digest().readUInt32LE(0);
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(hashSeed(seed));
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const logit = (p) => Math.log(p / (1 - p));

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseNumber(v) {
  if (typeof v === 'number') return v;
  const t = String(v).trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/* ----------------------- constructores de preguntas ---------------------- */

const single = (id, topic, prompt, options, answer) => ({
  id,
  make: (rng) => ({
    type: 'single', topic, prompt,
    data: { options: rng.shuffle(options) },
    key: { answer },
  }),
});

const multiple = (id, topic, prompt, options, answers) => ({
  id,
  make: (rng) => ({
    type: 'multiple', topic, prompt,
    data: { options: rng.shuffle(options) },
    key: { answers },
  }),
});

const trueFalse = (id, topic, prompt, answer) => ({
  id,
  make: () => ({ type: 'truefalse', topic, prompt, data: {}, key: { answer } }),
});

/* ------------------------------ banco MIE ------------------------------- */

const BANK = [
  single(
    'triangulo', 'Fundamentos',
    'En el triángulo de la enfermedad, ¿cuál de los siguientes NO es uno de sus vértices?',
    [
      { id: 'a', text: 'Hospedante susceptible' },
      { id: 'b', text: 'Patógeno virulento' },
      { id: 'c', text: 'Ambiente favorable' },
      { id: 'd', text: 'Aplicación de plaguicidas' },
    ],
    'd',
  ),

  trueFalse(
    'oomycete', 'Fundamentos',
    'Phytophthora infestans, agente causal de la gota de la papa, pertenece al reino Fungi (hongos verdaderos).',
    false,
  ),

  multiple(
    'cultural', 'Control',
    'Seleccione TODAS las prácticas que corresponden al control cultural de enfermedades.',
    [
      { id: 'a', text: 'Rotación de cultivos con especies no hospedantes' },
      { id: 'b', text: 'Eliminación o enterramiento de residuos de cosecha infectados' },
      { id: 'c', text: 'Mejoramiento del drenaje y ajuste de la densidad de siembra' },
      { id: 'd', text: 'Aplicación de un fungicida sistémico' },
      { id: 'e', text: 'Liberación de agentes de biocontrol (p. ej., Trichoderma)' },
    ],
    ['a', 'b', 'c'],
  ),

  {
    id: 'patogenos',
    make: (rng) => ({
      type: 'matching',
      topic: 'Patosistemas',
      prompt: 'Relacione cada patógeno con la enfermedad que causa. Toque un patógeno y luego su enfermedad.',
      data: {
        left: rng.shuffle([
          { id: 'l1', text: 'Phytophthora infestans' },
          { id: 'l2', text: 'Hemileia vastatrix' },
          { id: 'l3', text: 'Moniliophthora roreri' },
          { id: 'l4', text: 'Mycosphaerella fijiensis' },
          { id: 'l5', text: 'Fusarium oxysporum f. sp. cubense' },
        ]),
        right: rng.shuffle([
          { id: 'r1', text: 'Gota (tizón tardío) de la papa' },
          { id: 'r2', text: 'Roya del café' },
          { id: 'r3', text: 'Moniliasis del cacao' },
          { id: 'r4', text: 'Sigatoka negra del banano' },
          { id: 'r5', text: 'Marchitez por Fusarium (mal de Panamá) del banano' },
        ]),
      },
      key: { pairs: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4', l5: 'r5' } },
    }),
  },

  {
    id: 'ciclo',
    make: (rng) => ({
      type: 'ordering',
      topic: 'Ciclo de la enfermedad',
      prompt: 'Ordene las etapas del ciclo de una enfermedad, desde la primera hasta la última. Use las flechas para mover cada etapa.',
      data: {
        items: rng.shuffle([
          { id: 'o1', text: 'Inoculación' },
          { id: 'o2', text: 'Penetración' },
          { id: 'o3', text: 'Infección y colonización del tejido' },
          { id: 'o4', text: 'Reproducción del patógeno' },
          { id: 'o5', text: 'Diseminación' },
          { id: 'o6', text: 'Supervivencia' },
        ]),
      },
      key: { order: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'] },
    }),
  },

  {
    id: 'incidencia',
    make: (rng) => {
      const total = rng.pick([50, 80, 100, 120, 150, 200]);
      const sick = rng.int(Math.ceil(total * 0.1), Math.floor(total * 0.6));
      return {
        type: 'numeric',
        topic: 'Cuantificación',
        prompt: `En un lote de papa se evaluaron ${total} plantas y ${sick} presentaron síntomas de gota (Phytophthora infestans). Calcule la incidencia de la enfermedad. Redondee a un decimal.`,
        data: { unit: '%' },
        key: { answer: (sick / total) * 100, tol: 0.1 },
      };
    },
  },

  {
    id: 'severidad',
    make: (rng) => {
      const scale = [5, 10, 15, 20, 25, 30, 40, 50, 60];
      const vals = Array.from({ length: 6 }, () => rng.pick(scale));
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return {
        type: 'numeric',
        topic: 'Cuantificación',
        prompt: `En una evaluación de roya del café se estimó la severidad (% de área foliar afectada) en seis hojas: ${vals.join(', ')}. Calcule la severidad media. Redondee a un decimal.`,
        data: { unit: '%' },
        key: { answer: mean, tol: 0.1 },
      };
    },
  },

  {
    id: 'audpc',
    make: (rng) => {
      const y0 = rng.int(1, 5);
      const y1 = y0 + rng.int(3, 10);
      const y2 = y1 + rng.int(5, 15);
      const y3 = y2 + rng.int(8, 20);
      const audpc = 7 * (y0 / 2 + y1 + y2 + y3 / 2);
      return {
        type: 'numeric',
        topic: 'Epidemiología',
        prompt: `La severidad (%) de la sigatoka negra en un lote de banano se registró a los 0, 7, 14 y 21 días: ${y0}, ${y1}, ${y2} y ${y3}. Calcule el área bajo la curva del progreso de la enfermedad (AUDPC) por la regla del trapecio.`,
        data: { unit: '% · día', hint: 'AUDPC = Σ [ (yᵢ + yᵢ₊₁) / 2 ] · (tᵢ₊₁ − tᵢ)' },
        key: { answer: audpc, tol: 0.6 },
      };
    },
  },

  {
    id: 'umbral_grafico',
    make: (rng) => {
      const r = round(0.12 + rng.next() * 0.08, 3);
      const thr = rng.pick([10, 20, 30, 40, 50]);
      const y0 = 0.01;
      const t = Math.log((thr / 100 / (1 - thr / 100)) * ((1 - y0) / y0)) / r;
      return {
        type: 'graph_click',
        topic: 'Epidemiología',
        prompt: `La gráfica muestra el progreso de la severidad de una enfermedad en un lote. El umbral de acción es ${thr}%. Haga clic sobre la gráfica (o use el control deslizante) en el día en que la epidemia alcanza el umbral.`,
        data: { y0, r, thr, xmax: 50 },
        key: { answer: t, tol: 2 },
      };
    },
  },

  {
    id: 'simulador_fungicida',
    make: (rng) => {
      const r = rng.pick([0.18, 0.2, 0.22, 0.24]);
      const r2 = 0.04;
      const y0 = 0.01;
      const T = 40;
      const L = rng.pick([20, 30, 40]);
      const raw = (logit(L / 100) - logit(y0) - T * r2) / (r - r2);
      const dmax = Math.max(0, Math.min(T, Math.floor(raw + 1e-9)));
      return {
        type: 'simulator',
        topic: 'Manejo',
        prompt: `Un fungicida reduce la tasa de progreso de la enfermedad de ${r} a ${r2} por día, a partir del día en que se aplica. Con el simulador, encuentre el ÚLTIMO día en que puede aplicarse para que la severidad al día ${T} no supere ${L}%.`,
        data: { y0, r, r2, T, L },
        key: { answer: dmax },
      };
    },
  },

  single(
    'resistencia_fungicidas', 'Manejo',
    '¿Cuál es la estrategia más adecuada para retrasar la aparición de resistencia del patógeno a los fungicidas?',
    [
      { id: 'a', text: 'Aplicar siempre el mismo ingrediente activo a dosis más altas' },
      { id: 'b', text: 'Alternar o mezclar ingredientes activos con diferente modo de acción (grupos FRAC)' },
      { id: 'c', text: 'Aplicar solo cuando la enfermedad ya cubre todo el lote' },
      { id: 'd', text: 'Reducir la dosis a la mitad para ahorrar costos' },
    ],
    'b',
  ),

  {
    id: 'resistencia_horizontal',
    make: () => ({
      type: 'text',
      topic: 'Resistencia genética',
      prompt: 'Escriba el nombre del tipo de resistencia genética controlada por muchos genes de efecto menor, que reduce la velocidad de la epidemia y suele ser más durable (una palabra).',
      data: {},
      key: {
        accepted: ['horizontal', 'cuantitativa', 'poligenica', 'parcial', 'no especifica', 'inespecifica', 'de campo'],
      },
    }),
  },

  trueFalse(
    'resistencia_vertical', 'Resistencia genética',
    'La resistencia vertical, controlada por un solo gen mayor, puede ser superada con relativa facilidad por nuevas razas del patógeno.',
    true,
  ),

  multiple(
    'elementos_mie', 'Fundamentos',
    'Seleccione TODOS los elementos que forman parte del Manejo Integrado de Enfermedades.',
    [
      { id: 'a', text: 'Diagnóstico correcto del agente causal' },
      { id: 'b', text: 'Monitoreo del cultivo y uso de umbrales de acción' },
      { id: 'c', text: 'Combinación de tácticas culturales, genéticas, biológicas y químicas' },
      { id: 'd', text: 'Evaluación y registro de los resultados del manejo' },
      { id: 'e', text: 'Aplicaciones por calendario fijo, sin importar el monitoreo' },
      { id: 'f', text: 'Uso exclusivo de un único método de control' },
    ],
    ['a', 'b', 'c', 'd'],
  ),

  single(
    'monociclica', 'Epidemiología',
    '¿Qué caracteriza a una enfermedad monocíclica?',
    [
      { id: 'a', text: 'Produce varias generaciones de inóculo secundario durante el cultivo' },
      { id: 'b', text: 'Completa un solo ciclo de infección por temporada y su progreso depende del inóculo inicial' },
      { id: 'c', text: 'Solo afecta a cultivos de ciclo corto' },
      { id: 'd', text: 'No requiere un hospedante para desarrollarse' },
    ],
    'b',
  ),
];

/* ------------------------- construcción del intento ---------------------- */

function buildQuestions(seed) {
  const built = BANK.map((def) => ({
    id: def.id,
    ...def.make(makeRng(`${seed}:${def.id}`)),
  }));
  return makeRng(`${seed}:orden`).shuffle(built);
}

/** Vista que se envía al navegador: sin `key`. */
function publicView(q) {
  return { id: q.id, type: q.type, topic: q.topic, prompt: q.prompt, data: q.data };
}

/* ------------------------- validación de respuestas ---------------------- */

/** Devuelve la respuesta limpia o `undefined` si no es válida para la pregunta. */
function sanitizeAnswer(q, v) {
  switch (q.type) {
    case 'single':
      return q.data.options.some((o) => o.id === v) ? v : undefined;
    case 'truefalse':
      return typeof v === 'boolean' ? v : undefined;
    case 'multiple': {
      if (!Array.isArray(v)) return undefined;
      const ids = new Set(q.data.options.map((o) => o.id));
      return [...new Set(v.filter((x) => ids.has(x)))];
    }
    case 'numeric':
    case 'text':
      if (typeof v !== 'string' && typeof v !== 'number') return undefined;
      return String(v).slice(0, q.type === 'text' ? 300 : 30);
    case 'graph_click': {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= q.data.xmax ? round(n, 1) : undefined;
    }
    case 'simulator': {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= q.data.T ? n : undefined;
    }
    case 'ordering': {
      if (!Array.isArray(v)) return undefined;
      const ids = q.data.items.map((i) => i.id).sort().join(',');
      return v.slice().sort().join(',') === ids ? v : undefined;
    }
    case 'matching': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
      const lefts = new Set(q.data.left.map((i) => i.id));
      const rights = new Set(q.data.right.map((i) => i.id));
      const out = {};
      for (const [l, r] of Object.entries(v)) if (lefts.has(l) && rights.has(r)) out[l] = r;
      return out;
    }
    default:
      return undefined;
  }
}

/* ------------------------------ calificación ----------------------------- */

/** Fracción de 0 a 1 obtenida en una pregunta. */
function gradeQuestion(q, value) {
  if (value === undefined || value === null || value === '') return 0;
  const k = q.key;
  switch (q.type) {
    case 'single':
    case 'truefalse':
      return value === k.answer ? 1 : 0;
    case 'multiple': {
      if (!Array.isArray(value)) return 0;
      let good = 0;
      let bad = 0;
      for (const v of value) (k.answers.includes(v) ? good++ : bad++);
      return Math.max(0, Math.min(1, (good - bad) / k.answers.length));
    }
    case 'numeric':
    case 'graph_click': {
      const n = parseNumber(value);
      return Number.isFinite(n) && Math.abs(n - k.answer) <= k.tol + 1e-9 ? 1 : 0;
    }
    case 'text': {
      const ans = ` ${normalizeText(value)} `;
      return k.accepted.some((t) => ans.includes(` ${normalizeText(t)} `)) ? 1 : 0;
    }
    case 'ordering': {
      if (!Array.isArray(value)) return 0;
      return k.order.filter((id, i) => value[i] === id).length / k.order.length;
    }
    case 'matching': {
      if (!value || typeof value !== 'object') return 0;
      const entries = Object.entries(k.pairs);
      return entries.filter(([l, r]) => value[l] === r).length / entries.length;
    }
    case 'simulator': {
      const d = Number(value);
      if (d === k.answer) return 1;
      if (d === k.answer - 1) return 0.5;
      return 0;
    }
    default:
      return 0;
  }
}

function gradeAttempt(questions, answers) {
  const detail = questions.map((q) => ({ id: q.id, fraction: round(gradeQuestion(q, answers[q.id]), 3) }));
  const score = round(detail.reduce((a, d) => a + d.fraction, 0), 2);
  return { score, total: questions.length, detail };
}

module.exports = { BANK, buildQuestions, publicView, sanitizeAnswer, gradeAttempt, gradeQuestion };
