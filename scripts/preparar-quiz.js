#!/usr/bin/env node
'use strict';
/**
 * Valida un quiz en JSON y lo convierte a base64 para guardarlo como
 * variable de entorno privada (QUESTIONS_JSON_B64) en el hosting.
 *
 *   node scripts/preparar-quiz.js quiz.private.json
 *
 * No imprime las respuestas correctas.
 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const Q = require('../lib/questions');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/preparar-quiz.js ruta/al/quiz.json');
  process.exit(1);
}
const raw = fs.readFileSync(file, 'utf8');
let bank;
try {
  ({ bank } = Q.parseExam(raw));
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
const rng = Q.makeRng('validacion');
const built = bank.map((d) => d.make(rng));
const porTipo = {};
for (const q of built) porTipo[q.type] = (porTipo[q.type] || 0) + 1;

console.log(`Quiz válido: ${bank.length} preguntas.`);
console.log('Por tipo:', Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join(', '));
const sinExplicacion = built.map((q, i) => (q.explain ? null : i + 1)).filter(Boolean);
if (sinExplicacion.length) console.log(`Aviso: sin explicación las preguntas ${sinExplicacion.join(', ')} (la retroalimentación mostrará solo la respuesta correcta).`);

const out = path.join(path.dirname(file), `${path.basename(file, '.json')}.b64.txt`);
const b64 = Buffer.from(raw, 'utf8').toString('base64');
fs.writeFileSync(out, b64);
const gzOut = path.join(path.dirname(file), `${path.basename(file, '.json')}.gz.b64.txt`);
const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 9 }).toString('base64');
fs.writeFileSync(gzOut, gz);
console.log(`\nOpción corta (recomendada): variable QUESTIONS_JSON_GZ_B64 con el contenido de ${gzOut} (${gz.length} caracteres)`);
console.log(`Opción larga: variable QUESTIONS_JSON_B64 con el contenido de ${out} (${b64.length} caracteres)`);
console.log('NO suba ese archivo ni el JSON a GitHub (el .gitignore ya los excluye).');
