'use strict';
/* Lydspejl – stereo- og spektralmonitor. Al analyse sker lokalt i browseren. */

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbOf = p => (p > 1e-20 ? 10 * Math.log10(p) : -Infinity);
const fmtDb = (v, d = 1) => (isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(d).replace('-', '−') : '–');
const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' kHz' : Math.round(f) + ' Hz');
const LS_KEY = 'lydspejl.v1';

/* ---------- Forvalg ---------- */
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
const PRESETS = {
  mix6: { name: 'Mix – 6 bånd', bands: [['Sub', 20, 60, '#8b5cf6'], ['Bas', 60, 250, '#3b82f6'], ['Lav-mellem', 250, 800, '#06b6d4'], ['Mellem', 800, 2500, '#22c55e'], ['Høj-mellem', 2500, 6000, '#eab308'], ['Luft', 6000, 20000, '#ef4444']] },
  three: { name: '3 bånd (lav/mellem/høj)', bands: [['Lav', 20, 250, '#3b82f6'], ['Mellem', 250, 4000, '#22c55e'], ['Høj', 4000, 20000, '#ef4444']] },
  octave: { name: 'Oktavbånd (10)', bands: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((c, i) => [c >= 1000 ? c / 1000 + 'k' : String(c), c / Math.SQRT2, Math.min(c * Math.SQRT2, 22000), hslHex(270 - i * 30, 85, 58)]) },
  dialog: { name: 'Tale / dialog', bands: [['Rumlen', 20, 80, '#64748b'], ['Krop', 80, 300, '#3b82f6'], ['Kerne', 300, 1000, '#06b6d4'], ['Tydelighed', 1000, 4000, '#22c55e'], ['Sibilans', 4000, 9000, '#eab308'], ['Luft', 9000, 20000, '#ef4444']] },
  low: { name: 'Bund-fokus', bands: [['Sub', 20, 45, '#8b5cf6'], ['Kick', 45, 90, '#3b82f6'], ['Bas', 90, 180, '#06b6d4'], ['Mudder', 180, 400, '#eab308']] },
  spatial: { name: 'Rumlig lokalisering', bands: [['ITD-område', 20, 700, '#3b82f6'], ['Overgang', 700, 1600, '#22c55e'], ['ILD-område', 1600, 5000, '#eab308'], ['Pinna', 5000, 16000, '#ef4444']] },
};
const presetBands = k => PRESETS[k].bands.map(([name, lo, hi, color]) => ({ name, lo, hi, color, show: true }));

/* ---------- Indstillinger ---------- */
const DEFAULTS = {
  preset: 'mix6', bands: null, solo: -1, slope: 2, normBands: false,
  lMode: 'mix', lAxis: 'ms', lAuto: true, lGain: 0, lPersist: 55, lSens: 50, lEllipse: true,
  sView: 'lr', sTilt: 0, sRange: 100, sSmooth: 0.6, sHold: true,
  target: -14, monitor: false, autoDevice: false, deviceId: '', autoAnalyze: false, notify: false,
};
let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { /* ingen lagring */ }
if (!Array.isArray(S.bands) || !S.bands.length) S.bands = presetBands(S.preset in PRESETS ? S.preset : 'mix6');
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { } }, 300); }

/* ---------- Lydmotor ---------- */
let ac = null, inputGain, monitorGain, splitter, anL, anR, anM, anS, meterNode;
let srcNode = null, stream = null, testNodes = [], mediaElSrc = null, srcKind = '', srcLabel = '';
let bandChains = [];
let tdL, tdR, fL, fR, fM, fS;
const BAND_FFT = 2048;
let nyq = 24000, sr = 48000;

function mkAn(size) { const a = ac.createAnalyser(); a.fftSize = size; a.smoothingTimeConstant = S.sSmooth; return a; }

async function ensureContext() {
  if (ac) { if (ac.state === 'suspended') await ac.resume(); return; }
  ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  sr = ac.sampleRate; nyq = sr / 2;
  inputGain = ac.createGain();
  inputGain.channelCount = 2; inputGain.channelCountMode = 'explicit'; inputGain.channelInterpretation = 'speakers';
  monitorGain = ac.createGain(); monitorGain.gain.value = S.monitor ? 1 : 0;
  inputGain.connect(monitorGain).connect(ac.destination);
  splitter = ac.createChannelSplitter(2); inputGain.connect(splitter);
  anL = mkAn(8192); anR = mkAn(8192); anM = mkAn(8192); anS = mkAn(8192);
  splitter.connect(anL, 0); splitter.connect(anR, 1);
  const mid = ac.createGain(), side = ac.createGain();
  for (const n of [mid, side]) { n.channelCount = 1; n.channelCountMode = 'explicit'; }
  const g = v => { const x = ac.createGain(); x.gain.value = v; return x; };
  const mL = g(0.5), mR = g(0.5), sL = g(0.5), sR = g(-0.5);
  splitter.connect(mL, 0); splitter.connect(mR, 1); splitter.connect(sL, 0); splitter.connect(sR, 1);
  mL.connect(mid); mR.connect(mid); sL.connect(side); sR.connect(side);
  mid.connect(anM); side.connect(anS);
  tdL = new Float32Array(8192); tdR = new Float32Array(8192);
  fL = new Float32Array(4096); fR = new Float32Array(4096); fM = new Float32Array(4096); fS = new Float32Array(4096);
  try {
    await ac.audioWorklet.addModule('meter-worklet.js');
    meterNode = new AudioWorkletNode(ac, 'lydspejl-meter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    meterNode.port.onmessage = e => onMeterBlock(e.data);
    const sink = ac.createGain(); sink.gain.value = 0;
    inputGain.connect(meterNode); meterNode.connect(sink).connect(ac.destination);
  } catch (e) { console.warn('Loudness-worklet kunne ikke indlæses', e); }
  buildBands();
}

const SLOPE_Q = { 1: [0.7071], 2: [0.7071, 0.7071], 4: [0.5412, 1.3066, 0.5412, 1.3066] };
function buildBands() {
  if (!ac) return;
  for (const c of bandChains) { try { inputGain.disconnect(c.first); } catch (e) { } c.nodes.forEach(n => { try { n.disconnect(); } catch (e) { } }); }
  const qs = SLOPE_Q[S.slope] || SLOPE_Q[2];
  bandChains = S.bands.map(b => {
    const hps = qs.map(q => { const f = ac.createBiquadFilter(); f.type = 'highpass'; f.Q.value = q; return f; });
    const lps = qs.map(q => { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = q; return f; });
    const chain = [...hps, ...lps];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    const sp = ac.createChannelSplitter(2);
    chain[chain.length - 1].connect(sp);
    const aL = ac.createAnalyser(), aR = ac.createAnalyser();
    aL.fftSize = aR.fftSize = BAND_FFT;
    sp.connect(aL, 0); sp.connect(aR, 1);
    inputGain.connect(chain[0]);
    const c = { first: chain[0], hps, lps, nodes: [...chain, sp, aL, aR], aL, aR, bL: new Float32Array(BAND_FFT), bR: new Float32Array(BAND_FFT) };
    setChainFreq(c, b);
    return c;
  });
  allocBandState();
}
function setChainFreq(c, b) {
  const t = ac.currentTime;
  c.hps.forEach(f => f.frequency.setTargetAtTime(clamp(b.lo, 5, nyq * 0.95), t, 0.01));
  c.lps.forEach(f => f.frequency.setTargetAtTime(clamp(b.hi, 20, nyq * 0.98), t, 0.01));
}
function applyBandFreqs() { if (ac) bandChains.forEach((c, j) => S.bands[j] && setChainFreq(c, S.bands[j])); }

/* ---------- Kilder ---------- */
function stopSource() {
  if (srcNode) { try { srcNode.disconnect(); } catch (e) { } }
  srcNode = null;
  if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
  stream = null;
  testNodes.forEach(n => { try { n.stop && n.stop(); n.disconnect(); } catch (e) { } });
  testNodes = [];
  const p = $('#player'); if (!p.paused) p.pause(); p.hidden = true;
  srcKind = ''; srcLabel = '';
}
function attachStream(s, kind, label) {
  stream = s; srcKind = kind; srcLabel = label;
  srcNode = ac.createMediaStreamSource(s);
  srcNode.connect(inputGain);
  s.getTracks().forEach(t => { t.onended = () => { if (stream === s) { stopSource(); showStandby('idle', 'Delingen blev stoppet.'); } }; });
}
const AUDIO_RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };

async function startDisplay() {
  await ensureContext();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Denne browser kan ikke dele fane/skærm. Brug Chrome eller Edge.');
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1, width: { ideal: 320 }, height: { ideal: 180 } },
    audio: { ...AUDIO_RAW, suppressLocalAudioPlayback: false },
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
  });
  const at = s.getAudioTracks()[0];
  if (!at) { s.getTracks().forEach(t => t.stop()); throw new Error('Der blev ikke delt nogen lyd. Prøv igen og slå "Del lyd" til i dialogen.'); }
  stopSource();
  const vt = s.getVideoTracks()[0];
  const surf = vt && vt.getSettings ? vt.getSettings().displaySurface : '';
  attachStream(s, 'display', surf === 'browser' ? 'Browserfane' : surf === 'monitor' ? 'Systemlyd (hele skærmen)' : surf === 'window' ? 'Vindue' : 'Delt lyd');
}

async function startDevice(deviceId) {
  await ensureContext();
  const s = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_RAW, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
  stopSource();
  const t = s.getAudioTracks()[0];
  const st = t.getSettings ? t.getSettings() : {};
  S.deviceId = st.deviceId || deviceId || ''; save();
  attachStream(s, 'device', t.label || 'Lydenhed');
  refreshDevices();
}

async function startFile(file) {
  await ensureContext();
  stopSource();
  const p = $('#player');
  p.src = URL.createObjectURL(file);
  if (!mediaElSrc) mediaElSrc = ac.createMediaElementSource(p);
  srcNode = mediaElSrc;
  srcNode.connect(inputGain);
  if (!S.monitor) setMonitor(true);
  p.hidden = false; srcKind = 'file'; srcLabel = file.name;
  await p.play();
}

async function startTest() {
  await ensureContext();
  stopSource();
  const out = ac.createGain(); out.channelCount = 2; out.channelCountMode = 'explicit'; out.channelInterpretation = 'speakers';
  out.gain.value = 0.5;
  const merger = ac.createChannelMerger(2);
  const o1 = ac.createOscillator(), o2 = ac.createOscillator(), o3 = ac.createOscillator();
  o1.frequency.value = 440; o2.frequency.value = 441.3; o3.frequency.value = 55;
  const g1 = ac.createGain(), g2 = ac.createGain(), g3 = ac.createGain();
  g1.gain.value = g2.gain.value = 0.18; g3.gain.value = 0.35;
  o1.connect(g1).connect(merger, 0, 0); o2.connect(g2).connect(merger, 0, 1);
  o3.connect(g3).connect(out);
  merger.connect(out);
  const nb = ac.createBuffer(2, sr * 2, sr);
  for (let c = 0; c < 2; c++) { const d = nb.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const ns = ac.createBufferSource(); ns.buffer = nb; ns.loop = true;
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
  const ng = ac.createGain(); ng.gain.value = 0.12;
  ns.connect(hp).connect(ng).connect(out);
  out.connect(inputGain);
  [o1, o2, o3, ns].forEach(n => n.start());
  testNodes = [o1, o2, o3, ns, out];
  srcNode = out; srcKind = 'test'; srcLabel = 'Testsignal';
}

function setMonitor(on) { S.monitor = on; $('#monitorOut').checked = on; if (monitorGain) monitorGain.gain.setTargetAtTime(on ? 1 : 0, ac.currentTime, 0.02); save(); }

async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const sel = $('#devSel');
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  sel.innerHTML = '<option value="">Standard-input</option>';
  let pick = S.deviceId;
  for (const d of devs) {
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || 'Lydenhed (giv adgang for at se navn)';
    sel.appendChild(o);
    if (!pick && /blackhole|loopback|soundflower|vb-cable|stereo mix/i.test(d.label)) pick = d.deviceId;
  }
  if (pick && [...sel.options].some(o => o.value === pick)) sel.value = pick;
}

/* ---------- Standby / opstart ---------- */
let mode = 'standby';           // 'standby' | 'analyze'
let sbPhase = 'idle';           // 'idle' | 'listen'
let sigOnTime = 0, quietTime = 0, snoozed = false, askShown = false, levelFast = 0;
const SIG_THRESH_DB = -55;

function showStandby(phase, err) {
  mode = 'standby'; sbPhase = phase;
  $('#standby').hidden = false;
  $('#sbIdle').hidden = phase !== 'idle';
  $('#sbListen').hidden = phase !== 'listen';
  $('#sbAsk').hidden = true; askShown = false; snoozed = false; sigOnTime = 0;
  const e = $('#sbErr'); e.hidden = !err; e.textContent = err || '';
  $('#sbSrcName').textContent = srcLabel ? 'Lytter på: ' + srcLabel : 'Lytter…';
  $('#sbMsg').textContent = 'Venter på lyd. Afspil noget, så spørger jeg.';
  updateStatus();
}
function enterAnalyze() {
  mode = 'analyze';
  $('#standby').hidden = true;
  if (ac && ac.state === 'suspended') ac.resume();
  updateStatus();
}
async function beginSource(fn) {
  const e = $('#sbErr'); e.hidden = true;
  try {
    await fn();
    if (srcKind === 'file' || srcKind === 'test') { enterAnalyze(); return; }
    showStandby('listen');
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) showStandby('idle', 'Adgang blev afvist eller annulleret.');
    else showStandby('idle', (err && err.message) || String(err));
  }
}
function onSignalDetected() {
  if (S.autoAnalyze) { enterAnalyze(); notify(); return; }
  askShown = true;
  $('#sbAsk').hidden = false;
  $('#sbMsg').textContent = 'Signal registreret.';
  notify();
}
function notify() {
  if (!S.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification('Lydspejl', { body: 'Der er lyd på ' + (srcLabel || 'kilden') + '. Klik for at analysere.', icon: 'icons/icon-192.png' }); n.onclick = () => { window.focus(); enterAnalyze(); n.close(); }; } catch (e) { }
}
function standbyTick(dt) {
  const lvl = dbOf(levelFast);
  const w = isFinite(lvl) ? clamp((lvl + 70) / 70, 0, 1) : 0;
  $('#sbLevel').style.width = (w * 100).toFixed(1) + '%';
  $('#sbLevelTxt').textContent = isFinite(lvl) ? fmtDb(lvl) + ' dBFS' : '−∞ dBFS';
  const on = lvl > SIG_THRESH_DB;
  document.querySelector('.pulse').classList.toggle('live', on);
  if (on) { sigOnTime += dt; quietTime = 0; } else { quietTime += dt; sigOnTime = 0; }
  if (snoozed && quietTime > 3) { snoozed = false; $('#sbMsg').textContent = 'Venter på lyd.'; }
  if (!askShown && !snoozed && sigOnTime > 0.4) onSignalDetected();
}
function updateStatus() {
  const d = $('#liveDot');
  const live = !!srcKind && dbOf(levelFast) > SIG_THRESH_DB;
  d.className = 'dot ' + (srcKind ? (live ? 'live' : 'wait') : '');
  $('#status').textContent = !srcKind ? 'Ingen kilde' : (mode === 'analyze' ? 'Analyserer: ' : 'Standby: ') + srcLabel + (srcKind && !live ? ' · venter på signal' : '');
  document.title = (live && mode === 'analyze' ? '● ' : '') + 'Lydspejl';
}

/* ---------- Måledata ---------- */
const N = 256;
let dens = [], densFull = new Float32Array(N * N), bandStat = [], bandPk = [];
let fullPk = 0.1, globPk = 0.1;
function allocBandState() {
  dens = S.bands.map(() => new Float32Array(N * N));
  bandStat = S.bands.map(() => ({ ll: 0, rr: 0, lr: 0 }));
  bandPk = S.bands.map(() => 0.05);
}
allocBandState();

const fast = { msL: 0, msR: 0, ll: 0, rr: 0, lr: 0, pkL: -Infinity, pkR: -Infinity, holdL: -Infinity, holdR: -Infinity, holdTL: 0, holdTR: 0, clipT: 0 };
const lou = { blocks: [], gate: [], st: [], hist: [], tpMax: 0, M: -Infinity, ST: -Infinity, I: -Infinity, LRA: NaN, n: 0, dirty: true };
const ABS_P = Math.pow(10, (-70 + 0.691) / 10);
const lufs = p => -0.691 + dbOf(p);

function onMeterBlock(d) {
  if (mode !== 'analyze' || frozen) return;
  lou.blocks.push(d.kl + d.kr); if (lou.blocks.length > 30) lou.blocks.shift();
  lou.tpMax = Math.max(lou.tpMax, d.tl, d.tr);
  const B = lou.blocks, n = B.length;
  if (n >= 4) { const p = (B[n - 1] + B[n - 2] + B[n - 3] + B[n - 4]) / 4; lou.M = lufs(p); lou.gate.push(p); }
  let s = 0; for (const v of B) s += v; lou.ST = lufs(s / n);
  if (n === 30) lou.st.push(lou.ST);
  lou.hist.push([lou.M, lou.ST]); if (lou.hist.length > 600) lou.hist.shift();
  if (++lou.n % 5 === 0) calcIntegrated();
  if (lou.n % 10 === 0) calcLRA();
  lou.dirty = true;
}
function calcIntegrated() {
  let s = 0, c = 0;
  for (const p of lou.gate) if (p > ABS_P) { s += p; c++; }
  if (!c) { lou.I = -Infinity; return; }
  const rel = Math.max(ABS_P, (s / c) * 0.1);
  s = 0; c = 0;
  for (const p of lou.gate) if (p > rel) { s += p; c++; }
  lou.I = c ? lufs(s / c) : -Infinity;
}
function calcLRA() {
  const v = lou.st.filter(x => x > -70);
  if (v.length < 10) { lou.LRA = NaN; return; }
  let s = 0; for (const x of v) s += Math.pow(10, (x + 0.691) / 10);
  const rel = lufs(s / v.length) - 20;
  const g = v.filter(x => x > rel).sort((a, b) => a - b);
  if (g.length < 2) { lou.LRA = NaN; return; }
  const q = p => g[Math.min(g.length - 1, Math.round(p * (g.length - 1)))];
  lou.LRA = q(0.95) - q(0.10);
}
function resetLoudness() { Object.assign(lou, { blocks: [], gate: [], st: [], hist: [], tpMax: 0, M: -Infinity, ST: -Infinity, I: -Infinity, LRA: NaN, n: 0, dirty: true }); }

/* ---------- Farver ---------- */
const INFERNO = (() => {
  const st = [[0, 0, 0, 4], [0.13, 27, 12, 65], [0.25, 74, 12, 107], [0.38, 120, 28, 109], [0.5, 165, 44, 96], [0.63, 207, 68, 70], [0.75, 237, 105, 37], [0.88, 251, 155, 6], [1, 252, 255, 164]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let k = 0; while (k < st.length - 2 && t > st[k + 1][0]) k++;
    const a = st[k], b = st[k + 1], u = (t - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * u);
  }
  return lut;
})();
const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/* ---------- Canvas-opsætning ---------- */
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const cv = {};
for (const id of ['lissaCanvas', 'specCanvas', 'sgCanvas', 'meterCanvas', 'histCanvas']) cv[id] = { c: $('#' + id), g: $('#' + id).getContext('2d') };
const lissaOff = document.createElement('canvas'); lissaOff.width = lissaOff.height = N;
const lissaOffX = lissaOff.getContext('2d');
const lissaImg = lissaOffX.createImageData(N, N);
const sgBuf = document.createElement('canvas'); const sgBufX = sgBuf.getContext('2d');
let specMap = null, sgMap = null;
const ro = new ResizeObserver(entries => {
  for (const e of entries) {
    const c = e.target, d = dpr();
    const w = Math.max(10, Math.round(c.clientWidth * d)), h = Math.max(10, Math.round(c.clientHeight * d));
    if (c.width !== w || c.height !== h) {
      c.width = w; c.height = h;
      if (c.id === 'specCanvas') specMap = null;
      if (c.id === 'sgCanvas') {
        const old = document.createElement('canvas'); old.width = sgBuf.width; old.height = sgBuf.height;
        if (sgBuf.width) old.getContext('2d').drawImage(sgBuf, 0, 0);
        sgBuf.width = w; sgBuf.height = h; sgBufX.fillStyle = '#000004'; sgBufX.fillRect(0, 0, w, h);
        if (old.width) sgBufX.drawImage(old, 0, 0, w, h);
        sgMap = null;
      }
    }
  }
});
Object.values(cv).forEach(o => ro.observe(o.c));

/* ---------- Analysetrin pr. billede ---------- */
let frozen = false;
function pullFast(dt) {
  anL.getFloatTimeDomainData(tdL); anR.getFloatTimeDomainData(tdR);
  const m = clamp(Math.round(sr * dt), 128, 8192), st = 8192 - m;
  let pl = 0, pr = 0, ll = 0, rr = 0, lr = 0;
  for (let i = st; i < 8192; i++) {
    const l = tdL[i], r = tdR[i];
    ll += l * l; rr += r * r; lr += l * r;
    const al = Math.abs(l), ar = Math.abs(r); if (al > pl) pl = al; if (ar > pr) pr = ar;
  }
  ll /= m; rr /= m; lr /= m;
  levelFast += (((ll + rr) / 2) - levelFast) * (1 - Math.exp(-dt / 0.08));
  return { m, pl, pr, ll, rr, lr };
}
function analyzeStep(dt, f) {
  // Niveau-/fase-ballistik
  const kR = 1 - Math.exp(-dt / 0.3), kC = 1 - Math.exp(-dt / 0.4);
  fast.msL += (f.ll - fast.msL) * kR; fast.msR += (f.rr - fast.msR) * kR;
  fast.ll += (f.ll - fast.ll) * kC; fast.rr += (f.rr - fast.rr) * kC; fast.lr += (f.lr - fast.lr) * kC;
  const pdl = 20 * Math.log10(f.pl + 1e-12), pdr = 20 * Math.log10(f.pr + 1e-12);
  fast.pkL = Math.max(pdl, fast.pkL - 24 * dt); fast.pkR = Math.max(pdr, fast.pkR - 24 * dt);
  const now = performance.now();
  if (pdl >= fast.holdL || now - fast.holdTL > 2000) { fast.holdL = pdl; fast.holdTL = now; }
  if (pdr >= fast.holdR || now - fast.holdTR > 2000) { fast.holdR = pdr; fast.holdTR = now; }
  if (f.pl >= 0.999 || f.pr >= 0.999) fast.clipT = now;

  // Spektre
  anL.getFloatFrequencyData(fL); anR.getFloatFrequencyData(fR);
  if (S.sView === 'ms') { anM.getFloatFrequencyData(fM); anS.getFloatFrequencyData(fS); }

  // Lissajous-akkumulering
  const tau = 0.03 * Math.pow(100, S.lPersist / 100);
  const decay = Math.exp(-dt / tau);
  const w = 400 / (sr * tau);
  const ms = S.lAxis === 'ms';
  const pkDecay = Math.exp(-dt / 1.5);
  const kS = 1 - Math.exp(-dt / 0.35);
  const manual = Math.pow(10, S.lGain / 20);
  if (S.lMode === 'full') {
    for (let i = 0; i < densFull.length; i++) densFull[i] *= decay;
    const st = 8192 - Math.min(f.m, 4096);
    const pk = peakXY(tdL, tdR, st, 8192, ms);
    fullPk = Math.max(pk, fullPk * pkDecay, 1e-4);
    splat(densFull, tdL, tdR, st, 8192, (S.lAuto ? 0.9 / fullPk : 1) * manual, ms, w);
  }
  const bm = Math.min(f.m, BAND_FFT), bst = BAND_FFT - bm;
  let gp = 0;
  bandChains.forEach((c, j) => {
    c.aL.getFloatTimeDomainData(c.bL); c.aR.getFloatTimeDomainData(c.bR);
    let ll = 0, rr = 0, lr = 0;
    const L = c.bL, R = c.bR;
    for (let i = 0; i < BAND_FFT; i++) { const l = L[i], r = R[i]; ll += l * l; rr += r * r; lr += l * r; }
    const s = bandStat[j];
    s.ll += (ll / BAND_FFT - s.ll) * kS; s.rr += (rr / BAND_FFT - s.rr) * kS; s.lr += (lr / BAND_FFT - s.lr) * kS;
    const pk = peakXY(L, R, bst, BAND_FFT, ms);
    bandPk[j] = Math.max(pk, bandPk[j] * pkDecay, 1e-4);
    if (visible(j)) gp = Math.max(gp, bandPk[j]);
  });
  globPk = Math.max(gp, 1e-4);
  if (S.lMode !== 'full') {
    bandChains.forEach((c, j) => {
      const D = dens[j]; if (!D) return;
      for (let i = 0; i < D.length; i++) D[i] *= decay;
      if (!visible(j)) return;
      splat(D, c.bL, c.bR, bst, BAND_FFT, bandGain(j) * manual, ms, w);
    });
  }
}
function bandGain(j) { return S.lAuto || S.normBands ? 0.9 / (S.normBands ? bandPk[j] : globPk) : 1; }
const visible = j => (S.solo >= 0 ? j === S.solo : !!(S.bands[j] && S.bands[j].show));
function peakXY(L, R, a, b, ms) {
  let p = 0;
  for (let i = a; i < b; i++) {
    const l = L[i], r = R[i];
    const x = ms ? Math.abs(r - l) * 0.7071 : Math.abs(l), y = ms ? Math.abs(l + r) * 0.7071 : Math.abs(r);
    if (x > p) p = x; if (y > p) p = y;
  }
  return p;
}
function splat(D, L, R, a, b, g, ms, w) {
  const h = (N - 1) * 0.5;
  for (let i = a; i < b; i++) {
    const l = L[i], r = R[i];
    let x, y;
    if (ms) { x = (r - l) * 0.70710678; y = (l + r) * 0.70710678; } else { x = l; y = r; }
    const px = h + x * g * h, py = h - y * g * h;
    if (px < 0 || py < 0 || px >= N - 1 || py >= N - 1) continue;
    const ix = px | 0, iy = py | 0, fx = px - ix, fy = py - iy, k = iy * N + ix;
    D[k] += (1 - fx) * (1 - fy) * w; D[k + 1] += fx * (1 - fy) * w;
    D[k + N] += (1 - fx) * fy * w; D[k + N + 1] += fx * fy * w;
  }
}

/* ---------- Tegning: Lissajous ---------- */
function drawLissa() {
  const { c, g } = cv.lissaCanvas, W = c.width, H = c.height, d = dpr();
  const px = lissaImg.data, sens = 0.4 * Math.pow(60, S.lSens / 100);
  const vis = S.bands.map((b, j) => visible(j));
  const cols = S.bands.map(b => hexRgb(b.color));
  if (S.lMode === 'full' || S.lMode === 'heat') {
    for (let p = 0, q = 0; p < N * N; p++, q += 4) {
      let t = 0;
      if (S.lMode === 'full') t = densFull[p]; else for (let j = 0; j < dens.length; j++) if (vis[j]) t += dens[j][p];
      const a = 1 - Math.exp(-t * sens), i = Math.min(255, (a * 255) | 0) * 3;
      px[q] = INFERNO[i]; px[q + 1] = INFERNO[i + 1]; px[q + 2] = INFERNO[i + 2]; px[q + 3] = 255;
    }
  } else if (S.lMode === 'mix') {
    for (let p = 0, q = 0; p < N * N; p++, q += 4) {
      let r = 0, gg = 0, b = 0;
      for (let j = 0; j < dens.length; j++) {
        if (!vis[j]) continue;
        const v = dens[j][p]; if (v < 1e-5) continue;
        const a = 1 - Math.exp(-v * sens), cc = cols[j];
        r += cc[0] * a; gg += cc[1] * a; b += cc[2] * a;
      }
      px[q] = r > 255 ? 255 : r; px[q + 1] = gg > 255 ? 255 : gg; px[q + 2] = b > 255 ? 255 : b; px[q + 3] = 255;
    }
  } else { // dominant
    for (let p = 0, q = 0; p < N * N; p++, q += 4) {
      let best = -1, bv = 0, t = 0;
      for (let j = 0; j < dens.length; j++) { if (!vis[j]) continue; const v = dens[j][p]; t += v; if (v > bv) { bv = v; best = j; } }
      if (best < 0 || t < 1e-5) { px[q] = px[q + 1] = px[q + 2] = 0; px[q + 3] = 255; continue; }
      const a = 1 - Math.exp(-t * sens), cc = cols[best], wht = Math.max(0, a - 0.85) * 4;
      px[q] = Math.min(255, cc[0] * a + 255 * wht); px[q + 1] = Math.min(255, cc[1] * a + 255 * wht); px[q + 2] = Math.min(255, cc[2] * a + 255 * wht); px[q + 3] = 255;
    }
  }
  lissaOffX.putImageData(lissaImg, 0, 0);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(lissaOff, 0, 0, W, H);

  // Gitter og akser
  const cx = W / 2, cy = H / 2, R = W / 2;
  g.save();
  g.strokeStyle = 'rgba(148,163,184,.18)'; g.lineWidth = d;
  g.beginPath(); g.arc(cx, cy, R * 0.98, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(cx, cy, R * 0.49, 0, Math.PI * 2); g.stroke();
  g.setLineDash([4 * d, 5 * d]);
  g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, H); g.moveTo(0, cy); g.lineTo(W, cy);
  g.moveTo(cx - R * 0.7, cy - R * 0.7); g.lineTo(cx + R * 0.7, cy + R * 0.7);
  g.moveTo(cx + R * 0.7, cy - R * 0.7); g.lineTo(cx - R * 0.7, cy + R * 0.7); g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(203,213,225,.65)'; g.font = `${11 * d}px system-ui`; g.textAlign = 'center';
  const lab = (t, x, y) => g.fillText(t, x, y);
  if (S.lAxis === 'ms') { lab('M', cx, 14 * d); lab('L', cx - R * 0.72, cy - R * 0.72); lab('R', cx + R * 0.72, cy - R * 0.72); lab('+S', W - 14 * d, cy - 5 * d); lab('−S', 14 * d, cy - 5 * d); lab('fase', cx, H - 6 * d); }
  else { lab('R', cx, 14 * d); lab('L', W - 10 * d, cy - 5 * d); lab('M', cx + R * 0.72, cy - R * 0.72); lab('S', cx - R * 0.72, cy - R * 0.72); }

  // Ellipser pr. bånd (2σ)
  if (S.lEllipse && S.lMode !== 'full') {
    const manual = Math.pow(10, S.lGain / 20);
    S.bands.forEach((b, j) => {
      if (!vis[j] || !bandStat[j]) return;
      const s = bandStat[j]; if (s.ll + s.rr < 1e-10) return;
      let xx, yy, xy;
      if (S.lAxis === 'ms') { xx = (s.ll + s.rr - 2 * s.lr) / 2; yy = (s.ll + s.rr + 2 * s.lr) / 2; xy = (s.rr - s.ll) / 2; }
      else { xx = s.ll; yy = s.rr; xy = s.lr; }
      const tr = xx + yy, df = Math.sqrt(Math.max(0, (xx - yy) * (xx - yy) / 4 + xy * xy));
      const l1 = Math.max(0, tr / 2 + df), l2 = Math.max(0, tr / 2 - df);
      const th = 0.5 * Math.atan2(2 * xy, xx - yy);
      const k = bandGain(j) * manual * R;
      const r1 = Math.min(R * 1.2, 2 * Math.sqrt(l1) * k), r2 = Math.min(R * 1.2, 2 * Math.sqrt(l2) * k);
      g.strokeStyle = b.color; g.globalAlpha = 0.9; g.lineWidth = 1.5 * d;
      g.beginPath(); g.ellipse(cx, cy, Math.max(r1, 1), Math.max(r2, 0.5), -th, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    });
  }
  // Signaturforklaring
  if (S.lMode !== 'full') {
    g.textAlign = 'left'; g.font = `${10.5 * d}px system-ui`;
    let y = H - 10 * d - (S.bands.filter((b, j) => vis[j]).length - 1) * 14 * d;
    S.bands.forEach((b, j) => {
      if (!vis[j]) return;
      g.fillStyle = b.color; g.fillRect(8 * d, y - 8 * d, 9 * d, 9 * d);
      g.fillStyle = 'rgba(226,232,240,.85)'; g.fillText(b.name, 22 * d, y); y += 14 * d;
    });
  }
  if (!srcKind) { g.fillStyle = 'rgba(148,163,184,.8)'; g.textAlign = 'center'; g.font = `${13 * d}px system-ui`; g.fillText('Ingen kilde – vælg en under "Kilde…"', cx, cy + 40 * d); }
  if (frozen) { g.fillStyle = '#fbbf24'; g.textAlign = 'right'; g.font = `600 ${11 * d}px system-ui`; g.fillText('FROSSET', W - 8 * d, 16 * d); }
  g.restore();
}

/* ---------- Tegning: spektrum ---------- */
const FMIN = 20;
const fmax = () => Math.min(20000, nyq);
const xOfF = (f, W) => Math.log(f / FMIN) / Math.log(fmax() / FMIN) * W;
const fOfX = (x, W) => FMIN * Math.pow(fmax() / FMIN, x / W);
function buildMap(n, rev) {
  const lo = new Float32Array(n), hi = new Float32Array(n), tilt = new Float32Array(n), bin = sr / 8192;
  for (let i = 0; i < n; i++) {
    const p = rev ? n - 1 - i : i;
    const fa = fOfX(p - 0.5, n), fb = fOfX(p + 0.5, n), fc = fOfX(p, n);
    lo[i] = fa / bin; hi[i] = fb / bin; tilt[i] = Math.log2(fc / 1000);
  }
  return { n, lo, hi, tilt };
}
function resample(src, map, out, tiltDb) {
  const lim = src.length - 2;
  for (let i = 0; i < map.n; i++) {
    const a = map.lo[i], b = map.hi[i];
    let v;
    if (b - a < 1) {
      const c = Math.min((a + b) / 2, lim), k = c | 0, fr = c - k;
      v = Math.max(src[k], -200) * (1 - fr) + Math.max(src[k + 1], -200) * fr;
    } else {
      v = -200; const e = Math.min(b | 0, lim + 1);
      for (let k = Math.ceil(a); k <= e; k++) if (src[k] > v) v = src[k];
    }
    out[i] = v + tiltDb * map.tilt[i];
  }
}
let cA = null, cB = null, hA = null, hB = null, cSum = null;
const mouse = { x: -1, y: -1, over: false };
function drawSpectrum(dt) {
  const { c, g } = cv.specCanvas, W = c.width, H = c.height, d = dpr();
  if (!specMap || specMap.n !== W) {
    specMap = buildMap(W, false);
    cA = new Float32Array(W); cB = new Float32Array(W); hA = new Float32Array(W).fill(-200); hB = new Float32Array(W).fill(-200); cSum = new Float32Array(W);
  }
  g.fillStyle = '#06080a'; g.fillRect(0, 0, W, H);
  const top = 0, rng = S.sRange;
  const yOf = db => (top - db) / rng * H;
  // Bånd
  g.font = `${10.5 * d}px system-ui`; g.textAlign = 'center';
  S.bands.forEach((b, j) => {
    const x0 = xOfF(clamp(b.lo, FMIN, fmax()), W), x1 = xOfF(clamp(b.hi, FMIN, fmax()), W);
    g.fillStyle = b.color + (visible(j) ? '26' : '0c'); g.fillRect(x0, 0, x1 - x0, H);
    g.fillStyle = b.color; g.globalAlpha = visible(j) ? 0.9 : 0.35;
    g.fillRect(x0, 0, Math.max(1, d), H); g.fillRect(x1 - d, 0, Math.max(1, d), H);
    if (x1 - x0 > 28 * d) g.fillText(b.name, (x0 + x1) / 2, 13 * d);
    g.globalAlpha = 1;
  });
  // Gitter
  g.strokeStyle = 'rgba(148,163,184,.13)'; g.lineWidth = 1; g.fillStyle = 'rgba(148,163,184,.7)'; g.textAlign = 'left';
  g.beginPath();
  for (let db = 0; db >= -rng; db -= 10) { const y = yOf(db); g.moveTo(0, y); g.lineTo(W, y); if (db < 0 && db > -rng) g.fillText(db + ' dB', 4 * d, y - 3 * d); }
  for (const f of [20, 30, 40, 50, 60, 80, 100, 200, 300, 400, 500, 600, 800, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 20000]) { if (f > fmax()) continue; const x = xOfF(f, W); g.moveTo(x, 0); g.lineTo(x, H); }
  g.stroke();
  g.textAlign = 'center';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) g.fillText(fmtHz(f), xOfF(f, W), H - 5 * d);

  if (ac && srcKind) {
    const tilt = +S.sTilt;
    let A = fL, B = fR, colA = '#60a5fa', colB = '#f87171', nameA = 'L', nameB = 'R';
    if (S.sView === 'ms') { A = fM; B = fS; colA = '#e5e7eb'; colB = '#fbbf24'; nameA = 'Mid'; nameB = 'Side'; }
    resample(A, specMap, cA, tilt); resample(B, specMap, cB, tilt);
    if (S.sView === 'sum') { for (let i = 0; i < W; i++) cSum[i] = 10 * Math.log10((Math.pow(10, cA[i] / 10) + Math.pow(10, cB[i] / 10)) / 2 + 1e-30); }
    const fall = 15 * dt;
    const curves = S.sView === 'sum' ? [[cSum, hA, '#4fd1c5']] : [[cA, hA, colA], [cB, hB, colB]];
    curves.forEach(([cur, hold, col], ci) => {
      if (S.sHold) {
        for (let i = 0; i < W; i++) hold[i] = Math.max(cur[i], hold[i] - fall);
        g.strokeStyle = col; g.globalAlpha = 0.35; g.lineWidth = d; g.beginPath();
        for (let i = 0; i < W; i++) { const y = yOf(hold[i]); i ? g.lineTo(i, y) : g.moveTo(i, y); } g.stroke(); g.globalAlpha = 1;
      }
      g.beginPath();
      for (let i = 0; i < W; i++) { const y = yOf(cur[i]); i ? g.lineTo(i, y) : g.moveTo(i, y); }
      if (ci === 0) {
        g.save(); g.lineTo(W, H); g.lineTo(0, H); g.closePath();
        const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, col + '55'); gr.addColorStop(1, col + '05');
        g.fillStyle = gr; g.fill(); g.restore();
        g.beginPath(); for (let i = 0; i < W; i++) { const y = yOf(cur[i]); i ? g.lineTo(i, y) : g.moveTo(i, y); }
      }
      g.strokeStyle = col; g.lineWidth = 1.4 * d; g.stroke();
    });
    // Forklaring
    g.textAlign = 'right'; g.font = `${11 * d}px system-ui`;
    if (S.sView === 'sum') { g.fillStyle = '#4fd1c5'; g.fillText('Sum (L+R)', W - 8 * d, 30 * d); }
    else { g.fillStyle = colA; g.fillText(nameA, W - 40 * d, 30 * d); g.fillStyle = colB; g.fillText(nameB, W - 8 * d, 30 * d); }
    if (tilt) { g.fillStyle = 'rgba(148,163,184,.7)'; g.fillText('+' + String(tilt).replace('.', ',') + ' dB/okt @ 1 kHz', W - 8 * d, 44 * d); }
  }
  // Markør
  if (mouse.over) {
    const x = mouse.x * d, y = mouse.y * d, f = fOfX(x, W), db = -y / H * rng;
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    const midi = Math.round(69 + 12 * Math.log2(f / 440)), NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const cents = Math.round((69 + 12 * Math.log2(f / 440) - midi) * 100);
    const txt = `${fmtHz(f)} · ${NN[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}${cents ? (cents > 0 ? ' +' : ' ') + cents + '¢' : ''} · ${db.toFixed(0)} dB`;
    g.font = `${11 * d}px system-ui`; g.textAlign = x > W - 200 * d ? 'right' : 'left';
    g.fillStyle = '#e2e8f0'; g.fillText(txt, x + (x > W - 200 * d ? -6 : 6) * d, Math.max(28 * d, y - 6 * d));
  }
}

/* ---------- Tegning: spektrogram ---------- */
let sgCol = null, sgVals = null, sgA = null, sgB = null;
function drawSpectrogram(advance) {
  const { c, g } = cv.sgCanvas, W = c.width, H = c.height, d = dpr();
  if (!sgBuf.width) return;
  if (advance && ac && srcKind) {
    if (!sgMap || sgMap.n !== H) { sgMap = buildMap(H, true); sgCol = sgBufX.createImageData(1, H); sgVals = new Float32Array(H); sgA = new Float32Array(H); sgB = new Float32Array(H); }
    resample(fL, sgMap, sgA, +S.sTilt); resample(fR, sgMap, sgB, +S.sTilt);
    const px = sgCol.data, rng = S.sRange;
    for (let i = 0; i < H; i++) {
      const v = 10 * Math.log10((Math.pow(10, sgA[i] / 10) + Math.pow(10, sgB[i] / 10)) / 2 + 1e-30);
      const t = clamp((v + rng) / rng, 0, 1), k = ((t * t * 255) | 0) * 3;
      px[i * 4] = INFERNO[k]; px[i * 4 + 1] = INFERNO[k + 1]; px[i * 4 + 2] = INFERNO[k + 2]; px[i * 4 + 3] = 255;
    }
    const step = Math.max(1, Math.round(d));
    sgBufX.drawImage(sgBuf, -step, 0);
    for (let s = 0; s < step; s++) sgBufX.putImageData(sgCol, W - 1 - s, 0);
  }
  g.drawImage(sgBuf, 0, 0);
  // Frekvensakse og båndkanter
  const yOfF = f => H - xOfF(f, H);
  g.font = `${10 * d}px system-ui`; g.textAlign = 'left';
  for (const f of [100, 1000, 10000]) { const y = yOfF(f); g.fillStyle = 'rgba(226,232,240,.55)'; g.fillText(fmtHz(f), 4 * d, y - 2 * d); g.fillRect(0, y, 8 * d, 1); }
  S.bands.forEach((b, j) => {
    const y0 = yOfF(clamp(b.hi, FMIN, fmax())), y1 = yOfF(clamp(b.lo, FMIN, fmax()));
    g.fillStyle = b.color; g.globalAlpha = visible(j) ? 0.9 : 0.3;
    g.fillRect(W - 5 * d, y0, 5 * d, Math.max(1, y1 - y0 - d));
    g.globalAlpha = 1;
  });
}

/* ---------- Tegning: målere ---------- */
function drawMeters() {
  const { c, g } = cv.meterCanvas, W = c.width, H = c.height, d = dpr();
  g.fillStyle = '#06080a'; g.fillRect(0, 0, W, H);
  const padL = 84 * d, padR = 92 * d, bw = W - padL - padR, rowH = H / 4, bh = Math.min(16 * d, rowH * 0.5);
  const xDb = db => padL + clamp((db + 60) / 63, 0, 1) * bw;
  g.font = `${11 * d}px system-ui`; g.textBaseline = 'middle';
  const label = (t, y) => { g.fillStyle = '#94a3b8'; g.textAlign = 'left'; g.fillText(t, 8 * d, y); };
  const value = (t, y, col) => { g.fillStyle = col || '#e2e8f0'; g.textAlign = 'right'; g.font = `${12 * d}px ui-monospace,Menlo,monospace`; g.fillText(t, W - 8 * d, y); g.font = `${11 * d}px system-ui`; };
  const grad = g.createLinearGradient(xDb(-60), 0, xDb(3), 0);
  grad.addColorStop(0, '#15803d'); grad.addColorStop((60 - 18) / 63, '#22c55e'); grad.addColorStop((60 - 9) / 63, '#eab308'); grad.addColorStop((60 - 3) / 63, '#f97316'); grad.addColorStop(1, '#ef4444');
  const clip = performance.now() - fast.clipT < 3000;
  [['L', fast.msL, fast.pkL, fast.holdL], ['R', fast.msR, fast.pkR, fast.holdR]].forEach(([n, ms, pk, hold], i) => {
    const y = rowH * i + rowH / 2;
    label(n + '  pk/rms', y);
    g.fillStyle = '#1a2027'; g.fillRect(padL, y - bh / 2, bw, bh);
    const rms = 10 * Math.log10(ms + 1e-20);
    g.fillStyle = grad; g.fillRect(padL, y - bh / 2, Math.max(0, xDb(rms) - padL), bh);
    g.globalAlpha = 0.45; g.fillRect(padL, y - bh / 2 + bh * 0.35, Math.max(0, xDb(pk) - padL), bh * 0.3); g.globalAlpha = 1;
    g.fillStyle = '#f8fafc'; g.fillRect(xDb(pk) - d, y - bh / 2, 2 * d, bh);
    g.fillStyle = hold > -0.1 ? '#ef4444' : '#fbbf24'; g.fillRect(xDb(hold) - d, y - bh / 2 - 2 * d, 2 * d, bh + 4 * d);
    value(`${fmtDb(pk)} / ${fmtDb(rms)}`, y, clip ? '#ef4444' : undefined);
  });
  // dB-skala
  g.fillStyle = 'rgba(148,163,184,.65)'; g.textAlign = 'center'; g.font = `${9.5 * d}px system-ui`;
  for (const db of [-60, -48, -36, -24, -18, -12, -6, -3, 0]) { const x = xDb(db); g.fillText(String(db).replace('-', '−'), x, rowH * 2 - 5 * d); g.fillRect(x, rowH * 2 - 14 * d, 1, 4 * d); }
  g.font = `${11 * d}px system-ui`;
  // Korrelation
  const corr = fast.ll * fast.rr > 1e-14 ? clamp(fast.lr / Math.sqrt(fast.ll * fast.rr), -1, 1) : 0;
  const bal = fast.ll + fast.rr > 1e-14 ? (fast.rr - fast.ll) / (fast.rr + fast.ll) : 0;
  const cx = padL + bw / 2;
  [['Korrelation', corr, corr < 0 ? '#ef4444' : corr < 0.3 ? '#eab308' : '#22c55e', (corr >= 0 ? '+' : '') + corr.toFixed(2).replace('-', '−'), '−1', '+1'],
   ['Balance', bal, '#60a5fa', balTxt(fast.ll, fast.rr), 'L', 'R']].forEach(([n, v, col, txt, l0, l1], i) => {
    const y = rowH * (2 + i) + rowH / 2;
    label(n, y);
    g.fillStyle = '#1a2027'; g.fillRect(padL, y - bh / 2, bw, bh);
    g.fillStyle = col; const x = cx + v * bw / 2; g.fillRect(Math.min(cx, x), y - bh / 2, Math.abs(x - cx), bh);
    g.fillStyle = '#f8fafc'; g.fillRect(x - d, y - bh / 2 - 2 * d, 2 * d, bh + 4 * d);
    g.fillStyle = '#4b5563'; g.fillRect(cx, y - bh / 2, 1, bh);
    g.fillStyle = 'rgba(148,163,184,.75)'; g.font = `${9.5 * d}px system-ui`; g.textAlign = 'left'; g.fillText(l0, padL + 3 * d, y); g.textAlign = 'right'; g.fillText(l1, padL + bw - 3 * d, y); g.font = `${11 * d}px system-ui`;
    value(txt, y, i === 0 ? col : undefined);
  });
}
function balTxt(ll, rr) {
  if (ll + rr < 1e-14) return '–';
  const db = 10 * Math.log10((rr + 1e-20) / (ll + 1e-20));
  if (Math.abs(db) < 0.1) return 'C';
  return (db > 0 ? 'R ' : 'L ') + Math.abs(db).toFixed(1).replace('.', ',') + ' dB';
}
function drawHistory() {
  const { c, g } = cv.histCanvas, W = c.width, H = c.height, d = dpr();
  g.fillStyle = '#06080a'; g.fillRect(0, 0, W, H);
  const lo = -45, hi = -3, yOf = v => H - (clamp(v, lo, hi) - lo) / (hi - lo) * H;
  g.font = `${9.5 * d}px system-ui`; g.fillStyle = 'rgba(148,163,184,.6)'; g.textAlign = 'left';
  for (const v of [-40, -30, -20, -10]) { const y = yOf(v); g.fillRect(0, y, W, 1); g.fillText(String(v).replace('-', '−'), 4 * d, y - 2 * d); }
  const ty = yOf(S.target); g.fillStyle = 'rgba(79,209,197,.6)'; g.fillRect(0, ty, W, d); g.textAlign = 'right'; g.fillText('mål ' + String(S.target).replace('-', '−') + ' LUFS', W - 4 * d, ty - 3 * d);
  const hst = lou.hist, n = hst.length; if (n < 2) return;
  [[0, 'rgba(96,165,250,.55)', d], [1, '#4fd1c5', 1.8 * d]].forEach(([k, col, lw]) => {
    g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
    let st = false;
    for (let i = 0; i < n; i++) { const v = hst[i][k]; if (!isFinite(v)) { st = false; continue; } const x = W - (n - 1 - i) / 599 * W, y = yOf(v); st ? g.lineTo(x, y) : g.moveTo(x, y); st = true; }
    g.stroke();
  });
  g.textAlign = 'left'; g.fillStyle = 'rgba(148,163,184,.75)'; g.fillText('Short-term (tyk) · momentary (tynd) · 60 s', 40 * d, 12 * d);
}
let roT = 0;
function updateReadouts(t) {
  if (t - roT < 120) return; roT = t;
  const f = v => isFinite(v) && v > -70 ? v.toFixed(1).replace('.', ',').replace('-', '−') : '–';
  $('#roM').textContent = f(lou.M); $('#roS').textContent = f(lou.ST); $('#roI').textContent = f(lou.I);
  $('#roLRA').textContent = isFinite(lou.LRA) ? lou.LRA.toFixed(1).replace('.', ',') + ' LU' : '–';
  const tp = 20 * Math.log10(lou.tpMax + 1e-12);
  const tpEl = $('#roTP'); tpEl.textContent = lou.tpMax > 0 ? fmtDb(tp).replace('.', ',') : '–'; tpEl.style.color = tp > -1 ? '#ef4444' : '';
  $('#roPLR').textContent = lou.tpMax > 0 && isFinite(lou.I) && lou.I > -70 ? (tp - lou.I).toFixed(1).replace('.', ',') + ' LU' : '–';
  const dd = lou.I - S.target;
  $('#roD').textContent = isFinite(lou.I) && lou.I > -70 ? (Math.abs(dd) < 0.5 ? '✓ på mål' : (dd > 0 ? '+' : '−') + Math.abs(dd).toFixed(1).replace('.', ',') + ' LU fra mål') : '';
  // Bånd-tabel
  bandRefs.forEach((r, j) => {
    const s = bandStat[j]; if (!s) return;
    const lev = 10 * Math.log10((s.ll + s.rr) / 2 + 1e-20);
    r.lev.textContent = lev > -100 ? fmtDb(lev).replace('.', ',') + ' dB' : '–';
    const ok = s.ll * s.rr > 1e-16;
    const corr = ok ? clamp(s.lr / Math.sqrt(s.ll * s.rr), -1, 1) : 0;
    const bal = s.ll + s.rr > 1e-16 ? (s.rr - s.ll) / (s.rr + s.ll) : 0;
    setBar(r.corr, ok ? corr : 0, corr < 0 ? '#ef4444' : corr < 0.3 ? '#eab308' : '#22c55e');
    r.corrv.textContent = ok ? (corr >= 0 ? '+' : '−') + Math.abs(corr).toFixed(2).replace('.', ',') : '–';
    setBar(r.bal, bal, S.bands[j].color);
    r.balv.textContent = balTxt(s.ll, s.rr);
    const side = (s.ll + s.rr - 2 * s.lr) / 2, mid = (s.ll + s.rr + 2 * s.lr) / 2;
    const wd = 10 * Math.log10((side + 1e-20) / (mid + 1e-20));
    r.wid.textContent = s.ll + s.rr > 1e-16 ? (wd < -40 ? 'mono' : fmtDb(wd).replace('.', ',') + ' dB') : '–';
    r.wid.style.color = wd > 0 ? '#f87171' : '';
  });
}
function setBar(el, v, col) {
  v = clamp(v, -1, 1);
  el.style.left = (v >= 0 ? 50 : 50 + v * 50) + '%';
  el.style.width = Math.abs(v * 50) + '%';
  el.style.background = col;
}

/* ---------- Hovedløkke ---------- */
let lastT = performance.now(), stT = 0;
function frame(t) {
  const dt = clamp((t - lastT) / 1000, 0.001, 0.1); lastT = t;
  try {
    if (ac && srcKind && anL) {
      const f = pullFast(dt);
      if (mode === 'standby' && sbPhase === 'listen') standbyTick(dt);
      if (mode === 'analyze' && !frozen) analyzeStep(dt, f);
    } else levelFast = 0;
    if (t - stT > 400) { stT = t; updateStatus(); }
    if (mode === 'analyze' && !frozen) {
      drawLissa(); drawSpectrum(dt); drawSpectrogram(true); drawMeters();
      if (lou.dirty) { drawHistory(); lou.dirty = false; }
      updateReadouts(t);
    } else if (mode === 'analyze' && mouse.over) drawSpectrum(0);
  } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}

/* ---------- Bånd-tabel ---------- */
let bandRefs = [];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderBands() {
  const tb = $('#bandBody'); tb.innerHTML = '';
  bandRefs = S.bands.map((b, j) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" class="bshow" ${b.show ? 'checked' : ''}></td>
      <td><button class="bsolo ${S.solo === j ? 'on' : ''}" title="Solo i Lissajous${j < 9 ? ' (tast ' + (j + 1) + ')' : ''}">S</button></td>
      <td><input type="color" class="bcol" value="${b.color}"></td>
      <td><input type="text" class="bname" value="${esc(b.name)}"></td>
      <td><input type="number" class="blo" min="5" max="24000" step="1" value="${Math.round(b.lo)}"></td>
      <td><input type="number" class="bhi" min="10" max="24000" step="1" value="${Math.round(b.hi)}"></td>
      <td class="num"><span class="blev">–</span></td>
      <td><span class="cbar"><i class="bcorr"></i></span><span class="num bcorrv">–</span></td>
      <td><span class="cbar"><i class="bbal"></i></span><span class="num bbalv">–</span></td>
      <td class="num"><span class="bwid">–</span></td>
      <td><button class="bdel" title="Fjern bånd">✕</button></td>`;
    const q = s => tr.querySelector(s);
    q('.bshow').onchange = e => { b.show = e.target.checked; save(); };
    q('.bsolo').onclick = () => setSolo(S.solo === j ? -1 : j);
    q('.bcol').oninput = e => { b.color = e.target.value; save(); };
    q('.bname').oninput = e => { b.name = e.target.value; save(); };
    const onF = () => {
      let lo = +q('.blo').value, hi = +q('.bhi').value;
      if (!(lo > 0)) lo = 20; if (!(hi > 0)) hi = 20000;
      if (hi <= lo) hi = lo * 1.12;
      b.lo = lo; b.hi = hi; q('.bhi').value = Math.round(hi);
      applyBandFreqs(); markCustom(); save();
    };
    q('.blo').onchange = onF; q('.bhi').onchange = onF;
    q('.bdel').onclick = () => {
      if (S.bands.length <= 1) return;
      S.bands.splice(j, 1);
      if (S.solo === j) S.solo = -1; else if (S.solo > j) S.solo--;
      markCustom(); buildBands(); allocBandState(); renderBands(); save();
    };
    tb.appendChild(tr);
    return { tr, lev: q('.blev'), corr: q('.bcorr'), corrv: q('.bcorrv'), bal: q('.bbal'), balv: q('.bbalv'), wid: q('.bwid'), lo: q('.blo'), hi: q('.bhi') };
  });
}
function setSolo(j) {
  S.solo = j >= S.bands.length ? -1 : j;
  bandRefs.forEach((r, k) => r.tr.querySelector('.bsolo').classList.toggle('on', k === S.solo));
  save();
}
function markCustom() { S.preset = 'custom'; $('#preset').value = 'custom'; }

/* ---------- Træk båndkanter i spektret ---------- */
let drag = null;
function edgeAt(x) {
  const c = cv.specCanvas.c, W = c.clientWidth;
  let best = null, bd = 7;
  S.bands.forEach((b, j) => {
    for (const edge of ['lo', 'hi']) {
      const ex = xOfF(clamp(b[edge], FMIN, fmax()), W), dd = Math.abs(ex - x);
      if (dd < bd) { bd = dd; best = { j, edge }; }
    }
  });
  return best;
}
const sc = cv.specCanvas.c;
sc.addEventListener('pointermove', e => {
  const r = sc.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.over = true;
  if (drag) {
    const b = S.bands[drag.j];
    let f = fOfX(mouse.x, r.width);
    f = f < 100 ? Math.round(f) : f < 1000 ? Math.round(f / 5) * 5 : Math.round(f / 50) * 50;
    if (drag.edge === 'lo') b.lo = clamp(f, 5, b.hi * 0.95); else b.hi = clamp(f, b.lo * 1.05, 24000);
    bandRefs[drag.j].lo.value = Math.round(b.lo); bandRefs[drag.j].hi.value = Math.round(b.hi);
    applyBandFreqs();
  } else sc.style.cursor = edgeAt(mouse.x) ? 'ew-resize' : 'crosshair';
});
sc.addEventListener('pointerleave', () => { mouse.over = false; });
sc.addEventListener('pointerdown', e => {
  const r = sc.getBoundingClientRect(); const hit = edgeAt(e.clientX - r.left);
  if (hit) { drag = hit; sc.setPointerCapture(e.pointerId); }
});
sc.addEventListener('pointerup', () => { if (drag) { drag = null; markCustom(); save(); } });

/* ---------- Kontroller ---------- */
function bindSel(id, key, cb, num) {
  const el = $('#' + id); el.value = String(S[key]);
  el.onchange = () => { S[key] = num ? +el.value : el.value; save(); cb && cb(); };
}
function bindChk(id, key, cb) { const el = $('#' + id); el.checked = !!S[key]; el.onchange = () => { S[key] = el.checked; save(); cb && cb(); }; }
function bindRange(id, key, cb) { const el = $('#' + id); el.value = S[key]; el.oninput = () => { S[key] = +el.value; save(); cb && cb(); }; }
const clearDens = () => { dens.forEach(D => D.fill(0)); densFull.fill(0); };
bindSel('lMode', 'lMode', clearDens); bindSel('lAxis', 'lAxis', clearDens);
bindChk('lAuto', 'lAuto'); bindChk('lEllipse', 'lEllipse'); bindChk('normBands', 'normBands');
bindRange('lGain', 'lGain', () => { $('#lGainV').textContent = fmtDb(S.lGain, 1) + ' dB'; }); $('#lGainV').textContent = fmtDb(S.lGain, 1) + ' dB';
bindRange('lPersist', 'lPersist'); bindRange('lSens', 'lSens');
bindSel('sView', 'sView'); bindSel('sTilt', 'sTilt', null, true); bindSel('sRange', 'sRange', () => { hA && hA.fill(-200); hB && hB.fill(-200); }, true);
bindRange('sSmooth', 'sSmooth', () => { if (ac) [anL, anR, anM, anS].forEach(a => { a.smoothingTimeConstant = S.sSmooth; }); });
bindChk('sHold', 'sHold', () => { hA && hA.fill(-200); hB && hB.fill(-200); });
bindSel('target', 'target', () => { lou.dirty = true; }, true);
bindSel('slope', 'slope', buildBands, true);
const ps = $('#preset');
ps.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('') + '<option value="custom">Egne bånd</option>';
ps.value = S.preset in PRESETS ? S.preset : 'custom';
ps.onchange = () => {
  if (ps.value === 'custom') return;
  S.preset = ps.value; S.bands = presetBands(ps.value); S.solo = -1;
  buildBands(); allocBandState(); renderBands(); save();
};
$('#btnAddBand').onclick = () => {
  const last = S.bands[S.bands.length - 1];
  const lo = last ? Math.min(last.hi, 16000) : 1000;
  S.bands.push({ name: 'Bånd ' + (S.bands.length + 1), lo, hi: Math.min(lo * 2, 22000), color: hslHex((S.bands.length * 47) % 360, 80, 58), show: true });
  markCustom(); buildBands(); allocBandState(); renderBands(); save();
};
$('#btnResetL').onclick = resetLoudness;
$('#monitorOut').checked = S.monitor;
$('#monitorOut').onchange = e => setMonitor(e.target.checked);
$('#btnFreeze').onclick = toggleFreeze;
function toggleFreeze() { frozen = !frozen; $('#btnFreeze').classList.toggle('on', frozen); $('#btnFreeze').textContent = frozen ? 'Fortsæt' : 'Frys'; }
$('#btnHelp').onclick = () => $('#help').showModal();
$('#btnSource').onclick = () => showStandby('idle');
$('#btnStandby').onclick = () => { if (srcKind && srcKind !== 'file' && srcKind !== 'test') showStandby('listen'); else showStandby('idle'); };
$('#lissaCanvas').ondblclick = toggleFull;
function toggleFull() { if (document.fullscreenElement) document.exitFullscreen(); else $('#lissaPanel').requestFullscreen && $('#lissaPanel').requestFullscreen(); }

// Standby-knapper
$('#srcDisplay').onclick = () => beginSource(startDisplay);
$('#srcDevice').onclick = () => beginSource(() => startDevice($('#devSel').value));
$('#srcFile').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { const f = e.target.files[0]; if (f) beginSource(() => startFile(f)); e.target.value = ''; };
$('#srcTest').onclick = () => beginSource(startTest);
$('#btnAnalyze').onclick = () => enterAnalyze();
$('#btnAnalyzeNow').onclick = () => enterAnalyze();
$('#btnNotNow').onclick = () => { snoozed = true; askShown = false; $('#sbAsk').hidden = true; $('#sbMsg').textContent = 'OK – jeg spørger igen, næste gang lyden starter efter en pause.'; };
$('#btnChangeSrc').onclick = () => showStandby('idle');
bindChk('autoAnalyze', 'autoAnalyze');
bindChk('autoDevice', 'autoDevice');
$('#notify').checked = S.notify;
$('#notify').onchange = async e => {
  S.notify = e.target.checked; save();
  if (S.notify && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (err) { } }
};
$('#devSel').onchange = e => { S.deviceId = e.target.value; save(); };

document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); toggleFreeze(); }
  else if (e.key === 'f' || e.key === 'F') toggleFull();
  else if (e.key === '0') setSolo(-1);
  else if (/^[1-9]$/.test(e.key)) { const j = +e.key - 1; if (j < S.bands.length) setSolo(S.solo === j ? -1 : j); }
});
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

/* ---------- Installérbar app (PWA) ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false; });
$('#btnInstall').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#btnInstall').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });

/* ---------- Opstart ---------- */
renderBands();
requestAnimationFrame(frame);
(async function boot() {
  showStandby('idle');
  await refreshDevices().catch(() => { });
  // Automatisk start med lydenhed, hvis brugeren har valgt det og tilladelsen allerede er givet
  if (S.autoDevice && navigator.permissions) {
    try {
      const p = await navigator.permissions.query({ name: 'microphone' });
      if (p.state === 'granted') {
        await beginSource(() => startDevice(S.deviceId));
        // AudioContext kan være sat på pause indtil første klik
        if (ac && ac.state === 'suspended') {
          $('#sbMsg').textContent = 'Klik et vilkårligt sted for at starte lytningen.';
          const resume = () => { ac.resume(); $('#sbMsg').textContent = 'Venter på lyd. Afspil noget, så spørger jeg.'; };
          window.addEventListener('pointerdown', resume, { once: true });
          window.addEventListener('keydown', resume, { once: true });
        }
      }
    } catch (e) { }
  }
})();
