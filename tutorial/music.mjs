// Música lo-fi original, sintetizada por código (sin muestras ni derechos de terceros).
// 72 BPM: un compás dura 3,333 s, así que los cambios de escena del vídeo (múltiplos de compás)
// caen siempre en el primer tiempo.
import { writeFileSync } from 'node:fs';

export const BPM = 72;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
const SR = 44100;

// Generador pseudoaleatorio con semilla: la canción sale siempre igual.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

// Progresión: Fmaj9 – Em9 – Dm9 – Cmaj9 (voces cerradas, cálidas)
const CHORDS = [
  { notes: [53, 57, 60, 64, 67], bass: 41 },
  { notes: [52, 55, 59, 62, 66], bass: 40 },
  { notes: [50, 53, 57, 60, 64], bass: 38 },
  { notes: [48, 52, 55, 59, 62], bass: 36 },
];
// Melodía sencilla en pentatónica de do, un compás sí y otro no.
const MELODY = [
  [[0, 76, 1], [1.5, 74, 0.5], [2, 72, 1.5]],
  [[0.5, 71, 0.5], [1, 72, 1], [2.5, 67, 1.5]],
  [[0, 74, 1.5], [2, 76, 0.5], [2.5, 79, 1.5]],
  [[0, 76, 1], [1, 74, 1], [2, 72, 2]],
];

export function renderMusic(seconds, file) {
  const n = Math.ceil(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rand = rng(20261011);
  const bars = Math.ceil(seconds / BAR);
  const add = (buf, i, v) => { if (i >= 0 && i < n) buf[i] += v; };

  // Piano eléctrico (FM con trémolo estéreo)
  function keys(start, midi, dur, vel) {
    const f = mtof(midi), s0 = Math.floor(start * SR), len = Math.floor((dur + 0.6) * SR);
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      const index = 1.6 * Math.exp(-t * 3) + 0.25;
      const mod = Math.sin(2 * Math.PI * f * t) * index;
      let env = Math.min(1, t / 0.006) * (0.35 + 0.65 * Math.exp(-t * 1.6));
      if (t > dur) env *= Math.exp(-(t - dur) * 9);
      const v = Math.sin(2 * Math.PI * f * t + mod) * env * vel * 0.11;
      const trem = 0.15 * Math.sin(2 * Math.PI * 4.2 * t);
      add(L, s0 + k, v * (1 + trem));
      add(R, s0 + k, v * (1 - trem));
    }
  }
  // Campanita suave para la melodía
  function bell(start, midi, dur, vel) {
    const f = mtof(midi), s0 = Math.floor(start * SR), len = Math.floor((dur + 0.8) * SR);
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      let env = Math.min(1, t / 0.01) * Math.exp(-t * 2.2);
      if (t > dur) env *= Math.exp(-(t - dur) * 6);
      const v = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t)) * env * vel * 0.07;
      add(L, s0 + k, v * 0.8); add(R, s0 + k, v * 1.1);
    }
  }
  function bass(start, midi, dur, vel) {
    const f = mtof(midi), s0 = Math.floor(start * SR), len = Math.floor((dur + 0.2) * SR);
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      let env = Math.min(1, t / 0.01) * (0.55 + 0.45 * Math.exp(-t * 4));
      if (t > dur) env *= Math.exp(-(t - dur) * 20);
      const v = Math.tanh(1.4 * (Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t))) * env * vel * 0.2;
      add(L, s0 + k, v); add(R, s0 + k, v);
    }
  }
  const kickEnv = new Float32Array(n); // para el «sidechain» que hace respirar al piano
  function kick(start, vel) {
    const s0 = Math.floor(start * SR), len = Math.floor(0.45 * SR);
    let ph = 0;
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      ph += 2 * Math.PI * (44 + 85 * Math.exp(-t * 32)) / SR;
      const env = Math.exp(-t * 7);
      const v = Math.sin(ph) * env * vel * 0.42;
      add(L, s0 + k, v); add(R, s0 + k, v);
      if (s0 + k < n) kickEnv[s0 + k] = Math.max(kickEnv[s0 + k], env);
    }
  }
  function snare(start, vel) {
    const s0 = Math.floor(start * SR), len = Math.floor(0.3 * SR);
    let lp = 0, prev = 0;
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      const noise = rand() * 2 - 1;
      lp += 0.35 * (noise - lp);           // paso bajo
      const hp = lp - prev; prev = lp;      // y paso alto: ruido «de lija»
      const v = (hp * 1.6 * Math.exp(-t * 16) + Math.sin(2 * Math.PI * 185 * t) * 0.35 * Math.exp(-t * 28)) * vel * 0.2;
      add(L, s0 + k, v * 0.95); add(R, s0 + k, v * 1.05);
    }
  }
  function hat(start, vel) {
    const s0 = Math.floor(start * SR), len = Math.floor(0.07 * SR);
    let prev = 0;
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      const noise = rand() * 2 - 1;
      const v = (noise - prev) * Math.exp(-t * 70) * vel * 0.045; prev = noise;
      add(L, s0 + k, v * 1.2); add(R, s0 + k, v * 0.8);
    }
  }

  for (let b = 0; b < bars; b++) {
    const t0 = b * BAR;
    const ch = CHORDS[b % 4];
    const last = b >= bars - 1;
    // Acordes con un pequeño «rasgueo» y un segundo golpe a contratiempo
    ch.notes.forEach((m, i) => keys(t0 + i * 0.018 + rand() * 0.01, m, BEAT * 2.4, 0.9 - i * 0.06));
    if (!last) ch.notes.slice(1).forEach((m, i) => keys(t0 + BEAT * 2.5 + i * 0.015, m, BEAT * 1.4, 0.5));
    if (b >= 1 && !last) {
      bass(t0, ch.bass, BEAT * 1.6, 1);
      bass(t0 + BEAT * 2.75, ch.bass + (b % 2 ? 7 : 12), BEAT * 1.1, 0.8);
    }
    // La batería entra en el segundo compás y descansa en el último
    if (b >= 1 && !last) {
      const swing = BEAT * 0.5 * 0.16;
      kick(t0, 1); kick(t0 + BEAT * 2.5, 0.8);
      if (b % 4 === 3) kick(t0 + BEAT * 3.5, 0.55);
      snare(t0 + BEAT, 0.9); snare(t0 + BEAT * 3, 1);
      for (let e = 0; e < 8; e++) hat(t0 + e * BEAT / 2 + (e % 2 ? swing : 0), e % 2 ? 0.6 + rand() * 0.2 : 0.9);
    }
    if (b >= 2 && b % 2 === 0 && b < bars - 2) {
      for (const [beat, m, d] of MELODY[(b / 2) % 4]) bell(t0 + beat * BEAT, m, d * BEAT, 0.8);
    }
  }

  // Vinilo: chasquidos sueltos y un siseo muy suave
  let hiss = 0;
  for (let i = 0; i < n; i++) {
    hiss += 0.05 * ((rand() * 2 - 1) - hiss);
    let v = hiss * 0.012;
    if (rand() < 0.00035) v += (rand() * 2 - 1) * 0.12;
    L[i] += v; R[i] += v * 0.9;
  }

  // Mezcla final: el piano «respira» con el bombo, paso bajo cálido, saturación suave y fundidos
  let lpL = 0, lpR = 0, peak = 0;
  const a = 1 - Math.exp(-2 * Math.PI * 5200 / SR);
  for (let i = 0; i < n; i++) {
    const duck = 1 - 0.25 * kickEnv[i];
    lpL += a * (L[i] * duck - lpL); lpR += a * (R[i] * duck - lpR);
    const t = i / SR;
    const fade = Math.min(1, t / 1.5) * Math.min(1, (seconds - t) / 3);
    L[i] = Math.tanh(lpL * 1.2) * fade; R[i] = Math.tanh(lpR * 1.2) * fade;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }

  // WAV estéreo de 16 bits, normalizado a -1 dBFS
  const gain = 0.89 / (peak || 1);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * gain)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * gain)) * 32767), 46 + i * 4);
  }
  writeFileSync(file, buf);
}
