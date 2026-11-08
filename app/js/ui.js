(function () {
  'use strict';
  const { Rcsp, ZK, parseZK } = window.RCSP;
  const $ = (id) => document.getElementById(id);
  const CFG = window.APP_CONFIG;

  const ST_FREQ = ['20Hz', '30Hz', '40Hz', '50Hz', '60Hz', '70Hz', '80Hz', '90Hz', '100Hz', '150Hz', '200Hz', '250Hz', '300Hz', '350Hz', '400Hz', '450Hz', '500Hz', '550Hz', '600Hz', '650Hz', '700Hz', '750Hz', '800Hz', '850Hz', '900Hz', '950Hz', '1kHz', '2kHz', '3kHz', '4kHz', '5kHz', '6kHz', '7kHz', '8kHz', '9kHz', '10kHz', '11kHz', '12kHz', '13kHz', '14kHz', '15kHz', '16kHz', '17kHz', '18kHz', '19kHz', '20kHz'];
  const SUB_FREQ = ['20Hz', '40Hz', '60Hz', '80Hz', '100Hz', '120Hz', '140Hz', '160Hz', '180Hz', '200Hz'];
  const BANDS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const PRESETS = {
    'Graves potentes': [6, 5, 4, 2, 0, 0, 0, 0, 1, 2],
    'Voces claras': [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    'Rock': [4, 3, 1, -1, -2, 0, 2, 3, 4, 4],
    'Pop': [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
    'Electrónica / fiesta': [6, 5, 2, 0, -2, 0, 1, 3, 5, 5],
    'Clásica': [3, 2, 1, 0, 0, 0, -1, 0, 2, 3],
    'Jazz': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    'Volumen bajo (loudness)': [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
  };

  // ----- estado persistente -----
  const DEF = { gain: 20, eq: Array(10).fill(0), stGain: 10, subGain: 10, stLo: 2, stHi: 45, subLo: 0, subHi: 5, balL: 10, balR: 10, beep: true, source: 1, mode: 1 };
  let S;
  try { S = Object.assign({}, DEF, JSON.parse(localStorage.getItem('zk-state') || '{}')); } catch (e) { S = Object.assign({}, DEF); }
  const save = () => { try { localStorage.setItem('zk-state', JSON.stringify(S)); } catch (e) { /* sin almacenamiento */ } };

  let transport = null, rcsp = null, connected = false;

  // ----- utilidades UI -----
  const logEl = $('log');
  function log(m) {
    const t = new Date().toLocaleTimeString();
    logEl.textContent = (`[${t}] ${m}\n` + logEl.textContent).slice(0, 20000);
    try { window.AndroidBLE && window.AndroidBLE.log && window.AndroidBLE.log(m); } catch (e) { /* nada */ }
  }
  window.__zkLog = log;
  let toastT;
  function toast(m) {
    const el = $('toast'); el.textContent = m; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function setConn(state, text) {
    const p = $('connState'); p.textContent = text; p.className = 'pill' + (state === 'on' ? ' on' : state === 'busy' ? ' busy' : '');
    connected = state === 'on';
    $('controls').classList.toggle('locked', !connected);
    const bd = $('btnDisconnect');
    bd.hidden = state === 'off';
    bd.textContent = state === 'on' ? 'Desconectar' : text === 'Buscando…' ? 'Detener búsqueda' : 'Cancelar';
    $('btnScan').disabled = state !== 'off';
    $('btnScan').textContent = state === 'off' ? 'Buscar placa' : text;
    document.querySelectorAll('.lockmsg span').forEach((s) => {
      s.textContent = state === 'busy' ? text + ' (mirá la sección Conexión)' : 'Conectá la placa para usar los controles de abajo.';
    });
  }
  // Un único aviso arriba de los controles cuando no hay conexión.
  (function () {
    const m = document.createElement('div'); m.className = 'lockmsg';
    m.innerHTML = '<span>Conectá la placa para usar los controles de abajo.</span><button class="primary">Ir a Conexión</button>';
    m.querySelector('button').onclick = () => $('secConn').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('controls').prepend(m);
  })();
  function selSeg(id, v) {
    document.querySelectorAll('#' + id + ' button' + (id === 'segSource' ? ', #segSource2 button' : '')).forEach((b) => b.classList.toggle('sel', +b.dataset.v === +v));
  }
  const send = async (bytes, okMsg) => {
    if (!rcsp) return;
    const r = await rcsp.custom(bytes);
    if (okMsg) toast(r ? okMsg : 'Enviado (sin confirmación)');
    return r;
  };
  const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ----- construcción del EQ -----
  const eqWrap = $('eqBands');
  BANDS.forEach((f, i) => {
    const d = document.createElement('div'); d.className = 'band';
    d.innerHTML = `<b id="eqv${i}">0</b><input type="range" min="-12" max="12" step="1" id="eq${i}" aria-label="${f} Hz"><small>${f}</small>`;
    eqWrap.appendChild(d);
  });
  function paintEq() { S.eq.forEach((v, i) => { $('eq' + i).value = v; $('eqv' + i).textContent = (v > 0 ? '+' : '') + v; }); }
  const sendEqDebounced = debounce(() => send(ZK.setEq10(S.eq)), 250);
  BANDS.forEach((_, i) => $('eq' + i).addEventListener('input', (e) => {
    S.eq[i] = +e.target.value; paintEq(); save(); sendEqDebounced();
  }));
  Object.keys(PRESETS).forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; $('eqPreset').appendChild(o); });
  $('eqPreset').addEventListener('change', (e) => {
    if (!PRESETS[e.target.value]) return;
    S.eq = PRESETS[e.target.value].slice(); paintEq(); save(); send(ZK.setEq10(S.eq), 'Preajuste aplicado');
  });
  $('btnEqFlat').onclick = () => { S.eq = Array(10).fill(0); paintEq(); save(); send(ZK.setEq10(S.eq), 'EQ plano'); };
  $('btnEqSend').onclick = () => send(ZK.setEq10(S.eq), 'EQ aplicado');

  // ----- sliders simples -----
  function bindRange(id, key, fmt, onSend) {
    const el = $(id), out = $(id + 'Out');
    const paint = () => { el.value = S[key]; if (out) out.textContent = fmt(S[key]); };
    const ds = debounce(onSend, 200);
    el.addEventListener('input', () => { S[key] = +el.value; paint(); save(); ds(); });
    return paint;
  }
  const lvl = (v) => (v <= 4 ? 'bajo' : v <= 9 ? 'medio' : 'alto');
  const db = (v) => v + ' dB · ' + lvl(v);
  const bal = (v) => { const x = (v - 10) / 5; return (x > 0 ? '+' : '') + x.toFixed(1) + ' dB'; };
  const sendFilters = () => send(ZK.setFilters(S.stLo, S.stHi, S.subLo, S.subHi));
  const sendDspGain = () => send(ZK.setDspGain(S.stGain, S.subGain));
  const sendBal = () => send(ZK.setBalance(S.balL, S.balR));
  const painters = [
    bindRange('gain', 'gain', (v) => v + '/30', () => send(ZK.setGain(S.gain))),
    bindRange('stGain', 'stGain', db, sendDspGain),
    bindRange('subGain', 'subGain', db, sendDspGain),
    bindRange('stLo', 'stLo', (v) => ST_FREQ[v], sendFilters),
    bindRange('stHi', 'stHi', (v) => ST_FREQ[v], sendFilters),
    bindRange('subLo', 'subLo', (v) => SUB_FREQ[v], sendFilters),
    bindRange('subHi', 'subHi', (v) => SUB_FREQ[v], sendFilters),
    bindRange('balL', 'balL', bal, sendBal),
    bindRange('balR', 'balR', bal, sendBal),
  ];
  // escala mínimo / máximo debajo de cada barra
  // Marcas: [valor del control, texto]. Se ubican en su posición real sobre la barra.
  const ST_TICKS = [[0, '20 Hz'], [8, '100'], [16, '500'], [26, '1k'], [30, '5k'], [35, '10k'], [45, '20 kHz']];
  const SUB_TICKS = SUB_FREQ.map((f, i) => [i, i === 0 ? '20 Hz' : i === 9 ? '200 Hz' : f.replace('Hz', '')]);
  const SCALES = {
    gain: [[0, '0'], [10, '10'], [20, '20'], [30, '30 máx.']],
    stGain: [[0, '0 dB'], [7, '7'], [14, '14 dB']], subGain: [[0, '0 dB'], [7, '7'], [14, '14 dB']],
    stLo: ST_TICKS, stHi: ST_TICKS, subLo: SUB_TICKS, subHi: SUB_TICKS,
    balL: [[0, '−2 dB'], [10, '0'], [20, '+2 dB']], balR: [[0, '−2 dB'], [10, '0'], [20, '+2 dB']],
  };
  Object.entries(SCALES).forEach(([id, ticks]) => {
    const el = $(id); const max = +el.max, min = +el.min;
    const sc = document.createElement('div'); sc.className = 'rscale';
    sc.innerHTML = ticks.map(([v, t]) => {
      const p = ((v - min) / (max - min)) * 100;
      const align = p === 0 ? 'start' : p === 100 ? 'end' : 'mid';
      return `<span class="${align}" style="left:${p}%">${t}</span>`;
    }).join('');
    (el.parentElement.classList.contains('slider') ? el.parentElement : el).insertAdjacentElement('afterend', sc);
  });

  // mapa de frecuencias (escala logarítmica 20 Hz – 20 kHz)
  const hz = (s) => parseFloat(s) * (/k/i.test(s) ? 1000 : 1);
  const pos = (f) => (Math.log10(f / 20) / 3) * 100;
  const fmtHz = (f) => (f >= 1000 ? (f / 1000).toString().replace('.', ',') + ' kHz' : f + ' Hz');
  function paintMap() {
    const sLo = hz(SUB_FREQ[Math.min(S.subLo, S.subHi)]), sHi = hz(SUB_FREQ[Math.max(S.subLo, S.subHi)]);
    const pLo = hz(ST_FREQ[Math.min(S.stLo, S.stHi)]), pHi = hz(ST_FREQ[Math.max(S.stLo, S.stHi)]);
    const put = (el, a, b, txt) => { el.style.left = pos(a) + '%'; el.style.width = Math.max(pos(b) - pos(a), 3) + '%'; el.firstChild.textContent = txt; el.title = txt; };
    put($('mapSub'), sLo, sHi, `Sub · ${fmtHz(sLo)}–${fmtHz(sHi)} · ${S.subGain} dB`);
    put($('mapSpk'), pLo, pHi, `Parlantes · ${fmtHz(pLo)}–${fmtHz(pHi)} · ${S.stGain} dB`);
    let note = '';
    if (pLo < 60) note = 'Los parlantes están recibiendo graves muy profundos: subí “Graves: desde dónde suenan” a 80–120 Hz para que suenen más limpios.';
    else if (sHi < pLo * 0.7) note = 'Hay un hueco entre el sub y los parlantes: subí “Hasta dónde llega el sub” o bajá “Graves: desde dónde suenan”.';
    else note = '✓ Buen reparto entre subwoofer y parlantes.';
    $('mapNote').textContent = note;
  }
  ['stLo', 'stHi', 'subLo', 'subHi', 'stGain', 'subGain'].forEach((id) => $(id).addEventListener('input', paintMap));

  const paintAll = () => { painters.forEach((p) => p()); paintEq(); paintMap(); selSeg('segSource', S.source); selSeg('segMode', S.mode); $('beep').checked = S.beep; };

  $('btnDspDefault').onclick = async () => {
    Object.assign(S, { stGain: 10, subGain: 10, stLo: 8, stHi: 45, subLo: 0, subHi: 5, balL: 10, balR: 10 });
    paintAll(); save();
    await sendDspGain(); await sendFilters(); await sendBal();
    toast('DSP: parlantes desde 100 Hz, sub hasta 120 Hz');
  };

  // ----- segmentos -----
  const SRC_NAMES = { 1: 'Bluetooth', 2: 'USB', 3: 'AUX', 4: 'Tarjeta de sonido' };
  document.querySelectorAll('#segSource button, #segSource2 button').forEach((b) => b.onclick = () => {
    S.source = +b.dataset.v; selSeg('segSource', S.source); save(); send(ZK.setSource(S.source), 'Fuente: ' + SRC_NAMES[S.source]);
  });
  const MODE_NAMES = ['Perillas de la placa', 'EQ desde la app', 'Filtro DSP'];
  document.querySelectorAll('#segMode button').forEach((b) => b.onclick = () => {
    S.mode = +b.dataset.v; selSeg('segMode', S.mode); save(); send(ZK.setControlMode(S.mode), 'Modo: ' + MODE_NAMES[S.mode]);
  });
  $('beep').onchange = (e) => { S.beep = e.target.checked; save(); send(ZK.setBeep(S.beep), S.beep ? 'Aviso activado' : 'Aviso desactivado'); };
  $('btnBtOff').onclick = async () => { await rcsp.disconnectClassic(); toast('Audio Bluetooth cortado'); };

  // ----- lectura de estado -----
  function onZK(d) {
    const r = parseZK(d); if (!r) return;
    log('Placa: ' + JSON.stringify(r));
    if (r.kind === 'product') $('prodInfo').textContent = `Placa detectada · modelo ${r.product} · firmware ${r.firmware}`;
    if (r.kind === 'source' && r.source >= 1 && r.source <= 4) { S.source = r.source; selSeg('segSource', S.source); }
    if (r.kind === 'gain') { S.gain = r.gain; }
    if (r.kind === 'dspEq') { S.eq = r.bands; }
    if (r.kind === 'dspState') {
      Object.assign(S, { mode: r.mode, balL: r.left, balR: r.right, stGain: r.stereoGain, subGain: r.subGain, stLo: r.stLo, stHi: r.stHi, subLo: r.subLo, subHi: r.subHi });
    }
    save(); paintAll();
  }
  async function readAll() {
    for (const c of [ZK.readProduct(), ZK.readSource(), ZK.readGain(), ZK.readDspState(), ZK.readDspEq()]) {
      const r = await rcsp.custom(c);
      if (r && r.params && r.params[0] === 0xaa) onZK(r.params);
    }
  }
  $('btnRead').onclick = async () => { await readAll(); toast('Estado leído'); };

  // ----- conexión -----
  const list = $('devList');
  const info = (m, bad) => { const el = $('prodInfo'); el.textContent = m; el.style.color = bad ? 'var(--bad)' : ''; };
  let scanTimer;
  $('btnScan').onclick = async () => {
    list.innerHTML = '';
    // Si quedó una búsqueda anterior colgada, se cancela antes de empezar otra.
    try { transport && transport.cancel && transport.cancel(); } catch (e) { /* nada */ }
    transport = window.createTransport();
    const seen = new Map();
    info('Buscando… (0 equipos encontrados)');
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (!connected && seen.size === 0) info('No se encontró ningún equipo. Revisá que el AUX esté desenchufado, que el Bluetooth de la PC esté activo y que ningún otro celular o app esté conectado a la placa. Después tocá “Desconectar app” y otra vez “Buscar placa”.', true);
    }, 15000);
    const onFound = (d) => {
      if (seen.has(d.id)) return; seen.set(d.id, d);
      log('Encontrado: ' + (d.name || 'Sin nombre') + ' [' + d.id + ']');
      info(`${seen.size} equipo${seen.size === 1 ? '' : 's'} encontrado${seen.size === 1 ? '' : 's'}. Tocá uno para conectar: si no es la placa, simplemente no conecta. Muchas placas usan nombres genéricos (por ejemplo “JBL”).`);
      const li = document.createElement('li');
      const likely = !d.classic && /app|ble|zk|wuzhi/i.test(d.name || '');
      const nm = (d.name || 'Sin nombre').replace(/[<>&]/g, '');
      li.innerHTML = d.classic
        ? `<button class="audio-only"><span>${nm} · <em>solo audio (sin control)</em></span><small>${d.rssi ? d.rssi + ' dBm' : ''}</small></button>`
        : `<button class="${likely ? 'primary' : ''}"><span>${nm}</span><small>${d.rssi ? d.rssi + ' dBm' : ''}</small></button>`;
      li.firstChild.onclick = d.classic
        ? () => info(`${nm} es un Bluetooth de audio clásico: sirve para escuchar música, pero no tiene canal para recibir comandos. Esta placa no admite control por app (tampoco con la app oficial). Para controlarla hace falta una placa con APP o el módulo de control con ESP32.`, true)
        : () => connectTo(d);
      if (likely) list.prepend(li); else list.appendChild(li);
    };
    setConn('busy', 'Buscando…');
    $('btnDisconnect').disabled = false;
    try {
      const p = transport.scan(onFound);
      if (p && transport.needsList) {
        // En Windows la promesa solo se resuelve al elegir; si falla, se muestra el motivo.
        p.catch((e) => {
          if (connected) return;
          log('Búsqueda: ' + e.message);
          if (!/cancel/i.test(e.message)) info('No se pudo buscar: ' + e.message, true);
          list.innerHTML = ''; setConn('off', 'Desconectado');
        });
      } else if (p) { const dev = await p; connectTo({ id: dev.id, name: dev.name }, true); }
    } catch (e) { log(e.message); info('No se pudo buscar: ' + e.message, true); setConn('off', 'Desconectado'); }
  };

  async function connectTo(d) {
    window.__lastTarget = d;
    list.innerHTML = '';
    clearTimeout(scanTimer);
    info('Conectando con ' + (d.name || 'la placa') + '…');
    try { transport.stopScan && transport.stopScan(); } catch (e) { /* nada */ }
    setConn('busy', 'Conectando…');
    $('devName').textContent = d.name || 'Placa';
    try {
      transport.onClose = () => { setConn('off', 'Desconectado'); $('devName').textContent = 'Sin conectar'; rcsp = null; };
      await transport.connect(d);
      rcsp = new Rcsp(transport, log);
      rcsp.onCustom = onZK;
      setConn('busy', 'Autenticando…');
      let authOk = true;
      try { await rcsp.authenticate(); } catch (e) { authOk = false; log('Autenticación JieLi: ' + e.message); }
      if (authOk) {
        await rcsp.getTargetInfo();
        setConn('on', 'Conectado');
        info('Conectado ✓');
        toast('¡Conectado!');
        await readAll();
      } else {
        // Canal no estándar: se prueban comandos y se registra todo lo que conteste la placa.
        setConn('busy', 'Probando canal…');
        info('Conectado a un canal no estándar. Probando comandos… (mirá el Registro técnico)');
        rcsp.authState = 'none';
        let got = 0; rcsp.onRaw = () => { got++; };
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const probes = [
          ['RCSP datos del equipo', rcsp._pack(3, [0xff, 0xff, 0xff, 0xff, 0x00]).bytes],
          ['ZK leer producto (directo)', Uint8Array.from(ZK.readProduct())],
          ['ZK leer estado DSP (directo)', Uint8Array.from(ZK.readDspState())],
          ['ZK leer volumen (directo)', Uint8Array.from(ZK.readGain())],
          ['Texto AT', new TextEncoder().encode('AT\r\n')],
        ];
        for (const [name, bytes] of probes) {
          log('→ prueba ' + name + ': ' + window.RCSP.hex(bytes));
          await transport.write(bytes);
          await wait(1500);
        }
        log(got ? `La placa respondió ${got} vez/veces: mandá captura del registro.` : 'La placa no respondió a ninguna prueba.');
        info(got ? 'La placa respondió. Mandá una captura del Registro técnico.' : 'La placa no respondió a los comandos conocidos. Mandá una captura del Registro técnico.', !got);
        setConn('on', 'Conectado (modo prueba)');
      }
    } catch (e) {
      log('Error: ' + e.message);
      toast(e.message);
      info('Error al conectar: ' + e.message, true);
      try { transport.disconnect(); } catch (x) { /* nada */ }
      setConn('off', 'Desconectado');
    }
  }
  $('btnDisconnect').onclick = () => {
    try { transport && transport.stopScan && transport.stopScan(); } catch (e) { /* nada */ }
    try { transport && transport.cancel && transport.cancel(); } catch (e) { /* nada */ }
    try { transport && transport.disconnect(); } catch (e) { /* nada */ }
    clearTimeout(scanTimer);
    list.innerHTML = ''; setConn('off', 'Desconectado'); info('');
    $('devName').textContent = 'Sin conectar';
  };

  // ----- regalo -----
  const dlg = $('giftDlg');
  $('btnGift').onclick = () => dlg.showModal();
  $('btnGiftClose').onclick = () => dlg.close();
  $('btnGiftGo').onclick = () => {
    dlg.close();
    if (!CFG.donateUrl) { toast('Link de regalo próximamente'); return; }
    (transport || window.createTransport()).openUrl(CFG.donateUrl);
  };

  // Modo automático (diagnóstico por ADB): busca el equipo por nombre o dirección y conecta solo.
  window.__autoConnect = (target) => {
    log('Modo automático: buscando ' + target);
    list.innerHTML = '';
    transport = window.createTransport();
    let done = false;
    setConn('busy', 'Buscando…');
    transport.scan((d) => {
      if (done) return;
      if ((d.id || '').toUpperCase() === target.toUpperCase() || (d.name || '').toUpperCase().includes(target.toUpperCase())) {
        done = true; log('Modo automático: encontrado ' + d.name + ' ' + d.id); connectTo(d);
      }
    });
    setTimeout(() => { if (!done) { log('Modo automático: no apareció ' + target); setConn('off', 'Desconectado'); } }, 20000);
  };

  // Modo vigilancia: busca sin parar y conecta apenas aparece el equipo.
  window.__watch = (target) => {
    let busy = false;
    log('Vigilancia: esperando ' + target);
    const round = () => {
      if (busy || connected) return;
      transport = window.createTransport();
      setConn('busy', 'Buscando…'); info('Vigilando: esperando que aparezca ' + target + '…');
      transport.scan((d) => {
        if (busy || connected) return;
        if ((d.name || '').toUpperCase().includes(target.toUpperCase()) && !d.classic) {
          busy = true; log('Vigilancia: apareció ' + d.name + ' ' + d.id);
          connectTo(d).finally(() => { busy = false; });
        }
      });
    };
    round();
    setInterval(round, 18000);
  };

  paintAll();
  setConn('off', 'Desconectado');
  log('Control ZK Amp ' + CFG.version + ' listo');
})();
