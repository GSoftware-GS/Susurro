'use strict';
// Susurro: chat cifrado con OpenPGP que viaja por relays Nostr. Todo ocurre en el navegador.
(() => {
  const STORE_KEY = 'susurro.v1';
  const KIND = 4242;                    // tipo de evento Nostr propio de Susurro
  const TAG_PREFIX = 'susurro:';        // etiqueta #p = sha256(TAG_PREFIX + huella del destinatario)
  const SUB_ID = 'susurro';
  const BACKFILL_ID = 'susurro-old';    // suscripción auxiliar para pedir históricos que no cupieron
  const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://offchain.pub', 'wss://nostr.mom', 'wss://relay.nostr.net'];
  const MAX_TEXT = 8000;
  const PENDING_TEXT = 1000;            // texto guardado de mensajes de desconocidos
  const MAX_EVENT_CHARS = 100000;
  const MAX_KEY_CHARS = 20000;
  const MAX_FRAME = 200000;             // tamaño máximo de un mensaje de relay
  const MAX_DECOMPRESSED = 256 * 1024;  // evita «bombas» de descompresión
  const MAX_FUTURE_MS = 10 * 60 * 1000; // margen para relojes adelantados
  const MAX_PENDING = 20;               // solicitudes de desconocidos guardadas como máximo
  const MAX_PENDING_MSGS = 3;           // mensajes guardados por solicitud sin aceptar
  const SUB_LIMIT = 500;                // eventos por petición a un relay
  const MAX_PAGES = 20;                 // páginas de histórico que se piden como mucho
  const SINCE_MARGIN = 2 * 86400;       // al reconectar se vuelven a pedir los últimos 2 días
  const RESIGN_AFTER = 3600;            // un pendiente más antiguo se vuelve a firmar al publicarlo
  const RELAY_TTL = 7 * 86400;          // los relays borran los mensajes cifrados a los 7 días (NIP-40)
  const MAX_TTL = 30 * 86400;
  const TIMERS = [[0, 'Desactivados'], [300, '5 minutos'], [3600, '1 hora'], [86400, '1 día'], [604800, '1 semana']];
  const SEEN_MAX = 5000;
  const PAD_BLOCK = 512;                // el contenido se rellena a múltiplos de 512 bytes
  const MIN_ACCESS_PASS = 8;
  const MIN_BACKUP_PASS = 10;
  const AUTOLOCK_MS = 5 * 60 * 1000;    // se bloquea tras 5 minutos en segundo plano
  const ARGON2_LIMITS = { maxArgon2MemoryExponent: 17 }; // como mucho 128 MiB al abrir datos ajenos
  const VAULT_AAD = new TextEncoder().encode('susurro:vault:v2');

  const isTouch = matchMedia('(pointer: coarse)').matches;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const $ = (sel) => document.querySelector(sel);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Trusted Types: solo estos scripts pueden cargarse desde el código.
  const SCRIPTS = new Set(['sw.js', 'vendor/qrcode.js', 'vendor/jsQR.js']);
  const ttPolicy = window.trustedTypes?.createPolicy?.('susurro', {
    createScriptURL: (u) => { if (SCRIPTS.has(u)) return u; throw new TypeError('Script no permitido: ' + u); },
  });
  const scriptURL = (u) => (ttPolicy ? ttPolicy.createScriptURL(u) : u);

  let state = null;
  let vault = null;             // { dek, wrap }: clave que cifra los datos guardados, protegida con la contraseña
  let stored = null;            // datos cifrados leídos al arrancar, a la espera de la contraseña
  let halted = false;           // deja de guardar: datos borrados o app abierta en otra ventana
  let unlocked = false;
  let saveWarned = false;
  let myPriv = null, myPubB64 = '';
  let pool = null;
  let timers = [];
  let current = null;           // huella del chat abierto
  let pendingInvite = null;     // código recibido por enlace antes de entrar
  let pendingContact = null;    // contacto leído en el diálogo «Añadir»
  let deferredInstall = null;
  let waitingWorker = null;
  let previewSeq = 0;
  let hiddenAt = 0;
  let eventQueue = Promise.resolve();
  let saveChain = Promise.resolve();
  let seen = new Set();
  const keyCache = new Map();
  const evSeen = new Set();
  const inflight = new Set();

  // ---------- Utilidades ----------
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  function icon(name, cls = 'ic') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls);
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  const b64u = {
    enc(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(str) {
      const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    },
  };

  async function sha256hex(str) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const tagFor = (fpr) => sha256hex(TAG_PREFIX + fpr.toLowerCase());

  const fmtFpr = (fpr) => {
    const g = fpr.toUpperCase().match(/.{1,4}/g) || [];
    return g.slice(0, 5).join(' ') + '\n' + g.slice(5).join(' ');
  };
  const shortFpr = (fpr) => fpr.toUpperCase().slice(0, 8).replace(/(.{4})/, '$1 ');
  const hue = (fpr) => parseInt(fpr.slice(0, 4), 16) % 360;
  const initials = (name) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((p) => Array.from(p)[0]).join('').toUpperCase() || '?';
  };

  // Quita caracteres de control, invisibles, de relleno y de dirección de texto (evita nombres engañosos).
  const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\u{e0000}-\\u{e0fff}]|\\p{Cf}', 'gu');
  const BIDI = new RegExp('[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');
  function cleanName(s) {
    s = String(s || '')
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .replace(/\p{M}{3,}/gu, (m) => Array.from(m).slice(0, 2).join(''))
      .replace(/\s+/g, ' ')
      .trim();
    return Array.from(s).slice(0, 40).join('') || 'Sin nombre';
  }

  // «Esqueleto» de un nombre para detectar imitaciones: sin tildes, espacios ni signos,
  // en minúsculas y con las letras cirílicas y griegas que imitan a las latinas convertidas.
  const HOMOGLYPHS = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
    'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'ı': 'i',
    'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'u', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  };
  const skeleton = (name) => Array.from(name.normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Z}\p{P}\p{Cf}\s]/gu, ''))
    .map((ch) => HOMOGLYPHS[ch] || ch).join('');

  const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long' });
  const dayYearFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });
  const weekdayFmt = new Intl.DateTimeFormat('es', { weekday: 'short' });
  const shortFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function dayLabel(ts) {
    const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    return new Date(ts).getFullYear() === new Date().getFullYear() ? dayFmt.format(ts) : dayYearFmt.format(ts);
  }
  function listTime(ts) {
    const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (diff === 0) return timeFmt.format(ts);
    if (diff === 1) return 'Ayer';
    if (diff < 7) return weekdayFmt.format(ts);
    return shortFmt.format(ts);
  }
  const timerLabel = (ttl) => (TIMERS.find(([s]) => s === ttl) || [0, `${Math.round(ttl / 60)} minutos`])[1];

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    // Dentro del diálogo abierto para que quede por encima de su fondo.
    (document.querySelector('dialog[open]') || document.body).append(t);
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function copyText(text, msg = 'Copiado') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg);
  }

  const loaded = new Map();
  function loadScript(src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((res, rej) => {
        const s = document.createElement('script');
        s.onload = res;
        s.onerror = () => { loaded.delete(src); rej(new Error('No se pudo cargar ' + src)); };
        s.src = scriptURL(src);
        document.head.append(s);
      }));
    }
    return loaded.get(src);
  }

  // Convierte en enlaces solo las URL http(s). Los mensajes de desconocidos se muestran sin enlaces.
  function linkify(text, allowLinks) {
    text = text.replace(BIDI, '');
    if (!allowLinks) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    const re = /\bhttps?:\/\/[^\s<>"]+/gi;
    let last = 0, m;
    while ((m = re.exec(text))) {
      let end = m[0].length;
      while (end > 0 && '.,;:!?)]'.includes(m[0][end - 1])) end--;
      const url = m[0].slice(0, end);
      frag.append(text.slice(last, m.index), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    frag.append(text.slice(last));
    return frag;
  }

  function randomPassword() {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(bytes, (b) => abc[b % 32]).join('').match(/.{5}/g).join('-');
  }

  // ---------- Almacenamiento local cifrado ----------
  // En localStorage solo hay { v: 2, wrap, iv, data }: los datos van cifrados con AES-GCM usando
  // una clave aleatoria (DEK) que a su vez está cifrada con la contraseña de acceso (Argon2 + AEAD).
  const freshState = () => ({
    me: null, contacts: {}, msgs: {}, seen: [], seenFloor: {},
    relays: DEFAULT_RELAYS.slice(), since: 0, relaySince: {}, ui: {},
  });

  function normalizeState(s) {
    s = { ...freshState(), ...s };
    if (!s.seenFloor || typeof s.seenFloor !== 'object' || Array.isArray(s.seenFloor)) s.seenFloor = {};
    if (!Array.isArray(s.seen)) s.seen = [];
    if (!s.relaySince || typeof s.relaySince !== 'object') s.relaySince = {};
    return s;
  }

  // Devuelve 'empty', 'locked' (datos cifrados) o 'legacy' (datos antiguos sin contraseña).
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch {}
    state = freshState();
    if (!raw) return 'empty';
    let obj;
    try { obj = JSON.parse(raw); } catch {
      // No se pisa lo que había: se aparta por si se puede recuperar a mano.
      try { localStorage.setItem(STORE_KEY + '.corrupt', raw); } catch {}
      setTimeout(() => toast('Los datos guardados estaban dañados. Restaura tu copia de seguridad.'), 800);
      return 'empty';
    }
    if (obj?.v === 2 && typeof obj.wrap === 'string') { stored = obj; return 'locked'; }
    state = normalizeState(obj);
    return state.me ? 'legacy' : 'empty';
  }

  async function createVault(pass) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const wrap = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: raw }),
      passwords: [pass],
      config: { s2kType: openpgp.enums.s2k.argon2, aeadProtect: true },
    });
    const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    raw.fill(0);
    vault = { dek, wrap };
  }

  async function openVault(pass) {
    let raw;
    try {
      const res = await openpgp.decrypt({
        message: await openpgp.readMessage({ armoredMessage: stored.wrap }),
        passwords: [pass], format: 'binary', config: ARGON2_LIMITS,
      });
      raw = res.data;
    } catch { throw new Error('Contraseña incorrecta.'); }
    const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    raw.fill(0);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(stored.iv), additionalData: VAULT_AAD }, dek, b64u.dec(stored.data));
    } catch { throw new Error('Los datos guardados están dañados.'); }
    vault = { dek, wrap: stored.wrap };
    stored = null;
    state = normalizeState(JSON.parse(new TextDecoder().decode(plain)));
  }

  async function persist() {
    if (halted || !state || !vault) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(state));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: VAULT_AAD }, vault.dek, plain));
    if (halted) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, wrap: vault.wrap, iv: b64u.enc(iv), data: b64u.enc(data) }));
      saveWarned = false;
    } catch {
      if (!saveWarned) toast('No se pudo guardar: el almacenamiento está lleno o bloqueado');
      saveWarned = true;
    }
  }

  // Los guardados se encadenan para que nunca se escriba un estado más viejo encima de uno nuevo.
  let saveTimer;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => { saveChain = saveChain.then(persist).catch(() => {}); return saveChain; };
    if (now) return run();
    saveTimer = setTimeout(run, 250);
    return saveChain;
  }
  const flushSave = () => save(true);

  async function lockNow() {
    if (!unlocked) return;
    await flushSave();
    halted = true;
    location.reload(); // la recarga borra de la memoria la clave y las conversaciones
  }

  function markSeen(key, ts) {
    seen.add(key);
    state.seen.push([key, ts]);
    if (state.seen.length > SEEN_MAX) {
      // Lo que sale de la lista ya no se puede deduplicar: se rechaza lo anterior de ese remitente.
      for (const [oldKey, oldTs] of state.seen.splice(0, state.seen.length - SEEN_MAX)) {
        seen.delete(oldKey);
        const fpr = String(oldKey).split(':')[0];
        if (String(oldKey).includes(':')) state.seenFloor[fpr] = Math.max(state.seenFloor[fpr] || 0, oldTs);
      }
    }
  }

  // ---------- Claves y cifrado ----------
  async function keyName(key) {
    try {
      const { user } = await key.getPrimaryUser();
      return cleanName(user.userID?.name || user.userID?.userID);
    } catch {
      const uid = key.users[0]?.userID;
      return cleanName(uid?.name || uid?.userID);
    }
  }

  async function contactKey(c) {
    let k = keyCache.get(c.fpr);
    if (!k) {
      k = await openpgp.readKey({ binaryKey: b64u.dec(c.pub) });
      if (k.getFingerprint() !== c.fpr) throw new Error('La clave guardada no coincide con la huella del contacto');
      keyCache.set(c.fpr, k);
    }
    return k;
  }

  async function setIdentity(privKey, since) {
    await privKey.getEncryptionKey();
    await privKey.getSigningKey();
    state.me = { name: await keyName(privKey), priv: privKey.armor(), fpr: privKey.getFingerprint(), created: nowSec() };
    state.since = since ?? nowSec();
    await unlock();
  }

  async function unlock() {
    myPriv = await openpgp.readPrivateKey({ armoredKey: state.me.priv });
    if (!myPriv.isDecrypted()) throw new Error('La clave está protegida con contraseña');
    await myPriv.getEncryptionKey();
    await myPriv.getSigningKey();
    myPubB64 = b64u.enc(myPriv.toPublic().write());
    state.me.fpr = myPriv.getFingerprint();
  }

  // Contenido cifrado: JSON firmado con mi clave y cifrado para el destinatario.
  // Incluye mi clave pública para que pueda responderme aunque aún no me tenga
  // y su propia huella en `to` para que nadie pueda reenviarle a otro un mensaje firmado por mí.
  async function encryptFor(c, payload) {
    // Relleno en bytes hasta múltiplos de PAD_BLOCK para no delatar la longitud del texto.
    const enc = new TextEncoder();
    const base = enc.encode(JSON.stringify({ ...payload, pad: '' })).length;
    const text = JSON.stringify({ ...payload, pad: ' '.repeat((PAD_BLOCK - (base % PAD_BLOCK)) % PAD_BLOCK) });
    return openpgp.encrypt({
      message: await openpgp.createMessage({ text }),
      encryptionKeys: await contactKey(c),
      signingKeys: myPriv,
      wildcard: true, // no revela el ID de la clave del destinatario
    });
  }

  async function openEvent(ev) {
    if (typeof ev.content !== 'string' || ev.content.length > MAX_EVENT_CHARS) return null;
    const config = { maxDecompressedMessageSize: MAX_DECOMPRESSED };
    const read = () => openpgp.readMessage({ armoredMessage: ev.content });
    const msg = await read();
    // Exactamente un destinatario: con varios, cada uno obligaría a una operación de descifrado.
    const P = openpgp.enums.packet;
    if (msg.packets.filterByTag(P.publicKeyEncryptedSessionKey).length !== 1 || msg.packets.filterByTag(P.symEncryptedSessionKey).length) return null;
    const first = await openpgp.decrypt({ message: msg, decryptionKeys: myPriv, config });
    for (const s of first.signatures || []) s.verified?.catch?.(() => {});
    const p = JSON.parse(first.data);
    if (!p || typeof p !== 'object' || p.v !== 1 || p.to !== state.me.fpr) return null;
    if (typeof p.id !== 'string' || p.id.length > 64 || typeof p.text !== 'string') return null;
    if (!Number.isFinite(p.ts) || p.ts < 0 || p.ts > Date.now() + MAX_FUTURE_MS) return null;
    if (typeof p.key !== 'string' || p.key.length > MAX_KEY_CHARS) return null;
    if (p.t !== undefined && p.t !== 'timer') return null;
    p.ttl = p.ttl ?? 0;
    if (!Number.isInteger(p.ttl) || p.ttl < 0 || p.ttl > MAX_TTL) return null;
    const senderKey = await openpgp.readKey({ binaryKey: b64u.dec(p.key) });
    if (senderKey.isPrivate()) return null;
    // Segunda pasada: exige una firma válida hecha con la clave que viene dentro.
    // `date` tolera relojes del remitente algo adelantados (la clave se valida en la fecha de la firma).
    const second = await openpgp.decrypt({
      message: await read(), decryptionKeys: myPriv, verificationKeys: senderKey, expectSigned: true,
      date: new Date(Date.now() + MAX_FUTURE_MS), config,
    });
    if (second.data !== first.data) return null;
    return { p, senderKey };
  }

  // ---------- Relays Nostr ----------
  class Relay {
    constructor(pool, url) {
      this.pool = pool;
      this.url = url;
      this.ws = null;
      this.status = 'off';
      this.retry = 0;
      this.timer = null;
      this.subTimer = null;
      this.reqAt = 0;
      this.page = null;
      this.closed = false;
      this.waiting = new Map();
    }
    connect() {
      clearTimeout(this.timer);
      if (this.closed || (this.ws && this.ws.readyState <= 1)) return;
      this.status = 'connecting';
      this.pool.changed();
      let ws;
      try { ws = new WebSocket(this.url); } catch { this.status = 'off'; this.pool.changed(); return; }
      this.ws = ws;
      const openTimeout = setTimeout(() => { if (ws.readyState === 0) ws.close(); }, 10000);
      ws.onopen = () => {
        clearTimeout(openTimeout);
        this.status = 'open';
        this.retry = 0;
        this.subscribe();
        this.pool.changed();
        this.pool.onOpen();
      };
      ws.onmessage = (e) => this.onMessage(e.data);
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(openTimeout);
        if (this.ws !== ws) return;
        this.drop();
        if (!this.closed) {
          const delay = Math.min(60000, 1000 * 2 ** this.retry++) * (0.75 + Math.random() / 2);
          this.timer = setTimeout(() => this.connect(), delay);
        }
      };
    }
    // Suelta el socket actual sin esperar a su onclose (que se ignora porque ya no es this.ws).
    drop() {
      clearTimeout(this.subTimer);
      const ws = this.ws;
      this.ws = null;
      this.status = 'off';
      this.page = null;
      for (const w of this.waiting.values()) w.resolve(null);
      this.waiting.clear();
      if (ws && ws.readyState <= 1) ws.close();
      this.pool.changed();
    }
    // Tras dormir el móvil o cambiar de red un socket puede seguir «abierto» pero muerto.
    restart() {
      this.drop();
      this.retry = 0;
      this.connect();
    }
    close() {
      this.closed = true;
      clearTimeout(this.timer);
      this.drop();
    }
    send(msg) {
      if (this.ws?.readyState !== 1) return false;
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    subscribe() {
      clearTimeout(this.subTimer);
      this.reqAt = nowSec();
      this.page = { sub: SUB_ID, got: 0, oldest: Infinity, prev: Infinity, n: 0 };
      this.send(['REQ', SUB_ID, this.pool.filter(this.url)]);
    }
    // Un relay entrega como mucho SUB_LIMIT eventos (los más recientes). Si llega al tope puede haber
    // más antiguos (por ejemplo, si alguien inunda la etiqueta): se piden antes de dar el histórico por completo.
    onEose() {
      const pg = this.page;
      if (pg.got >= SUB_LIMIT && pg.n < MAX_PAGES && Number.isFinite(pg.oldest)) {
        const until = pg.oldest < pg.prev ? pg.oldest : pg.oldest - 1;
        Object.assign(pg, { sub: BACKFILL_ID, got: 0, prev: pg.oldest, oldest: Infinity, n: pg.n + 1 });
        this.send(['REQ', BACKFILL_ID, { ...this.pool.filter(this.url), until }]);
        return;
      }
      if (pg.sub === BACKFILL_ID) this.send(['CLOSE', BACKFILL_ID]);
      this.page = null;
      if (pg.got < SUB_LIMIT) this.pool.onEose(this.url, this.reqAt);
    }
    publish(ev) {
      if (this.waiting.has(ev.id)) return this.waiting.get(ev.id).promise;
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      if (!this.send(['EVENT', ev])) return Promise.resolve(null);
      const timer = setTimeout(() => done(null), 10000);
      const done = (ok) => { clearTimeout(timer); this.waiting.delete(ev.id); resolve(ok); };
      this.waiting.set(ev.id, { promise, resolve: done });
      return promise;
    }
    onMessage(data) {
      if (typeof data !== 'string' || data.length > MAX_FRAME) return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!Array.isArray(m)) return;
      if (m[0] === 'EVENT' && (m[1] === SUB_ID || m[1] === BACKFILL_ID) && m[2] && typeof m[2] === 'object') {
        const pg = this.page;
        if (pg && m[1] === pg.sub) {
          pg.got++;
          if (Number.isFinite(m[2].created_at)) pg.oldest = Math.min(pg.oldest, m[2].created_at);
        }
        this.pool.onEvent(m[2]);
      } else if (m[0] === 'EOSE' && this.page && m[1] === this.page.sub) {
        this.onEose();
      } else if (m[0] === 'OK') {
        this.waiting.get(m[1])?.resolve(m[2] === true || /^duplicate/i.test(String(m[3] || '')));
      } else if (m[0] === 'CLOSED' && m[1] === SUB_ID) {
        clearTimeout(this.subTimer);
        this.subTimer = setTimeout(() => this.subscribe(), 60000);
      }
    }
  }

  class Pool {
    constructor({ filter, onEvent, onEose, onOpen, onChange }) {
      this.relays = new Map();
      this.filter = filter;
      this.onEvent = onEvent;
      this.onEose = onEose;
      this.onOpen = onOpen;
      this.changed = onChange;
    }
    setRelays(urls) {
      for (const [u, r] of this.relays) if (!urls.includes(u)) { r.close(); this.relays.delete(u); }
      for (const u of urls) if (!this.relays.has(u)) { const r = new Relay(this, u); this.relays.set(u, r); r.connect(); }
      this.changed();
    }
    wake(force) {
      for (const r of this.relays.values()) {
        if (r.status === 'off') { r.retry = 0; r.connect(); }
        else if (force) r.restart();
      }
    }
    counts() {
      let open = 0;
      for (const r of this.relays.values()) if (r.status === 'open') open++;
      return { open, total: this.relays.size };
    }
    // true: aceptado por al menos dos relays (o por todos los que respondieron) ·
    // false: todos lo rechazaron · null: sin respuesta suficiente (se reintentará)
    publish(ev) {
      const open = [...this.relays.values()].filter((r) => r.status === 'open');
      if (!open.length) return Promise.resolve(null);
      const need = Math.min(2, open.length);
      return new Promise((res) => {
        let pending = open.length, accepted = 0, rejected = 0, done = false;
        const finish = (v) => { if (!done) { done = true; res(v); } };
        for (const r of open) {
          r.publish(ev).then((ok) => {
            pending--;
            if (ok === true) accepted++;
            else if (ok === false) rejected++;
            if (accepted >= need) finish(true);
            else if (pending === 0) finish(rejected === open.length ? false : accepted && accepted + rejected === open.length ? true : null);
          });
        }
      });
    }
  }

  // Cada relay sigue desde donde terminó su último histórico completo (EOSE), con margen.
  function subscriptionFilter(url) {
    const base = state.relaySince[url] ?? state.since;
    return { kinds: [KIND], '#p': [state.me.tag], since: Math.max(0, base - SINCE_MARGIN), limit: SUB_LIMIT };
  }

  function onEose(url, reqAt) {
    if (!reqAt || halted) return;
    state.relaySince[url] = Math.max(state.relaySince[url] || 0, reqAt);
    save();
  }

  // ---------- Mensajes ----------
  function addMessage(fpr, m) {
    const list = (state.msgs[fpr] ||= []);
    let i = list.length;
    while (i > 0 && list[i - 1].ts > m.ts) i--;
    list.splice(i, 0, m);
    const c = state.contacts[fpr];
    c.lastTs = Math.max(c.lastTs || 0, m.ts);
  }

  const sysMsg = (text, ts, extra) => ({ id: 'sys-' + crypto.randomUUID(), dir: 'sys', text, ts, ...extra });
  const timerText = (who, ttl) => ttl
    ? `${who} ${who === 'Has' ? 'activado' : 'ha activado'} los mensajes temporales: ${timerLabel(ttl)}`
    : `${who} ${who === 'Has' ? 'desactivado' : 'ha desactivado'} los mensajes temporales`;

  // Los eventos se procesan de uno en uno: evita carreras y ráfagas de descifrados.
  function onRelayEvent(ev) {
    eventQueue = eventQueue.then(() => handleEvent(ev)).catch(() => {});
  }

  async function handleEvent(ev) {
    if (!state?.me || halted || typeof ev.id !== 'string' || evSeen.has(ev.id)) return;
    if (ev.kind !== KIND || !Array.isArray(ev.tags) || !ev.tags.some((t) => Array.isArray(t) && t[0] === 'p' && t[1] === state.me.tag)) return;
    const expiration = ev.tags.find((t) => Array.isArray(t) && t[0] === 'expiration');
    if (expiration && Number(expiration[1]) < nowSec()) return; // NIP-40: ya caducado
    if (!NostrTools.verifyEvent(ev)) return;
    if (evSeen.size > 20000) evSeen.clear();
    evSeen.add(ev.id);
    let res;
    try { res = await openEvent(ev); } catch { return; }
    if (!res) return;
    const { p, senderKey } = res;
    const fpr = senderKey.getFingerprint();
    const ts = Math.min(p.ts, Date.now());
    const key = fpr + ':' + p.id;
    if (fpr === state.me.fpr || seen.has(key) || seen.has(p.id) || ts <= (state.seenFloor[fpr] || 0)) return;
    let c = own(state.contacts, fpr) ? state.contacts[fpr] : null;
    if (c?.status === 'blocked') return;
    if (!c) {
      // Límite de solicitudes: crear claves no cuesta nada y llenarían el almacenamiento.
      if (Object.values(state.contacts).filter((x) => x.status === 'pending').length >= MAX_PENDING) return;
      try { await senderKey.getEncryptionKey(); } catch { return; }
      c = state.contacts[fpr] = { fpr, name: await keyName(senderKey), pub: p.key, status: 'pending', added: Date.now(), unread: 0, verified: false, ttl: 0 };
      keyCache.set(fpr, senderKey);
    } else if (c.status === 'pending' && (state.msgs[fpr]?.length || 0) >= MAX_PENDING_MSGS) {
      return;
    }
    markSeen(key, ts);
    // El temporizador lo fija quien escribe: cada mensaje lleva el suyo y el chat se sincroniza.
    if ((c.ttl || 0) !== p.ttl) {
      c.ttl = p.ttl;
      addMessage(fpr, sysMsg(timerText(c.name, p.ttl), ts));
      if (current === fpr) renderChatHeader();
    }
    if (p.t !== 'timer') {
      const exp = p.ttl ? ts + p.ttl * 1000 : 0;
      if (exp && exp <= Date.now()) { save(); return; } // llegó cuando ya había caducado
      addMessage(fpr, { id: p.id, dir: 'in', text: p.text.slice(0, c.status === 'pending' ? PENDING_TEXT : MAX_TEXT), ts, exp });
      if (!(current === fpr && !document.hidden)) c.unread = (c.unread || 0) + 1;
    }
    save();
    renderList();
    if (current === fpr) { renderRequest(); renderMessages(true); }
  }

  // Clave Nostr desechable por evento: los relays no pueden saber quién envía.
  const signEvent = (tags, content) =>
    NostrTools.finalizeEvent({ kind: KIND, created_at: nowSec(), tags, content }, NostrTools.generateSecretKey());

  async function buildEvent(fpr, extra) {
    const c = state.contacts[fpr];
    const ttl = c.ttl || 0;
    const payload = { v: 1, id: crypto.randomUUID(), ts: Date.now(), to: fpr, key: myPubB64, text: '', ttl, ...extra };
    // NIP-40: los relays borran el evento al caducar (el tiempo del temporizador o RELAY_TTL).
    const tags = [['p', await tagFor(fpr)], ['expiration', String(nowSec() + (ttl || RELAY_TTL))]];
    return { payload, ttl, ev: signEvent(tags, await encryptFor(c, payload)) };
  }

  async function sendMessage(fpr, text) {
    const c = state.contacts[fpr];
    if (c.status !== 'ok') { c.status = 'ok'; renderRequest(); } // responder acepta la solicitud
    const { payload, ttl, ev } = await buildEvent(fpr, { text });
    const m = { id: payload.id, dir: 'out', text, ts: payload.ts, st: 'sending', ev, exp: ttl ? payload.ts + ttl * 1000 : 0 };
    addMessage(fpr, m);
    save();
    renderList();
    renderMessages(true, true);
    publishMsg(fpr, m);
  }

  async function setTimer(fpr, ttl) {
    const c = state.contacts[fpr];
    if ((c.ttl || 0) === ttl) return;
    c.ttl = ttl;
    // Aviso de control cifrado para que el otro lado use el mismo temporizador.
    const { payload, ev } = await buildEvent(fpr, { t: 'timer' });
    const m = sysMsg(timerText('Has', ttl), payload.ts, { id: payload.id, st: 'sending', ev });
    addMessage(fpr, m);
    save();
    renderChatHeader();
    renderList();
    renderMessages(true, true);
    publishMsg(fpr, m);
  }

  function publishMsg(fpr, m) {
    if (!pool || !m.ev || inflight.has(m.id)) return;
    // Un pendiente antiguo se firma de nuevo con fecha actual para que entre en el filtro del destinatario.
    if (!Number.isFinite(m.ev.created_at) || nowSec() - m.ev.created_at > RESIGN_AFTER) m.ev = signEvent(m.ev.tags, m.ev.content);
    inflight.add(m.id);
    pool.publish(m.ev).then((ok) => {
      inflight.delete(m.id);
      if (m.st === 'sent') return;
      if (ok === true) { m.st = 'sent'; delete m.ev; }
      else if (ok === false) m.st = 'failed';
      save();
      if (current === fpr) updateMsg(m);
    });
  }

  // Reenvía lo pendiente (p. ej. escrito sin conexión): al conectar un relay y cada 30 s.
  function flushOutbox() {
    if (halted) return;
    for (const [fpr, list] of Object.entries(state.msgs)) {
      for (const m of list) if (m.dir !== 'in' && m.st === 'sending' && m.ev) publishMsg(fpr, m);
    }
  }

  function retry(fpr, m) {
    if (!m.ev) return;
    m.st = 'sending';
    updateMsg(m);
    publishMsg(fpr, m);
  }

  // Borra los mensajes temporales caducados (aquí; los relays los borran por su cuenta).
  function sweepExpired() {
    if (halted || !state) return;
    const now = Date.now();
    let changed = false;
    for (const [fpr, list] of Object.entries(state.msgs)) {
      const keep = list.filter((m) => !m.exp || m.exp > now);
      if (keep.length !== list.length) { state.msgs[fpr] = keep; changed = true; }
    }
    if (!changed) return;
    save();
    renderList();
    if (current) renderMessages(true);
  }

  // ---------- Interfaz: lista de chats ----------
  function avatar(c, cls = 'avatar') {
    const el = h('span', { class: cls }, initials(c.name));
    el.style.setProperty('--h', hue(c.fpr));
    return el;
  }

  // Otro contacto con un nombre que se ve igual y distinta huella: posible suplantación.
  function nameClash(name, fpr) {
    const k = skeleton(name);
    return !!k && Object.values(state.contacts).some((c) => c.fpr !== fpr && c.status !== 'blocked' && skeleton(c.name) === k);
  }

  function renderList() {
    const ul = $('#chat-list');
    const cs = Object.values(state.contacts)
      .filter((c) => c.status !== 'blocked')
      .sort((a, b) => (b.lastTs || b.added) - (a.lastTs || a.added));
    $('#list-empty').hidden = cs.length > 0;
    ul.hidden = cs.length === 0;
    ul.replaceChildren(...cs.map((c) => {
      const msgs = state.msgs[c.fpr] || [];
      const last = msgs[msgs.length - 1];
      const preview = c.status === 'pending'
        ? h('span', { class: 'ci-preview req' }, 'Solicitud de chat')
        : h('span', { class: 'ci-preview' }, last ? (last.dir === 'out' ? 'Tú: ' : '') + last.text.replace(BIDI, '').split('\n')[0] : 'Sin mensajes todavía');
      return h('li', {}, h('button', { class: 'chat-item' + (c.fpr === current ? ' active' : ''), type: 'button', onclick: () => openChat(c.fpr) },
        avatar(c),
        h('span', { class: 'ci-main' },
          h('span', { class: 'ci-top' },
            h('strong', { class: 'ci-name' }, c.name),
            c.verified ? icon('shield', 'ic verified') : null,
            c.ttl ? icon('timer', 'ic ci-timer') : null,
            h('time', {}, last ? listTime(last.ts) : '')),
          h('span', { class: 'ci-bottom' }, preview, c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null))));
    }));
    updateBadge();
  }

  function updateBadge() {
    let n = 0;
    for (const c of Object.values(state.contacts)) if (c.status !== 'blocked') n += c.unread || 0;
    document.title = n ? `(${n}) Susurro` : 'Susurro';
    if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  function renderNet() {
    if (!pool) return;
    const { open, total } = pool.counts();
    const el = $('#net');
    el.className = 'net ' + (open ? 'on' : navigator.onLine ? 'wait' : 'off');
    el.lastElementChild.textContent = open ? `Conectado · ${open}/${total} relays` : navigator.onLine ? 'Conectando…' : 'Sin conexión';
    if ($('#dlg-settings').open) renderRelayStatus();
  }

  // ---------- Interfaz: conversación ----------
  function openChat(fpr) {
    const c = state.contacts[fpr];
    if (!c) return;
    current = fpr;
    c.unread = 0;
    save();
    $('#app').classList.add('in-chat');
    $('#chat-none').hidden = true;
    $('#chat-bar').hidden = false;
    $('#messages').hidden = false;
    $('#composer').hidden = false;
    // En móvil, el botón «atrás» del sistema vuelve a la lista.
    if (!history.state?.chat) history.pushState({ chat: true }, '');
    renderChatHeader();
    renderRequest();
    renderMessages(false, true);
    renderList();
    if (!isTouch) $('#in-msg').focus();
  }

  function closeChat() {
    current = null;
    $('#app').classList.remove('in-chat');
    $('#chat-none').hidden = false;
    $('#chat-bar').hidden = true;
    $('#messages').hidden = true;
    $('#composer').hidden = true;
    $('#request').hidden = true;
    renderList();
  }

  // Cierra el chat al momento y retira la entrada del historial que abrió openChat.
  function leaveChat() {
    closeChat();
    if (history.state?.chat) history.back();
  }

  function renderChatHeader() {
    const c = state.contacts[current];
    if (!c) return;
    const av = $('#chat-avatar');
    av.textContent = initials(c.name);
    av.style.setProperty('--h', hue(c.fpr));
    $('#chat-name').textContent = c.name;
    const sub = $('#chat-sub');
    sub.className = c.verified ? 'ok' : '';
    // Sin verificar se muestra el principio de la huella: un impostor no puede imitarla.
    sub.replaceChildren(...(c.verified ? [icon('shield'), 'Verificado'] : [`Sin verificar · ${shortFpr(c.fpr)} · toca para comprobar`]));
    const tb = $('#btn-timer');
    tb.classList.toggle('on', !!c.ttl);
    tb.title = c.ttl ? `Mensajes temporales: ${timerLabel(c.ttl)}` : 'Mensajes temporales';
  }

  function renderRequest() {
    const c = current && state.contacts[current];
    const pending = !!c && c.status === 'pending';
    $('#request').hidden = !pending;
    if (!pending) return;
    $('#req-name').textContent = c.name;
    $('#req-fpr').textContent = shortFpr(c.fpr);
    $('#req-warn').hidden = !nameClash(c.name, c.fpr);
  }

  function statusIcon(st) {
    if (st === 'sending') return icon('clock');
    if (st === 'failed') return icon('alert');
    return icon('check');
  }

  function msgEl(m, allowLinks) {
    if (m.dir === 'sys') return h('div', { class: 'sys', 'data-id': m.id }, h('span', {}, icon('timer'), m.text));
    const meta = h('span', { class: 'meta' }, m.exp ? icon('timer') : null, timeFmt.format(m.ts), m.dir === 'out' ? statusIcon(m.st) : null);
    const el = h('div', { class: `msg ${m.dir}${m.st === 'failed' ? ' failed' : ''}`, 'data-id': m.id },
      h('div', { class: 'bubble' }, linkify(m.text, allowLinks), meta));
    if (m.st === 'failed') {
      el.append(h('span', { class: 'fail-note' }, 'No se pudo enviar. Toca para reintentar.'));
      const fpr = current;
      el.addEventListener('click', () => retry(fpr, m));
    }
    return el;
  }

  function renderMessages(keepPosition = false, toBottom = false) {
    const box = $('#messages');
    const c = state.contacts[current];
    if (!c) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const prevTop = box.scrollTop;
    const list = state.msgs[current] || [];
    const allowLinks = c.status === 'ok';
    const nodes = [h('p', { class: 'e2e' }, icon('lock'),
      list.length
        ? `Mensajes cifrados de extremo a extremo con PGP. Solo tú y ${c.name} podéis leerlos.`
        : `Mensajes cifrados de extremo a extremo con PGP. Escríbele algo: con tu primer mensaje recibirá tu clave y podrá contestarte.`)];
    let lastDay = null;
    for (const m of list) {
      const d = startOfDay(m.ts);
      if (d !== lastDay) { nodes.push(h('div', { class: 'day' }, h('span', {}, dayLabel(m.ts)))); lastDay = d; }
      nodes.push(msgEl(m, allowLinks));
    }
    box.replaceChildren(...nodes);
    box.scrollTop = !keepPosition || toBottom || nearBottom ? box.scrollHeight : prevTop;
  }

  function updateMsg(m) {
    const old = $('#messages').querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (old) old.replaceWith(msgEl(m, state.contacts[current]?.status === 'ok'));
  }

  function autosize() {
    const ta = $('#in-msg');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 140) + 'px';
  }

  // ---------- Diálogos ----------
  function openDialog(id) {
    const d = $(id);
    if (!d.open) d.showModal();
    return d;
  }

  const inviteLink = () => (/^https?:$/.test(location.protocol) ? location.origin + location.pathname + '#c=' + myPubB64 : '');

  async function openShare() {
    const link = inviteLink();
    try {
      await loadScript('vendor/qrcode.js');
      drawQR($('#qr'), link || myPubB64);
    } catch {
      return toast('No se pudo generar el QR');
    }
    $('#my-fpr').textContent = fmtFpr(state.me.fpr);
    $('#btn-share-link').hidden = !(link && navigator.share);
    $('#btn-copy-link').hidden = !link;
    openDialog('#dlg-share');
  }

  function drawQR(canvas, text) {
    const qr = qrcode(0, 'L');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount(), quiet = 4, total = n + quiet * 2;
    const scale = Math.max(2, Math.floor((280 * Math.min(3, Math.max(1, devicePixelRatio || 1))) / total));
    canvas.width = canvas.height = total * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }

  function openAdd(prefill = '') {
    stopScan();
    $('#in-contact').value = prefill;
    openDialog('#dlg-add');
    previewContact();
  }

  async function parseContactKey(raw) {
    const PRIV = 'Eso es una clave PRIVADA. No la compartas con nadie.';
    if (raw.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) throw new Error(PRIV);
    let key;
    if (raw.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
      try { key = await openpgp.readKey({ armoredKey: raw }); } catch { throw new Error('La clave PGP está incompleta o dañada.'); }
    } else {
      const m = raw.match(/[#?&]c=([A-Za-z0-9_-]+)/);
      const code = m ? m[1] : raw.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9_-]{40,}$/.test(code) || code.length > MAX_KEY_CHARS) throw new Error('No reconozco ese código. Pega el enlace o la clave pública completa.');
      try { key = await openpgp.readKey({ binaryKey: b64u.dec(code) }); } catch { throw new Error('El código está incompleto o dañado.'); }
    }
    if (key.isPrivate()) throw new Error(PRIV);
    try { await key.getEncryptionKey(); } catch { throw new Error('Esa clave no sirve para cifrar (¿caducada o revocada?).'); }
    if (key.getFingerprint() === state.me.fpr) throw new Error('Ese es tu propio código.');
    return key;
  }

  async function previewContact() {
    const raw = $('#in-contact').value.trim();
    const seq = ++previewSeq;
    pendingContact = null;
    $('#contact-error').hidden = true;
    $('#contact-warn').hidden = true;
    $('#contact-preview').hidden = true;
    const btn = $('#btn-add-confirm');
    btn.disabled = true;
    btn.textContent = 'Añadir';
    if (!raw) return;
    try {
      const key = await parseContactKey(raw);
      const name = await keyName(key);
      if (seq !== previewSeq) return;
      const fpr = key.getFingerprint();
      pendingContact = { key, name, fpr };
      const av = $('#cp-avatar');
      av.textContent = initials(name);
      av.style.setProperty('--h', hue(fpr));
      $('#cp-name').textContent = name;
      $('#cp-fpr').textContent = fmtFpr(fpr);
      $('#contact-preview').hidden = false;
      $('#contact-warn').hidden = !nameClash(name, fpr);
      btn.disabled = false;
      if (own(state.contacts, fpr) && state.contacts[fpr].status === 'ok') btn.textContent = 'Ya es tu contacto: abrir chat';
    } catch (e) {
      if (seq !== previewSeq) return;
      $('#contact-error').textContent = e.message;
      $('#contact-error').hidden = false;
    }
  }

  function confirmAdd() {
    if (!pendingContact) return;
    const { key, name, fpr } = pendingContact;
    const existing = own(state.contacts, fpr) ? state.contacts[fpr] : null;
    const pub = b64u.enc(key.write());
    if (existing) Object.assign(existing, { status: 'ok', name, pub: existing.pub || pub });
    else state.contacts[fpr] = { fpr, name, pub, status: 'ok', added: Date.now(), unread: 0, verified: false, ttl: 0 };
    keyCache.set(fpr, key);
    save();
    $('#dlg-add').close();
    renderList();
    openChat(fpr);
    if (!existing) toast(`${name} añadido`);
  }

  // Escáner QR con la cámara (jsQR se carga solo cuando hace falta).
  // scanSeq invalida un arranque en curso si se cierra el diálogo o se detiene el escáner.
  let scanStream = null, scanTimer = null, scanSeq = 0;
  async function startScan() {
    const my = ++scanSeq;
    const alive = () => my === scanSeq && $('#dlg-add').open;
    const btn = $('#btn-scan');
    btn.disabled = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return toast('Este navegador no deja usar la cámara aquí');
      try { await loadScript('vendor/jsQR.js'); } catch { return toast('No se pudo cargar el lector de QR'); }
      if (!alive()) return;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch {
        return toast('Sin acceso a la cámara. Revisa los permisos del navegador.');
      }
      if (!alive()) { stream.getTracks().forEach((t) => t.stop()); return; }
      scanStream = stream;
      const video = $('#scan-video');
      video.srcObject = stream;
      $('#scan-box').hidden = false;
      $('#btn-scan span').textContent = 'Detener cámara';
      await video.play().catch(() => {});
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (my !== scanSeq || !scanStream) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * s);
          canvas.height = Math.round(video.videoHeight * s);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code?.data) {
            stopScan();
            navigator.vibrate?.(60);
            $('#in-contact').value = code.data;
            previewContact();
            return;
          }
        }
        scanTimer = setTimeout(tick, 160);
      };
      tick();
    } finally {
      btn.disabled = false;
    }
  }

  function stopScan() {
    scanSeq++;
    clearTimeout(scanTimer);
    scanStream?.getTracks().forEach((t) => t.stop());
    scanStream = null;
    $('#scan-video').srcObject = null;
    $('#scan-box').hidden = true;
    $('#btn-scan span').textContent = 'Escanear código QR';
  }

  function openContact() {
    const c = state.contacts[current];
    $('#ct-name').textContent = c.name;
    $('#ct-fpr').textContent = fmtFpr(c.fpr);
    $('#ct-myfpr').textContent = fmtFpr(state.me.fpr);
    $('#btn-ct-verify span').textContent = c.verified ? 'Quitar verificación' : 'Marcar como verificado';
    openDialog('#dlg-contact');
  }

  function openTimer() {
    const c = state.contacts[current];
    $('#timer-options').replaceChildren(...TIMERS.map(([ttl, label]) =>
      h('button', {
        class: 'btn timer-opt' + ((c.ttl || 0) === ttl ? ' selected' : ''), type: 'button',
        onclick: async () => {
          $('#dlg-timer').close();
          try { await setTimer(current, ttl); } catch (e) { console.error(e); toast('No se pudo cambiar el temporizador'); }
        },
      }, label)));
    openDialog('#dlg-timer');
  }

  function openSettings() {
    $('#set-name').textContent = state.me.name;
    $('#set-fpr').textContent = fmtFpr(state.me.fpr);
    $('#in-relays').value = state.relays.join('\n');
    for (const id of ['#in-backup-pass', '#in-pass-old', '#in-pass-new', '#in-pass-new2']) $(id).value = '';
    $('#in-backup-pass').type = 'password';
    renderRelayStatus();
    openDialog('#dlg-settings');
  }

  function renderRelayStatus() {
    const label = { open: 'conectado', connecting: 'conectando…', off: 'sin conexión' };
    $('#relay-status').replaceChildren(...[...pool.relays.values()].map((r) =>
      h('li', { class: r.status }, h('i'), `${r.url} · ${label[r.status]}`)));
  }

  const isWss = (u) => { try { return new URL(u).protocol === 'wss:'; } catch { return false; } };

  function saveRelays() {
    const list = [...new Set($('#in-relays').value.split(/\s+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean))];
    const bad = list.find((u) => !isWss(u));
    if (bad) return toast(`Dirección no válida: ${bad} (debe empezar por wss://)`);
    if (!list.length) return toast('Necesitas al menos un relay');
    state.relays = list;
    save();
    pool.setRelays(list);
    renderRelayStatus();
    toast('Relays guardados');
  }

  // ---------- Copias de seguridad ----------
  async function saveFile(name, text) {
    const file = new File([text], name, { type: 'text/plain' });
    if (isTouch && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function makeBackup(pass) {
    const { me, contacts, relays, since, relaySince, seen: seenList, seenFloor } = state;
    // Los mensajes temporales no se copian: deben desaparecer.
    const msgs = {};
    for (const [fpr, list] of Object.entries(state.msgs)) msgs[fpr] = list.filter((m) => !m.exp);
    const data = { app: 'susurro', v: 1, me, contacts, msgs, relays, since, relaySince, seen: seenList, seenFloor };
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: JSON.stringify(data) }),
      passwords: [pass],
      // Argon2 encarece mucho probar contraseñas por fuerza bruta si la copia se filtra.
      config: { s2kType: openpgp.enums.s2k.argon2, aeadProtect: true },
    });
    await saveFile(`susurro-copia-${new Date().toISOString().slice(0, 10)}.asc`, armored);
  }

  // Solo se admite lo que tiene la forma esperada: una copia manipulada no puede romper la app.
  function sanitizeBackup(data) {
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const str = (v) => typeof v === 'string';
    const okTs = (t) => Number.isFinite(t) && t >= 0 && t <= Date.now() + MAX_FUTURE_MS;
    const contacts = {};
    for (const c of Object.values(obj(data.contacts))) {
      if (!c || !str(c.fpr) || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(c.fpr) || !str(c.name)) continue;
      const blocked = c.status === 'blocked';
      if (!blocked && (!str(c.pub) || c.pub.length > MAX_KEY_CHARS)) continue;
      contacts[c.fpr] = {
        fpr: c.fpr, name: cleanName(c.name), status: blocked ? 'blocked' : c.status === 'ok' ? 'ok' : 'pending',
        added: okTs(c.added) ? c.added : Date.now(), lastTs: okTs(c.lastTs) ? c.lastTs : 0, unread: 0,
        verified: c.verified === true, ttl: Number.isInteger(c.ttl) && c.ttl >= 0 && c.ttl <= MAX_TTL ? c.ttl : 0,
        ...(blocked ? {} : { pub: c.pub }),
      };
    }
    const msgs = {};
    for (const [fpr, list] of Object.entries(obj(data.msgs))) {
      if (!own(contacts, fpr) || contacts[fpr].status === 'blocked' || !Array.isArray(list)) continue;
      msgs[fpr] = list
        .filter((m) => m && str(m.id) && m.id.length <= 64 && str(m.text) && okTs(m.ts) && ['in', 'out', 'sys'].includes(m.dir) && !m.exp)
        .map((m) => {
          const out = { id: m.id, dir: m.dir, text: m.text.slice(0, MAX_TEXT), ts: m.ts };
          if (m.dir !== 'in') {
            const ev = m.ev && str(m.ev.content) && Array.isArray(m.ev.tags) ? { content: m.ev.content, tags: m.ev.tags, created_at: 0 } : null;
            if (ev && (m.st === 'sending' || m.st === 'failed')) { out.st = m.st; out.ev = ev; }
            else if (m.dir === 'out') out.st = 'sent';
          }
          return out;
        });
    }
    const relays = (Array.isArray(data.relays) ? data.relays : []).filter((u) => str(u) && isWss(u));
    const relaySince = {};
    for (const [u, t] of Object.entries(obj(data.relaySince))) if (isWss(u) && okTs(t * 1000)) relaySince[u] = t;
    const seenFloor = {};
    for (const [f, t] of Object.entries(obj(data.seenFloor))) if (/^[0-9a-f]{40,64}$/.test(f) && okTs(t)) seenFloor[f] = t;
    return {
      ...freshState(),
      me: { name: cleanName(data.me.name), priv: data.me.priv, created: Number(data.me.created) || nowSec() },
      contacts, msgs, relaySince, seenFloor,
      relays: relays.length ? relays : DEFAULT_RELAYS.slice(),
      since: Number(data.since) || nowSec() - 7 * 86400,
      seen: (Array.isArray(data.seen) ? data.seen : []).filter((s) => Array.isArray(s) && str(s[0]) && s[0].length <= 160 && okTs(s[1])),
    };
  }

  async function restore(text, pass) {
    const prev = { state, seen };
    try {
      await restoreFrom(text.trim(), pass);
      keyCache.clear();
    } catch (e) {
      // Si algo falla no se queda un estado a medias.
      state = prev.state;
      seen = prev.seen;
      myPriv = null;
      throw e;
    }
  }

  async function restoreFrom(text, pass) {
    if (text.includes('-----BEGIN PGP MESSAGE-----')) {
      if (!pass) throw new Error('Escribe la contraseña de la copia.');
      let data;
      try {
        const res = await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: text }), passwords: [pass],
          config: { ...ARGON2_LIMITS, maxDecompressedMessageSize: 64 * 1024 * 1024 },
        });
        data = JSON.parse(res.data);
      } catch { throw new Error('Contraseña incorrecta o copia dañada.'); }
      if (data?.app !== 'susurro' || typeof data.me?.priv !== 'string') throw new Error('Esto no es una copia de Susurro.');
      state = sanitizeBackup(data);
      seen = new Set(state.seen.map((s) => s[0]));
      try { await unlock(); } catch { throw new Error('La clave de la copia está dañada.'); }
      return;
    }
    if (text.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) {
      let key;
      try { key = await openpgp.readPrivateKey({ armoredKey: text }); } catch { throw new Error('La clave privada está incompleta o dañada.'); }
      if (!key.isDecrypted()) {
        if (!pass) throw new Error('Esta clave tiene contraseña: escríbela abajo.');
        try { key = await openpgp.decryptKey({ privateKey: key, passphrase: pass }); } catch { throw new Error('Contraseña de la clave incorrecta.'); }
      }
      state = freshState();
      seen = new Set();
      try { await setIdentity(key, nowSec() - 7 * 86400); } catch { throw new Error('Esta clave no sirve para firmar y cifrar.'); }
      return;
    }
    throw new Error('Pega una copia de Susurro o una clave privada PGP.');
  }

  // ---------- Instalación y actualizaciones ----------
  function updateInstallUI() {
    const standalone = isStandalone();
    const canInstall = !standalone && (deferredInstall || isIOS);
    $('#install-banner').hidden = !canInstall || !!state?.ui?.installDismissed;
    $('#install-text').textContent = deferredInstall
      ? 'Instala Susurro y tenlo como una app más.'
      : 'Para instalarla: toca Compartir y luego «Añadir a pantalla de inicio».';
    $('#btn-install').hidden = !deferredInstall;
    $('#btn-install-welcome').hidden = !deferredInstall;
    $('#install-hint-ios').hidden = !(isIOS && !standalone);
  }

  async function doInstall() {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    updateInstallUI();
  }

  // La versión nueva se instala en segundo plano y espera: se aplica entera al pulsar «Actualizar»
  // (o en el siguiente arranque), así nunca se mezclan archivos de dos versiones.
  function registerWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register(scriptURL('sw.js')).then((reg) => {
      const offer = (w) => { if (w && navigator.serviceWorker.controller) { waitingWorker = w; $('#update-banner').hidden = false; } };
      offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
      });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (reloading) return;
      reloading = true;
      await flushSave();
      halted = true;
      location.reload();
    });
  }

  // ---------- Arranque ----------
  function takeInvite() {
    let code = null;
    const m = location.hash.match(/^#c=([A-Za-z0-9_-]+)$/);
    if (m) code = m[1];
    // Enlaces compartidos a la app instalada (share_target del manifest).
    const params = new URLSearchParams(location.search);
    const shared = `${params.get('url') || ''} ${params.get('text') || ''}`.match(/[#?&]c=([A-Za-z0-9_-]+)/);
    if (!code && shared) code = shared[1];
    if (m || params.has('url') || params.has('text')) history.replaceState(history.state, '', location.pathname);
    return code;
  }

  // Otra ventana o pestaña ha cambiado los datos: esta deja de guardar para no pisarlos.
  function halt(msg) {
    halted = true;
    pool?.setRelays([]);
    stopScan();
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    $('#boot-msg').textContent = msg;
    $('#btn-reload').hidden = false;
    $('#boot').hidden = false;
  }

  function showScreen(id) {
    for (const s of ['#welcome', '#lock', '#setpass', '#app']) $(s).hidden = s !== id;
    const first = $(id).querySelector('input');
    if (first && !isTouch) first.focus();
  }

  function showWelcome() {
    showScreen('#welcome');
    $('#invite-note').hidden = !pendingInvite;
    $('#invite-ios').hidden = !(pendingInvite && isIOS && !isStandalone());
    updateInstallUI();
  }

  function showSetPass(reason) {
    $('#setpass-lead').textContent = reason === 'migrate'
      ? 'Ahora Susurro protege tus datos con una contraseña. Créala para seguir.'
      : 'Elige la contraseña con la que abrirás Susurro en este dispositivo.';
    showScreen('#setpass');
  }

  function startApp() {
    unlocked = true;
    showScreen('#app');
    pool ||= new Pool({ filter: subscriptionFilter, onEvent: onRelayEvent, onEose, onOpen: flushOutbox, onChange: renderNet });
    pool.setRelays(state.relays);
    if (!timers.length) timers = [setInterval(flushOutbox, 30000), setInterval(sweepExpired, 5000)];
    sweepExpired();
    renderList();
    renderNet();
    updateInstallUI();
    if (pendingInvite) { openAdd(pendingInvite); pendingInvite = null; }
  }

  async function enter() {
    state.me.tag = await tagFor(state.me.fpr);
    await flushSave();
    navigator.storage?.persist?.().catch(() => {});
    startApp();
  }

  function checkNewPass(a, b) {
    if (a.length < MIN_ACCESS_PASS) throw new Error(`La contraseña debe tener al menos ${MIN_ACCESS_PASS} caracteres.`);
    if (a !== b) throw new Error('Las contraseñas no coinciden.');
  }

  async function withBusy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }

  function bindUI() {
    // Bienvenida: nombre + contraseña de acceso
    $('#form-create').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#create-error');
      err.hidden = true;
      const pass = $('#in-create-pass').value;
      try { checkNewPass(pass, $('#in-create-pass2').value); } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
      await withBusy(e.submitter || $('#form-create button'), 'Generando claves…', async () => {
        try {
          const { privateKey } = await openpgp.generateKey({ type: 'ecc', userIDs: [{ name: cleanName($('#in-name').value) }], format: 'object' });
          state = freshState();
          await setIdentity(privateKey);
          await createVault(pass);
          await enter();
        } catch (ex) {
          console.error(ex);
          toast('No se pudieron generar las claves');
        }
      });
    });
    $('#in-restore-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) $('#in-restore-text').value = f.size > 20e6 ? '' : await f.text();
    });
    $('#form-restore').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#restore-error');
      err.hidden = true;
      await withBusy(e.submitter || $('#form-restore button'), 'Restaurando…', async () => {
        try {
          await restore($('#in-restore-text').value, $('#in-restore-pass').value);
          $('#in-restore-text').value = '';
          $('#in-restore-pass').value = '';
          showSetPass('restore');
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
    });
    $('#btn-copy-invite').addEventListener('click', () => copyText(location.origin + location.pathname + '#c=' + pendingInvite, 'Enlace copiado'));
    $('#btn-install-welcome').addEventListener('click', doInstall);
    $('#btn-reload').addEventListener('click', () => location.reload());

    // Crear contraseña (tras restaurar o al pasar de una versión sin contraseña)
    $('#form-setpass').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#setpass-error');
      err.hidden = true;
      const pass = $('#in-setpass').value;
      try { checkNewPass(pass, $('#in-setpass2').value); } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
      await withBusy(e.submitter || $('#form-setpass button'), 'Protegiendo…', async () => {
        await createVault(pass);
        $('#in-setpass').value = $('#in-setpass2').value = '';
        await enter();
      });
    });

    // Pantalla de bloqueo
    $('#form-unlock').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#unlock-error');
      err.hidden = true;
      await withBusy(e.submitter || $('#form-unlock button'), 'Abriendo…', async () => {
        try {
          await openVault($('#in-unlock').value);
          $('#in-unlock').value = '';
          seen = new Set(state.seen.map((s) => s[0]));
          await unlock();
          await enter();
        } catch (ex) {
          err.textContent = ex.message || 'No se pudo abrir';
          err.hidden = false;
          $('#in-unlock').select();
        }
      });
    });
    $('#btn-forgot').addEventListener('click', () => {
      if (!confirm('Sin la contraseña no se pueden abrir tus datos: nadie puede recuperarla.\n\n¿Borrar todo de este dispositivo y empezar de nuevo (o restaurar una copia de seguridad)?')) return;
      wipe();
    });

    // Barra lateral
    $('#btn-share').addEventListener('click', openShare);
    $('#btn-empty-share').addEventListener('click', openShare);
    $('#btn-add').addEventListener('click', () => openAdd());
    $('#btn-empty-add').addEventListener('click', () => openAdd());
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-lock').addEventListener('click', lockNow);
    $('#btn-install').addEventListener('click', doInstall);
    $('#btn-install-close').addEventListener('click', () => { state.ui.installDismissed = true; save(); updateInstallUI(); });
    $('#btn-update').addEventListener('click', () => waitingWorker?.postMessage('skipWaiting'));

    // Conversación
    $('#btn-back').addEventListener('click', leaveChat);
    window.addEventListener('popstate', () => { if (current && !history.state?.chat) closeChat(); });
    $('#btn-who').addEventListener('click', openContact);
    $('#btn-timer').addEventListener('click', openTimer);
    $('#btn-accept').addEventListener('click', () => {
      state.contacts[current].status = 'ok';
      save();
      renderRequest();
      renderList();
      renderMessages(true);
    });
    $('#btn-block').addEventListener('click', () => {
      const c = state.contacts[current];
      if (!confirm(`¿Bloquear a ${c.name}? No volverás a recibir sus mensajes.`)) return;
      // Del bloqueado solo se guarda la huella: no ocupa espacio con su clave ni sus mensajes.
      state.contacts[c.fpr] = { fpr: c.fpr, name: c.name, status: 'blocked', added: c.added, unread: 0 };
      delete state.msgs[c.fpr];
      keyCache.delete(c.fpr);
      save();
      leaveChat();
    });
    const ta = $('#in-msg');
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
        e.preventDefault();
        $('#composer').requestSubmit();
      }
    });
    // Que el teclado del móvil no se cierre al pulsar «Enviar».
    $('#btn-send').addEventListener('pointerdown', (e) => e.preventDefault());
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || !current) return;
      ta.value = '';
      autosize();
      try { await sendMessage(current, text.slice(0, MAX_TEXT)); }
      catch (err) { console.error(err); ta.value = text; autosize(); toast('No se pudo cifrar el mensaje'); }
    });

    // Diálogos: se cierran al pulsar el fondo (no al soltar fuera tras seleccionar texto).
    for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());
    for (const d of document.querySelectorAll('dialog')) {
      let downOnBackdrop = false;
      d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
      d.addEventListener('click', (e) => { if (e.target === d && downOnBackdrop) d.close(); });
      d.addEventListener('close', () => document.body.append($('#toast')));
    }
    $('#btn-share-link').addEventListener('click', () => {
      navigator.share({ title: 'Susurro', text: `Hablemos cifrado en Susurro. Soy ${state.me.name}:`, url: inviteLink() }).catch(() => {});
    });
    $('#btn-copy-link').addEventListener('click', () => copyText(inviteLink(), 'Enlace copiado'));
    $('#btn-copy-pgp').addEventListener('click', () => copyText(myPriv.toPublic().armor(), 'Clave pública copiada'));

    $('#btn-scan').addEventListener('click', () => (scanStream ? stopScan() : startScan()));
    $('#in-contact').addEventListener('input', previewContact);
    $('#btn-add-confirm').addEventListener('click', confirmAdd);
    $('#dlg-add').addEventListener('close', stopScan);

    $('#btn-ct-verify').addEventListener('click', () => {
      const c = state.contacts[current];
      c.verified = !c.verified;
      save();
      renderChatHeader();
      renderList();
      $('#dlg-contact').close();
      toast(c.verified ? 'Contacto verificado' : 'Verificación quitada');
    });
    $('#btn-ct-copy').addEventListener('click', async () => {
      try { copyText((await contactKey(state.contacts[current])).armor(), 'Clave pública copiada'); }
      catch { toast('No se pudo leer la clave de este contacto'); }
    });
    $('#btn-ct-delete').addEventListener('click', () => {
      const c = state.contacts[current];
      if (!confirm(`¿Eliminar el chat con ${c.name}? Se borrarán sus mensajes de este dispositivo.`)) return;
      delete state.contacts[c.fpr];
      delete state.msgs[c.fpr];
      keyCache.delete(c.fpr);
      save();
      $('#dlg-contact').close();
      leaveChat();
    });

    // Ajustes
    $('#btn-gen-pass').addEventListener('click', () => {
      const inp = $('#in-backup-pass');
      inp.value = randomPassword();
      inp.type = 'text';
      inp.select();
      toast('Apunta esta contraseña en un lugar seguro');
    });
    $('#form-backup').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = $('#in-backup-pass').value;
      if (pass.length < MIN_BACKUP_PASS) return toast(`Usa una contraseña de al menos ${MIN_BACKUP_PASS} caracteres`);
      await withBusy(e.submitter || $('#form-backup button[type=submit]'), 'Cifrando…', async () => {
        try { await makeBackup(pass); $('#in-backup-pass').value = ''; $('#in-backup-pass').type = 'password'; }
        catch (err) { console.error(err); toast('No se pudo crear la copia'); }
      });
    });
    $('#form-pass').addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = $('#in-pass-new').value;
      try { checkNewPass(next, $('#in-pass-new2').value); } catch (ex) { return toast(ex.message); }
      await withBusy(e.submitter || $('#form-pass button'), 'Cambiando…', async () => {
        // Se comprueba la actual descifrando lo guardado; después todo se vuelve a cifrar con una clave nueva.
        const live = state;
        try {
          stored = JSON.parse(localStorage.getItem(STORE_KEY));
          await openVault($('#in-pass-old').value);
        } catch { stored = null; return toast('La contraseña actual no es correcta'); }
        finally { state = live; } // lo que está en memoria es lo más reciente
        await createVault(next);
        await flushSave();
        for (const id of ['#in-pass-old', '#in-pass-new', '#in-pass-new2']) $(id).value = '';
        toast('Contraseña cambiada');
      });
    });
    $('#btn-lock-now').addEventListener('click', lockNow);
    $('#btn-relays-save').addEventListener('click', saveRelays);
    $('#btn-relays-reset').addEventListener('click', () => { $('#in-relays').value = DEFAULT_RELAYS.join('\n'); });
    $('#btn-wipe').addEventListener('click', () => {
      if (!confirm('¿Borrar tu identidad, contactos y mensajes de este dispositivo?\n\nSi no tienes copia de seguridad perderás tu identidad para siempre.')) return;
      wipe();
    });

    // Sistema
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; updateInstallUI(); });
    window.addEventListener('appinstalled', () => { deferredInstall = null; updateInstallUI(); });
    window.addEventListener('online', () => { pool?.wake(true); renderNet(); });
    window.addEventListener('offline', renderNet);
    window.addEventListener('pagehide', () => { flushSave(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); flushSave(); return; }
      if (unlocked && Date.now() - hiddenAt > AUTOLOCK_MS && hiddenAt) return void lockNow();
      pool?.wake(Date.now() - hiddenAt > 30000);
      if (current && state.contacts[current]?.unread) { state.contacts[current].unread = 0; save(); renderList(); }
    });
    window.addEventListener('storage', (e) => {
      if ((e.key !== STORE_KEY && e.key !== null) || halted) return;
      halt(e.newValue === null ? 'Se han borrado los datos de Susurro en otra ventana.' : 'Susurro está abierto en otra ventana.');
    });
    window.addEventListener('hashchange', () => {
      const code = takeInvite();
      if (!code) return;
      if (unlocked) openAdd(code);
      else { pendingInvite = code; if (!$('#welcome').hidden) showWelcome(); }
    });
    // iOS no redimensiona la página al abrir el teclado: se ajusta la altura a mano.
    if (isIOS && window.visualViewport) {
      const vv = window.visualViewport;
      const fit = () => {
        if (vv.scale > 1.01) return; // el usuario está haciendo zoom
        const box = $('#messages');
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        document.documentElement.style.setProperty('--app-h', vv.height + 'px');
        window.scrollTo(0, 0);
        if (!box.hidden && nearBottom) box.scrollTop = box.scrollHeight;
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
      fit();
    }
  }

  function wipe() {
    halted = true;
    pool?.setRelays([]);
    try { localStorage.clear(); } catch {}
    location.replace(location.pathname);
  }

  async function boot() {
    const fail = (msg) => { $('#boot-msg').textContent = msg; };
    if (!window.isSecureContext || !crypto.subtle) return fail('Abre Susurro desde una dirección https:// (o localhost).');
    if (!window.openpgp || !window.NostrTools) return fail('No se pudieron cargar las librerías. Recarga la página.');
    registerWorker();
    // Al recargar dentro de un chat queda una entrada de historial que ya no corresponde.
    if (history.state?.chat) history.replaceState(null, '');
    const kind = load();
    pendingInvite = takeInvite();
    bindUI();
    if (kind === 'locked') showScreen('#lock');
    else if (kind === 'legacy') {
      try { await unlock(); } catch (e) {
        console.error(e);
        return fail('No se pudo abrir tu clave guardada. Si tienes copia, borra los datos del sitio y restáurala.');
      }
      seen = new Set(state.seen.map((s) => s[0]));
      showSetPass('migrate');
    } else showWelcome();
    $('#boot').hidden = true;
  }

  boot();
})();
