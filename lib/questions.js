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
 * Cursiva: encierre entre asteriscos los nombres científicos, p. ej. *Phytophthora infestans*.
 * Tipos: single, multiple, truefalse, numeric, text, ordering, matching,
 *        graph_click (gráfico interactivo), simulator (dinámica con simulador).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');

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
const es = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

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

const SAMPLE_BANK = [
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
    '*Phytophthora infestans*, agente causal de la gota de la papa, pertenece al reino Fungi (hongos verdaderos).',
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
      { id: 'e', text: 'Liberación de agentes de biocontrol (p. ej., *Trichoderma*)' },
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
          { id: 'l1', text: '*Phytophthora infestans*' },
          { id: 'l2', text: '*Hemileia vastatrix*' },
          { id: 'l3', text: '*Moniliophthora roreri*' },
          { id: 'l4', text: '*Mycosphaerella fijiensis*' },
          { id: 'l5', text: '*Fusarium oxysporum* f. sp. *cubense*' },
        ]),
        right: rng.shuffle([
          { id: 'r1', text: 'Gota (tizón tardío) de la papa' },
          { id: 'r2', text: 'Roya del café' },
          { id: 'r3', text: 'Moniliasis del cacao' },
          { id: 'r4', text: 'Sigatoka negra del banano' },
          { id: 'r5', text: 'Marchitez por *Fusarium* (mal de Panamá) del banano' },
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
        prompt: `En un lote de papa se evaluaron ${total} plantas y ${sick} presentaron síntomas de gota (*Phytophthora infestans*). Calcule la incidencia de la enfermedad. Redondee a un decimal.`,
        data: { unit: '%' },
        key: { answer: (sick / total) * 100, tol: 0.1 },
        explain: `Incidencia (%) = plantas enfermas / plantas evaluadas × 100 = ${sick} / ${total} × 100 = ${es((sick / total) * 100)}%.`,
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
        explain: `Severidad media = suma de las severidades / número de hojas = ${vals.reduce((a, b) => a + b, 0)} / ${vals.length} = ${es(mean)}%.`,
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
        explain: `Con evaluaciones cada 7 días, AUDPC = 7 × (${y0}/2 + ${y1} + ${y2} + ${y3}/2) = ${es(audpc)} % · día. Cada trapecio suma (yᵢ + yᵢ₊₁)/2 × 7 días.`,
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
        explain: `La curva alcanza el umbral de ${thr}% hacia el día ${es(t)}. Se acepta una diferencia de ±2 días.`,
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
        explain: `Con una tasa de ${es(r, 2)} por día antes de aplicar y ${es(r2, 2)} después, la última aplicación que mantiene la severidad al día ${T} en ${L}% o menos es el día ${dmax}. Aplicar un día antes también protege, pero vale 0,5 porque no es el último día posible.`,
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


/* ----------------------- retroalimentación (preguntas fijas) ------------- */

const EXPLAIN = {
  triangulo:
    'El triángulo de la enfermedad integra tres factores: un hospedante susceptible, un patógeno virulento y un ambiente favorable. La aplicación de plaguicidas es una medida de manejo, no un vértice del triángulo.',
  oomycete:
    '*Phytophthora infestans* es un oomiceto (Stramenopila), no un hongo verdadero. Se parece a los hongos por su crecimiento filamentoso, pero es un grupo distinto; por eso muchos fungicidas para hongos verdaderos no lo controlan y se usan productos específicos para oomicetos.',
  cultural:
    'El control cultural modifica las prácticas del cultivo para reducir el inóculo o crear un ambiente menos favorable: rotación, eliminación de residuos, drenaje y densidad adecuada. El fungicida sistémico es control químico y *Trichoderma* es control biológico.',
  patogenos:
    '*Phytophthora infestans* causa la gota (tizón tardío) de la papa; *Hemileia vastatrix*, la roya del café; *Moniliophthora roreri*, la moniliasis del cacao; *Mycosphaerella fijiensis*, la sigatoka negra del banano; y *Fusarium oxysporum* f. sp. *cubense*, la marchitez por *Fusarium* (mal de Panamá).',
  ciclo:
    'El ciclo de una enfermedad sigue este orden: inoculación (el inóculo llega al hospedante), penetración, infección y colonización, reproducción del patógeno, diseminación y supervivencia hasta el siguiente ciclo.',
  resistencia_fungicidas:
    'Alternar o mezclar ingredientes activos con distinto modo de acción (grupos FRAC) reduce la presión de selección sobre el patógeno. Repetir el mismo activo, usar dosis menores a las recomendadas o aplicar tarde favorece la aparición de resistencia o el fracaso del control.',
  resistencia_horizontal:
    'La resistencia horizontal (también llamada cuantitativa, poligénica o parcial) depende de muchos genes de efecto menor. No es específica de una raza, reduce la velocidad de la epidemia y suele ser más durable.',
  resistencia_vertical:
    'La resistencia vertical (cualitativa, específica de raza) depende de un gen mayor. Protege por completo frente a ciertas razas, pero una raza nueva del patógeno puede superarla con relativa facilidad.',
  elementos_mie:
    'El Manejo Integrado de Enfermedades combina diagnóstico correcto, monitoreo con umbrales de acción, varias tácticas (culturales, genéticas, biológicas y químicas) y evaluación de los resultados. Aplicar por calendario fijo o depender de un solo método contradice sus principios.',
  monociclica:
    'En una enfermedad monocíclica hay un solo ciclo de infección por temporada: no se produce inóculo secundario que infecte de nuevo, así que la epidemia depende del inóculo inicial.',
};

/** Respuesta correcta lista para mostrar al estudiante o al profesor. */
function correctView(q) {
  const k = q.key;
  switch (q.type) {
    case 'single':
    case 'truefalse': return { answer: k.answer };
    case 'multiple': return { answers: k.answers };
    case 'numeric': return { answer: round(k.answer, 2), tol: k.tol };
    case 'text': return { accepted: k.accepted };
    case 'ordering': return { order: k.order };
    case 'matching': return { pairs: k.pairs };
    case 'graph_click': return { answer: round(k.answer, 1), tol: k.tol };
    case 'simulator': return { answer: k.answer };
    default: return {};
  }
}


/* ------------------- examen privado (fuera del repositorio) -------------- */
/**
 * El examen real NO debe subirse a GitHub. Se carga, en este orden, desde:
 *   QUESTIONS_JSON_GZ_B64  JSON comprimido (gzip) y codificado en base64: la más corta de copiar
 *   QUESTIONS_JSON_B64  JSON codificado en base64
 *   QUESTIONS_JSON      JSON en una sola variable de entorno
 *   QUESTIONS_FILE      ruta a un archivo JSON (o /etc/secrets/questions.json)
 * Si no hay ninguno, se usa el banco de ejemplo SAMPLE_BANK.
 *
 * Formato (ver EXAMEN-EJEMPLO.json): { "title": "...", "questions": [ {type, prompt, ...} ] }
 */
const optionList = (arr) => arr.map((text, i) => ({ id: String.fromCharCode(97 + i), text: String(text) }));

function defFromSpec(spec, i) {
  if (!spec || typeof spec !== 'object') throw new Error(`Pregunta ${i + 1}: debe ser un objeto.`);
  if (spec.builtin) {
    const d = SAMPLE_BANK.find((x) => x.id === spec.builtin);
    if (!d) throw new Error(`Pregunta ${i + 1}: "builtin" desconocido "${spec.builtin}". Opciones: ${SAMPLE_BANK.map((x) => x.id).join(', ')}`);
    return d;
  }
  const id = String(spec.id || `p${i + 1}`);
  const need = (cond, msg) => { if (!cond) throw new Error(`Pregunta ${i + 1} (${id}): ${msg}`); };
  need(/^[A-Za-z0-9_-]{1,40}$/.test(id), '"id" solo admite letras, números, guion y guion bajo');
  need(typeof spec.prompt === 'string' && spec.prompt.trim(), 'falta "prompt" (el enunciado)');
  const topic = String(spec.topic || 'General');
  const explain = String(spec.explain || '');
  const prompt = spec.prompt.trim();
  const isIdx = (n, len) => Number.isInteger(n) && n >= 0 && n < len;
  const wrap = (type, data, key) => ({ id, custom: true, make: (rng) => ({ type, topic, prompt, data: data(rng), key, explain }) });

  switch (spec.type) {
    case 'single': {
      need(Array.isArray(spec.options) && spec.options.length >= 2 && spec.options.length <= 10, '"options" debe tener de 2 a 10 textos');
      need(isIdx(spec.answer, spec.options.length), '"answer" debe ser el número de la opción correcta, empezando en 0');
      const opts = optionList(spec.options);
      return wrap('single', (rng) => ({ options: rng.shuffle(opts) }), { answer: opts[spec.answer].id });
    }
    case 'multiple': {
      need(Array.isArray(spec.options) && spec.options.length >= 2 && spec.options.length <= 10, '"options" debe tener de 2 a 10 textos');
      need(Array.isArray(spec.answers) && spec.answers.length >= 1 && new Set(spec.answers).size === spec.answers.length && spec.answers.every((n) => isIdx(n, spec.options.length)),
        '"answers" debe listar los números (desde 0) de las opciones correctas, sin repetir');
      const opts = optionList(spec.options);
      return wrap('multiple', (rng) => ({ options: rng.shuffle(opts) }), { answers: spec.answers.map((n) => opts[n].id) });
    }
    case 'truefalse':
      need(typeof spec.answer === 'boolean', '"answer" debe ser true o false');
      return wrap('truefalse', () => ({}), { answer: spec.answer });
    case 'numeric': {
      need(typeof spec.answer === 'number' && Number.isFinite(spec.answer), '"answer" debe ser un número');
      const tol = spec.tol === undefined ? 0 : Number(spec.tol);
      need(Number.isFinite(tol) && tol >= 0, '"tol" (tolerancia) debe ser un número mayor o igual a 0');
      return wrap('numeric', () => ({ unit: spec.unit ? String(spec.unit) : '', ...(spec.hint ? { hint: String(spec.hint) } : {}) }), { answer: spec.answer, tol });
    }
    case 'text':
      need(Array.isArray(spec.accepted) && spec.accepted.length >= 1 && spec.accepted.every((t) => typeof t === 'string' && t.trim()), '"accepted" debe listar las respuestas aceptadas');
      return wrap('text', () => ({}), { accepted: spec.accepted });
    case 'ordering': {
      need(Array.isArray(spec.items) && spec.items.length >= 2 && spec.items.length <= 10, '"items" debe listar de 2 a 10 elementos, ESCRITOS EN EL ORDEN CORRECTO');
      const items = spec.items.map((text, k) => ({ id: `o${k + 1}`, text: String(text) }));
      return wrap('ordering', (rng) => ({ items: rng.shuffle(items) }), { order: items.map((x) => x.id) });
    }
    case 'matching': {
      need(Array.isArray(spec.pairs) && spec.pairs.length >= 2 && spec.pairs.length <= 10 && spec.pairs.every((pr) => Array.isArray(pr) && pr.length === 2),
        '"pairs" debe ser una lista de parejas [izquierda, derecha]');
      const extra = spec.distractors === undefined ? [] : spec.distractors;
      need(Array.isArray(extra) && extra.length <= 6 && extra.every((t) => typeof t === 'string' && t.trim()),
        '"distractors" debe ser una lista de hasta 6 textos que no tienen pareja');
      const left = spec.pairs.map((pr, k) => ({ id: `l${k + 1}`, text: String(pr[0]) }));
      const right = spec.pairs.map((pr, k) => ({ id: `r${k + 1}`, text: String(pr[1]) }));
      const spare = extra.map((t, k) => ({ id: `rd${k + 1}`, text: t }));
      return wrap('matching', (rng) => ({ left: rng.shuffle(left), right: rng.shuffle([...right, ...spare]) }),
        { pairs: Object.fromEntries(left.map((l, k) => [l.id, right[k].id])) });
    }
    default:
      throw new Error(`Pregunta ${i + 1} (${id}): "type" desconocido "${spec.type}". Use single, multiple, truefalse, numeric, text, ordering o matching (o "builtin").`);
  }
}

/** Convierte el texto JSON de un examen en { bank, title }. Lanza Error con un mensaje claro. */
function parseExam(raw) {
  let spec;
  try { spec = JSON.parse(raw); } catch (e) { throw new Error(`El examen no es un JSON válido: ${e.message}`); }
  const list = Array.isArray(spec) ? spec : spec && spec.questions;
  if (!Array.isArray(list) || !list.length) throw new Error('El examen debe tener una lista "questions" con al menos una pregunta.');
  const bank = list.map(defFromSpec);
  const ids = bank.map((d) => d.id);
  const dup = ids.find((x, k) => ids.indexOf(x) !== k);
  if (dup) throw new Error(`El id "${dup}" está repetido.`);
  const meta = Array.isArray(spec) ? {} : spec;
  if (meta.intro !== undefined && !(Array.isArray(meta.intro) && meta.intro.every((t) => typeof t === 'string'))) {
    throw new Error('"intro" debe ser una lista de textos (las instrucciones que se muestran antes de comenzar).');
  }
  let durationMinutes = null;
  if (meta.durationMinutes !== undefined) {
    durationMinutes = Number(meta.durationMinutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 600) {
      throw new Error('"durationMinutes" debe ser un número de minutos entre 1 y 600.');
    }
  }
  return {
    bank,
    durationMinutes,
    title: meta.title ? String(meta.title) : null,
    course: meta.course ? String(meta.course) : null,
    intro: meta.intro || [],
    shuffleQuestions: meta.shuffleQuestions !== false,
  };
}

function loadPrivate() {
  let raw = null;
  const env = process.env;
  if (env.QUESTIONS_JSON_GZ_B64) raw = zlib.gunzipSync(Buffer.from(env.QUESTIONS_JSON_GZ_B64.trim(), 'base64')).toString('utf8');
  else if (env.QUESTIONS_JSON_B64) raw = Buffer.from(env.QUESTIONS_JSON_B64.trim(), 'base64').toString('utf8');
  else if (env.QUESTIONS_JSON) raw = env.QUESTIONS_JSON;
  else {
    const file = env.QUESTIONS_FILE || (fs.existsSync('/etc/secrets/questions.json') ? '/etc/secrets/questions.json' : null);
    if (file) raw = fs.readFileSync(file, 'utf8');
  }
  return raw ? parseExam(raw) : null;
}

/**
 * Exámenes disponibles:
 *   prueba  Banco de ejemplo (MIE), público, retroalimentación siempre visible. Ruta /prueba
 *   parcial Examen real cargado desde el entorno (privado). Ruta /
 */
const EXAMS = {
  prueba: {
    id: 'prueba',
    name: 'Examen de prueba',
    bank: SAMPLE_BANK,
    title: 'Examen de prueba · Manejo Integrado de Enfermedades',
    course: 'Manejo Integrado de Enfermedades',
    intro: ['Este es un examen de práctica para que pruebe la plataforma. No tiene valor académico y sus respuestas son públicas.'],
    shuffleQuestions: true,
    durationMinutes: null,
    public: true,
    source: 'sample',
  },
};
let privateExam = null;
try {
  privateExam = loadPrivate();
} catch (e) {
  // Mejor no arrancar que abrir el examen equivocado el día del parcial.
  throw new Error(`No se pudo cargar el examen privado: ${e.message}`);
}
if (privateExam) EXAMS.parcial = { id: 'parcial', name: 'Parcial', ...privateExam, public: false, source: 'private' };
const DEFAULT_EXAM = EXAMS.parcial ? 'parcial' : 'prueba';
const getExam = (id) => EXAMS[id] || null;

/* ------------------------- construcción del intento ---------------------- */

function buildQuestions(seed, examId = DEFAULT_EXAM) {
  const exam = EXAMS[examId];
  if (!exam) throw new Error(`Examen desconocido: ${examId}`);
  const built = exam.bank.map((def) => {
    const q = def.make(makeRng(`${seed}:${def.id}`));
    const explain = q.explain !== undefined ? q.explain : (def.custom ? '' : EXPLAIN[def.id] || '');
    return { id: def.id, ...q, explain };
  });
  return exam.shuffleQuestions ? makeRng(`${seed}:orden`).shuffle(built) : built;
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

module.exports = { EXAMS, DEFAULT_EXAM, getExam, parseExam, makeRng, buildQuestions, publicView, correctView, sanitizeAnswer, gradeAttempt, gradeQuestion };
