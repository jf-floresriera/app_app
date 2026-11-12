'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let password = '';
  let data = { rows: [], questionIds: [], exams: [], settings: {} };
  let currentExam = '';

  const STATUS = { ready: 'Sin iniciar', in_progress: 'En curso', submitted: 'Enviado', annulled: 'Anulado' };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('es-CO', { hour12: false }) : '');

  async function call(path, opts = {}) {
    const res = await fetch(`/api/admin/${path}`, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Error');
    return json;
  }

  async function load() {
    data = await call(`results${currentExam ? `?exam=${encodeURIComponent(currentExam)}` : ''}`);
    currentExam = data.exam;
    const sel = $('exam-select');
    sel.replaceChildren(...data.exams.map((e) => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = `${e.name}${e.public ? ' (público)' : ' (privado)'}${e.id === data.defaultExam ? ' · ruta /' : ` · ruta /${e.id}`}`;
      o.selected = e.id === currentExam;
      return o;
    }));
    render();
  }
  $('exam-select').addEventListener('change', (ev) => { currentExam = ev.target.value; load(); });

  function renderFeedback() {
    const on = !!(data.settings && data.settings.feedbackReleased);
    const fixed = !!(data.settings && data.settings.alwaysVisible);
    $('fb-toggle').classList.toggle('hidden', fixed);
    if (fixed) {
      $('fb-status').textContent = 'Examen de prueba: la retroalimentación es siempre visible para los estudiantes.';
      return;
    }
    $('fb-status').textContent = on
      ? 'Retroalimentación VISIBLE: los estudiantes ven las respuestas correctas al ingresar.'
      : 'Retroalimentación OCULTA: los estudiantes solo ven su nota. Usted siempre puede verla con "Ver respuestas".';
    $('fb-toggle').textContent = on ? 'Ocultar de nuevo' : 'Liberar a los estudiantes';
    $('fb-toggle').dataset.released = String(on);
  }

  $('fb-toggle').addEventListener('click', async () => {
    const release = $('fb-toggle').dataset.released !== 'true';
    const msg = release
      ? '¿Liberar la retroalimentación? Los estudiantes que ya enviaron podrán ver las respuestas correctas. Hágalo cuando todos los grupos hayan terminado.'
      : '¿Ocultar la retroalimentación a los estudiantes?';
    if (!window.confirm(msg)) return;
    try {
      await call('feedback', { method: 'POST', body: { exam: currentExam, released: release } });
      await load();
    } catch (ex) {
      window.alert(ex.message);
    }
  });

  function render() {
    renderFeedback();
    const q = $('filter').value.trim().toLowerCase();
    const rows = data.rows
      .filter((r) => !q || `${r.name} ${r.email} ${r.document}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const done = data.rows.filter((r) => r.status === 'submitted');
    const avg = done.length ? (done.reduce((a, r) => a + r.grade, 0) / done.length).toFixed(2) : '—';
    $('summary').textContent = `${data.rows.length} estudiantes · ${done.length} enviados · promedio ${avg}`;

    $('rows').replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      const cells = [
        r.document, r.name, r.email, null,
        r.grade == null ? '' : r.grade.toFixed(1),
        r.score == null ? '' : `${r.score}/${r.total}`,
        r.restarts, r.violations.length, fmtDate(r.startedAt), fmtDate(r.submittedAt),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 3) {
          const b = document.createElement('span');
          b.className = `badge ${r.status}`;
          b.textContent = STATUS[r.status] || r.status;
          td.append(b);
        } else {
          td.textContent = c;
        }
        if (i === 7 && r.violations.length) td.title = r.violations.map((v) => `${fmtDate(v.at)} · ${v.type}`).join('\n');
        tr.append(td);
      });
      const act = document.createElement('td');
      if (r.status === 'submitted' || r.status === 'annulled') {
        const view = document.createElement('button');
        view.className = 'btn';
        view.textContent = 'Ver respuestas';
        view.onclick = () => openReview(r);
        act.append(view, ' ');
      }
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Reabrir';
      btn.title = 'Borra el intento para que el estudiante pueda presentar de nuevo';
      btn.onclick = async () => {
        if (!window.confirm(`¿Reabrir el intento de ${r.name}? Se borrará su resultado actual.`)) return;
        await call('reset', { method: 'POST', body: { exam: currentExam, document: r.document } });
        load();
      };
      act.append(btn);
      tr.append(act);
      return tr;
    }));
  }

  async function openReview(r) {
    try {
      const d = await call(`review?exam=${encodeURIComponent(currentExam)}&document=${encodeURIComponent(r.document)}`);
      $('detail-title').textContent = `${d.name} · nota ${d.grade.toFixed(1)} (${d.score}/${d.total})`;
      window.MieReview.render($('detail-body'), d.review);
      $('detail').classList.remove('hidden');
      $('detail').scrollIntoView({ behavior: 'smooth' });
    } catch (ex) {
      window.alert(ex.message);
    }
  }
  $('detail-close').addEventListener('click', () => $('detail').classList.add('hidden'));

  // Evita que Excel interprete celdas como fórmulas (=, +, -, @).
  const csvCell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  function downloadCsv() {
    const head = ['documento', 'nombre', 'correo', 'estado', 'nota', 'puntos', 'total', 'reinicios', 'infracciones', 'tipos_infraccion', 'inicio', 'envio', ...data.questionIds];
    const lines = [head.map(csvCell).join(',')];
    for (const r of data.rows) {
      const perQ = Object.fromEntries((r.detail || []).map((d) => [d.id, d.fraction]));
      lines.push([
        r.document, r.name, r.email, STATUS[r.status], r.grade, r.score, r.total, r.restarts, r.violations.length,
        r.violations.map((v) => v.type).join('|'), fmtDate(r.startedAt), fmtDate(r.submittedAt),
        ...data.questionIds.map((id) => perQ[id] ?? ''),
      ].map(csvCell).join(','));
    }
    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `resultados-${currentExam}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $('gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    password = $('pw').value;
    try {
      await load();
      $('gate').classList.add('hidden');
      $('panel').classList.remove('hidden');
    } catch (ex) {
      $('gate-error').textContent = ex.message;
      $('gate-error').classList.remove('hidden');
    }
  });
  $('refresh').addEventListener('click', load);
  $('filter').addEventListener('input', render);
  $('csv').addEventListener('click', downloadCsv);
})();
