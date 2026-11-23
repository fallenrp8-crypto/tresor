'use strict';
/* =====================================================================
   Chasse au trésor — client
   ?sim=1 dans l'URL : mode test sans GPS (touche la carte pour te déplacer)
   ===================================================================== */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIM = params.has('sim');

/* ---------- Géo (identique au serveur) ---------- */
const EARTH = 6371000, RAD = Math.PI / 180;
function dist(a, b) {
  const x = (b.lng - a.lng) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD);
  return EARTH * Math.hypot(x, (b.lat - a.lat) * RAD);
}
function offset(p, dx, dy) {
  return { lat: p.lat + dy / EARTH / RAD, lng: p.lng + dx / (EARTH * Math.cos(p.lat * RAD)) / RAD };
}
const radiusAt = (s, step, steps) => Math.round(s.radius * Math.pow(s.finalRadius / s.radius, step / steps));
const zoneSteps = (s) => Math.max(1, Math.ceil(s.duration / s.zoneInterval) - 1);

/* ---------- Utilitaires ---------- */
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km` : `${Math.round(m)} m`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vibrate = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* ignore */ } };
function toast(msg, ms = 3200) {
  const box = $('toasts'), t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
const showErr = (e) => toast('⚠️ ' + e.message);

/* Petits sons (WebAudio, activés au premier clic de l'utilisateur) */
let audio = null;
function unlockAudio() {
  try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { audio = null; }
}
function beep(notes) {
  if (!audio || $('mute').checked) return;
  try {
    let t = audio.currentTime;
    for (const [f, d] of notes) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + d + 0.02);
      t += d * 0.9;
    }
  } catch { /* ignore */ }
}
const SOUND = {
  zone: () => { beep([[523, 0.15], [392, 0.15], [262, 0.3]]); vibrate([150, 80, 150]); },
  capture: () => { beep([[523, 0.12], [659, 0.12], [784, 0.3]]); vibrate([100, 50, 300]); },
  reveal: () => { beep([[880, 0.1], [880, 0.1], [880, 0.2]]); vibrate([80, 60, 80, 60, 80]); },
  hunt: () => { beep([[392, 0.15], [523, 0.15], [659, 0.15], [784, 0.35]]); vibrate([100, 60, 100, 60, 300]); },
  hide: () => { beep([[659, 0.15], [523, 0.3]]); },
  end: () => { beep([[784, 0.2], [659, 0.2], [784, 0.2], [1047, 0.5]]); vibrate(400); },
  tick: () => beep([[1000, 0.06]]),
  fail: () => { beep([[200, 0.25]]); vibrate(60); },
  caught: () => { beep([[400, 0.2], [300, 0.2], [200, 0.5]]); vibrate([400, 100, 400]); },
};

const ROLE = {
  chercheur: { label: 'Chercheur', icon: '🔎' },
  tresor: { label: 'Trésor', icon: '💎' },
  elimine: { label: 'Spectateur', icon: '👻' },
};
const COLORS = ['#f59e0b', '#a855f7', '#22c55e', '#ec4899', '#06b6d4', '#eab308', '#f97316', '#84cc16', '#e11d48', '#3b82f6'];
const zoneColor = (n) => COLORS[((n % COLORS.length) + COLORS.length) % COLORS.length];
const NUM_KEYS = ['treasureCount', 'hideTime', 'duration', 'radius', 'finalRadius', 'zoneInterval', 'captureDist', 'grace'];

/* ---------- État ---------- */
// En mode test (?sim=1), chaque onglet est un joueur différent (sessionStorage).
const store = SIM ? sessionStorage : localStorage;
let session = null;
try { session = JSON.parse(store.getItem('cat_session') || 'null'); } catch { session = null; }
let state = null, clockOffset = 0, es = null, lastMsgAt = 0;
let myPos = null, lastSentPos = null, sending = false, gpsWatch = null, centeredOnce = false;
let localOutSince = null, lastEventAt = 0, zonesSig = '', capLockUntil = 0, lastTickSec = -1;
const serverNow = () => Date.now() + clockOffset;
const meP = () => (state ? state.players.find((p) => p.id === state.meId) : null);
const isHost = () => !!state && state.hostId === state.meId;

/* ---------- API ---------- */
async function api(route, body) {
  const r = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { /* 204 : pas de contenu */ }
  if (!r.ok) { const e = new Error((data && data.error) || 'Erreur ' + r.status); e.status = r.status; e.data = data; throw e; }
  return data;
}
const act = (type, extra = {}) => {
  if (!session) return Promise.reject(new Error('Pas de partie'));
  return api('action', { code: session.code, token: session.token, type, ...extra });
};

/* ---------- Carte ---------- */
const map = L.map('map', { zoomControl: false }).setView([46.6, 2.4], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const zoneLayer = L.layerGroup().addTo(map);
const accCircle = L.circle([0, 0], { radius: 1, stroke: false, fillColor: '#38bdf8', fillOpacity: 0.12, interactive: false });
const capCircle = L.circle([0, 0], { radius: 1, color: '#22c55e', weight: 1.5, dashArray: '4 4', fill: false, interactive: false });
const markers = new Map();

const show = (layer, on) => {
  if (on && !map.hasLayer(layer)) layer.addTo(map);
  else if (!on && map.hasLayer(layer)) layer.remove();
};
const mkIcon = (cls, name) => L.divIcon({
  className: '', html: `<div class="${cls}"><i></i><span>${esc(name)}</span></div>`, iconSize: [18, 18], iconAnchor: [9, 9],
});
function upsertMarker(id, ll, cls, name) {
  const key = cls + '|' + name;
  let m = markers.get(id);
  if (!m) {
    m = L.marker(ll, { icon: mkIcon(cls, name), keyboard: false, interactive: false, zIndexOffset: cls.includes(' me') ? 1000 : 0 }).addTo(map);
    m.k = key;
    markers.set(id, m);
  } else {
    m.setLatLng(ll);
    if (m.k !== key) { m.setIcon(mkIcon(cls, name)); m.k = key; } // DOM recréé seulement si besoin
  }
}
function clearMap() {
  for (const m of markers.values()) m.remove();
  markers.clear();
  zoneLayer.clearLayers();
  zonesSig = '';
  $('legend').textContent = '';
  show(accCircle, false);
  show(capCircle, false);
}

/* Zones : une par trésor, redessinées seulement quand elles changent */
function renderZones(me) {
  const zones = state.status === 'lobby' ? [] : state.zones;
  const sig = JSON.stringify(zones) + me.id;
  if (sig === zonesSig) return;
  zonesSig = sig;
  zoneLayer.clearLayers();
  zones.forEach((z) => {
    const c = zoneColor(z.n), mine = z.id === me.id;
    L.circle([z.lat, z.lng], {
      radius: z.r, color: c, weight: mine ? 4 : 2.5, fillColor: c, fillOpacity: mine ? 0.12 : 0.07, interactive: false,
    }).addTo(zoneLayer);
    // étiquettes réparties autour du cercle pour éviter qu'elles se superposent
    const a = Math.PI / 2 - (z.n % 4) * (Math.PI / 2), lab = offset(z, Math.cos(a) * z.r, Math.sin(a) * z.r);
    L.marker([lab.lat, lab.lng], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="zl" style="--c:${c}">💎 ${esc(z.name)}${mine ? ' (toi)' : ''} · ${fmtDist(z.r)}</div>` }),
    }).addTo(zoneLayer);
  });
  renderLegend(me);
}
function renderLegend(me) {
  const zones = state.status === 'lobby' ? [] : state.zones;
  const lg = $('legend');
  lg.textContent = '';
  for (const z of zones) {
    const b = document.createElement('button');
    b.style.setProperty('--c', zoneColor(z.n));
    b.dataset.id = z.id;
    b.className = z.id === me.id ? 'mine' : '';
    b.textContent = `💎 ${z.name} · ${fmtDist(z.r)}`;
    b.title = `Zone de ${z.name} (📍 = tu es dedans). Touche pour zoomer.`;
    b.onclick = () => map.fitBounds(L.latLng(z.lat, z.lng).toBounds(z.r * 2.2));
    lg.appendChild(b);
  }
  markInside();
}
// Indique dans quelles zones je me trouve (aide à fouiller, sans donner d'indice sur les trésors)
function markInside() {
  if (!state) return;
  for (const b of $('legend').children) {
    const z = state.zones.find((x) => x.id === b.dataset.id);
    b.classList.toggle('inside', !!(z && myPos && dist(myPos, z) <= z.r));
  }
}
function fitZones() {
  const zones = state && state.status !== 'lobby' ? state.zones : [];
  if (!zones.length) { if (myPos) map.setView([myPos.lat, myPos.lng], 16); return; }
  let b = null;
  for (const z of zones) {
    const zb = L.latLng(z.lat, z.lng).toBounds(z.r * 2);
    b = b ? b.extend(zb) : zb;
  }
  map.fitBounds(b, { padding: [20, 20] });
}

function drawMe() {
  const me = meP();
  if (!me || !myPos) return;
  const ll = [myPos.lat, myPos.lng];
  upsertMarker(me.id, ll, `mk ${me.role} me`, me.name);
  accCircle.setLatLng(ll).setRadius(Math.max(myPos.acc || 0, 1));
  show(accCircle, true);
  const cap = state.status === 'running' && state.phase === 'hunt' && me.role === 'chercheur';
  if (cap) capCircle.setLatLng(ll).setRadius(state.settings.captureDist);
  show(capCircle, cap);
  markInside();
}

function renderMarkers(me) {
  const seen = new Set();
  const byId = new Map(state.players.map((p) => [p.id, p]));
  for (const q of state.pos) {
    const p = byId.get(q.id);
    if (!p) continue;
    seen.add(q.id);
    if (q.id === me.id && myPos) continue; // ma position locale est plus réactive
    const rev = state.status === 'running' && (p.out || p.offline) && p.role !== me.role;
    const cls = `mk ${p.role}${q.id === me.id ? ' me' : ''}${q.stale ? ' stale' : ''}${rev ? ' revealed' : ''}`;
    upsertMarker(q.id, [q.lat, q.lng], cls, p.name + (rev && p.offline ? ' 📡' : ''));
  }
  if (myPos) { seen.add(me.id); drawMe(); }
  for (const [id, m] of markers) if (!seen.has(id)) { m.remove(); markers.delete(id); }
}

/* ---------- Rendu ---------- */
function onState(msg) {
  lastMsgAt = Date.now();
  clockOffset = msg.now - Date.now();
  const prev = state;
  state = msg.v;
  const me = meP();
  if (!me) return;

  const prevMe = prev && prev.players.find((p) => p.id === me.id);
  if (prev && prev.status === 'running' && prevMe && prevMe.role === 'tresor' && me.role !== 'tresor') {
    SOUND.caught();
    toast('😱 Tu as été capturé !', 5000);
  }
  if (!prev || prev.status !== state.status || prev.phase !== state.phase) {
    localOutSince = null;
    if (state.status === 'running' && state.phase === 'hunt') fitZones();
  }

  $('home').classList.add('hidden');
  $('lobby').classList.toggle('hidden', state.status !== 'lobby');
  $('hud').classList.toggle('hidden', state.status !== 'running');
  $('end').classList.toggle('hidden', state.status !== 'ended');

  renderZones(me);
  if (state.status === 'lobby') renderLobby(me);
  if (state.status === 'running') renderHud(me);
  if (state.status === 'ended') renderEnd(me);
  renderMarkers(me);
  renderFeed(!!prev);
}

function renderLobby(me) {
  const host = isHost(), s = state.settings;
  $('lobbyCode').textContent = state.code;

  const ul = $('playerList');
  ul.textContent = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${p.online ? 'on' : ''}"></span>
      <span class="pname">${esc(p.name)}${p.id === state.hostId ? ' 👑' : ''}${p.id === me.id ? ' <span class="muted">(toi)</span>' : ''}
      ${p.gps ? '' : '<span class="nogps">📡 pas de GPS</span>'}</span>
      <span class="tag ${p.role}">${ROLE[p.role].icon} ${ROLE[p.role].label}</span>`;
    if (host) {
      const rt = document.createElement('button');
      rt.className = 'rt' + (p.role === 'tresor' ? ' on' : '');
      rt.textContent = p.role === 'tresor' ? '🔎' : '💎';
      rt.title = p.role === 'tresor' ? 'Mettre chercheur' : 'Mettre trésor';
      rt.setAttribute('aria-label', `${p.name} : ${rt.title}`);
      rt.onclick = () => act('role', { id: p.id, role: p.role === 'tresor' ? 'chercheur' : 'tresor' }).catch(showErr);
      li.appendChild(rt);
      if (p.id !== me.id) {
        const k = document.createElement('button');
        k.textContent = '✕';
        k.title = 'Exclure';
        k.setAttribute('aria-label', `Exclure ${p.name}`);
        k.onclick = () => { if (confirm(`Exclure ${p.name} ?`)) act('kick', { id: p.id }).catch(showErr); };
        li.appendChild(k);
      }
    }
    ul.appendChild(li);
  }
  const tr = state.players.filter((p) => p.role === 'tresor');
  const nT = tr.length, nC = state.players.filter((p) => p.role === 'chercheur').length;
  $('counts').textContent = `· ${nT}/${s.treasureCount} 💎 · ${nC} 🔎`;
  $('roleHelp').textContent = host
    ? `Touche 💎 à côté d'un joueur pour en faire un trésor (${s.treasureCount} requis).`
    : `L'hôte choisit les rôles. Tu es : ${ROLE[me.role].icon} ${ROLE[me.role].label}.`;

  for (const k of NUM_KEYS) {
    const el = $('s_' + k);
    el.disabled = !host;
    if (document.activeElement !== el) el.value = s[k];
  }
  $('s_captureMode').disabled = !host;
  $('s_captureMode').value = s.captureMode;

  const steps = zoneSteps(s), radii = [];
  for (let i = 0; i <= steps; i++) radii.push(fmtDist(radiusAt(s, i, steps)));
  $('schedule').textContent = `${s.hideTime ? `${s.hideTime} min pour se cacher, puis ` : ''}zones de ${radii.join(' → ')} `
    + `(toutes les ${s.zoneInterval} min, chasse de ${s.duration} min).`;

  document.querySelectorAll('.host-only').forEach((e) => e.classList.toggle('hidden', !host));
  $('waitInfo').classList.toggle('hidden', host);
  const missingGps = state.players.filter((p) => !p.gps).map((p) => p.name);
  let why = '';
  if (nT !== s.treasureCount) why = `Il faut ${s.treasureCount} trésor(s) (${nT} choisi(s))`;
  else if (nC < 1) why = 'Il faut au moins 1 chercheur';
  else if (missingGps.length) why = `Localisation requise — demande à ces joueurs de l’activer : ${missingGps.join(', ')}`;
  $('btnStart').disabled = !!why;
  $('btnStart').textContent = why || '🚀 Lancer la partie';
}

function renderHud(me) {
  $('roleBadge').className = 'badge ' + me.role;
  $('roleBadge').textContent = `${ROLE[me.role].icon} ${ROLE[me.role].label}`;
  $('btnCapture').classList.toggle('hidden', me.role !== 'chercheur');
  if (state.capBlockUntil) capLockUntil = Math.max(capLockUntil, state.capBlockUntil - clockOffset);
  hudTick();
}

function hudTick() {
  const me = meP();
  if (!me || state.status !== 'running') return;
  const now = serverNow(), hiding = state.phase === 'hide';
  const zi = $('zoneInfo'), w = $('warn');
  let txt = null, soft = false, banner = null;

  if (hiding) {
    const left = state.hideEndAt - now;
    $('timer').textContent = '🙈 ' + fmt(left);
    zi.textContent = 'Phase de cache';
    zi.classList.remove('alert');
    banner = me.role === 'tresor'
      ? `🏃 Cache-toi ! Ta zone sera créée autour de toi dans ${fmt(left)}`
      : `🙈 Les trésors se cachent… Reste au point de départ ! Chasse dans ${fmt(left)}`;
    tickCountdown(left);
  } else {
    $('timer').textContent = '⏱ ' + fmt(state.endAt - now);
    const left = state.nextZoneAt ? state.nextZoneAt - now : null;
    zi.textContent = left !== null ? `🔄 ${fmtDist(state.nextRadius)} dans ${fmt(left)}` : '⭕ Zones finales';
    zi.classList.toggle('alert', left !== null && left < 60000);
    if (left !== null) tickCountdown(left);
  }
  $('phase').classList.toggle('hidden', !banner);
  if (banner) $('phase').textContent = banner;

  // Bouton capturer : bloqué pendant la cache et pendant la pénalité
  const cap = $('btnCapture');
  const wait = capLockUntil - Date.now();
  cap.disabled = hiding || wait > 0;
  cap.classList.toggle('ready', !cap.disabled);
  cap.textContent = hiding ? 'CAPTURER 🔒' : wait > 0 ? `CAPTURER (${fmt(wait)})` : 'CAPTURER';

  // Trésor : alerte s'il sort (ou s'approche du bord) de sa zone, ou si son GPS ne part plus
  const z = !hiding && me.role === 'tresor' && state.zones.find((x) => x.id === me.id);
  if (z && myPos) {
    const outBy = dist(myPos, z) - z.r;
    if (outBy > 0) {
      if (!localOutSince) { localOutSince = Date.now(); vibrate([200, 100, 200]); }
      const since = state.outSince ? now - state.outSince : Date.now() - localOutSince;
      const rest = state.settings.grace * 1000 - since;
      txt = rest > 0 && !me.out
        ? `⚠️ HORS DE TA ZONE (${fmtDist(outBy)}) — révélé dans ${Math.ceil(rest / 1000)} s`
        : `🚨 HORS ZONE : les chercheurs te voient ! Rentre (${fmtDist(outBy)})`;
    } else {
      localOutSince = null;
      if (-outBy < Math.min(60, z.r * 0.1)) { txt = `↩️ Bord de ta zone à ${fmtDist(-outBy)}`; soft = true; }
    }
  }
  if (!txt && me.role === 'tresor' && !SIM) {
    const age = lastSentPos ? Date.now() - lastSentPos.t : Infinity;
    if (me.offline) txt = '🚨 Ton GPS ne répond plus : les chercheurs voient ta dernière position !';
    else if (age > 45000) { txt = '📡 Ta position n’est plus envoyée : garde l’écran allumé et l’appli ouverte'; soft = true; }
  }
  w.classList.toggle('hidden', !txt);
  w.classList.toggle('soft', soft);
  if (txt) w.textContent = txt;
}
// Bips des 10 dernières secondes avant un changement de zone ou la fin de la cache
function tickCountdown(left) {
  const sec = Math.ceil(left / 1000);
  if (sec !== lastTickSec && sec > 0 && sec <= 10) { SOUND.tick(); if (sec <= 3) vibrate(40); }
  lastTickSec = sec;
}

function renderEnd(me) {
  const won = (state.winner === 'tresors') === (me.orig === 'tresor');
  $('endTitle').textContent = state.winner === 'tresors' ? '💎 Les trésors ont survécu !' : '🔎 Tous les trésors ont été trouvés !';
  $('endSub').textContent = won ? '🎉 Victoire de ton équipe !' : '😤 Défaite… revanche ?';
  const ul = $('endStats');
  ul.textContent = '';
  const ps = [...state.players];
  const best = (f) => ps.reduce((a, b) => ((f(b) || 0) > (f(a) || 0) ? b : a), ps[0]);
  const hunter = best((p) => p.caps), walker = best((p) => p.walked);
  const awards = [];
  if (hunter && hunter.caps) awards.push(`🏹 Meilleur chasseur : ${hunter.name} (${hunter.caps})`);
  if (walker && walker.walked) awards.push(`👟 Marathonien : ${walker.name} (${fmtDist(walker.walked)})`);
  $('awards').innerHTML = awards.map((a) => `<div>${esc(a)}</div>`).join('');
  ps.sort((a, b) => b.caps - a.caps || (b.survived || 0) - (a.survived || 0)).forEach((p) => {
    const li = document.createElement('li');
    let t = `${ROLE[p.orig].icon} ${p.name}`;
    const bits = [];
    if (p.caps) bits.push(`${p.caps} capture(s)`);
    if (p.orig === 'tresor') bits.push(p.by ? `capturé par ${p.by} après ${fmt(p.survived || 0)}` : 'a survécu 🛡️');
    if (p.walked) bits.push(`${fmtDist(p.walked)} parcourus`);
    if (bits.length) t += ' — ' + bits.join(' · ');
    li.textContent = t;
    ul.appendChild(li);
  });
  $('btnReplay').classList.toggle('hidden', !isHost());
}

function renderFeed(notify) {
  const ev = state.events || [];
  $('feedList').innerHTML = ev.slice().reverse()
    .map((e) => `<div><time>${new Date(e.at - clockOffset).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</time>${esc(e.msg)}</div>`)
    .join('') || '<div class="muted">Aucun événement</div>';
  if (notify) {
    for (const e of ev) {
      if (e.at <= lastEventAt) continue;
      toast(e.msg);
      if (SOUND[e.kind]) SOUND[e.kind]();
    }
  }
  if (ev.length) lastEventAt = Math.max(lastEventAt, ev[ev.length - 1].at);
}

/* ---------- GPS ---------- */
function gpsBanner(msg) { $('gps').textContent = msg || ''; $('gps').classList.toggle('hidden', !msg); }
function startGPS() {
  if (gpsWatch !== null) return;
  if (SIM) { gpsWatch = 'sim'; gpsBanner('🧪 Mode test : touche la carte pour déplacer ton joueur'); return; }
  if (!window.isSecureContext) { gpsBanner('⚠️ Le GPS nécessite HTTPS — héberge le site en https://'); return; }
  if (!navigator.geolocation) { gpsBanner('⚠️ Géolocalisation non supportée par ce navigateur'); return; }
  gpsBanner('📡 Recherche du signal GPS…');
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => setMyPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    (e) => gpsBanner(e.code === 1 ? '⛔ Localisation refusée : autorise-la dans les réglages du navigateur' : '📡 Signal GPS faible…'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}
function setMyPos(lat, lng, acc) {
  myPos = { lat, lng, acc };
  if (!SIM) gpsBanner(acc > 60 ? `📡 Précision GPS faible (±${Math.round(acc)} m)` : null);
  if (!centeredOnce && !(state && state.status === 'running')) { map.setView([lat, lng], 16); centeredOnce = true; }
  if (state) drawMe();
  else { accCircle.setLatLng([lat, lng]).setRadius(Math.max(acc, 1)); show(accCircle, true); }
  sendPos();
}
// Envoi optimisé : si on a bougé de 4 m (max toutes les 1,5 s) + un battement toutes les 8 s
function sendPos(force) {
  if (!session || !myPos || sending) return;
  const now = Date.now();
  const dt = lastSentPos ? now - lastSentPos.t : Infinity;
  const moved = lastSentPos ? dist(lastSentPos, myPos) : Infinity;
  if (!force && (dt < 1500 || (moved < 4 && dt < 8000))) return;
  sending = true;
  const p = { ...myPos }, s = session;
  api('pos', { code: s.code, token: s.token, lat: p.lat, lng: p.lng, acc: p.acc })
    .then(() => { lastSentPos = { ...p, t: now }; })
    .catch((e) => { if (e.status === 404 && session === s) logout('Cette partie n’existe plus.'); })
    .finally(() => { sending = false; });
}
setInterval(() => sendPos(), 2000);

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* non supporté */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  sendPos(true);
  if (session && Date.now() - lastMsgAt > 20000) connect(true); // la connexion a pu mourir pendant la veille
});

/* ---------- Connexion temps réel ---------- */
let connecting = false;
async function connect(forceNew) {
  if (!session || connecting) return;
  if (forceNew && es) { es.close(); es = null; }
  connecting = true;
  startGPS();
  keepAwake();
  const s = session;
  try {
    await api('hello', { code: s.code, token: s.token });
  } catch (e) {
    connecting = false;
    if (session !== s) return;
    if (e.status === 404) { logout('Cette partie n’existe plus.'); return; }
    setTimeout(connect, 3000);
    return;
  }
  connecting = false;
  if (session !== s) return;
  if (es) es.close();
  lastMsgAt = Date.now();
  const src = new EventSource(`/api/stream?code=${encodeURIComponent(s.code)}&token=${encodeURIComponent(s.token)}`);
  es = src;
  src.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  src.onerror = () => {
    if (es === src && src.readyState === EventSource.CLOSED) { es = null; setTimeout(connect, 2000); }
  };
}
// Surveillance : le serveur envoie au moins un message toutes les 15 s ; sinon on se reconnecte
setInterval(() => {
  if (session && es && Date.now() - lastMsgAt > 25000) { $('net').classList.remove('hidden'); connect(true); }
  else $('net').classList.add('hidden');
}, 5000);

function logout(msg) {
  if (es) { es.close(); es = null; }
  session = null;
  state = null;
  lastEventAt = 0;
  store.removeItem('cat_session');
  clearMap();
  ['lobby', 'hud', 'end'].forEach((id) => $(id).classList.add('hidden'));
  $('home').classList.remove('hidden');
  $('homeErr').textContent = msg || '';
  if (myPos) { accCircle.setLatLng([myPos.lat, myPos.lng]); show(accCircle, true); }
}

/* ---------- Boutons ---------- */
document.addEventListener('pointerdown', unlockAudio, { once: false, passive: true });
try { $('mute').checked = localStorage.getItem('cat_mute') === '1'; } catch { /* ignore */ }
$('mute').addEventListener('change', () => { try { localStorage.setItem('cat_mute', $('mute').checked ? '1' : '0'); } catch { /* ignore */ } });
try { $('name').value = localStorage.getItem('cat_name') || ''; } catch { /* ignore */ }
if (params.get('code')) $('joinCode').value = params.get('code').toUpperCase().slice(0, 4);
async function enter(kind) {
  const name = $('name').value.trim();
  if (!name) { $('homeErr').textContent = 'Choisis un pseudo 🙂'; $('name').focus(); return; }
  if (kind === 'join' && $('joinCode').value.trim().length !== 4) { $('homeErr').textContent = 'Le code fait 4 lettres'; return; }
  try { localStorage.setItem('cat_name', name); } catch { /* ignore */ }
  unlockAudio();
  startGPS(); // demandé pendant le clic : meilleure compatibilité mobile
  try {
    const r = await api(kind, { name, code: $('joinCode').value });
    session = { code: r.code, token: r.token, id: r.id };
    store.setItem('cat_session', JSON.stringify(session));
    history.replaceState(null, '', location.pathname + (SIM ? '?sim=1' : ''));
    $('homeErr').textContent = '';
    lastSentPos = null;
    connect();
    sendPos(true);
  } catch (e) { $('homeErr').textContent = e.message; }
}
$('btnCreate').onclick = () => enter('create');
$('btnJoin').onclick = () => enter('join');
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter('join'); });
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter($('joinCode').value.trim() ? 'join' : 'create'); });

$('lobbyGrip').onclick = () => $('lobby').classList.toggle('collapsed');
for (const k of NUM_KEYS) {
  $('s_' + k).addEventListener('change', (e) => act('settings', { settings: { [k]: e.target.value } }).catch(showErr));
}
$('s_captureMode').addEventListener('change', (e) => act('settings', { settings: { captureMode: e.target.value } }).catch(showErr));
$('btnStart').onclick = () => act('start').catch(showErr);
$('btnShare').onclick = async () => {
  const url = `${location.origin}/?code=${state.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Chasse au trésor', text: `Rejoins ma chasse au trésor ! Code : ${state.code}`, url });
    else { await navigator.clipboard.writeText(url); toast('🔗 Lien copié !'); }
  } catch { toast(`Code de la partie : ${state.code}`); }
};
const leave = async () => {
  if (!session || !confirm('Quitter la partie ?')) return;
  const leavingSession = session;
  try {
    await api('action', { code: leavingSession.code, token: leavingSession.token, type: 'leave' });
  } catch (e) {
    showErr(e);
    return;
  }
  if (session === leavingSession) logout('Tu as quitté la partie.');
};
$('btnLeave').onclick = leave;
$('btnLeave2').onclick = leave;
$('btnQuit').onclick = leave;
$('btnReplay').onclick = () => act('reset').catch(showErr);
$('btnFeed').onclick = () => $('feed').classList.toggle('hidden');
$('btnMe').onclick = () => {
  if (myPos) map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 17));
  else toast('📡 Pas encore de position GPS');
};
$('btnZone').onclick = fitZones;
$('btnCapture').onclick = () => {
      capLockUntil = Date.now() + 3000; // bloque immédiatement, le serveur précise ensuite la pénalité
  hudTick();
  act('capture')
    .then((r) => {
      capLockUntil = r.capBlockUntil ? r.capBlockUntil - clockOffset : capLockUntil;
      toast(r.msg);
      if (!r.ok) SOUND.fail();
    })
    .catch((e) => {
      if (e.data && e.data.capBlockUntil) capLockUntil = e.data.capBlockUntil - clockOffset;
      else capLockUntil = 0;
      showErr(e);
    })
    .finally(hudTick);
};

map.on('click', (e) => { if (SIM) setMyPos(e.latlng.lat, e.latlng.lng, 5); });

// Chronos mis à jour 4 fois par seconde (calculés localement, synchronisés sur le serveur)
setInterval(() => { if (state && state.status === 'running') hudTick(); }, 250);

/* ---------- Démarrage ---------- */
if (session) connect();
else if (SIM) startGPS();
