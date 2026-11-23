'use strict';
/**
 * Chasse au trésor GPS — serveur temps réel SANS AUCUNE DÉPENDANCE.
 * Node.js >= 18 :   node server.js        (port : variable PORT, 3000 par défaut)
 *
 * Déroulement :
 *  1. Salon : l'hôte choisit les trésors (4 par défaut). Chacun ne voit que sa propre position.
 *  2. Phase de cache (10 min) : les trésors partent se cacher, les chercheurs attendent.
 *  3. Chasse : chaque trésor reçoit SA zone (3 km), jamais centrée sur lui.
 *     Toutes les 20 min, les zones rétrécissent et sont recalculées autour des trésors.
 *     Les trésors voient les chercheurs en temps réel ; les chercheurs ne voient que les zones.
 *     Un trésor hors de sa zone (après délai) ou sans GPS depuis 90 s est révélé.
 *  4. Fin : tous les trésors capturés (chercheurs gagnent) ou chrono écoulé (trésors gagnent).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TICK_MS = 1000;
const STALE_MS = 30000;            // position « périmée » (affichage grisé)
const OFFLINE_MS = 90000;          // trésor sans GPS depuis 90 s => révélé et capturable à sa dernière position
const CAPTURE_FRESH_MS = 20000;    // le chercheur doit avoir une position récente
const CAPTURE_COOLDOWN_MS = 3000;  // entre deux essais réussis / délai minimum
const CAPTURE_FAIL_MINUTES = [5, 8, 10, 13, 15, 18, 20];
const CAPTURE_TOLERANCE_MAX = 10;  // tolérance GPS maximale ajoutée à la distance de capture (m)
const MAX_SPEED = 12;              // m/s : au-delà, saut GPS ignoré pour la distance parcourue
const MAX_GAMES = 300;
const MAX_PLAYERS = 60;
const GAME_TTL_MS = 6 * 3600e3;

const DEFAULT_SETTINGS = {
  treasureCount: 4,     // nombre de trésors exigé
  hideTime: 10,         // minutes pour se cacher avant la création des zones
  radius: 3000,         // rayon de départ des zones (m)
  finalRadius: 150,     // rayon de la dernière zone (m)
  zoneInterval: 20,     // minutes entre deux rétrécissements
  duration: 120,        // durée de la chasse (min), après la phase de cache
  captureDist: 20,      // distance de capture (m)
  grace: 30,            // secondes hors de sa zone avant d'être révélé
  captureMode: 'convert', // 'convert' = devient chercheur, 'eliminate' = spectateur
};
const LIMITS = {
  treasureCount: [1, 10], hideTime: [0, 60], radius: [200, 20000], finalRadius: [20, 5000],
  zoneInterval: [1, 120], duration: [5, 600], captureDist: [5, 100], grace: [0, 300],
};

const games = new Map();

/* ------------------------------------------------------------------ Géo */
const EARTH = 6371000, RAD = Math.PI / 180;
function dist(a, b) {
  const x = (b.lng - a.lng) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const y = (b.lat - a.lat) * RAD;
  return EARTH * Math.hypot(x, y);
}
function offset(p, dx, dy) {
  return { lat: p.lat + dy / EARTH / RAD, lng: p.lng + dx / (EARTH * Math.cos(p.lat * RAD)) / RAD };
}

/**
 * Centre d'une zone de rayon r qui contient P sans être centrée dessus :
 * P est toujours entre 30 % et 80 % du rayon depuis le centre.
 * Avec une zone précédente, on cherche une zone entièrement incluse dedans,
 * sinon celle qui dépasse le moins (cas d'un trésor collé au bord).
 */
const MIN_OFF = 0.3, MAX_OFF = 0.8;
function makeZoneCenter(P, r, prev) {
  const cands = [];
  for (let i = 0; i < 400; i++) {
    const a = Math.random() * 2 * Math.PI, d = r * (MIN_OFF + Math.random() * (MAX_OFF - MIN_OFF));
    cands.push(offset(P, d * Math.cos(a), d * Math.sin(a)));
  }
  if (!prev) return cands[0];
  const dp = dist(P, prev);
  if (dp > 1) {
    const k = (MAX_OFF * r) / dp;
    cands.push({ lat: P.lat + (prev.lat - P.lat) * k, lng: P.lng + (prev.lng - P.lng) * k });
  }
  let best = null, bestOver = Infinity;
  for (const c of cands) {
    const over = dist(c, prev) + r - prev.r;
    if (over <= 0) return c;
    if (over < bestOver) { bestOver = over; best = c; }
  }
  return best;
}
function radiusAt(s, step, steps) {
  return Math.round(s.radius * Math.pow(s.finalRadius / s.radius, step / steps));
}
const zoneSteps = (s) => Math.max(1, Math.ceil(s.duration / s.zoneInterval) - 1);

/* ------------------------------------------------------------- Outils */
const rid = (n) => crypto.randomBytes(n).toString('hex');
function fail(status, msg, extra) { const e = new Error(msg); e.status = status; e.extra = extra; throw e; }
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while (games.has(c));
  return c;
}
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Joueur'; }
function uniqueName(g, n) {
  const taken = new Set([...g.players.values()].map((p) => p.name.toLowerCase()));
  let x = n, i = 2;
  while (taken.has(x.toLowerCase())) x = `${n.slice(0, 17)} ${i++}`;
  return x;
}
function cleanSettings(cur, inp) {
  const s = { ...cur };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (inp[k] !== undefined && inp[k] !== '' && inp[k] !== null && Number.isFinite(+inp[k])) {
      s[k] = Math.min(hi, Math.max(lo, Math.round(+inp[k])));
    }
  }
  if (s.finalRadius >= s.radius) s.finalRadius = Math.max(LIMITS.finalRadius[0], Math.round(s.radius / 10));
  if (s.duration <= s.zoneInterval) s.duration = Math.min(LIMITS.duration[1], s.zoneInterval * 2);
  if (inp.captureMode === 'convert' || inp.captureMode === 'eliminate') s.captureMode = inp.captureMode;
  return s;
}
function event(g, msg, kind = '') {
  g.events.push({ at: Date.now(), msg, kind });
  if (g.events.length > 40) g.events.shift();
}
const fresh = (p, now, ms = STALE_MS) => !!p.pos && now - p.pos.t < ms;
const treasures = (g) => [...g.players.values()].filter((p) => p.role === 'tresor');
const revealed = (p) => p.out || p.offline;

/* ------------------------------------------------------------ Joueurs */
function resetPlayerForGame(p) {
  Object.assign(p, {
    outSince: null, out: false, offline: false, captures: 0, captureFails: 0, capturedBy: null, capturedAt: null,
    zone: null, zoneIdx: -1, walked: 0, track: null, capBlockUntil: 0,
  });
}
function addPlayer(g, name) {
  const p = {
    id: rid(4), token: rid(16), name: uniqueName(g, cleanName(name)), role: 'chercheur', origRole: 'chercheur',
    pos: null, conns: new Set(), lastSent: '', lastWrite: 0,
  };
  resetPlayerForGame(p);
  g.players.set(p.id, p);
  g.tokens.set(p.token, p.id);
  return p;
}
function removePlayer(g, p) {
  for (const r of p.conns) r.end();
  p.conns.clear();
  g.players.delete(p.id);
  g.tokens.delete(p.token);
  if (!g.players.size) { games.delete(g.code); return; }
  if (g.hostId === p.id) {
    const next = g.players.values().next().value;
    g.hostId = next.id;
    event(g, `👑 ${next.name} devient l'hôte`);
  }
}

/* --------------------------------------------------------- Logique jeu */
function endGame(g, winner, now) {
  g.status = 'ended';
  g.winner = winner;
  g.nextZoneAt = null;
  g.endedAt = now;
  event(g, winner === 'chercheurs'
    ? '🏆 Tous les trésors ont été trouvés : victoire des chercheurs !'
    : '🏆 Temps écoulé : victoire des trésors !', 'end');
}

function beginHunt(g, now) {
  const s = g.settings;
  g.phase = 'hunt';
  g.huntAt = now;
  g.endAt = now + s.duration * 60000;
  g.zoneStep = 0;
  g.zoneSteps = zoneSteps(s);
  g.nextZoneAt = now + s.zoneInterval * 60000;
  if (g.nextZoneAt >= g.endAt) g.nextZoneAt = null;
  const tr = treasures(g);
  tr.forEach((q, i) => {
    // pos existe forcément : vérifiée au lancement (dernière position connue si GPS coupé)
    const c = makeZoneCenter(q.pos, s.radius, null);
    q.zone = { lat: +c.lat.toFixed(7), lng: +c.lng.toFixed(7), r: s.radius, at: now };
    q.zoneIdx = i;
  });
  event(g, `🔍 La chasse commence ! ${tr.length} zones de ${s.radius} m sont apparues`, 'hunt');
}

function shrinkZones(g, now) {
  g.zoneStep++;
  const r = radiusAt(g.settings, g.zoneStep, g.zoneSteps);
  for (const p of treasures(g)) {
    if (!p.zone || !p.pos) continue;
    const c = makeZoneCenter(p.pos, r, p.zone);
    p.zone = { lat: +c.lat.toFixed(7), lng: +c.lng.toFixed(7), r, at: now };
    p.outSince = null;
    p.out = false;
  }
  g.nextZoneAt = g.zoneStep < g.zoneSteps ? g.huntAt + (g.zoneStep + 1) * g.settings.zoneInterval * 60000 : null;
  event(g, g.nextZoneAt ? `🔄 Les zones rétrécissent : rayon ${r} m` : `🔄 Zones finales : rayon ${r} m`, 'zone');
}

function update(g, now) {
  if (g.status !== 'running') return;
  if (g.phase === 'hide') {
    if (now >= g.hideEndAt) beginHunt(g, now);
    else return;
  }
  if (g.nextZoneAt && now >= g.nextZoneAt) shrinkZones(g, now);

  for (const p of treasures(g)) {
    // Trésor sans GPS : révélé à sa dernière position (impossible de se rendre incapturable)
    const off = !fresh(p, now, OFFLINE_MS);
    if (off && !p.offline) event(g, `📡 ${p.name} n'envoie plus sa position : dernière position révélée !`, 'reveal');
    p.offline = off;
    // Trésor hors de sa zone : révélé après le délai de grâce
    if (!p.pos || !p.zone || dist(p.pos, p.zone) <= p.zone.r) { p.outSince = null; p.out = false; continue; }
    if (!p.outSince) p.outSince = now;
    const was = p.out;
    p.out = now - p.outSince >= g.settings.grace * 1000;
    if (p.out && !was) event(g, `📍 ${p.name} est sorti de sa zone : position révélée !`, 'reveal');
  }

  if (!treasures(g).length) endGame(g, 'chercheurs', now);
  else if (now >= g.endAt) endGame(g, 'tresors', now);
}

function canSee(me, q, status) {
  if (me === q) return true;
  if (status === 'ended') return true;
  if (status === 'lobby') return false;                         // au salon : chacun ne voit que soi
  if (q.role === 'tresor' && q.offline) return false;          // garde la zone, masque la dernière position
  if (me.role === 'elimine') return true;
  if (q.role === me.role) return true;                          // coéquipiers
  if (me.role === 'tresor' && q.role === 'chercheur') return true; // trésors : chercheurs en temps réel
  if (me.role === 'chercheur' && q.role === 'tresor') return q.out;
  return false;
}

/* Vue personnalisée : chaque joueur ne reçoit que ce qu'il a le droit de voir */
function view(g, me, now) {
  const players = [], pos = [], zones = [];
  const ended = g.status === 'ended';
  for (const p of g.players.values()) {
    const pl = {
      id: p.id, name: p.name, role: p.role, orig: p.origRole, online: p.conns.size > 0,
      gps: fresh(p, now, 120000), caps: p.captures, by: p.capturedBy, out: p.out, offline: p.offline,
    };
    if (ended) {
      pl.walked = Math.round(p.walked);
      if (p.origRole === 'tresor' && g.huntAt) pl.survived = Math.max(0, (p.capturedAt || g.endedAt) - g.huntAt);
    }
    players.push(pl);
    if (p.pos && canSee(me, p, g.status)) {
      pos.push({ id: p.id, lat: +p.pos.lat.toFixed(6), lng: +p.pos.lng.toFixed(6), acc: Math.round(p.pos.acc), stale: !fresh(p, now) });
    }
    if (g.status !== 'lobby' && p.role === 'tresor' && p.zone) {
      zones.push({ id: p.id, name: p.name, n: p.zoneIdx, lat: p.zone.lat, lng: p.zone.lng, r: p.zone.r });
    }
  }
  zones.sort((a, b) => a.n - b.n);
  return {
    status: g.status, phase: g.phase, code: g.code, hostId: g.hostId, meId: me.id, settings: g.settings,
    players, pos, zones, startAt: g.startAt, hideEndAt: g.hideEndAt, huntAt: g.huntAt, endAt: g.endAt,
    zoneStep: g.zoneStep, zoneSteps: g.zoneSteps, nextZoneAt: g.nextZoneAt,
    nextRadius: g.nextZoneAt ? radiusAt(g.settings, g.zoneStep + 1, g.zoneSteps) : null,
    outSince: me.outSince, capBlockUntil: me.capBlockUntil, winner: g.winner, events: g.events.slice(-15),
  };
}

/* Diffusion : on n'envoie que si la vue a changé (ou toutes les 15 s comme keep-alive) */
function broadcast(g, now) {
  for (const p of g.players.values()) {
    if (!p.conns.size) continue;
    const body = JSON.stringify(view(g, p, now));
    if (body === p.lastSent && now - p.lastWrite < 15000) continue;
    p.lastSent = body;
    p.lastWrite = now;
    const msg = `data: {"now":${now},"v":${body}}\n\n`;
    for (const res of p.conns) res.write(msg);
  }
}

/* ---------------------------------------------------------------- API */
function doAction(g, p, b, now) {
  const isHost = p.id === g.hostId;
  const needHost = () => { if (!isHost) fail(403, "Réservé à l'hôte"); };
  const needLobby = () => { if (g.status !== 'lobby') fail(409, 'Impossible pendant la partie'); };

  switch (b.type) {
    case 'role': { // seul l'hôte choisit les rôles
      needHost(); needLobby();
      const t = g.players.get(String(b.id || ''));
      if (!t) fail(404, 'Joueur introuvable');
      if (b.role !== 'chercheur' && b.role !== 'tresor') fail(400, 'Rôle invalide');
      if (b.role === 'tresor' && t.role !== 'tresor' && treasures(g).length >= g.settings.treasureCount) {
        fail(400, `Il y a déjà ${g.settings.treasureCount} trésors`);
      }
      t.role = t.origRole = b.role;
      return null;
    }
    case 'settings':
      needHost(); needLobby();
      g.settings = cleanSettings(g.settings, b.settings || {});
      return null;
    case 'start': {
      needHost(); needLobby();
      const s = g.settings, list = [...g.players.values()], tr = treasures(g);
      if (tr.length !== s.treasureCount) fail(400, `Il faut exactement ${s.treasureCount} trésor(s) (actuellement ${tr.length})`);
      if (!list.some((q) => q.role === 'chercheur')) fail(400, 'Il faut au moins un chercheur');
      const noGps = list.filter((q) => !fresh(q, now, 120000)).map((q) => q.name);
      if (noGps.length) fail(400, `Localisation requise — demande à ces joueurs de l’activer : ${noGps.join(', ')}`);
      list.forEach(resetPlayerForGame);
      Object.assign(g, {
        status: 'running', phase: 'hide', startAt: now, hideEndAt: now + s.hideTime * 60000,
        huntAt: 0, endAt: now + (s.hideTime + s.duration) * 60000, endedAt: 0, winner: null, events: [],
        zoneStep: 0, zoneSteps: zoneSteps(s), nextZoneAt: null,
      });
      if (s.hideTime > 0) event(g, `🙈 Les trésors ont ${s.hideTime} min pour se cacher ! Chercheurs : restez au départ.`, 'hide');
      update(g, now); // sans phase de cache, la chasse commence tout de suite
      return null;
    }
    case 'capture': {
      if (g.status !== 'running') fail(409, "La partie n'est pas en cours");
      if (g.phase !== 'hunt') fail(409, 'Les trésors se cachent encore');
      if (p.role !== 'chercheur') fail(403, 'Seuls les chercheurs peuvent capturer');
      if (now < p.capBlockUntil) {
        fail(429, `Attends encore ${Math.ceil((p.capBlockUntil - now) / 1000)} s`, { capBlockUntil: p.capBlockUntil });
      }
      if (!fresh(p, now, CAPTURE_FRESH_MS)) fail(400, 'Ta position GPS est trop ancienne : attends le signal');
      let best = null, bd = Infinity;
      for (const q of treasures(g)) {
        // toujours capturable à sa dernière position connue (même si son GPS est en retard ou coupé)
        if (!q.pos) continue;
        const d = dist(p.pos, q.pos);
        if (d < bd) { bd = d; best = q; }
      }
      const tol = best ? Math.min(CAPTURE_TOLERANCE_MAX, ((p.pos.acc || 0) + (best.pos.acc || 0)) / 2) : 0;
      if (!best || bd > g.settings.captureDist + tol) {
        p.captureFails++;
        const minutes = CAPTURE_FAIL_MINUTES[Math.min(p.captureFails - 1, CAPTURE_FAIL_MINUTES.length - 1)];
        p.capBlockUntil = now + minutes * 60000;
        return { ok: false, msg: `❌ Raté ! Pénalité : ${minutes} min (${p.captureFails}e échec)`, capBlockUntil: p.capBlockUntil };
      }
      p.capBlockUntil = now + CAPTURE_COOLDOWN_MS;
      best.role = g.settings.captureMode === 'eliminate' ? 'elimine' : 'chercheur';
      Object.assign(best, { capturedBy: p.name, capturedAt: now, out: false, outSince: null, offline: false, zone: null });
      p.captures++;
      event(g, `💰 ${p.name} a capturé ${best.name} ! (${treasures(g).length} trésor(s) restant(s))`, 'capture');
      update(g, now);
      return { ok: true, msg: `💰 Trésor capturé : ${best.name} !`, capBlockUntil: p.capBlockUntil };
    }
    case 'kick': {
      needHost();
      const t = g.players.get(String(b.id || ''));
      if (!t || t === p) fail(400, 'Joueur invalide');
      event(g, `🚪 ${t.name} a été exclu`);
      removePlayer(g, t);
      return null;
    }
    case 'reset': {
      needHost();
      if (g.status === 'lobby') return null;
      Object.assign(g, { status: 'lobby', phase: null, winner: null, nextZoneAt: null, zoneStep: 0 });
      for (const q of g.players.values()) { q.role = q.origRole; resetPlayerForGame(q); }
      event(g, '↩️ Retour au salon');
      return null;
    }
    case 'leave':
      event(g, `👋 ${p.name} est parti`);
      if (g.status === 'running' && p.role === 'tresor') {
        p.offline = true;
        if (p.pos) p.pos.t = now - OFFLINE_MS - 1;
        for (const r of p.conns) r.end();
        p.conns.clear();
        return null;
      }
      removePlayer(g, p);
      return null;
    default:
      fail(400, 'Action inconnue');
  }
  return null;
}

function trackDistance(g, p, np) {
  if (g.status !== 'running') return;
  if (!p.track) { p.track = np; return; }
  const d = dist(p.track, np), dt = Math.max(0.5, (np.t - p.track.t) / 1000);
  if (d / dt > MAX_SPEED) { p.track = np; return; }         // saut GPS : ignoré
  if (d >= Math.max(8, Math.min(np.acc, 40))) { p.walked += d; p.track = np; } // filtre le bruit GPS
}

function handleApi(name, b) {
  const now = Date.now();
  if (name === 'create') {
    if (games.size >= MAX_GAMES) fail(503, 'Serveur plein, réessaie plus tard');
    const g = {
      code: newCode(), hostId: null, players: new Map(), tokens: new Map(), settings: { ...DEFAULT_SETTINGS },
      status: 'lobby', phase: null, startAt: 0, hideEndAt: 0, huntAt: 0, endAt: 0, endedAt: 0,
      zoneStep: 0, zoneSteps: 0, nextZoneAt: null, events: [], winner: null, lastActivity: now,
    };
    games.set(g.code, g);
    const p = addPlayer(g, b.name);
    g.hostId = p.id;
    event(g, `🏴‍☠️ Partie créée par ${p.name}`);
    return { code: g.code, token: p.token, id: p.id };
  }
  if (name === 'join') {
    const g = games.get(String(b.code || '').trim().toUpperCase());
    if (!g) fail(404, 'Partie introuvable — vérifie le code');
    if (g.players.size >= MAX_PLAYERS) fail(403, 'Partie complète');
    const p = addPlayer(g, b.name);
    event(g, `👋 ${p.name} a rejoint la partie`);
    g.lastActivity = now;
    return { code: g.code, token: p.token, id: p.id };
  }

  const g = games.get(String(b.code || '').toUpperCase());
  const p = g && g.players.get(g.tokens.get(String(b.token || '')));
  if (!p) fail(404, 'Session expirée ou partie supprimée');
  g.lastActivity = now;

  if (name === 'hello') return { ok: true, id: p.id };
  if (name === 'pos') {
    const lat = +b.lat, lng = +b.lng, acc = Math.max(0, +b.acc || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) fail(400, 'Position invalide');
    if (!(p.pos && now - p.pos.t < 500)) {
      p.pos = { lat, lng, acc: Math.min(acc, 9999), t: now };
      trackDistance(g, p, p.pos);
    }
    return null;
  }
  if (name === 'action') {
    const r = doAction(g, p, b, now);
    if (games.has(g.code)) broadcast(g, Date.now());
    return r || { ok: true };
  }
  fail(404, 'Route inconnue');
  return null;
}

/* ------------------------------------------------------------ Serveur */
function send(res, status, obj) {
  if (obj == null) { res.writeHead(204); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(JSON.stringify(obj));
}

function openStream(req, res, url) {
  const g = games.get((url.searchParams.get('code') || '').toUpperCase());
  const p = g && g.players.get(g.tokens.get(url.searchParams.get('token') || ''));
  if (!p) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // désactive la mise en tampon des proxys (nginx…)
  });
  res.write('retry: 3000\n\n');
  p.conns.add(res);
  p.lastSent = '';
  req.on('close', () => p.conns.delete(res));
  return broadcast(g, Date.now());
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
function serveStatic(pathname, res) {
  let fp;
  try { fp = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname))); }
  catch { res.writeHead(400); return res.end(); }
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  return fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stream') return openStream(req, res, url);
  if (url.pathname === '/health') return send(res, 200, { ok: true, games: games.size });
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST attendu' });
    let raw = '', tooBig = false;
    req.on('data', (c) => { raw += c; if (raw.length > 16384) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      try {
        send(res, 200, handleApi(url.pathname.slice(5), raw ? JSON.parse(raw) : {}));
      } catch (e) {
        if (!e.status && !(e instanceof SyntaxError)) console.error(e);
        send(res, e.status || 400, { error: e.status ? e.message : 'Requête invalide', ...(e.extra || {}) });
      }
    });
    return undefined;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return serveStatic(url.pathname, res);
});

setInterval(() => {
  const now = Date.now();
  for (const g of [...games.values()]) {
    try {
      update(g, now);
      broadcast(g, now);
    } catch (e) { console.error('Erreur partie', g.code, e); }
    if (now - g.lastActivity > GAME_TTL_MS && ![...g.players.values()].some((p) => p.conns.size)) games.delete(g.code);
  }
}, TICK_MS);

if (require.main === module) {
  server.listen(PORT, () => console.log(`🏴‍☠️  Chasse au trésor : http://localhost:${PORT}  (test sans GPS : http://localhost:${PORT}/?sim=1)`));
}
module.exports = { makeZoneCenter, radiusAt, zoneSteps, dist, server, games, DEFAULT_SETTINGS, OFFLINE_MS };
