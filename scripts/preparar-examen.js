#!/usr/bin/env node
'use strict';
/**
 * Valida un examen en JSON y lo convierte a base64 para guardarlo como
 * variable de entorno privada (QUESTIONS_JSON_B64) en el hosting.
 *
 *   node scripts/preparar-examen.js examen.private.json
 *
 * No imprime las respuestas correctas.
 */
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../lib/questions');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/preparar-examen.js ruta/al/examen.json');
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

console.log(`Examen válido: ${bank.length} preguntas.`);
console.log('Por tipo:', Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join(', '));
const sinExplicacion = built.map((q, i) => (q.explain ? null : i + 1)).filter(Boolean);
if (sinExplicacion.length) console.log(`Aviso: sin explicación las preguntas ${sinExplicacion.join(', ')} (la retroalimentación mostrará solo la respuesta correcta).`);

const out = path.join(path.dirname(file), `${path.basename(file, '.json')}.b64.txt`);
const b64 = Buffer.from(raw, 'utf8').toString('base64');
fs.writeFileSync(out, b64);
console.log(`\nValor listo para pegar en la variable QUESTIONS_JSON_B64: ${out} (${b64.length} caracteres)`);
console.log('NO suba ese archivo ni el JSON a GitHub (el .gitignore ya los excluye).');
