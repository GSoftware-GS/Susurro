// Vídeo tutorial de Susurro (motion graphics vertical 1080×1920, 30 fps) con música lo-fi.
// Uso:  npm run render                      → tutorial/susurro-tutorial.mp4
//       node render.mjs --stills 3,15,40    → fotogramas sueltos en tutorial/stills/ para revisar
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR, renderMusic } from './music.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = 1080, H = 1920, FPS = 30;

GlobalFonts.registerFromPath('C:/Windows/Fonts/segoeuib.ttf', 'SB');
GlobalFonts.registerFromPath('C:/Windows/Fonts/seguisb.ttf', 'SSB');
GlobalFonts.registerFromPath('C:/Windows/Fonts/segoeui.ttf', 'SR');
GlobalFonts.registerFromPath('C:/Windows/Fonts/consola.ttf', 'MONO');

const C = {
  bg: '#0b1113', screen: '#0e1517', panel: '#141d20', panel2: '#1a2427', line: '#24343a',
  text: '#e6eeef', muted: '#8fa2a5', accent: '#14b8a6', accentDark: '#0f766e', soft: 'rgba(20,184,166,0.16)',
  out: '#0f6d65', in: '#1b2629', ok: '#22c55e', warn: '#fb923c',
};

// ---------- Guion: cada escena dura un número entero de compases de la música ----------
const SCENES = [
  { id: 'intro', bars: 2 },
  { id: 'install', bars: 3, step: 1, title: 'Instálala', caption: 'Abre susurro-chat.netlify.app en el móvil y pulsa Compartir → «Añadir a pantalla de inicio». En Android: «Instalar».' },
  { id: 'identity', bars: 3, step: 2, title: 'Crea tu identidad', caption: 'Elige un nombre y una contraseña. Tus claves se crean en tu móvil y nadie más las tiene.' },
  { id: 'contacts', bars: 3, step: 3, title: 'Añade a tus amigos', caption: 'Enseña tu código QR o escanea el de tu amigo. También puedes enviarle tu enlace.' },
  { id: 'chat', bars: 3, step: 4, title: 'Chatea cifrado', caption: 'Cada mensaje se cifra en tu móvil y viaja por servidores elegidos al azar. Solo tu contacto puede leerlo.' },
  { id: 'timer', bars: 3, step: 5, title: 'Mensajes temporales', caption: 'Actívalos en un chat y los mensajes desaparecen de los dos móviles pasado el tiempo que elijas.' },
  { id: 'protect', bars: 3, step: 6, title: 'Protege tu cuenta', caption: 'Se bloquea sola cuando no la usas. Guarda una copia cifrada para cambiar de móvil sin perder nada.' },
  { id: 'tips', bars: 2 },
  { id: 'outro', bars: 2 },
];
let acc = 0;
for (const s of SCENES) { s.start = acc; s.dur = s.bars * BAR; acc += s.dur; }
const TOTAL = acc;

// ---------- Utilidades de animación ----------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const eOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const eInOut = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const eBack = (t) => { t = clamp(t); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const prog = (u, s, d = 0.5) => clamp((u - s) / d);
function rand(seed) { let x = Math.sin(seed * 9301.17 + 49297.3) * 233280; return x - Math.floor(x); }

// ---------- Dibujo básico ----------
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fillRR(ctx, x, y, w, h, r, color) { rr(ctx, x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); }
function text(ctx, s, x, y, size, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.font = `${size}px ${o.font || 'SR'}`;
  ctx.fillStyle = o.color || C.text;
  ctx.textAlign = o.align || 'center';
  ctx.textBaseline = o.baseline || 'alphabetic';
  ctx.fillText(s, x, y);
  ctx.restore();
}
function wrap(ctx, s, size, font, maxW) {
  ctx.font = `${size}px ${font}`;
  const lines = []; let line = '';
  for (const w of s.split(' ')) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
function paragraph(ctx, s, x, y, size, o = {}) {
  const lines = wrap(ctx, s, size, o.font || 'SR', o.maxW || 900);
  lines.forEach((l, i) => text(ctx, l, x, y + i * (o.lh || size * 1.35), size, o));
  return lines.length * (o.lh || size * 1.35);
}

// Iconos (trazos de 24×24, los mismos de la app)
const ICONS = {
  lock: ['M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  globe: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
  key: ['M2 15.5a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0', 'm21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3'],
  timer: ['M10 2h4M12 14l3-3', 'M4 14a8 8 0 1 0 16 0a8 8 0 1 0-16 0'],
  check: ['M20 6 9 17l-5-5'],
  share: ['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', 'm16 6-4-4-4 4M12 2v13'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
  send: ['M22 2 11 13', 'm22 2-7 20-4-9-9-4 20-7z'],
  plusSquare: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M12 8v8M8 12h8'],
  bookmark: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z'],
  copy: ['M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  back: ['m15 18-6-6 6-6'],
  fwd: ['m9 18 6-6-6-6'],
  tabs: ['M8 3h11a2 2 0 0 1 2 2v11', 'M5 7h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  relay: ['M5 12a7 7 0 0 1 14 0', 'M2 12a10 10 0 0 1 20 0', 'M12 12v9', 'M10.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
};
const iconPaths = Object.fromEntries(Object.entries(ICONS).map(([k, v]) => [k, v.map((d) => new Path2D(d))]));
function icon(ctx, name, cx, cy, size, color, lw = 2) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const p of iconPaths[name]) ctx.stroke(p);
  ctx.restore();
}

// Logo de Susurro: burbuja con cerradura sobre un cuadrado con degradado
function logo(ctx, cx, cy, size, alpha = 1) {
  const x = cx - size / 2, y = cy - size / 2, s = size;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, '#14b8a6'); g.addColorStop(1, '#0f766e');
  ctx.shadowColor = 'rgba(20,184,166,0.45)'; ctx.shadowBlur = s * 0.25;
  fillRR(ctx, x, y, s, s, s * 0.225, g);
  ctx.shadowBlur = 0;
  fillRR(ctx, x + s * 0.22, y + s * 0.25, s * 0.56, s * 0.44, s * 0.13, '#fff');
  ctx.beginPath(); ctx.moveTo(x + s * 0.33, y + s * 0.6); ctx.lineTo(x + s * 0.29, y + s * 0.79); ctx.lineTo(x + s * 0.5, y + s * 0.66); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.beginPath(); ctx.arc(x + s * 0.5, y + s * 0.43, s * 0.062, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  fillRR(ctx, x + s * 0.472, y + s * 0.455, s * 0.056, s * 0.12, s * 0.02, g);
  ctx.restore();
}

function avatar(ctx, cx, cy, r, letter, hue) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = `hsl(${hue} 45% 42%)`; ctx.fill();
  text(ctx, letter, cx, cy + r * 0.36, r * 0.95, { font: 'SB' });
}

function tap(ctx, x, y, u, t0) {
  const a = (u - t0) / 0.6;
  if (u > t0 - 0.25 && u < t0) { // el dedo se acerca
    const k = eOut((u - (t0 - 0.25)) / 0.25);
    ctx.beginPath(); ctx.arc(x, y, lerp(46, 30, k), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.35 * k})`; ctx.fill();
  }
  if (a < 0 || a > 1) return;
  ctx.beginPath(); ctx.arc(x, y, lerp(20, 80, eOut(a)), 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - a)})`; ctx.lineWidth = 4; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 30, 0, Math.PI * 2); ctx.fillStyle = `rgba(255,255,255,${0.35 * (1 - a)})`; ctx.fill();
}

function button(ctx, x, y, w, h, label, o = {}) {
  const pressed = o.pressed || 0;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2); ctx.scale(1 - pressed * 0.04, 1 - pressed * 0.04); ctx.translate(-(x + w / 2), -(y + h / 2));
  if (o.ghost) { rr(ctx, x, y, w, h, h / 2); ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.stroke(); }
  else fillRR(ctx, x, y, w, h, h / 2, o.color || C.accent);
  const iconSize = h * 0.38;
  const tx = o.icon ? x + w / 2 + iconSize * 0.7 : x + w / 2;
  if (o.icon) {
    ctx.font = `${h * 0.36}px SB`;
    const tw = ctx.measureText(label).width;
    icon(ctx, o.icon, x + w / 2 - tw / 2 - iconSize * 0.2, y + h / 2, iconSize, o.ghost ? C.accent : '#032421', 2.4);
  }
  text(ctx, label, tx, y + h * 0.63, h * 0.36, { font: 'SB', color: o.ghost ? C.accent : '#032421' });
  ctx.restore();
}

function field(ctx, x, y, w, h, value, o = {}) {
  fillRR(ctx, x, y, w, h, 18, C.panel2);
  if (o.focus) { rr(ctx, x, y, w, h, 18); ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.stroke(); }
  const isDots = o.dots != null;
  ctx.save();
  if (isDots) {
    for (let i = 0; i < o.dots; i++) { ctx.beginPath(); ctx.arc(x + 32 + i * 26, y + h / 2, 8, 0, Math.PI * 2); ctx.fillStyle = C.text; ctx.fill(); }
  } else if (value) {
    text(ctx, value, x + 26, y + h * 0.64, o.size || 28, { align: 'left', font: o.font || 'SR', color: o.color || C.text });
  } else if (o.placeholder) {
    text(ctx, o.placeholder, x + 26, y + h * 0.64, 26, { align: 'left', color: C.muted });
  }
  if (o.caret) {
    ctx.font = `${o.size || 28}px ${o.font || 'SR'}`;
    const cx = isDots ? x + 32 + o.dots * 26 - 10 : x + 26 + ctx.measureText(value || '').width + 4;
    fillRR(ctx, cx, y + h * 0.25, 3, h * 0.5, 1, C.accent);
  }
  ctx.restore();
}

function bubble(ctx, S, y, s, out, o = {}) {
  const size = 28, pad = 22, maxW = S.w * 0.7;
  const lines = wrap(ctx, s, size, 'SR', maxW - pad * 2);
  ctx.font = `${size}px SR`;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), o.minW || 0);
  const w = Math.min(maxW, tw + pad * 2 + 70), h = lines.length * 38 + 44;
  const x = out ? S.x + S.w - 24 - w : S.x + 24;
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  const sc = o.scale ?? 1;
  ctx.translate(x + (out ? w : 0), y + h); ctx.scale(sc, sc); ctx.translate(-(x + (out ? w : 0)), -(y + h));
  fillRR(ctx, x, y, w, h, 28, out ? C.out : C.in);
  const color = o.cipher ? '#7ff0dd' : C.text;
  lines.forEach((l, i) => text(ctx, o.cipher ? scramble(l, o.cipher) : l, x + pad, y + 46 + i * 38, size, { align: 'left', color, font: o.cipher ? 'MONO' : 'SR' }));
  // hora, temporizador y estado
  let mx = x + w - 18;
  if (out) { icon(ctx, o.sent ? 'check' : 'timer', mx - 10, y + h - 20, 20, 'rgba(234,255,251,0.8)', 2.4); mx -= 28; }
  text(ctx, o.time || '18:24', mx, y + h - 13, 20, { align: 'right', color: 'rgba(230,238,239,0.6)' });
  if (o.temp) icon(ctx, 'timer', mx - 72, y + h - 20, 18, 'rgba(230,238,239,0.7)', 2.4);
  ctx.restore();
  return { x, y, w, h };
}
function scramble(s, seed) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/=';
  return Array.from(s, (ch, i) => (ch === ' ' ? ' ' : abc[Math.floor(rand(seed * 31 + i) * abc.length)])).join('');
}

function chip(ctx, x, y, label, iconName, a, o = {}) {
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(a);
  const s = eBack(a);
  ctx.font = '28px SSB';
  const w = ctx.measureText(label).width + 96, h = 68;
  const cx = o.align === 'right' ? x - w / 2 : x + w / 2;
  ctx.translate(cx, y); ctx.scale(s, s); ctx.translate(-cx, -y);
  const left = cx - w / 2;
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 30;
  fillRR(ctx, left, y - h / 2, w, h, h / 2, '#16302f');
  ctx.shadowBlur = 0;
  rr(ctx, left, y - h / 2, w, h, h / 2); ctx.strokeStyle = 'rgba(20,184,166,0.6)'; ctx.lineWidth = 2; ctx.stroke();
  icon(ctx, iconName, left + 40, y, 30, C.accent, 2.4);
  text(ctx, label, left + 68, y + 10, 28, { align: 'left', font: 'SSB' });
  ctx.restore();
}

// ---------- Fondo ----------
function background(ctx, t) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color); g.addColorStop(1, 'rgba(11,17,19,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  glow(W * 0.15 + Math.sin(t * 0.3) * 120, 360 + Math.cos(t * 0.23) * 90, 760, 'rgba(20,184,166,0.20)');
  glow(W * 0.9 + Math.cos(t * 0.27) * 110, 1500 + Math.sin(t * 0.2) * 120, 860, 'rgba(15,118,110,0.24)');
  // rejilla de puntos que sube despacio
  ctx.fillStyle = 'rgba(230,238,239,0.05)';
  const off = (t * 12) % 64;
  for (let y = -off; y < H; y += 64) for (let x = 32; x < W; x += 64) ctx.fillRect(x, y, 3, 3);
}

// ---------- Teléfono ----------
const P = { x: (W - 560) / 2, y: 430, w: 560, h: 1120, r: 74 };
const S = { x: P.x + 16, y: P.y + 16, w: P.w - 32, h: P.h - 32, r: 60 };
function phone(ctx, alpha, dy, drawScreen) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(0, dy);
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 80; ctx.shadowOffsetY = 30;
  fillRR(ctx, P.x, P.y, P.w, P.h, P.r, '#05080a');
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  rr(ctx, P.x + 1, P.y + 1, P.w - 2, P.h - 2, P.r); ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.save();
  rr(ctx, S.x, S.y, S.w, S.h, S.r); ctx.clip();
  ctx.fillStyle = C.screen; ctx.fillRect(S.x, S.y, S.w, S.h);
  drawScreen(ctx);
  // barra de estado y «isla»
  text(ctx, '9:41', S.x + 66, S.y + 46, 26, { font: 'SSB' });
  rr(ctx, S.x + S.w - 92, S.y + 28, 44, 22, 6); ctx.strokeStyle = C.text; ctx.lineWidth = 2; ctx.stroke();
  fillRR(ctx, S.x + S.w - 88, S.y + 32, 30, 14, 3, C.text);
  ctx.restore();
  fillRR(ctx, P.x + P.w / 2 - 80, S.y + 18, 160, 42, 21, '#000');
  ctx.restore();
}

function appBar(ctx, title, sub, o = {}) {
  ctx.fillStyle = C.panel; ctx.fillRect(S.x, S.y, S.w, 190);
  ctx.fillStyle = C.line; ctx.fillRect(S.x, S.y + 190, S.w, 2);
  icon(ctx, 'back', S.x + 44, S.y + 128, 34, C.text, 2.4);
  avatar(ctx, S.x + 108, S.y + 128, 34, title[0], 330);
  text(ctx, title, S.x + 156, S.y + 122, 30, { align: 'left', font: 'SB' });
  if (sub) {
    icon(ctx, 'shield', S.x + 168, S.y + 151, 20, C.accent, 2.4);
    text(ctx, sub, S.x + 186, S.y + 159, 21, { align: 'left', color: C.accent });
  }
  const tx = S.x + S.w - 56, ty = S.y + 128;
  if (o.timerOn) { ctx.beginPath(); ctx.arc(tx, ty, 32, 0, Math.PI * 2); ctx.fillStyle = C.soft; ctx.fill(); }
  icon(ctx, 'timer', tx, ty, 34, o.timerOn ? C.accent : C.text, 2.4);
}
function composer(ctx, typed, caret, sendTap) {
  const y = S.y + S.h - 120;
  ctx.fillStyle = C.panel; ctx.fillRect(S.x, y, S.w, 120);
  field(ctx, S.x + 24, y + 22, S.w - 130, 72, typed, { placeholder: 'Mensaje cifrado', caret, size: 26 });
  ctx.save();
  const s = 1 - (sendTap || 0) * 0.1;
  ctx.translate(S.x + S.w - 58, y + 58); ctx.scale(s, s);
  ctx.beginPath(); ctx.arc(0, 0, 38, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();
  icon(ctx, 'send', -2, 2, 34, '#032421', 2.4);
  ctx.restore();
}

// ---------- Escenas ----------
const typeText = (s, u, t0, t1) => s.slice(0, Math.round(s.length * clamp((u - t0) / (t1 - t0))));
const blink = (u) => Math.floor(u * 2.2) % 2 === 0;

function qr(ctx, x, y, size, seed, reveal = 1) {
  const n = 29, m = size / n;
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if ((r + c) / (2 * n) > reveal) continue;
    if (finder(r, c)) continue;
    if (rand(seed + r * 131 + c * 7) > 0.52) ctx.fillRect(x + c * m, y + r * m, m + 0.5, m + 0.5);
  }
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    if ((r0 + c0) / (2 * n) > reveal) continue;
    ctx.fillRect(x + c0 * m, y + r0 * m, 7 * m, 7 * m);
    ctx.fillStyle = '#fff'; ctx.fillRect(x + (c0 + 1) * m, y + (r0 + 1) * m, 5 * m, 5 * m);
    ctx.fillStyle = '#000'; ctx.fillRect(x + (c0 + 2) * m, y + (r0 + 2) * m, 3 * m, 3 * m);
  }
}

function sceneInstall(ctx, u) {
  const cx = S.x + S.w / 2;
  const home = eInOut(prog(u, 5.4, 0.6));
  if (home < 1) {
    ctx.save(); ctx.globalAlpha *= 1 - home;
    // Navegador
    fillRR(ctx, S.x + 24, S.y + 84, S.w - 48, 66, 33, '#1f2a2d');
    icon(ctx, 'lock', S.x + 66, S.y + 117, 22, C.muted, 2.4);
    text(ctx, 'susurro-chat.netlify.app', S.x + 88, S.y + 126, 24, { align: 'left', color: C.text });
    logo(ctx, cx, S.y + 330, 150);
    text(ctx, 'Susurro', cx, S.y + 480, 56, { font: 'SB' });
    text(ctx, 'Chat cifrado con PGP', cx, S.y + 530, 26, { color: C.muted });
    button(ctx, S.x + 60, S.y + 590, S.w - 120, 80, 'Crear mi identidad');
    const by = S.y + S.h - 112;
    ctx.fillStyle = '#141c1f'; ctx.fillRect(S.x, by, S.w, 112);
    icon(ctx, 'back', S.x + 70, by + 52, 34, C.accent, 2.4);
    icon(ctx, 'fwd', S.x + 160, by + 52, 34, C.muted, 2.4);
    icon(ctx, 'share', cx, by + 50, 36, C.accent, 2.4);
    icon(ctx, 'bookmark', S.x + S.w - 160, by + 52, 32, C.accent, 2.4);
    icon(ctx, 'tabs', S.x + S.w - 70, by + 52, 34, C.accent, 2.4);
    tap(ctx, cx, by + 50, u, 2.2);
    // Hoja de compartir
    const sh = eOut(prog(u, 2.5, 0.5));
    if (sh > 0) {
      ctx.fillStyle = `rgba(0,0,0,${0.45 * sh})`; ctx.fillRect(S.x, S.y, S.w, S.h);
      const hgt = 560, y = S.y + S.h - hgt * sh;
      fillRR(ctx, S.x, y, S.w, hgt + 40, 36, '#1c2629');
      fillRR(ctx, cx - 40, y + 14, 80, 8, 4, '#3a4a50');
      logo(ctx, S.x + 70, y + 84, 64);
      text(ctx, 'Susurro', S.x + 120, y + 78, 28, { align: 'left', font: 'SB' });
      text(ctx, 'susurro-chat.netlify.app', S.x + 120, y + 112, 22, { align: 'left', color: C.muted });
      const rows = [['copy', 'Copiar enlace'], ['plusSquare', 'Añadir a pantalla de inicio'], ['bookmark', 'Añadir a marcadores']];
      rows.forEach(([ic, label], i) => {
        const ry = y + 160 + i * 112;
        const hl = i === 1 ? prog(u, 4.1, 0.2) : 0;
        fillRR(ctx, S.x + 24, ry, S.w - 48, 96, 22, hl > 0 ? `rgba(20,184,166,${0.12 + 0.2 * hl})` : C.panel2);
        if (i === 1 && hl > 0) { rr(ctx, S.x + 24, ry, S.w - 48, 96, 22); ctx.strokeStyle = C.accent; ctx.lineWidth = 3 * hl; ctx.stroke(); }
        text(ctx, label, S.x + 52, ry + 58, 27, { align: 'left', font: i === 1 ? 'SB' : 'SR' });
        icon(ctx, ic, S.x + S.w - 72, ry + 48, 32, i === 1 ? C.accent : C.text, 2.4);
      });
      tap(ctx, cx, y + 160 + 112 + 48, u, 4.3);
    }
    ctx.restore();
  }
  if (home > 0) {
    // Pantalla de inicio con el icono nuevo
    ctx.save(); ctx.globalAlpha *= home;
    const g = ctx.createLinearGradient(S.x, S.y, S.x + S.w, S.y + S.h);
    g.addColorStop(0, '#173238'); g.addColorStop(1, '#0a1416');
    ctx.fillStyle = g; ctx.fillRect(S.x, S.y, S.w, S.h);
    const cols = 4, size = 92, gap = (S.w - cols * size) / (cols + 1);
    const hues = [210, 30, 280, 140, 0, 190, 50, 320, 100, 250, 15, 170];
    for (let i = 0; i < 12; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const x = S.x + gap + c * (size + gap), y = S.y + 140 + r * 170;
      if (i === 5) continue;
      fillRR(ctx, x, y, size, size, 24, `hsla(${hues[i]} 35% 45% / 0.55)`);
      fillRR(ctx, x + 18, y + size + 16, size - 36, 10, 5, 'rgba(230,238,239,0.25)');
    }
    const c = 1, r = 1, x = S.x + gap + c * (size + gap), y = S.y + 140 + r * 170;
    const pop = eBack(prog(u, 6.0, 0.5));
    const press = 1 - 0.08 * Math.sin(Math.PI * prog(u, 7.9, 0.3));
    if (pop > 0) {
      ctx.save();
      ctx.translate(x + size / 2, y + size / 2); ctx.scale(pop * press, pop * press);
      logo(ctx, 0, 0, size);
      ctx.restore();
      text(ctx, 'Susurro', x + size / 2, y + size + 30, 22, { font: 'SSB', alpha: clamp(pop) });
      // brillo al aparecer
      const glow = prog(u, 6.0, 1.2);
      if (glow > 0 && glow < 1) {
        ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, 60 + 90 * glow, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(20,184,166,${0.6 * (1 - glow)})`; ctx.lineWidth = 4; ctx.stroke();
      }
    }
    tap(ctx, x + size / 2, y + size / 2, u, 8.0);
    ctx.restore();
  }
}

function sceneIdentity(ctx, u) {
  const cx = S.x + S.w / 2, L = S.x + 40, FW = S.w - 80;
  logo(ctx, cx, S.y + 190, 110);
  text(ctx, 'Susurro', cx, S.y + 300, 46, { font: 'SB' });
  text(ctx, '¿Cómo quieres que te vean?', L, S.y + 380, 24, { align: 'left', font: 'SSB' });
  field(ctx, L, S.y + 396, FW, 76, typeText('Ana', u, 0.8, 1.5), { focus: u > 0.6 && u < 1.9, caret: u > 0.6 && u < 1.9 && blink(u), placeholder: 'Tu nombre o apodo' });
  text(ctx, 'Contraseña', L, S.y + 512, 24, { align: 'left', font: 'SSB' });
  field(ctx, L, S.y + 528, FW, 76, '', { dots: Math.round(12 * clamp((u - 2.0) / 1.4)), focus: u > 1.9 && u < 3.5, caret: u > 1.9 && u < 3.5 && blink(u), placeholder: u < 1.9 ? 'Mínimo 10 caracteres' : '' });
  field(ctx, L, S.y + 622, FW, 76, '', { dots: Math.round(12 * clamp((u - 3.6) / 1.0)), focus: u > 3.5 && u < 4.8, caret: u > 3.5 && u < 4.8 && blink(u), placeholder: u < 3.5 ? 'Repite la contraseña' : '' });
  const ck = prog(u, 5.0, 0.2);
  rr(ctx, L, S.y + 730, 40, 40, 10); ctx.fillStyle = ck > 0 ? C.accent : C.panel2; ctx.fill();
  if (ck > 0) icon(ctx, 'check', L + 20, S.y + 750, 30 * eBack(ck), '#032421', 3.4);
  text(ctx, 'Acepto los términos y la privacidad', L + 58, S.y + 760, 24, { align: 'left' });
  tap(ctx, L + 20, S.y + 750, u, 5.0);
  const busy = prog(u, 6.0, 0.15);
  if (busy <= 0) button(ctx, L, S.y + 812, FW, 86, 'Crear mi identidad', { pressed: Math.sin(Math.PI * prog(u, 5.75, 0.3)) });
  else {
    fillRR(ctx, L, S.y + 812, FW, 86, 43, C.accentDark);
    ctx.save();
    ctx.translate(L + 70, S.y + 855); ctx.rotate(u * 7);
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 1.4); ctx.strokeStyle = '#e6fffb'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();
    text(ctx, 'Generando claves…', cx + 24, S.y + 866, 30, { font: 'SB', color: '#e6fffb' });
  }
  tap(ctx, cx, S.y + 855, u, 5.85);
  const ok = prog(u, 7.4, 0.5);
  if (ok > 0) {
    ctx.save();
    ctx.globalAlpha *= eOut(ok);
    ctx.fillStyle = C.screen; ctx.fillRect(S.x, S.y, S.w, S.h);
    const s = eBack(prog(u, 7.5, 0.6));
    ctx.beginPath(); ctx.arc(cx, S.y + 440, 130 * s, 0, Math.PI * 2); ctx.fillStyle = C.soft; ctx.fill();
    icon(ctx, 'key', cx, S.y + 440, 130 * s, C.accent, 2);
    text(ctx, '¡Identidad creada!', cx, S.y + 650, 42, { font: 'SB', alpha: prog(u, 7.8, 0.4) });
    paragraph(ctx, 'Tus claves están cifradas en este móvil', cx, S.y + 710, 27, { color: C.muted, maxW: S.w - 100, alpha: prog(u, 8.0, 0.4) });
    ctx.restore();
  }
}

function sceneContacts(ctx, u) {
  const cx = S.x + S.w / 2;
  const scan = eInOut(prog(u, 4.0, 0.5));
  if (scan < 1) {
    ctx.save(); ctx.globalAlpha *= 1 - scan;
    text(ctx, 'Mi código', cx, S.y + 140, 40, { font: 'SB' });
    text(ctx, 'Que tu amigo lo escanee', cx, S.y + 186, 25, { color: C.muted });
    fillRR(ctx, cx - 210, S.y + 226, 420, 420, 28, '#fff');
    qr(ctx, cx - 180, S.y + 256, 360, 7, prog(u, 0.3, 1.0));
    text(ctx, 'Tu huella', cx, S.y + 712, 22, { color: C.muted });
    fillRR(ctx, S.x + 40, S.y + 730, S.w - 80, 100, 18, C.panel2);
    text(ctx, '8D29 7F3A 9F47 65C6 BD6A', cx, S.y + 772, 26, { font: 'MONO' });
    text(ctx, 'DA6F C92D EA17 BA7D 7EE1', cx, S.y + 810, 26, { font: 'MONO' });
    button(ctx, S.x + 40, S.y + 870, S.w - 80, 84, 'Compartir enlace', { icon: 'share', pressed: Math.sin(Math.PI * prog(u, 2.6, 0.3)) });
    tap(ctx, cx, S.y + 912, u, 2.7);
    ctx.restore();
  }
  if (scan > 0) {
    ctx.save(); ctx.globalAlpha *= scan;
    // «Cámara»: el QR del amigo en otro móvil, moviéndose un poco
    const g = ctx.createLinearGradient(S.x, S.y, S.x, S.y + S.h);
    g.addColorStop(0, '#20292b'); g.addColorStop(1, '#0c1213');
    ctx.fillStyle = g; ctx.fillRect(S.x, S.y, S.w, S.h);
    const wob = Math.sin(u * 2.4) * 10, rot = Math.sin(u * 1.7) * 0.05;
    ctx.save();
    ctx.translate(cx + wob, S.y + 470); ctx.rotate(rot);
    fillRR(ctx, -170, -250, 340, 520, 40, '#05080a');
    fillRR(ctx, -150, -150, 300, 300, 18, '#fff');
    qr(ctx, -130, -130, 260, 99, 1);
    ctx.restore();
    const done = prog(u, 6.6, 0.25);
    const fc = done > 0 ? C.ok : C.accent, fs = 330 + Math.sin(u * 6) * 6;
    ctx.strokeStyle = fc; ctx.lineWidth = 8; ctx.lineCap = 'round';
    const fx = cx - fs / 2, fy = S.y + 470 - fs / 2, k = 60;
    for (const [x0, y0, dx, dy] of [[fx, fy, 1, 1], [fx + fs, fy, -1, 1], [fx, fy + fs, 1, -1], [fx + fs, fy + fs, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x0, y0 + dy * k); ctx.lineTo(x0, y0); ctx.lineTo(x0 + dx * k, y0); ctx.stroke();
    }
    if (done <= 0) {
      const ly = fy + fs * ((u * 0.9) % 1);
      const lg = ctx.createLinearGradient(fx, ly - 30, fx, ly);
      lg.addColorStop(0, 'rgba(20,184,166,0)'); lg.addColorStop(1, 'rgba(20,184,166,0.8)');
      ctx.fillStyle = lg; ctx.fillRect(fx + 10, ly - 30, fs - 20, 30);
    } else if (done < 1) {
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - done)})`; ctx.fillRect(S.x, S.y, S.w, S.h);
    }
    text(ctx, done > 0 ? '¡Código leído!' : 'Apunta al código QR', cx, S.y + 790, 30, { font: 'SB', color: done > 0 ? C.ok : C.text });
    // Ficha del contacto nuevo
    const card = eOut(prog(u, 7.1, 0.5));
    if (card > 0) {
      const y = S.y + S.h - 420 * card;
      fillRR(ctx, S.x, y, S.w, 460, 36, '#1c2629');
      avatar(ctx, cx, y + 90, 50, 'B', 330);
      text(ctx, 'Beto', cx, y + 190, 40, { font: 'SB' });
      text(ctx, 'Huella 2958 7734 …', cx, y + 232, 24, { font: 'MONO', color: C.muted });
      const added = prog(u, 8.1, 0.2);
      if (added <= 0) button(ctx, S.x + 40, y + 268, S.w - 80, 84, 'Añadir', { pressed: Math.sin(Math.PI * prog(u, 7.85, 0.3)) });
      else button(ctx, S.x + 40, y + 268, S.w - 80, 84, 'Añadido', { icon: 'check', color: C.ok });
      tap(ctx, cx, y + 310, u, 7.95);
    }
    ctx.restore();
  }
}

function sceneChat(ctx, u, fx) {
  appBar(ctx, 'Beto', 'Verificado');
  fillRR(ctx, S.x + 70, S.y + 214, S.w - 140, 48, 14, C.panel);
  icon(ctx, 'lock', S.x + 110, S.y + 238, 20, C.muted, 2.4);
  text(ctx, 'Cifrado de extremo a extremo', S.x + 130, S.y + 246, 21, { align: 'left', color: C.muted });
  let y = S.y + 300;
  const sent1 = prog(u, 1.75, 0.3);
  if (sent1 > 0) {
    const cipher = u > 2.0 && u < 3.7 ? Math.floor(u * 14) + 1 : 0;
    const b = bubble(ctx, S, y, '¿Quedamos mañana?', true, { scale: eBack(sent1), sent: u > 3.7, cipher });
    if (cipher) { // candado latiendo sobre el mensaje cifrado
      const pulse = 1 + 0.12 * Math.sin(u * 10);
      ctx.beginPath(); ctx.arc(b.x - 34, b.y + b.h / 2, 26 * pulse, 0, Math.PI * 2); ctx.fillStyle = C.soft; ctx.fill();
      icon(ctx, 'lock', b.x - 34, b.y + b.h / 2, 28, C.accent, 2.6);
    }
    y += b.h + 18;
  }
  const typing = u > 4.2 && u < 5.3;
  if (typing) {
    fillRR(ctx, S.x + 24, y, 120, 64, 28, C.in);
    for (let i = 0; i < 3; i++) {
      const by = Math.sin(u * 9 - i * 0.8) * 6;
      ctx.beginPath(); ctx.arc(S.x + 56 + i * 28, y + 32 + by, 8, 0, Math.PI * 2); ctx.fillStyle = C.muted; ctx.fill();
    }
  }
  const in1 = prog(u, 5.3, 0.3);
  if (in1 > 0) { const b = bubble(ctx, S, y, '¡Sí! A las 6 en el parque', false, { scale: eBack(in1), time: '18:25' }); y += b.h + 18; }
  const sent2 = prog(u, 7.4, 0.3);
  if (sent2 > 0) bubble(ctx, S, y, 'Genial, hasta mañana', true, { scale: eBack(sent2), sent: u > 8.4, time: '18:25' });
  const t1 = typeText('¿Quedamos mañana?', u, 0.4, 1.4), t2 = typeText('Genial, hasta mañana', u, 6.3, 7.1);
  composer(ctx, u < 1.6 ? t1 : u > 6.2 && u < 7.3 ? t2 : '', (u < 1.6 || (u > 6.2 && u < 7.3)) && blink(u), Math.sin(Math.PI * prog(u, 1.55, 0.25)) + Math.sin(Math.PI * prog(u, 7.2, 0.25)));
  tap(ctx, S.x + S.w - 58, S.y + S.h - 62, u, 1.6);
  tap(ctx, S.x + S.w - 58, S.y + S.h - 62, u, 7.25);
  fx.push(() => {
    chip(ctx, 24, 1030, 'Cifrado PGP', 'lock', prog(u, 2.2, 0.5));
    chip(ctx, W - 24, 1160, '3 relays al azar', 'relay', prog(u, 2.8, 0.5), { align: 'right' });
    chip(ctx, 24, 1290, 'Nadie más lo lee', 'eye', prog(u, 3.4, 0.5));
  });
}

function sceneTimer(ctx, u, fx) {
  const on = u > 3.7;
  appBar(ctx, 'Beto', 'Verificado', { timerOn: on });
  let y = S.y + 240;
  let b = bubble(ctx, S, y, '¡Sí! A las 6 en el parque', false, { time: '18:25' }); y += b.h + 18;
  b = bubble(ctx, S, y, 'Genial, hasta mañana', true, { sent: true, time: '18:25' }); y += b.h + 26;
  const sys = prog(u, 3.8, 0.4);
  if (sys > 0) {
    ctx.save(); ctx.globalAlpha *= sys;
    fillRR(ctx, S.x + 40, y, S.w - 80, 56, 16, C.panel);
    icon(ctx, 'timer', S.x + 78, y + 28, 22, C.muted, 2.4);
    text(ctx, 'Temporales activados: 1 hora', S.x + 100, y + 37, 22, { align: 'left', color: C.muted });
    ctx.restore();
    y += 80;
  }
  // El mensaje temporal y cómo se deshace en partículas
  const tmp = prog(u, 4.7, 0.3), dissolve = prog(u, 7.4, 1.4);
  if (tmp > 0 && dissolve < 1) {
    if (dissolve <= 0) bubble(ctx, S, y, 'Este mensaje desaparecerá en 1 hora', true, { scale: eBack(tmp), sent: u > 5.3, temp: true, time: '18:30' });
    else {
      ctx.save();
      ctx.beginPath(); ctx.rect(S.x, S.y, S.w, S.h); ctx.clip();
      const bw = S.w * 0.7, bx = S.x + S.w - 24 - bw, bh = 120;
      for (let i = 0; i < 18; i++) for (let j = 0; j < 6; j++) {
        const k = i * 6 + j, delay = (i / 18) * 0.5, p = clamp((dissolve - delay) / 0.5);
        if (p >= 1) continue;
        const px = bx + i * (bw / 18) + p * 140 * (rand(k) - 0.3), py = y + j * (bh / 6) - p * 220 * rand(k + 7);
        ctx.fillStyle = `rgba(15,109,101,${1 - p})`;
        ctx.fillRect(px, py, bw / 18 - 2, bh / 6 - 2);
      }
      ctx.restore();
    }
  }
  const typingTmp = u > 3.8 && u < 4.6;
  composer(ctx, typingTmp ? typeText('Este mensaje desaparecerá en 1 hora', u, 3.9, 4.5) : '', typingTmp && blink(u), Math.sin(Math.PI * prog(u, 4.55, 0.25)));
  tap(ctx, S.x + S.w - 56, S.y + 128, u, 0.8);
  // Hoja con las opciones
  const open = eOut(prog(u, 1.1, 0.4)) * (1 - eInOut(prog(u, 3.2, 0.4)));
  if (open > 0) {
    ctx.fillStyle = `rgba(0,0,0,${0.45 * open})`; ctx.fillRect(S.x, S.y, S.w, S.h);
    const hgt = 700, sy = S.y + S.h - hgt * open;
    fillRR(ctx, S.x, sy, S.w, hgt + 40, 36, '#1c2629');
    text(ctx, 'Mensajes temporales', S.x + 40, sy + 78, 32, { align: 'left', font: 'SB' });
    ['Desactivados', '5 minutos', '1 hora', '1 día', '1 semana'].forEach((label, i) => {
      const ry = sy + 120 + i * 108;
      const sel = i === 2 && u > 2.65;
      fillRR(ctx, S.x + 32, ry, S.w - 64, 92, 22, sel ? 'rgba(20,184,166,0.18)' : C.panel2);
      if (sel) { rr(ctx, S.x + 32, ry, S.w - 64, 92, 22); ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.stroke(); icon(ctx, 'check', S.x + S.w - 80, ry + 46, 30, C.accent, 3); }
      text(ctx, label, S.x + 62, ry + 56, 28, { align: 'left', font: sel ? 'SB' : 'SR', color: sel ? C.accent : C.text });
    });
    tap(ctx, S.x + S.w / 2, sy + 120 + 2 * 108 + 46, u, 2.6);
  }
  fx.push(() => {
    // reloj que avanza una hora
    const clock = prog(u, 5.8, 0.4) * (1 - prog(u, 9.0, 0.4));
    if (clock > 0) {
      ctx.save();
      ctx.globalAlpha *= clamp(clock);
      const cx = W - 140, cy = 740, r = 92 * eBack(clock);
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 30;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#16302f'; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = C.accent; ctx.lineWidth = 5; ctx.stroke();
      const spin = clamp((u - 5.9) / 1.4) * Math.PI * 2;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(spin * 12) * r * 0.75, cy - Math.cos(spin * 12) * r * 0.75); ctx.strokeStyle = C.text; ctx.lineWidth = 5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(spin) * r * 0.5, cy - Math.cos(spin) * r * 0.5); ctx.strokeStyle = C.accent; ctx.lineWidth = 8; ctx.stroke();
      text(ctx, '+1 h', cx, cy + r + 52, 40, { font: 'SB', color: C.accent });
      ctx.restore();
    }
    chip(ctx, 24, 1240, 'Borrado de los dos móviles', 'check', prog(u, 8.7, 0.5));
  });
}

function sceneProtect(ctx, u, fx) {
  const cx = S.x + S.w / 2, L = S.x + 40, FW = S.w - 80;
  const settings = eInOut(prog(u, 4.4, 0.5));
  if (settings < 1) {
    ctx.save(); ctx.globalAlpha *= 1 - settings;
    logo(ctx, cx, S.y + 230, 120);
    text(ctx, 'Susurro está', cx, S.y + 380, 40, { font: 'SB' });
    text(ctx, 'bloqueado', cx, S.y + 428, 40, { font: 'SB' });
    field(ctx, L, S.y + 480, FW, 80, '', { dots: Math.round(14 * clamp((u - 0.8) / 1.3)), focus: u > 0.6 && u < 2.4, caret: u > 0.6 && u < 2.4 && blink(u) });
    button(ctx, L, S.y + 590, FW, 86, 'Desbloquear', { pressed: Math.sin(Math.PI * prog(u, 2.5, 0.3)) });
    tap(ctx, cx, S.y + 633, u, 2.6);
    // candado que se abre
    const open = eOut(prog(u, 2.9, 0.4));
    const ly = S.y + 800;
    ctx.beginPath(); ctx.arc(cx, ly, 70, 0, Math.PI * 2); ctx.fillStyle = C.soft; ctx.fill();
    ctx.save();
    ctx.strokeStyle = C.accent; ctx.lineWidth = 9; ctx.lineCap = 'round';
    fillRR(ctx, cx - 38, ly - 6, 76, 56, 10, open > 0.5 ? C.ok : C.accent);
    ctx.beginPath(); ctx.moveTo(cx - 22, ly - 6); ctx.lineTo(cx - 22, ly - 26 - open * 20);
    ctx.arc(cx, ly - 26 - open * 20, 22, Math.PI, 0); ctx.lineTo(cx + 22, ly - 26 - open * 20 + (1 - open) * 20);
    ctx.strokeStyle = open > 0.5 ? C.ok : C.accent; ctx.stroke();
    ctx.restore();
    ctx.restore();
  }
  if (settings > 0) {
    ctx.save(); ctx.globalAlpha *= settings;
    ctx.fillStyle = C.panel; ctx.fillRect(S.x, S.y, S.w, 190);
    icon(ctx, 'back', S.x + 44, S.y + 128, 34, C.text, 2.4);
    text(ctx, 'Ajustes', S.x + 84, S.y + 140, 38, { align: 'left', font: 'SB' });
    text(ctx, 'COPIA DE SEGURIDAD', L, S.y + 260, 22, { align: 'left', font: 'SSB', color: C.muted });
    paragraph(ctx, 'Tu clave y tus chats, cifrados con una contraseña.', L, S.y + 304, 26, { align: 'left', maxW: FW });
    const gen = 'fd92c-2rjuu-jz8k4-ysqfq';
    const shown = typeText(gen, u, 5.7, 6.3);
    field(ctx, L, S.y + 380, FW, 76, shown, { font: 'MONO', size: 26, placeholder: 'Contraseña de la copia', focus: u > 5.6 && u < 6.6 });
    button(ctx, L, S.y + 476, FW, 74, 'Generar contraseña segura', { ghost: true, pressed: Math.sin(Math.PI * prog(u, 5.4, 0.3)) });
    tap(ctx, cx, S.y + 513, u, 5.5);
    button(ctx, L, S.y + 572, FW, 84, 'Guardar copia cifrada', { icon: 'download', pressed: Math.sin(Math.PI * prog(u, 6.7, 0.3)) });
    tap(ctx, cx, S.y + 614, u, 6.8);
    const drop = prog(u, 7.1, 0.6);
    if (drop > 0) {
      const fy = S.y + 760 + (1 - eOut(drop)) * -80;
      ctx.save(); ctx.globalAlpha *= clamp(drop * 2);
      icon(ctx, 'file', cx, fy + 40, 150, C.text, 1.6);
      ctx.beginPath(); ctx.arc(cx + 50, fy + 90, 34, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();
      icon(ctx, 'lock', cx + 50, fy + 90, 34, '#032421', 2.6);
      text(ctx, 'susurro-copia.asc', cx, fy + 170, 24, { font: 'MONO', color: C.muted });
      const okc = eBack(prog(u, 8.0, 0.4));
      if (okc > 0) {
        ctx.beginPath(); ctx.arc(cx - 60, fy - 10, 30 * okc, 0, Math.PI * 2); ctx.fillStyle = C.ok; ctx.fill();
        icon(ctx, 'check', cx - 60, fy - 10, 34 * okc, '#032421', 3.4);
      }
      ctx.restore();
    }
    ctx.restore();
  }
  fx.push(() => {
    chip(ctx, W - 24, 720, 'Se bloquea sola', 'lock', prog(u, 1.0, 0.5) * (1 - prog(u, 4.3, 0.4)), { align: 'right' });
    chip(ctx, 24, 1000, 'Datos cifrados', 'shield', prog(u, 1.6, 0.5) * (1 - prog(u, 4.3, 0.4)));
    chip(ctx, W - 24, 1450, 'Guárdala bien', 'key', prog(u, 8.4, 0.5), { align: 'right' });
  });
}

const SCREENS = { install: sceneInstall, identity: sceneIdentity, contacts: sceneContacts, chat: sceneChat, timer: sceneTimer, protect: sceneProtect };

function sceneIntro(ctx, u, d) {
  const out = 1 - prog(u, d - 0.5, 0.5);
  ctx.save(); ctx.globalAlpha *= out;
  const s = eBack(prog(u, 0.2, 0.8));
  for (let i = 0; i < 3; i++) { // ondas
    const p = ((u - 0.4 - i * 0.6) % 1.8) / 1.8;
    if (u < 0.4 + i * 0.6 || p < 0) continue;
    ctx.beginPath(); ctx.arc(W / 2, 760, 170 + p * 330, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(20,184,166,${0.35 * (1 - p)})`; ctx.lineWidth = 3; ctx.stroke();
  }
  ctx.save(); ctx.translate(W / 2, 760 + Math.sin(u * 1.6) * 8); ctx.scale(s, s); logo(ctx, 0, 0, 300); ctx.restore();
  const a1 = eOut(prog(u, 0.9, 0.6));
  text(ctx, 'Susurro', W / 2, 1060 + (1 - a1) * 40, 128, { font: 'SB', alpha: a1 });
  const a2 = eOut(prog(u, 1.4, 0.6)), a3 = eOut(prog(u, 1.8, 0.6));
  text(ctx, 'Chat cifrado de extremo a extremo', W / 2, 1150 + (1 - a2) * 30, 42, { alpha: a2, font: 'SSB' });
  text(ctx, 'Sin cuentas · Sin teléfono · Sin servidor central', W / 2, 1215 + (1 - a3) * 30, 34, { alpha: a3, color: C.muted });
  const a4 = eOut(prog(u, 2.6, 0.6));
  if (a4 > 0) {
    ctx.save(); ctx.globalAlpha *= a4;
    fillRR(ctx, W / 2 - 200, 1380, 400, 76, 38, C.soft);
    text(ctx, 'Tutorial en 6 pasos', W / 2, 1430, 32, { font: 'SB', color: C.accent });
    ctx.restore();
  }
  ctx.restore();
}

function sceneTips(ctx, u, d) {
  const out = 1 - prog(u, d - 0.45, 0.45);
  ctx.save(); ctx.globalAlpha *= out;
  const a = eOut(prog(u, 0.1, 0.5));
  text(ctx, 'Tres consejos', W / 2, 300 + (1 - a) * 30, 84, { font: 'SB', alpha: a });
  const tips = [
    ['shield', 'Compara la huella', 'Toca el nombre de tu contacto y comprobad que coincide.'],
    ['globe', 'Usa VPN o Tor', 'Así nadie sabe desde dónde te conectas.'],
    ['key', 'Recuerda tu contraseña', 'Nadie puede recuperarla: guarda una copia.'],
  ];
  tips.forEach(([ic, title, body], i) => {
    const p = eOut(prog(u, 0.4 + i * 0.45, 0.6));
    if (p <= 0) return;
    const y = 470 + i * 360 + (1 - p) * 60;
    ctx.save(); ctx.globalAlpha *= p;
    fillRR(ctx, 70, y, W - 140, 300, 40, C.panel);
    rr(ctx, 70, y, W - 140, 300, 40); ctx.strokeStyle = 'rgba(20,184,166,0.25)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(200, y + 150, 76, 0, Math.PI * 2); ctx.fillStyle = C.soft; ctx.fill();
    icon(ctx, ic, 200, y + 150, 80, C.accent, 2);
    text(ctx, title, 320, y + 120, 46, { align: 'left', font: 'SB' });
    paragraph(ctx, body, 320, y + 178, 32, { align: 'left', color: C.muted, maxW: 600, lh: 42 });
    ctx.restore();
  });
  ctx.restore();
}

function sceneOutro(ctx, u, d) {
  const s = eBack(prog(u, 0.1, 0.8));
  ctx.save(); ctx.translate(W / 2, 720); ctx.scale(s, s); logo(ctx, 0, 0, 280); ctx.restore();
  const a1 = eOut(prog(u, 0.6, 0.6)), a2 = eOut(prog(u, 1.0, 0.6)), a3 = eOut(prog(u, 1.4, 0.6));
  text(ctx, 'Susurro', W / 2, 1010 + (1 - a1) * 40, 116, { font: 'SB', alpha: a1 });
  if (a2 > 0) {
    ctx.save(); ctx.globalAlpha *= a2;
    rr(ctx, W / 2 - 330, 1090, 660, 96, 48); ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = C.soft; ctx.fill();
    text(ctx, 'susurro-chat.netlify.app', W / 2, 1152, 40, { font: 'SB', color: C.accent });
    ctx.restore();
  }
  text(ctx, 'Gratis · Sin cuentas · Cifrado de extremo a extremo', W / 2, 1270 + (1 - a3) * 20, 31, { color: C.muted, alpha: a3 });
  const black = prog(u, d - 1.1, 1.0);
  if (black > 0) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
}

// ---------- Fotograma completo ----------
function frame(ctx, t) {
  background(ctx, t);
  const scene = SCENES.find((s) => t >= s.start && t < s.start + s.dur) || SCENES[SCENES.length - 1];
  const u = t - scene.start, d = scene.dur;
  if (scene.id === 'intro') sceneIntro(ctx, u, d);
  else if (scene.id === 'tips') sceneTips(ctx, u, d);
  else if (scene.id === 'outro') sceneOutro(ctx, u, d);
  else {
    const first = scene.step === 1, last = scene.step === 6;
    const enter = first ? eOut(prog(u, 0, 0.8)) : 1;
    const exit = last ? 1 - eInOut(prog(u, d - 0.6, 0.6)) : 1;
    const head = eOut(prog(u, 0.15, 0.5)) * (1 - prog(u, d - 0.4, 0.4));
    // Cabecera: paso y título
    ctx.save(); ctx.globalAlpha *= head;
    const label = `PASO ${scene.step} DE 6`;
    ctx.font = '28px SB';
    const lw = ctx.measureText(label).width + 56;
    fillRR(ctx, W / 2 - lw / 2, 120 + (1 - head) * 20, lw, 60, 30, C.soft);
    text(ctx, label, W / 2, 161 + (1 - head) * 20, 28, { font: 'SB', color: C.accent });
    text(ctx, scene.title, W / 2, 300 + (1 - head) * 30, 84, { font: 'SB' });
    ctx.restore();
    // Teléfono con la pantalla de la escena
    const fx = [];
    const content = Math.min(prog(u, 0.05, 0.35), 1 - prog(u, d - 0.35, 0.35));
    phone(ctx, enter * exit, (1 - enter) * 260 - (1 - exit) * 120, (c) => {
      c.save(); c.globalAlpha *= first || last ? 1 : content;
      SCREENS[scene.id](c, u, fx);
      c.restore();
    });
    for (const f of fx) { ctx.save(); ctx.globalAlpha *= head; f(); ctx.restore(); }
    // Texto explicativo
    const cap = eOut(prog(u, 0.5, 0.6)) * (1 - prog(u, d - 0.4, 0.4));
    paragraph(ctx, scene.caption, W / 2, 1640 + (1 - cap) * 24, 40, { alpha: cap, maxW: 940, lh: 54, font: 'SSB' });
  }
  // Barra de progreso
  fillRR(ctx, 90, H - 52, W - 180, 8, 4, 'rgba(230,238,239,0.10)');
  fillRR(ctx, 90, H - 52, (W - 180) * clamp(t / TOTAL), 8, 4, C.accent);
}

// ---------- Salida ----------
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
const stillsArg = process.argv.indexOf('--stills');
if (stillsArg > 0) {
  const dir = join(HERE, 'stills');
  mkdirSync(dir, { recursive: true });
  for (const s of process.argv[stillsArg + 1].split(',').map(Number)) {
    frame(ctx, s);
    writeFileSync(join(dir, `t${String(s).replace('.', '_')}.png`), canvas.toBuffer('image/png'));
  }
  console.log('Fotogramas en', dir);
} else {
  const wav = join(tmpdir(), `susurro-musica-${process.pid}.wav`);
  const out = join(HERE, 'susurro-tutorial.mp4');
  console.log(`Duración: ${TOTAL.toFixed(1)} s · componiendo la música…`);
  renderMusic(TOTAL, wav);
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-i', wav,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
    '-metadata', 'title=Susurro · Tutorial', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round(TOTAL * FPS);
  for (let i = 0; i < frames; i++) {
    frame(ctx, i / FPS);
    if (!ff.stdin.write(canvas.data())) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`  fotograma ${i}/${frames}`);
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on('close', r));
  rmSync(wav, { force: true });
  if (code !== 0) { console.error('ffmpeg falló con código', code); process.exit(1); }
  console.log('Listo:', out);
}
