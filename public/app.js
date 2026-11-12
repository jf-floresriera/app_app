'use strict';
(() => {
  /* ---------------------------------------------------------------------- */
  /* Utilidades                                                              */
  /* ---------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Convierte *texto* en cursiva (<i>) sin usar innerHTML. */
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
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }

  function svgEl(tag, attrs = {}, text) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  };

  /* ---------------------------------------------------------------------- */
  /* Estado                                                                  */
  /* ---------------------------------------------------------------------- */
  // El examen se elige por la ruta: / (examen vigente), /prueba (examen de prueba), /examen...
  const pathExam = (/^\/([a-z0-9_-]+)\/?$/.exec(window.location.pathname) || [])[1];
  const examRequested = pathExam && pathExam !== 'admin' ? pathExam : null;
  const TOKEN_KEY = `mie_token:${examRequested || 'default'}`;
  let token = sessionStorage.getItem(TOKEN_KEY) || null; // por pestaña
  let st = null;            // último estado entregado por el servidor
  let answers = {};
  let current = 0;
  let screen = 'login';
  let monitoring = false;
  let needFullscreen = false;
  let handlingViolation = false;
  let timerEnd = 0;
  let timerHandle = null;
  let heartbeatHandle = null;
  const dirty = new Set();
  const saveTimers = new Map();
  const tabId = Math.random().toString(36).slice(2);
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mie-quiz') : null;

  async function api(path, { method = 'GET', body, keepalive = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/${path}`, {
        method, headers, keepalive, cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('network'), { network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'error'), { status: res.status, data });
    return data;
  }

  function setWatermark(on) {
    const w = $('watermark');
    if (!on || !st || !st.name) { w.classList.add('hidden'); return; }
    const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const label = esc(`${st.name} · ${st.document || ''}`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220"><text x="12" y="130" transform="rotate(-24 210 110)" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#0e3b22" fill-opacity="0.11">${label}</text></svg>`;
    w.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
    w.classList.remove('hidden');
  }

  function show(name) {
    screen = name;
    setWatermark(name === 'quiz' || name === 'done');
    if (name === 'quiz') document.body.classList.remove('obscured');
    for (const n of ['login', 'intro', 'quiz', 'done', 'block']) $(`screen-${n}`).classList.toggle('hidden', n !== name);
    $('timer').classList.toggle('hidden', name !== 'quiz');
    window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Pantalla completa                                                       */
  /* ---------------------------------------------------------------------- */
  const fsSupported = () => !!(document.documentElement.requestFullscreen && document.fullscreenEnabled);
  function requestFs() {
    if (!fsSupported()) return Promise.resolve();
    return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  function exitFs() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  /* ---------------------------------------------------------------------- */
  /* Ingreso                                                                 */
  /* ---------------------------------------------------------------------- */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.classList.add('hidden');
    const btn = $('login-btn');
    btn.disabled = true;
    try {
      const data = await api('login', {
        method: 'POST',
        body: { name: $('f-name').value, email: $('f-email').value, document: $('f-document').value, exam: examRequested },
      });
      token = data.token;
      if (token) {
        sessionStorage.setItem(TOKEN_KEY, token);
        channel?.postMessage({ t: 'login', id: tabId, exam: data.exam });
      } else {
        sessionStorage.removeItem(TOKEN_KEY);
      }
      applyState(data);
    } catch (ex) {
      err.textContent = ex.network ? 'No hay conexión con el servidor. Intente de nuevo.' : ex.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  channel?.addEventListener('message', (ev) => {
    if (ev.data?.t === 'login' && ev.data.id !== tabId && st && ev.data.exam === st.exam && token && (screen === 'quiz' || screen === 'intro')) {
      showDisplaced();
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Enrutamiento según el estado del servidor                               */
  /* ---------------------------------------------------------------------- */
  function applyState(data) {
    st = data;
    answers = data.answers || {};
    if (data.status === 'submitted') return showDone(data);
    if (data.status === 'annulled') return showAnnulled(data);
    showIntro(data);
    startHeartbeat();
  }

  function showIntro(data) {
    stopMonitoring();
    const inProgress = data.status === 'in_progress';
    $('intro-title').textContent = `Hola, ${data.name}`;
    $('intro-text').textContent = inProgress
      ? 'Su evaluación está en curso. El reloj sigue corriendo.'
      : 'Lea las condiciones antes de comenzar.';
    const notice = $('intro-notice');
    if (data.restarts > 0) {
      notice.textContent = `Su evaluación se reinició ${data.restarts} ${data.restarts === 1 ? 'vez' : 'veces'}. Infracciones registradas: ${data.violations} de ${data.maxViolations || '∞'}.`;
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }
    const facts = $('intro-facts');
    const custom = (data.examIntro || []).map((t) => el('li', { text: t }));
    facts.replaceChildren(
      ...custom,
      el('li', { text: `Duración total en esta aplicación: ${Math.round(data.durationMs / 60000)} minutos. El reloj inicia al comenzar y no se detiene.` }),
      inProgress ? el('li', { text: `Tiempo restante: ${fmtTime(data.remainingMs)}.` }) : null,
      custom.length ? null : el('li', { text: 'Tipos de pregunta: selección única y múltiple, verdadero/falso, numéricas con valores propios, ordenar, relacionar, gráficos y simuladores interactivos.' }),
      el('li', { text: 'No salga de la pantalla, no cambie de pestaña ni de ventana y no copie ni pegue. Cualquiera de esas acciones reinicia la evaluación.' }),
    );
    $('intro-start').textContent = inProgress ? 'Continuar evaluación' : 'Comenzar evaluación';
    show('intro');
  }

  function showDone(data) {
    stopMonitoring();
    stopTimers();
    exitFs();
    $('done-title').textContent = 'Evaluación enviada';
    $('done-text').textContent = `${data.name}, sus respuestas quedaron registradas. Ya puede cerrar esta ventana.`;
    $('done-result').replaceChildren(
      el('div', { class: 'grade' }, document.createTextNode(Number(data.grade).toFixed(1)), el('small', { text: ' / 5.0' })),
      el('div', { class: 'sub', text: `${data.score} de ${data.total} puntos` }),
    );
    const box = $('done-review');
    if (data.review && window.MieReview) {
      window.MieReview.render(box, data.review);
    } else if (data.status === 'submitted') {
      box.replaceChildren(
        el('div', { class: 'notice', role: 'status', text: 'La retroalimentación (respuestas correctas y explicaciones) estará disponible cuando el profesor la publique. Cuando lo haga, vuelva a ingresar con sus datos o pulse el botón.' }),
        el('button', { class: 'btn', type: 'button', text: 'Consultar retroalimentación', onclick: () => window.location.reload() }),
      );
    } else {
      box.replaceChildren();
    }
    show('done');
  }

  function showBlock(title, text, actionLabel, action) {
    $('block-title').textContent = title;
    $('block-text').textContent = text;
    const btn = $('block-action');
    btn.classList.toggle('hidden', !actionLabel);
    if (actionLabel) {
      btn.textContent = actionLabel;
      btn.onclick = action;
    }
    show('block');
  }

  function showAnnulled(data) {
    stopMonitoring();
    stopTimers();
    exitFs();
    showBlock(
      'Intento anulado',
      `Se registraron ${data.violations} infracciones (salir de la pantalla, abrir otra pestaña o ventana, copiar o pegar). La calificación es 0.0. Comuníquese con el profesor si cree que fue un error.`,
    );
  }

  function showDisplaced() {
    stopMonitoring();
    stopTimers();
    exitFs();
    token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    showBlock(
      'Sesión abierta en otro lugar',
      'Se ingresó con sus datos desde otra pestaña, ventana o navegador. La evaluación se reinició y quedó registrada una infracción. Cierre esta ventana.',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Inicio / continuación de la evaluación                                  */
  /* ---------------------------------------------------------------------- */
  async function enterQuiz() {
    const fs = requestFs(); // debe invocarse dentro del gesto del usuario
    try {
      await fs;
      needFullscreen = !!document.fullscreenElement;
      const data = await api('start', { method: 'POST' });
      st = data;
      answers = data.answers || {};
      if (data.status !== 'in_progress') return applyState(data);
      current = 0;
      timerEnd = Date.now() + data.remainingMs;
      renderNav();
      renderQuestion();
      show('quiz');
      startTimer();
      setTimeout(() => { monitoring = true; }, 800);
    } catch (ex) {
      handleApiError(ex);
    }
  }
  $('intro-start').addEventListener('click', enterQuiz);

  function handleApiError(ex) {
    if (ex.status === 401) return showDisplaced();
    if (ex.network) {
      showBlock('Sin conexión', 'No se pudo comunicar con el servidor. Revise su internet e intente de nuevo.', 'Reintentar', enterQuiz);
      return;
    }
    showBlock('Error', ex.message || 'Ocurrió un error inesperado.', 'Reintentar', enterQuiz);
  }

  /* ---------------------------------------------------------------------- */
  /* Reloj y latido                                                          */
  /* ---------------------------------------------------------------------- */
  function startTimer() {
    clearInterval(timerHandle);
    const tick = () => {
      const left = timerEnd - Date.now();
      $('timer-value').textContent = fmtTime(left);
      $('timer').classList.toggle('low', left < 5 * 60 * 1000);
      if (left <= 0 && screen === 'quiz') {
        clearInterval(timerHandle);
        finish(true);
      }
    };
    tick();
    timerHandle = setInterval(tick, 500);
  }
  function stopTimers() {
    clearInterval(timerHandle);
    clearInterval(heartbeatHandle);
    timerHandle = heartbeatHandle = null;
  }

  function startHeartbeat() {
    clearInterval(heartbeatHandle);
    heartbeatHandle = setInterval(async () => {
      if (!token) return;
      try {
        await flushDirty();
        const hb = await api('heartbeat', { method: 'POST' });
        if (hb.status === 'submitted' || hb.status === 'annulled') {
          const data = await api('attempt');
          applyState(data);
        } else if (hb.status === 'in_progress' && screen === 'quiz') {
          timerEnd = Date.now() + hb.remainingMs;
        }
      } catch (ex) {
        if (ex.status === 401) showDisplaced();
      }
    }, 5000);
  }

  /* ---------------------------------------------------------------------- */
  /* Antitrampas                                                             */
  /* ---------------------------------------------------------------------- */
  function stopMonitoring() {
    monitoring = false;
  }

  const REASONS = {
    tab_hidden: 'Se detectó un cambio de pestaña, ventana o aplicación.',
    window_blur: 'La ventana de la evaluación perdió el foco.',
    fullscreen_exit: 'Se salió de la pantalla completa.',
    devtools_key: 'Se intentó abrir las herramientas del navegador.',
    print: 'Se intentó imprimir o guardar la página.',
    screenshot: 'Se detectó un intento de captura de pantalla.',
    other: 'Se detectó una acción no permitida.',
  };

  async function violation(type) {
    if (!monitoring || handlingViolation) return;
    handlingViolation = true;
    stopMonitoring();
    exitFs();
    showBlock('Salida detectada', 'Registrando la infracción…');
    try {
      const data = await api('violation', { method: 'POST', body: { type }, keepalive: true });
      st = data;
      if (data.status === 'annulled') return showAnnulled(data);
      if (data.status === 'submitted') return showDone(data);
      showBlock(
        'La evaluación se reinició',
        `${REASONS[type] || REASONS.other} Se borraron sus respuestas, las preguntas cambiaron de valores y de orden, y el tiempo sigue corriendo. Infracciones: ${data.violations} de ${data.maxViolations || '∞'}.`,
        'Volver a empezar',
        enterQuiz,
      );
    } catch (ex) {
      if (ex.status === 401) showDisplaced();
      else showBlock('Salida detectada', 'No se pudo registrar la infracción por falta de conexión. Al reconectar, la evaluación se reiniciará.', 'Reintentar', enterQuiz);
    } finally {
      handlingViolation = false;
    }
  }

  // Al perder el foco se oculta el contenido de inmediato; si el foco vuelve pronto se muestra de nuevo.
  const obscure = (on) => document.body.classList.toggle('obscured', on && monitoring);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { obscure(true); violation('tab_hidden'); }
  });
  window.addEventListener('blur', () => {
    obscure(true);
    setTimeout(() => { if (!document.hasFocus()) violation('window_blur'); else obscure(false); }, 350);
  });
  window.addEventListener('focus', () => { if (!handlingViolation) obscure(false); });
  document.addEventListener('fullscreenchange', () => {
    if (needFullscreen && !document.fullscreenElement) violation('fullscreen_exit');
  });
  window.addEventListener('beforeprint', () => violation('print'));

  // Copiar, cortar, menú contextual y arrastrar: siempre bloqueados.
  for (const evt of ['copy', 'cut', 'contextmenu', 'dragstart', 'drop']) {
    document.addEventListener(evt, (e) => e.preventDefault());
  }
  // Pegar: permitido solo en la pantalla de ingreso.
  document.addEventListener('paste', (e) => { if (screen !== 'login') e.preventDefault(); });
  document.addEventListener('beforeinput', (e) => {
    if (screen !== 'login' && /^insertFrom(Paste|Drop|Yank)/.test(e.inputType)) e.preventDefault();
  });
  document.addEventListener('selectstart', (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });
  window.open = () => null;

  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F12' || (mod && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k))) {
      e.preventDefault();
      violation('devtools_key');
      return;
    }
    if (screen === 'login') return;
    // Capturas: PrintScreen, Win+Shift+S (Recortes), Cmd+Shift+3/4/5 (macOS)
    if (e.key === 'PrintScreen' || (e.metaKey && e.shiftKey && (k === 's' || ['Digit3', 'Digit4', 'Digit5'].includes(e.code)))) {
      e.preventDefault();
      navigator.clipboard?.writeText('').catch(() => {});
      violation('screenshot');
      return;
    }
    if (mod && ['c', 'x', 'v', 'a', 'p', 's', 'u', 'f', 'g'].includes(k)) {
      e.preventDefault();
      if (k === 'p' || k === 's') violation('print');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen') {
      navigator.clipboard?.writeText('').catch(() => {});
      violation('screenshot');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Guardado de respuestas                                                  */
  /* ---------------------------------------------------------------------- */
  const setSaved = (msg) => { $('q-saved').textContent = msg; };

  async function saveAnswer(id) {
    const value = answers[id] === undefined ? null : answers[id];
    try {
      await api('answer', { method: 'POST', body: { id, value } });
      dirty.delete(id);
      if (!dirty.size) setSaved('Respuesta guardada ✓');
    } catch (ex) {
      if (ex.status === 401) return showDisplaced();
      if (ex.status === 409 && ex.data?.status) return applyState(ex.data);
      dirty.add(id);
      setSaved('Sin conexión: se reintentará');
    }
  }
  async function flushDirty() {
    for (const id of [...dirty]) await saveAnswer(id);
  }

  function setAnswer(id, value, immediate = true) {
    const empty = value == null || value === '' || (Array.isArray(value) && !value.length) ||
      (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
    if (empty) delete answers[id]; else answers[id] = value;
    dirty.add(id);
    setSaved('Guardando…');
    updateNav();
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => saveAnswer(id), immediate ? 0 : 500));
  }

  /* ---------------------------------------------------------------------- */
  /* Navegación entre preguntas                                              */
  /* ---------------------------------------------------------------------- */
  function renderNav() {
    const nav = $('q-nav');
    nav.replaceChildren(...st.questions.map((q, i) =>
      el('button', { type: 'button', 'aria-label': `Pregunta ${i + 1}`, text: String(i + 1), onclick: () => goTo(i) })));
    updateNav();
  }
  function updateNav() {
    [...$('q-nav').children].forEach((b, i) => {
      const q = st.questions[i];
      b.classList.toggle('answered', answers[q.id] !== undefined);
      b.classList.toggle('current', i === current);
    });
  }
  function goTo(i) {
    current = Math.max(0, Math.min(st.questions.length - 1, i));
    renderQuestion();
  }
  $('q-prev').addEventListener('click', () => goTo(current - 1));
  $('q-next').addEventListener('click', () => goTo(current + 1));

  function renderQuestion() {
    const q = st.questions[current];
    $('q-count').textContent = `Pregunta ${current + 1} de ${st.questions.length}`;
    $('q-topic').textContent = q.topic;
    $('q-prompt').replaceChildren(rich(q.prompt));
    $('q-prev').disabled = current === 0;
    $('q-next').classList.toggle('hidden', current === st.questions.length - 1);
    setSaved('');
    const ctx = {
      get: () => answers[q.id],
      set: (v, immediate = true) => setAnswer(q.id, v, immediate),
      redraw: () => renderQuestion(),
    };
    $('q-body').replaceChildren(RENDERERS[q.type](q, ctx));
    updateNav();
  }

  /* ---------------------------------------------------------------------- */
  /* Renderizadores por tipo de pregunta                                     */
  /* ---------------------------------------------------------------------- */
  const noAssist = { autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' };

  function optionButton(text, selected, kind, onclick) {
    return el('button', {
      type: 'button', class: `opt${selected ? ' selected' : ''}`,
      role: kind === 'round' ? 'radio' : 'checkbox', 'aria-checked': String(selected), onclick,
    }, el('span', { class: `mark ${kind}` }), el('span', { rich: text }));
  }

  const RENDERERS = {
    single(q, ctx) {
      const val = ctx.get();
      return el('div', { class: 'options', role: 'radiogroup' },
        q.data.options.map((o) => optionButton(o.text, val === o.id, 'round', () => { ctx.set(o.id); ctx.redraw(); })));
    },

    multiple(q, ctx) {
      const val = ctx.get() || [];
      return el('div', { class: 'options', role: 'group' },
        el('p', { class: 'muted small', text: 'Puede seleccionar varias opciones.' }),
        q.data.options.map((o) => optionButton(o.text, val.includes(o.id), 'square', () => {
          ctx.set(val.includes(o.id) ? val.filter((x) => x !== o.id) : [...val, o.id]);
          ctx.redraw();
        })));
    },

    truefalse(q, ctx) {
      const val = ctx.get();
      const mk = (label, v) => optionButton(label, val === v, 'round', () => { ctx.set(v); ctx.redraw(); });
      return el('div', { class: 'options tf', role: 'radiogroup' }, mk('Verdadero', true), mk('Falso', false));
    },

    numeric(q, ctx) {
      const input = el('input', {
        type: 'text', inputmode: 'decimal', maxlength: '12', 'aria-label': 'Respuesta numérica',
        placeholder: 'Escriba un número', value: ctx.get() ?? '', ...noAssist,
      });
      input.addEventListener('input', () => {
        input.value = input.value.replace(/[^0-9.,-]/g, '');
        ctx.set(input.value.trim() || null, false);
      });
      return el('div', {},
        q.data.hint ? el('p', { class: 'hint', text: q.data.hint }) : null,
        el('div', { class: 'answer-row' }, input, el('span', { class: 'unit', text: q.data.unit || '' })));
    },

    text(q, ctx) {
      const input = el('input', {
        type: 'text', maxlength: '300', 'aria-label': 'Respuesta escrita', placeholder: 'Escriba su respuesta',
        value: ctx.get() ?? '', ...noAssist,
      });
      input.addEventListener('input', () => ctx.set(input.value.trim() || null, false));
      return el('div', { class: 'answer-row' }, input);
    },

    ordering(q, ctx) {
      const byId = Object.fromEntries(q.data.items.map((i) => [i.id, i]));
      const order = ctx.get() || q.data.items.map((i) => i.id);
      const move = (i, d) => {
        const next = order.slice();
        [next[i], next[i + d]] = [next[i + d], next[i]];
        ctx.set(next);
        ctx.redraw();
      };
      return el('div', {},
        el('ol', { class: 'order-list' }, order.map((id, i) =>
          el('li', {},
            el('span', { class: 'num', text: String(i + 1) }),
            el('span', { class: 'txt', rich: byId[id].text }),
            el('button', { type: 'button', 'aria-label': 'Subir', text: '▲', disabled: i === 0, onclick: () => move(i, -1) }),
            el('button', { type: 'button', 'aria-label': 'Bajar', text: '▼', disabled: i === order.length - 1, onclick: () => move(i, 1) })))),
        el('p', { class: 'muted small', text: ctx.get() ? 'Respuesta registrada.' : 'Su respuesta se registra al mover al menos un elemento.' }));
    },

    matching(q, ctx) {
      const pairs = { ...(ctx.get() || {}) };
      const leftById = Object.fromEntries(q.data.left.map((i) => [i.id, i]));
      const rightById = Object.fromEntries(q.data.right.map((i) => [i.id, i]));
      let picking = null;
      const box = el('div', { class: 'match' });

      function draw() {
        const usedRights = new Set(Object.values(pairs));
        const leftCol = el('div', { class: 'col' }, el('h3', { text: 'Patógeno' }),
          q.data.left.map((l) => el('button', {
            type: 'button',
            class: `opt${picking === l.id ? ' picking' : ''}${pairs[l.id] ? ' paired' : ''}`,
            onclick: () => { picking = picking === l.id ? null : l.id; draw(); },
          }, el('span', { rich: l.text }), pairs[l.id] ? el('small', {}, '→ ', rich(rightById[pairs[l.id]].text)) : null)));
        const rightCol = el('div', { class: 'col' }, el('h3', { text: 'Enfermedad' }),
          q.data.right.map((r) => el('button', {
            type: 'button',
            class: `opt${usedRights.has(r.id) ? ' used' : ''}`,
            onclick: () => {
              if (picking) {
                for (const k of Object.keys(pairs)) if (pairs[k] === r.id) delete pairs[k];
                pairs[picking] = r.id;
                picking = null;
              } else {
                for (const k of Object.keys(pairs)) if (pairs[k] === r.id) delete pairs[k];
              }
              ctx.set({ ...pairs });
              draw();
            },
          }, el('span', { rich: r.text }))));
        box.replaceChildren(leftCol, rightCol);
      }
      draw();
      return el('div', {}, box,
        el('p', { class: 'muted small', text: 'Toque un patógeno y luego su enfermedad. Toque una enfermedad ya usada (sin patógeno seleccionado) para quitar la pareja.' }));
    },

    graph_click(q, ctx) {
      const { y0, r, thr, xmax } = q.data;
      const f = (t) => 100 / (1 + ((1 - y0) / y0) * Math.exp(-r * t));
      const c = chartBase({ xmax });
      c.svg.append(
        svgEl('path', { d: curvePath(f, xmax, c.sx, c.sy), class: 'curve' }),
        svgEl('line', { x1: c.L, x2: c.W - c.R, y1: c.sy(thr), y2: c.sy(thr), class: 'thr' }),
        svgEl('text', { x: c.L + 8, y: c.sy(thr) - 6, class: 'thr-label' }, `Umbral de acción: ${thr}%`),
      );
      const marker = svgEl('line', { class: 'marker', y1: c.T, y2: c.H - c.B, visibility: 'hidden' });
      const dot = svgEl('circle', { r: 6, class: 'marker-dot', visibility: 'hidden' });
      c.svg.append(marker, dot);

      const slider = el('input', { type: 'range', min: '0', max: String(xmax), step: '0.5', value: '0', 'aria-label': 'Día seleccionado' });
      const readout = el('span', { class: 'readout' });

      function draw(v) {
        if (v == null) { readout.textContent = 'Haga clic sobre la gráfica o use el control.'; return; }
        for (const n of [marker, dot]) n.setAttribute('visibility', 'visible');
        marker.setAttribute('x1', c.sx(v)); marker.setAttribute('x2', c.sx(v));
        dot.setAttribute('cx', c.sx(v)); dot.setAttribute('cy', c.sy(f(v)));
        slider.value = v;
        readout.textContent = `Día seleccionado: ${v}`;
      }
      const pick = (x) => { const v = Math.round(x * 2) / 2; draw(v); ctx.set(v, false); };
      let dragging = false;
      c.svg.addEventListener('pointerdown', (e) => { dragging = true; c.svg.setPointerCapture(e.pointerId); pick(c.toX(e)); });
      c.svg.addEventListener('pointermove', (e) => { if (dragging) pick(c.toX(e)); });
      c.svg.addEventListener('pointerup', () => { dragging = false; });
      c.svg.addEventListener('pointercancel', () => { dragging = false; });
      slider.addEventListener('input', () => pick(Number(slider.value)));
      draw(ctx.get() ?? null);
      return el('div', {}, el('div', { class: 'chart-wrap' }, c.svg), el('div', { class: 'slider-row' }, slider, readout));
    },

    simulator(q, ctx) {
      const { y0, r, r2, T, L } = q.data;
      const l0 = Math.log(y0 / (1 - y0));
      const sev = (t, d) => 100 / (1 + Math.exp(-(t <= d ? l0 + r * t : l0 + r * d + r2 * (t - d))));
      const c = chartBase({ xmax: T, xstep: 5 });
      const untreated = svgEl('path', { d: curvePath((t) => sev(t, T), T, c.sx, c.sy, 0.25), class: 'curve-alt' });
      const treated = svgEl('path', { class: 'curve' });
      const marker = svgEl('line', { class: 'marker', y1: c.T, y2: c.H - c.B });
      c.svg.append(
        svgEl('line', { x1: c.L, x2: c.W - c.R, y1: c.sy(L), y2: c.sy(L), class: 'thr' }),
        svgEl('text', { x: c.L + 8, y: c.sy(L) - 6, class: 'thr-label' }, `Límite aceptable: ${L}%`),
        untreated, treated, marker,
        svgEl('text', { x: c.L + 10, y: c.T + 16 }, '— con aplicación    - - sin aplicación'),
      );
      const slider = el('input', { type: 'range', min: '0', max: String(T), step: '1', value: String(ctx.get() ?? 0), 'aria-label': 'Día de aplicación' });
      const dayOut = el('span', { class: 'readout' });
      const sevOut = el('span', { class: 'readout' });
      const status = el('p', { class: 'muted small' });

      function draw(d) {
        treated.setAttribute('d', curvePath((t) => sev(t, d), T, c.sx, c.sy, 0.25));
        marker.setAttribute('x1', c.sx(d)); marker.setAttribute('x2', c.sx(d));
        const final = sev(T, d);
        dayOut.textContent = `Aplicación el día ${d}`;
        sevOut.textContent = `Severidad al día ${T}: ${final.toFixed(1)}%`;
        const ok = final <= L;
        sevOut.className = `readout ${ok ? 'ok' : 'bad'}`;
        status.textContent = ctx.get() === undefined
          ? 'Mueva el control para registrar su respuesta.'
          : `Respuesta registrada: aplicar el día ${ctx.get()}.`;
      }
      slider.addEventListener('input', () => {
        const d = Number(slider.value);
        ctx.set(d, false);
        draw(d);
      });
      draw(Number(slider.value));
      return el('div', {},
        el('div', { class: 'chart-wrap' }, c.svg),
        el('div', { class: 'slider-row' }, slider, dayOut),
        el('div', { class: 'slider-row' }, sevOut),
        status);
    },
  };

  /* ---------------------------------------------------------------------- */
  /* Gráficos SVG                                                            */
  /* ---------------------------------------------------------------------- */
  function chartBase({ xmax, xstep = 10, xlabel = 'Días', ylabel = 'Severidad (%)' }) {
    const W = 640, H = 320, L = 50, R = 14, T = 14, B = 44;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Gráfico de ${ylabel} contra ${xlabel}` });
    const sx = (x) => L + (x / xmax) * (W - L - R);
    const sy = (y) => H - B - (y / 100) * (H - T - B);
    for (let y = 0; y <= 100; y += 20) {
      svg.append(svgEl('line', { x1: L, x2: W - R, y1: sy(y), y2: sy(y), class: 'grid' }),
        svgEl('text', { x: L - 8, y: sy(y) + 4, 'text-anchor': 'end' }, String(y)));
    }
    for (let x = 0; x <= xmax; x += xstep) {
      svg.append(svgEl('line', { x1: sx(x), x2: sx(x), y1: T, y2: H - B, class: 'grid' }),
        svgEl('text', { x: sx(x), y: H - B + 18, 'text-anchor': 'middle' }, String(x)));
    }
    svg.append(
      svgEl('line', { x1: L, x2: L, y1: T, y2: H - B, class: 'axis' }),
      svgEl('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'axis' }),
      svgEl('text', { x: (L + W - R) / 2, y: H - 8, 'text-anchor': 'middle' }, xlabel),
      svgEl('text', { x: 14, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${(T + H - B) / 2})` }, ylabel),
    );
    const toX = (evt) => {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      return Math.min(xmax, Math.max(0, ((p.x - L) / (W - L - R)) * xmax));
    };
    return { svg, sx, sy, toX, W, H, L, R, T, B };
  }

  function curvePath(fn, xmax, sx, sy, step = 0.5) {
    let d = '';
    for (let x = 0; x <= xmax + 1e-9; x += step) d += `${d ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(fn(x)).toFixed(1)}`;
    return d;
  }

  /* ---------------------------------------------------------------------- */
  /* Envío                                                                   */
  /* ---------------------------------------------------------------------- */
  const modal = $('modal');
  $('q-finish').addEventListener('click', () => {
    const missing = st.questions.filter((q) => answers[q.id] === undefined).length;
    $('modal-text').textContent = missing
      ? `Tiene ${missing} ${missing === 1 ? 'pregunta sin responder' : 'preguntas sin responder'}. Una vez enviada no podrá cambiar sus respuestas.`
      : 'Una vez enviada no podrá cambiar sus respuestas.';
    modal.classList.remove('hidden');
  });
  $('modal-cancel').addEventListener('click', () => modal.classList.add('hidden'));
  $('modal-ok').addEventListener('click', () => { modal.classList.add('hidden'); finish(false); });

  async function finish() {
    stopMonitoring();
    try {
      await flushDirty();
      const data = await api('submit', { method: 'POST' });
      st = data;
      if (data.status === 'submitted') showDone(data);
      else if (data.status === 'annulled') showAnnulled(data);
      else applyState(data);
    } catch (ex) {
      if (ex.status === 401) return showDisplaced();
      showBlock('No se pudo enviar', 'Revise su conexión e intente de nuevo. Sus respuestas ya guardadas no se pierden.', 'Reintentar', async () => {
        show('quiz');
        monitoring = true;
        finish();
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Arranque: recuperar sesión de esta pestaña si existe                    */
  /* ---------------------------------------------------------------------- */
  // Título del examen (se conoce antes de ingresar)
  fetch(`/api/config${examRequested ? `?exam=${encodeURIComponent(examRequested)}` : ''}`, { cache: 'no-store' }).then((r) => r.json()).then((c) => {
    if (c && c.title) { $('app-title').textContent = c.title; document.title = c.title; }
  }).catch(() => {});

  (async function init() {
    if (!token) return show('login');
    try {
      applyState(await api('attempt'));
    } catch {
      token = null;
      sessionStorage.removeItem(TOKEN_KEY);
      show('login');
    }
  })();
})();
