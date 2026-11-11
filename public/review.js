'use strict';
/**
 * Revisión de respuestas (retroalimentación). La usan la pantalla final del
 * estudiante y el panel del profesor. Expone window.MieReview.render().
 */
(() => {
  function rich(str) {
    const frag = document.createDocumentFragment();
    String(str).split(/\*([^*]+)\*/).forEach((part, i) => {
      if (!part) return;
      if (i % 2) { const it = document.createElement('i'); it.textContent = part; frag.append(it); }
      else frag.append(document.createTextNode(part));
    });
    return frag;
  }

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'rich') n.append(rich(v));
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }

  const num = (n) => Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 });
  const points = (f) => (f === 1 ? 'Correcta' : f === 0 ? 'Incorrecta' : 'Parcial');
  const optionText = (q, id) => q.data.options.find((o) => o.id === id)?.text ?? '';

  /** Una línea "Etiqueta: valor" con marca de acierto opcional. */
  const line = (label, value, state) =>
    el('p', { class: `rv-line${state ? ` ${state}` : ''}` },
      el('strong', { text: `${label}: ` }),
      typeof value === 'string' ? el('span', { rich: value }) : value);

  const BODY = {
    single(q) {
      const mine = q.answer;
      return el('ul', { class: 'rv-options' }, q.data.options.map((o) => {
        const isCorrect = o.id === q.correct.answer;
        const isMine = o.id === mine;
        return el('li', { class: isCorrect ? 'ok' : isMine ? 'bad' : '' },
          el('span', { class: 'rv-mark', text: isCorrect ? '✓' : isMine ? '✗' : '' }),
          el('span', { rich: o.text }),
          isMine ? el('em', { class: 'rv-tag', text: 'su respuesta' }) : null);
      }));
    },

    multiple(q) {
      const mine = new Set(q.answer || []);
      const good = new Set(q.correct.answers);
      return el('ul', { class: 'rv-options' }, q.data.options.map((o) => {
        const cls = good.has(o.id) ? 'ok' : mine.has(o.id) ? 'bad' : '';
        const mark = good.has(o.id) ? '✓' : mine.has(o.id) ? '✗' : '';
        return el('li', { class: cls },
          el('span', { class: 'rv-mark', text: mark }),
          el('span', { rich: o.text }),
          mine.has(o.id) ? el('em', { class: 'rv-tag', text: 'su respuesta' }) : null);
      }));
    },

    truefalse(q) {
      const word = (v) => (v === true ? 'Verdadero' : v === false ? 'Falso' : 'Sin responder');
      return el('div', {},
        line('Su respuesta', word(q.answer), q.answer === q.correct.answer ? 'ok' : 'bad'),
        line('Respuesta correcta', word(q.correct.answer)));
    },

    numeric(q) {
      const unit = q.data.unit ? ` ${q.data.unit}` : '';
      return el('div', {},
        line('Su respuesta', q.answer == null ? 'Sin responder' : `${q.answer}${unit}`, q.fraction === 1 ? 'ok' : 'bad'),
        line('Respuesta correcta', `${num(q.correct.answer)}${unit} (se acepta ±${num(q.correct.tol)})`));
    },

    text(q) {
      return el('div', {},
        line('Su respuesta', q.answer == null ? 'Sin responder' : q.answer, q.fraction === 1 ? 'ok' : 'bad'),
        line('Respuestas aceptadas', q.correct.accepted.join(', ')));
    },

    ordering(q) {
      const text = Object.fromEntries(q.data.items.map((i) => [i.id, i.text]));
      const mine = q.answer || [];
      return el('div', { class: 'rv-cols' },
        el('div', {}, el('h4', { text: 'Su orden' }),
          mine.length
            ? el('ol', { class: 'rv-options' }, mine.map((id, i) => el('li', { class: id === q.correct.order[i] ? 'ok' : 'bad' },
              el('span', { class: 'rv-mark', text: id === q.correct.order[i] ? '✓' : '✗' }), el('span', { rich: text[id] }))))
            : el('p', { class: 'muted', text: 'Sin responder' })),
        el('div', {}, el('h4', { text: 'Orden correcto' }),
          el('ol', { class: 'rv-options' }, q.correct.order.map((id) => el('li', {}, el('span', { class: 'rv-mark' }), el('span', { rich: text[id] }))))));
    },

    matching(q) {
      const left = Object.fromEntries(q.data.left.map((i) => [i.id, i.text]));
      const right = Object.fromEntries(q.data.right.map((i) => [i.id, i.text]));
      const mine = q.answer || {};
      return el('ul', { class: 'rv-options' }, Object.entries(q.correct.pairs).map(([l, r]) => {
        const ok = mine[l] === r;
        return el('li', { class: ok ? 'ok' : 'bad' },
          el('span', { class: 'rv-mark', text: ok ? '✓' : '✗' }),
          el('span', {}, el('span', { rich: left[l] }), ' → ', el('span', { rich: right[r] }),
            ok ? null : el('em', { class: 'rv-tag', text: mine[l] ? `usted: ${right[mine[l]]}` : 'sin responder' })));
      }));
    },

    graph_click(q) {
      return el('div', {},
        line('Su respuesta', q.answer == null ? 'Sin responder' : `día ${num(q.answer)}`, q.fraction === 1 ? 'ok' : 'bad'),
        line('Respuesta correcta', `día ${num(q.correct.answer)} (se acepta ±${num(q.correct.tol)} días)`));
    },

    simulator(q) {
      return el('div', {},
        line('Su respuesta', q.answer == null ? 'Sin responder' : `aplicar el día ${q.answer}`, q.fraction === 1 ? 'ok' : q.fraction > 0 ? 'part' : 'bad'),
        line('Último día posible', `día ${q.correct.answer}`));
    },
  };

  function render(container, review) {
    const total = review.reduce((a, q) => a + q.fraction, 0);
    container.replaceChildren(
      el('h2', { text: 'Revisión de respuestas' }),
      el('p', { class: 'muted', text: `Puntaje: ${num(total)} de ${review.length}. ✓ indica la respuesta correcta y ✗ lo que respondió el estudiante cuando no coincide.` }),
      ...review.map((q, i) => el('article', { class: `rv-q ${q.fraction === 1 ? 'full' : q.fraction === 0 ? 'zero' : 'half'}` },
        el('div', { class: 'rv-head' },
          el('span', { class: 'rv-n', text: `Pregunta ${i + 1}` }),
          el('span', { class: 'chip', text: q.topic }),
          el('span', { class: 'rv-score', text: `${points(q.fraction)} · ${num(q.fraction)} / 1` })),
        el('p', { class: 'rv-prompt', rich: q.prompt }),
        BODY[q.type](q),
        q.explain ? el('p', { class: 'rv-explain' }, el('strong', { text: 'Explicación: ' }), el('span', { rich: q.explain })) : null)));
  }

  window.MieReview = { render };
})();
