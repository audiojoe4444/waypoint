/* Waypoint — walking navigation for Meta Ray-Ban Display.
 *
 * Input:  the Neural Band / touchpad send ArrowUp/Down/Left/Right + Enter.
 * Back:   the glasses call history.back(), so every screen is a history entry.
 * Location comes from the paired phone via navigator.geolocation.
 *
 * Providers:
 *   Free (default)  search = Photon (komoot, OpenStreetMap)   routing = Valhalla (FOSSGIS)
 *   Mapbox (token)  search = Mapbox Search Box                routing = Mapbox Directions
 *
 * Add ?demo to the URL to simulate walking the route (great for testing on a laptop).
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ config
  const CFG = Object.assign({
    MAPBOX_TOKEN: '', UNITS: 'metric', LANGUAGE: 'en-GB', VOICE: true,
    OFF_ROUTE_METRES: 30, ARRIVE_METRES: 20,
  }, window.WAYPOINT_CONFIG || {});

  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const USE_MAPBOX = /^pk\./.test((CFG.MAPBOX_TOKEN || '').trim());
  const TOKEN = (CFG.MAPBOX_TOKEN || '').trim();

  const ZOOMS = [0.5, 1, 2, 4];          // metres per CSS pixel on the mini map
  const FAR_ANNOUNCE = 60;               // "In 60 metres, turn left…"
  const NEAR_ANNOUNCE = 15;              // "Turn left…"

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lcFirst = (s) => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  const trimDot = (s) => String(s || '').trim().replace(/\.$/, '');

  const store = {
    get(k, d) { try { const v = localStorage.getItem('wp.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) {
      try { localStorage.setItem('wp.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
      if (Backup.KEYS.includes(k)) Backup.changed();
    },
  };

  // ------------------------------------------------------------------ backup to your GitHub
  // Glasses software updates can wipe a web app's saved data. Like GlassCast,
  // Waypoint keeps an encrypted copy in a private gist in your own GitHub
  // account and restores it automatically.
  //  · Key: ?sync=YOUR-GITHUB-TOKEN (classic token, "gist" permission only) on
  //    the app address in the Meta AI app. Never stored in the code or repo.
  //  · Encryption: PBKDF2-SHA256 (150k) over the token → AES-GCM-256.
  //  · One gist per app: file "waypoint-backup.json".
  const Backup = {
    KEYS: ['favs', 'recents', 'sound', 'ttsKey', 'ttsVoice', 'mapMode', 'pairCode'],
    FILE: 'waypoint-backup.json',
    API: 'https://api.github.com',
    token: (() => {
      const q = new URLSearchParams(location.search).get('sync');
      const h = new URLSearchParams(location.hash.replace(/^#/, '')).get('sync');
      return (q || h || '').trim();
    })(),
    status: 'off',      // off | checking | ok | offline | badkey | otherkey | error
    savedAt: 0,
    timer: null,
    busy: false,
    pending: false,
    blocked: false,     // a backup made with a different key exists: never overwrite it

    enabled() { return !!Backup.token && !DEMO; },
    headers() {
      return { Authorization: 'Bearer ' + Backup.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    },

    setStatus(s) {
      Backup.status = s;
      if (typeof renderLocInfo === 'function' && current === 'loc') renderLocInfo();
    },
    label() {
      switch (Backup.status) {
        case 'off': return 'Off (add ?sync= to the address)';
        case 'checking': return 'Checking…';
        case 'ok': return 'Backed up · ' + (Backup.savedAt ? fmtClock(new Date(Backup.savedAt)) : 'just now');
        case 'offline': return 'Waiting for a connection';
        case 'badkey': return 'Key not accepted by GitHub';
        case 'otherkey': return 'Backup made with a different key';
        default: return 'Problem saving — will retry';
      }
    },

    // ---- crypto
    b64(buf) { let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); },
    unb64(str) { const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
    async aesKey(salt) {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(Backup.token), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
    async encrypt(obj) {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await Backup.aesKey(salt);
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
      return { app: 'waypoint', v: 1, salt: Backup.b64(salt), iv: Backup.b64(iv), data: Backup.b64(data) };
    },
    async decrypt(file) {
      const key = await Backup.aesKey(Backup.unb64(file.salt));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Backup.unb64(file.iv) }, key, Backup.unb64(file.data));
      return JSON.parse(new TextDecoder().decode(plain));
    },

    // ---- GitHub
    async gh(path, opts = {}) {
      let res;
      try { res = await fetch(Backup.API + path, Object.assign({ headers: Backup.headers(), cache: 'no-store' }, opts)); }
      catch (e) { const err = new Error('offline'); err.kind = 'offline'; throw err; }
      if (res.status === 401 || res.status === 403) { const err = new Error('badkey'); err.kind = 'badkey'; throw err; }
      if (res.status === 404) { const err = new Error('missing'); err.kind = 'missing'; throw err; }
      if (!res.ok) { const err = new Error('HTTP ' + res.status); err.kind = 'error'; throw err; }
      return res.json();
    },
    async findGist() {
      const cached = store.get('backupGist', null);
      if (cached) {
        try { return await Backup.gh('/gists/' + cached); }
        catch (e) { if (e.kind !== 'missing') throw e; localStorage.removeItem('wp.backupGist'); }
      }
      for (let page = 1; page <= 10; page++) {
        const list = await Backup.gh('/gists?per_page=100&page=' + page);
        const hit = list.find((g) => g.files && g.files[Backup.FILE]);
        if (hit) { store.set('backupGist', hit.id); return Backup.gh('/gists/' + hit.id); }
        if (list.length < 100) break;
      }
      return null;
    },
    async readFile(gist) {
      const f = gist.files[Backup.FILE];
      if (!f) return null;
      const text = f.truncated && f.raw_url ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
      return JSON.parse(text);
    },

    snapshot() {
      const items = {};
      Backup.KEYS.forEach((k) => { const raw = localStorage.getItem('wp.' + k); if (raw != null) items[k] = JSON.parse(raw); });
      return { savedAt: store.get('localSavedAt', 0) || Date.now(), items };
    },
    // "Empty" = none of your own data yet (an automatic pairing code doesn't count).
    localIsEmpty() { return !Backup.KEYS.filter((k) => k !== 'pairCode').some((k) => localStorage.getItem('wp.' + k) != null); },
    placesIn(items) { return ((items && items.favs) || []).length + ((items && items.recents) || []).length; },
    remotePlaces: 0,

    // ---- launch: restore if this device is empty or the backup is newer
    async start() {
      if (!Backup.enabled()) { Backup.setStatus('off'); return; }
      Backup.setStatus('checking');
      try {
        const gist = await Backup.findGist();
        if (!gist) { await Backup.save(true); return; }       // first run: create it
        const file = await Backup.readFile(gist);
        let data;
        try { data = await Backup.decrypt(file); }
        catch { Backup.blocked = true; Backup.setStatus('otherkey'); return; }
        Backup.savedAt = data.savedAt || 0;
        Backup.remotePlaces = Backup.placesIn(data.items);
        const localAt = store.get('localSavedAt', 0);
        if (Backup.localIsEmpty() || (data.savedAt || 0) > localAt) {
          Object.entries(data.items || {}).forEach(([k, v]) => {
            if (Backup.KEYS.includes(k)) try { localStorage.setItem('wp.' + k, JSON.stringify(v)); } catch { /* ignore */ }
          });
          localStorage.setItem('wp.localSavedAt', JSON.stringify(data.savedAt || Date.now()));
          try { sessionStorage.setItem('wp.restored', '1'); } catch { /* ignore */ }
          location.reload();                                    // start fresh with the restored data
          return;
        }
        if (localAt > (data.savedAt || 0)) await Backup.save(true); else Backup.setStatus('ok');
      } catch (e) {
        Backup.setStatus(e.kind === 'badkey' ? 'badkey' : e.kind === 'offline' ? 'offline' : 'error');
        if (e.kind === 'offline') setTimeout(Backup.start, 60000);
      }
    },

    changed() {
      try { localStorage.setItem('wp.localSavedAt', JSON.stringify(Date.now())); } catch { /* ignore */ }
      if (!Backup.enabled()) return;
      clearTimeout(Backup.timer);
      Backup.timer = setTimeout(() => Backup.save(), 3000);
    },

    async save(force = false, keepalive = false) {
      if (!Backup.enabled() || Backup.blocked) return;
      if (Backup.busy) { Backup.pending = true; return; }
      Backup.busy = true;
      try {
        const snap = Backup.snapshot();
        if (!force && snap.savedAt <= Backup.savedAt) { Backup.setStatus('ok'); return; }
        // Safety net: never replace a backup that has places with a device that has
        // never had any (e.g. just wiped). Deliberately clearing them still saves.
        if (Backup.remotePlaces > 0 && snap.items.favs === undefined && snap.items.recents === undefined) { Backup.setStatus('ok'); return; }
        const body = JSON.stringify({ description: 'Waypoint backup (encrypted)', files: { [Backup.FILE]: { content: JSON.stringify(await Backup.encrypt(snap)) } } });
        const id = store.get('backupGist', null);
        const opts = { method: id ? 'PATCH' : 'POST', body: id ? body : JSON.stringify(Object.assign(JSON.parse(body), { public: false })), keepalive };
        let gist;
        try { gist = await Backup.gh(id ? '/gists/' + id : '/gists', opts); }
        catch (e) {
          if (e.kind !== 'missing' || !id) throw e;
          localStorage.removeItem('wp.backupGist');              // gist deleted on GitHub: make a new one
          gist = await Backup.gh('/gists', { method: 'POST', body: JSON.stringify(Object.assign(JSON.parse(body), { public: false })) });
        }
        if (gist && gist.id) store.set('backupGist', gist.id);
        Backup.savedAt = snap.savedAt;
        Backup.remotePlaces = Backup.placesIn(snap.items);
        Backup.setStatus('ok');
      } catch (e) {
        Backup.setStatus(e.kind === 'badkey' ? 'badkey' : e.kind === 'offline' ? 'offline' : 'error');
        if (e.kind !== 'badkey') { clearTimeout(Backup.timer); Backup.timer = setTimeout(() => Backup.save(), 60000); }
      } finally {
        Backup.busy = false;
        if (Backup.pending) { Backup.pending = false; Backup.save(); }
      }
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && Backup.enabled() && store.get('localSavedAt', 0) > Backup.savedAt) Backup.save(false, true);
  });

  async function fetchJSON(url, opts = {}, timeout = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
      let body = null;
      try { body = await res.json(); } catch { /* not json */ }
      if (!res.ok) {
        const msg = (body && (body.error || body.message)) || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return body;
    } finally { clearTimeout(t); }
  }

  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const el = $('toast');
    el.classList.toggle('on-nav', current === 'nav');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ------------------------------------------------------------------ geo math
  const EARTH = 6371008.8;
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;

  function haversine(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  // Flat metres (east, north) relative to ref — accurate enough at walking scale.
  function project(p, ref) {
    return [rad(p[1] - ref[1]) * Math.cos(rad(ref[0])) * EARTH, rad(p[0] - ref[0]) * EARTH];
  }
  function decodePolyline(str, precision = 6) {
    const factor = 10 ** precision, out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let shift = 0, result = 0, b;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = (result & 1) ? ~(result >> 1) : (result >> 1);
        if (which === 0) lat += d; else lon += d;
      }
      out.push([lat / factor, lon / factor]);
    }
    return out;
  }
  function angleLerp(a, b, t) {
    const d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }

  // ------------------------------------------------------------------ formatting
  function fmtDist(m) {
    m = Math.max(0, m);
    if (CFG.UNITS === 'imperial') {
      const yd = m * 1.09361;
      if (yd < 300) return Math.max(10, Math.round(yd / 10) * 10) + ' yd';
      const mi = m / 1609.344;
      return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
    }
    if (m < 1000) return (m < 100 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 10) * 10) + ' m';
    const km = m / 1000;
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
  }
  function spokenDist(m) {
    return fmtDist(m)
      .replace(/ m$/, ' metres').replace(/ km$/, ' kilometres')
      .replace(/ yd$/, ' yards').replace(/ mi$/, ' miles');
  }
  function fmtDur(s) {
    const min = Math.max(1, Math.round(s / 60));
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60), mm = min % 60;
    return h + ' h' + (mm ? ' ' + mm : '');
  }
  function fmtClock(d) {
    try { return d.toLocaleTimeString(CFG.LANGUAGE, { hour: '2-digit', minute: '2-digit' }); }
    catch { return d.toTimeString().slice(0, 5); }
  }

  // ------------------------------------------------------------------ location
  // The glasses' location comes from the phone and can be flaky to start:
  // a request may be refused or go silent even when permission is fine, and a
  // fresh request then works. So Waypoint looks after itself: it asks once,
  // then keeps one watch running and quietly restarts it (with back-off)
  // whenever it errors or goes quiet. The user never has to press Try again.
  const Loc = {
    last: null,        // best glasses fix {lat, lon, accuracy, heading, speed, t, src}
    phone: null,       // last location reported by the phone page
    lastFixAt: 0,
    watchId: null,
    listeners: new Set(),
    waiters: [],
    status: { state: 'idle', msg: 'Not started', code: null, at: 0 },
    perm: 'unknown',
    fixes: 0,
    started: false,
    startedAt: 0,
    fails: 0,          // restarts since the last good fix
    denies: 0,         // permission refusals since the last good fix
    firstDenyAt: 0,
    restarts: 0,
    timer: null,

    norm(pos, src = 'glasses') {
      const c = pos.coords;
      return { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, t: Date.now(), src };
    },

    setStatus(state, msg, code = null) {
      Loc.status = { state, msg, code, at: Date.now() };
      renderLocBadge();
    },

    // Only call it "blocked" once refusals have persisted for a while.
    reallyBlocked() { return Loc.denies >= 4 && Date.now() - Loc.firstDenyAt > 20000; },

    onFix(pos) {
      const c = pos && pos.coords;
      if (!c || !finite(c.latitude) || !finite(c.longitude)) return;
      Loc.last = Loc.norm(pos);
      Loc.lastFixAt = Date.now();
      Loc.fixes++;
      Loc.fails = 0; Loc.denies = 0; Loc.firstDenyAt = 0;
      Loc.setStatus('ok', 'Location found');
      Loc.waiters.splice(0).forEach((w) => w.resolve(Loc.last));
      Loc.listeners.forEach((cb) => cb(Loc.last));
      Loc.schedule();
    },

    onError(err) {
      const code = err && err.code;
      if (code === 1) { Loc.denies++; if (!Loc.firstDenyAt) Loc.firstDenyAt = Date.now(); }
      Loc.lastErr = { code, msg: (err && err.message) || '', at: Date.now() };
      if (!Loc.fresh(30000)) {
        if (code === 1 && Loc.reallyBlocked()) Loc.setStatus('denied', locError(err), code);
        else Loc.setStatus('searching', 'Looking for your location…', code);
      }
      // A refused or failed watch is dead — try again soon.
      Loc.dead = true;
      Loc.schedule(code === 1 ? (Loc.denies <= 2 ? 700 : 2000) : 2500);
    },

    clearWatch() {
      if (Loc.watchId != null) { try { navigator.geolocation.clearWatch(Loc.watchId); } catch { /* ignore */ } }
      Loc.watchId = null;
    },

    startWatch() {
      Loc.clearWatch();
      Loc.restarts++;
      Loc.dead = false;
      Loc.startedAt = Date.now();
      try { Loc.watchId = navigator.geolocation.watchPosition(Loc.onFix, Loc.onError, { enableHighAccuracy: true }); }
      catch (e) { Loc.onError({ code: 2, message: e.message }); return; }
      // Every other retry, also try a one-shot request (some runtimes answer one but not the other).
      if (Loc.fails % 2 === 1) { try { navigator.geolocation.getCurrentPosition(Loc.onFix, () => {}, { timeout: 10000 }); } catch { /* ignore */ } }
      Loc.schedule();
    },

    // Health check: when nothing has arrived for a while, restart the watch.
    schedule(delay) {
      clearTimeout(Loc.timer);
      if (delay == null) delay = Loc.fresh(30000) ? 15000 : Math.min(15000, 3000 * Math.pow(1.6, Loc.fails));
      Loc.timer = setTimeout(Loc.check, delay);
    },

    check() {
      if (document.visibilityState === 'hidden') { Loc.schedule(5000); return; }
      const quietFor = Date.now() - Math.max(Loc.lastFixAt, Loc.startedAt);
      const needRestart = !Loc.fresh(30000) && (Loc.dead || quietFor > 2500 || Loc.watchId == null);
      if (needRestart) { Loc.fails++; Loc.startWatch(); }
      else Loc.schedule();
    },

    // Begin. The very first request is a single one-shot so only one
    // permission prompt can appear; the watch starts once it's answered.
    start() {
      if (DEMO || Loc.started) return;
      Loc.started = true;
      Loc.firstStartAt = Date.now();
      if (!('geolocation' in navigator)) { Loc.setStatus('unsupported', 'This browser has no location support.'); return; }
      Loc.setStatus('searching', 'Looking for your location…');
      let begun = false;
      const begin = () => { if (!begun) { begun = true; Loc.startWatch(); } };
      try {
        navigator.geolocation.getCurrentPosition((p) => { Loc.onFix(p); begin(); },
          (e) => { Loc.onError(e); begin(); }, { timeout: 15000 });
      } catch { begin(); }
      setTimeout(begin, 4000);    // no answer yet? start the watch anyway (retries cover any clash)
      Loc.checkPermission();
    },

    // "I need a location now": restart straight away unless a request is fresh.
    kick() {
      if (DEMO) return;
      if (!Loc.started) { Loc.start(); return; }
      if (!Loc.fresh(30000) && Date.now() - Loc.startedAt > 2000) { Loc.fails++; Loc.startWatch(); }
    },

    ensure(restart = false) { if (restart) { Loc.fails = 0; Loc.denies = 0; Loc.firstDenyAt = 0; Loc.started ? Loc.startWatch() : Loc.start(); } else Loc.kick(); },

    async checkPermission() {
      try {
        if (!navigator.permissions || !navigator.permissions.query) return;
        const p = await navigator.permissions.query({ name: 'geolocation' });
        Loc.perm = p.state;
        p.onchange = () => { Loc.perm = p.state; renderLocBadge(); if (p.state === 'granted') Loc.ensure(true); };
        renderLocBadge();
      } catch { /* not supported */ }
    },

    fresh(maxAge = 60000) { return Loc.last && Date.now() - Loc.last.t < maxAge ? Loc.last : null; },
    phoneFresh() { return Loc.phone && Date.now() - Loc.phone.t < 10 * 60000 ? Loc.phone : null; },

    // Resolves with a fix, or the phone's location, or rejects — never hangs.
    getOnce(timeout = 12000, { allowPhone = true } = {}) {
      if (DEMO) return Promise.resolve(Sim.current());
      const f = Loc.fresh();
      if (f) return Promise.resolve(f);
      Loc.kick();
      if (allowPhone && Loc.phoneFresh()) timeout = Math.min(timeout, 3000);
      return new Promise((resolve, reject) => {
        const w = { resolve: (v) => { clearTimeout(w.t); resolve(v); }, reject: (e) => { clearTimeout(w.t); reject(e); } };
        w.t = setTimeout(() => {
          Loc.waiters = Loc.waiters.filter((x) => x !== w);
          const ph = allowPhone && Loc.phoneFresh();
          if (Loc.last && Date.now() - Loc.last.t < 10 * 60000) resolve(Loc.last);   // an older fix beats nothing
          else if (ph) resolve(ph);
          else reject(new Error(Loc.status.state === 'denied' ? locError({ code: 1 }) : 'Still finding your location.'));
        }, timeout);
        Loc.waiters.push(w);
      });
    },

    watch(cb) {
      if (DEMO) { Sim.start(cb); return; }
      Loc.listeners.add(cb);
      Loc.kick();
    },

    stop() {
      if (DEMO) Sim.stop();
      Loc.listeners.clear();   // the background watch keeps running so a fix stays warm
    },
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !DEMO && Loc.started && !Loc.fresh(30000)) { Loc.fails = 0; Loc.startWatch(); }
  });

  function locError(err) {
    if (!err) return 'Location unavailable.';
    if (err.code === 1) return 'Location is blocked. On your iPhone: Settings → Meta AI → Location → Always, with Precise Location on.';
    if (err.code === 3) return 'Still looking for your location…';
    return 'Can’t get your location right now. Is your phone connected?';
  }

  // Demo: walks along the active route so you can test indoors.
  const Sim = {
    pos: (() => {
      const s = (params.get('start') || '').split(',').map(Number);
      return (s.length === 2 && s.every(finite)) ? s : [51.50797, -0.12804]; // Trafalgar Square
    })(),
    timer: null,
    speed: finite(Number(params.get('speed'))) && Number(params.get('speed')) > 0 ? Number(params.get('speed')) : 6,
    current() { return { lat: Sim.pos[0], lon: Sim.pos[1], accuracy: 6, heading: null, speed: 0, t: Date.now() }; },
    start(cb) {
      Sim.stop();
      Sim.timer = setInterval(() => {
        if (!nav || !nav.route) return;
        const r = nav.route;
        const d = Math.min(r.total, nav.along + Sim.speed);
        const p = pointAt(r, d), ahead = pointAt(r, Math.min(r.total, d + 5));
        Sim.pos = p;
        Loc.lastFixAt = Date.now();
        cb({ lat: p[0], lon: p[1], accuracy: 6, heading: bearing(p, ahead), speed: 1.4, t: Date.now() });
      }, 1000);
    },
    stop() { clearInterval(Sim.timer); Sim.timer = null; },
  };

  // ------------------------------------------------------------------ routing providers
  // Every provider returns the same shape:
  // { shape:[[lat,lon]], cum:[m], total, duration, steps:[{kind,text,verbal,street,beginIdx}] }
  async function getRoute(from, to) {
    const r = USE_MAPBOX ? await routeMapbox(from, to) : await routeValhalla(from, to);
    r.cum = [0];
    for (let i = 1; i < r.shape.length; i++) r.cum[i] = r.cum[i - 1] + haversine(r.shape[i - 1], r.shape[i]);
    r.total = r.cum[r.cum.length - 1];
    if (!r.steps.length || r.steps[r.steps.length - 1].kind !== 'arrive') {
      r.steps.push({ kind: 'arrive', text: 'Arrive at your destination', verbal: 'You have arrived.', street: '', beginIdx: r.shape.length - 1 });
    }
    return r;
  }

  const VALHALLA_KIND = {
    1: 'depart', 2: 'depart', 3: 'depart', 4: 'arrive', 5: 'arrive', 6: 'arrive',
    7: 'straight', 8: 'straight', 9: 'slight-right', 10: 'right', 11: 'sharp-right',
    12: 'uturn', 13: 'uturn', 14: 'sharp-left', 15: 'left', 16: 'slight-left',
    17: 'straight', 18: 'slight-right', 19: 'slight-left', 20: 'slight-right', 21: 'slight-left',
    22: 'straight', 23: 'keep-right', 24: 'keep-left', 25: 'straight',
    26: 'roundabout', 27: 'roundabout', 28: 'ferry', 29: 'ferry',
    37: 'slight-right', 38: 'slight-left', 39: 'stairs', 40: 'stairs', 41: 'stairs',
  };

  async function routeValhalla(from, to) {
    const body = {
      locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
      costing: 'pedestrian',
      directions_options: { units: CFG.UNITS === 'imperial' ? 'miles' : 'kilometers', language: CFG.LANGUAGE },
    };
    const url = 'https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(body));
    const data = await fetchJSON(url, {}, 20000);
    const leg = data && data.trip && data.trip.legs && data.trip.legs[0];
    if (!leg) throw new Error('No walking route found.');
    const shape = decodePolyline(leg.shape, 6);
    const steps = (leg.maneuvers || []).map((m) => ({
      kind: VALHALLA_KIND[m.type] || 'straight',
      text: trimDot(m.instruction),
      verbal: trimDot(m.verbal_pre_transition_instruction || m.instruction),
      street: (m.street_names || []).join(' / '),
      beginIdx: clamp(m.begin_shape_index | 0, 0, shape.length - 1),
    }));
    return { shape, steps, duration: (data.trip.summary && data.trip.summary.time) || leg.summary.time || 0 };
  }

  function mapboxKind(man) {
    const t = man.type || '', mod = man.modifier || 'straight';
    if (t === 'depart') return 'depart';
    if (t === 'arrive') return 'arrive';
    if (/roundabout|rotary/.test(t)) return 'roundabout';
    if (t === 'fork') return /left/.test(mod) ? 'keep-left' : /right/.test(mod) ? 'keep-right' : 'straight';
    return ({ uturn: 'uturn', 'sharp right': 'sharp-right', right: 'right', 'slight right': 'slight-right',
      straight: 'straight', 'slight left': 'slight-left', left: 'left', 'sharp left': 'sharp-left' })[mod] || 'straight';
  }

  async function routeMapbox(from, to) {
    const url = 'https://api.mapbox.com/directions/v5/mapbox/walking/' +
      `${from.lon},${from.lat};${to.lon},${to.lat}` +
      '?steps=true&geometries=polyline6&overview=full&language=' + CFG.LANGUAGE.split('-')[0] +
      '&access_token=' + TOKEN;
    const data = await fetchJSON(url, {}, 20000);
    const route = data && data.routes && data.routes[0];
    if (!route) throw new Error((data && data.message) || 'No walking route found.');
    const shape = [], steps = [];
    for (const leg of route.legs) {
      for (const st of leg.steps) {
        const pts = decodePolyline(st.geometry, 6);
        if (shape.length && pts.length) pts.shift();          // shared join point
        const beginIdx = Math.max(0, shape.length - (shape.length ? 1 : 0));
        shape.push(...pts);
        const text = trimDot(st.maneuver.instruction);
        steps.push({ kind: mapboxKind(st.maneuver), text, verbal: text, street: st.name || '', beginIdx });
      }
    }
    if (!shape.length) throw new Error('No walking route found.');
    steps.forEach((s) => { s.beginIdx = clamp(s.beginIdx, 0, shape.length - 1); });
    return { shape, steps, duration: route.duration || 0 };
  }

  function pointAt(r, d) {
    d = clamp(d, 0, r.total);
    let lo = 0, hi = r.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r.cum[mid] <= d) lo = mid; else hi = mid; }
    const seg = r.cum[hi] - r.cum[lo];
    const t = seg > 0 ? (d - r.cum[lo]) / seg : 0;
    const a = r.shape[lo], b = r.shape[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // Snap a position onto the route. Searches forward from the last segment so a
  // route that doubles back on itself doesn't make you jump ahead.
  function snapToRoute(r, p, fromSeg, lastAlong) {
    let best = null;
    const start = Math.max(0, fromSeg - 15);
    for (let i = start; i < r.shape.length - 1; i++) {
      const a = project(r.shape[i], p), b = project(r.shape[i + 1], p);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? clamp(-(a[0] * dx + a[1] * dy) / len2, 0, 1) : 0;
      const qx = a[0] + dx * t, qy = a[1] + dy * t;
      const dist = Math.hypot(qx, qy);
      const along = r.cum[i] + (r.cum[i + 1] - r.cum[i]) * t;
      const score = dist + Math.max(0, along - (lastAlong + 120)) * 0.3;
      if (!best || score < best.score) best = { score, dist, along, seg: i };
    }
    return best;
  }

  // ------------------------------------------------------------------ voice
  // Sound has four modes:
  //   'voice'  — natural Google voice (needs a key, set from the phone page)
  //   'chimes' — short tones; left turns play in the left ear, right in the right
  //   'system' — the glasses' built-in voice
  //   'off'
  const DIR_KIND = { left: 'left', 'slight-left': 'left', 'sharp-left': 'left', 'keep-left': 'left', uturn: 'left',
    right: 'right', 'slight-right': 'right', 'sharp-right': 'right', 'keep-right': 'right', arrive: 'arrive' };

  const Voice = {
    key: store.get('ttsKey', CFG.GOOGLE_TTS_KEY || ''),
    voiceName: store.get('ttsVoice', CFG.VOICE_NAME || 'en-GB-Chirp3-HD-Charon'),
    mode: null,
    ok: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    ctx: null, cache: new Map(), gen: 0, chain: Promise.resolve(), playing: null,

    init() {
      const saved = store.get('sound', null);
      Voice.mode = saved && Voice.modes().includes(saved) ? saved : (CFG.VOICE === false ? 'off' : Voice.key ? 'voice' : 'chimes');
    },
    modes() { return (Voice.key ? ['voice'] : []).concat(['chimes', 'system', 'off']); },
    label() { return { voice: 'Natural voice', chimes: 'Chimes', system: 'Glasses voice', off: 'Off' }[Voice.mode]; },
    get on() { return Voice.mode !== 'off'; },
    cycle() {
      const m = Voice.modes();
      Voice.mode = m[(m.indexOf(Voice.mode) + 1) % m.length];
      store.set('sound', Voice.mode);
      Voice.stop();
      const b = $('btn-voice'); if (b) b.textContent = 'Sound: ' + Voice.label();
      Voice.say(Voice.mode === 'chimes' ? '' : 'Sound on.', true, { kind: 'info' });
    },
    setKey(key, name) {
      Voice.key = key || '';
      if (name) Voice.voiceName = name;
      store.set('ttsKey', Voice.key); store.set('ttsVoice', Voice.voiceName);
      Voice.cache.clear();
      Voice.mode = Voice.key ? 'voice' : 'chimes';
      store.set('sound', Voice.mode);
    },

    // Audio needs one tap/pinch before it may play; call on any input.
    unlock() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!Voice.ctx) Voice.ctx = new AC();
        if (Voice.ctx.state === 'suspended') Voice.ctx.resume();
      } catch { /* no web audio */ }
    },

    stop() {
      Voice.gen++;
      Voice.chain = Promise.resolve();
      try { if (Voice.playing) Voice.playing.stop ? Voice.playing.stop() : Voice.playing.pause(); } catch { /* already stopped */ }
      Voice.playing = null;
      if (Voice.ok) try { speechSynthesis.cancel(); } catch { /* ignore */ }
    },

    // ---- chimes (Web Audio)
    tone(freq, start, dur, pan = 0, vol = 0.22, type = 'sine') {
      const c = Voice.ctx; if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = freq;
      const t0 = c.currentTime + start;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let node = o.connect(g);
      if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; node = g.connect(p); p.connect(c.destination); }
      else g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.05);
    },
    chime(kind) {
      Voice.unlock();
      if (!Voice.ctx) return;
      const T = (f, s, d, p, v) => Voice.tone(f, s, d, p, v);
      switch (kind) {
        case 'prepare-left': T(784, 0, 0.35, -0.8, 0.16); break;
        case 'prepare-right': T(784, 0, 0.35, 0.8, 0.16); break;
        case 'prepare': T(784, 0, 0.35, 0, 0.16); break;
        case 'left': T(988, 0, 0.22, -0.9); T(740, 0.16, 0.4, -0.9); break;     // falling, left ear
        case 'right': T(740, 0, 0.22, 0.9); T(988, 0.16, 0.4, 0.9); break;     // rising, right ear
        case 'straight': T(880, 0, 0.18); T(880, 0.2, 0.3); break;
        case 'arrive': T(523, 0, 0.3); T(659, 0.15, 0.3); T(784, 0.3, 0.6); break;
        case 'reroute': T(440, 0, 0.25, 0, 0.18); T(392, 0.22, 0.4, 0, 0.18); break;
        case 'info': T(1046, 0, 0.18, 0, 0.12); break;
        default: break;
      }
    },

    // ---- natural voice (Google Cloud Text-to-Speech)
    synth(text) {
      if (Voice.cache.has(text)) return Voice.cache.get(text);
      const p = fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(Voice.key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: Voice.voiceName.split('-').slice(0, 2).join('-'), name: Voice.voiceName },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1.05 },
        }),
      }).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.audioContent) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
        const bin = atob(j.audioContent), buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
      });
      p.catch(() => Voice.cache.delete(text));
      Voice.cache.set(text, p);
      if (Voice.cache.size > 120) Voice.cache.delete(Voice.cache.keys().next().value);
      return p;
    },
    prefetch(texts) {
      if (Voice.mode !== 'voice' || !Voice.key) return;
      [...new Set(texts.filter(Boolean))].slice(0, 40).forEach((t, i) => setTimeout(() => Voice.synth(t).catch(() => {}), i * 120));
    },
    async playBuffer(buf, pan, gen) {
      if (gen !== Voice.gen) return;
      Voice.unlock();
      const c = Voice.ctx;
      if (c) {
        const audio = await c.decodeAudioData(buf.slice(0));
        if (gen !== Voice.gen) return;
        const src = c.createBufferSource(); src.buffer = audio;
        let last = src;
        if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; src.connect(p); last = p; }
        last.connect(c.destination);
        Voice.playing = src;
        await new Promise((res) => { src.onended = res; src.start(); });
      } else {
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
        const el = new Audio(url); Voice.playing = el;
        await new Promise((res) => { el.onended = res; el.onerror = res; el.play().catch(res); });
        URL.revokeObjectURL(url);
      }
    },

    // say(text, interrupt, { kind }) — kind: 'left' | 'right' | 'straight' | 'prepare-left' | … | 'arrive' | 'reroute' | 'info'
    say(text, interrupt = false, opts = {}) {
      const kind = opts.kind || null;
      if (Voice.mode === 'off') return;
      if (interrupt) Voice.stop();
      if (Voice.mode === 'chimes') { if (kind) Voice.chime(kind); return; }
      if (!text) { if (kind) Voice.chime(kind); return; }
      if (Voice.mode === 'system') {
        if (!Voice.ok) return;
        try { const u = new SpeechSynthesisUtterance(text); u.lang = CFG.LANGUAGE; u.rate = 1.05; speechSynthesis.speak(u); } catch (e) { console.warn('TTS', e); }
        return;
      }
      // natural voice: queue so phrases never overlap; pan turns slightly toward their side
      const gen = Voice.gen;
      const pan = /left/.test(kind || '') ? -0.5 : /right/.test(kind || '') ? 0.5 : 0;
      const job = Voice.synth(text);
      Voice.chain = Voice.chain.then(() => job).then((buf) => Voice.playBuffer(buf, pan, gen)).catch((e) => {
        console.warn('voice', e);
        if (gen === Voice.gen && kind) Voice.chime(kind);    // network trouble: fall back to a chime
      });
    },
  };
  Voice.init();
  ['pointerdown', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, () => Voice.unlock(), { capture: true, passive: true }));

  // ------------------------------------------------------------------ heading (compass)
  const Heading = {
    compass: null, compassAt: 0, attached: false,

    async request() {
      try {
        const O = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
        const owner = (O && typeof O.requestPermission === 'function') ? O
          : (M && typeof M.requestPermission === 'function') ? M : null;
        if (owner) {
          const state = await Promise.race([owner.requestPermission(), new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
          if (state !== 'granted') return false;
        }
        Heading.attach();
        return true;
      } catch (e) { console.warn('sensor permission', e); return false; }
    },

    attach() {
      if (Heading.attached) return;
      Heading.attached = true;
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', Heading.onEvent);
      window.addEventListener('deviceorientation', Heading.onEvent);
    },

    detach() {
      window.removeEventListener('deviceorientationabsolute', Heading.onEvent);
      window.removeEventListener('deviceorientation', Heading.onEvent);
      Heading.attached = false;
    },

    onEvent(e) {
      let h = null;
      if (finite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && finite(e.alpha)) h = (360 - e.alpha) % 360;
      if (h == null) return;
      Heading.compass = Heading.compass == null ? h : angleLerp(Heading.compass, h, 0.25);
      Heading.compassAt = Date.now();
      requestDraw();
    },

    // Best available heading for rotating the map, or null for north-up.
    current() {
      if (!nav || nav.mapMode === 'north') return null;
      if (Heading.compass != null && Date.now() - Heading.compassAt < 2500) return Heading.compass;
      const p = nav.pos;
      if (p && finite(p.heading) && (!finite(p.speed) || p.speed > 0.5)) nav.lastCourse = p.heading;
      return nav.lastCourse;
    },
  };

  // ------------------------------------------------------------------ wake lock
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { /* not supported — fine */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && nav && nav.active) keepAwake(true);
  });

  // ------------------------------------------------------------------ screens + history
  let current = 'home';

  function show(name, mode = 'push') {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
    current = name;
    const depth = (history.state && history.state.d) || 0;
    if (mode === 'push') history.pushState({ s: name, d: depth + 1 }, '', '#' + name);
    else if (mode === 'replace') history.replaceState({ s: name, d: depth }, '', '#' + name);
    focusScreen(name);
  }

  function goHome() {
    const depth = (history.state && history.state.d) || 0;
    if (depth > 0) history.go(-depth);   // popstate renders home
    else show('home', 'none');
  }

  let lastKeyAt = 0;
  document.addEventListener('keydown', () => { lastKeyAt = Date.now(); }, true);

  // The glasses can move focus around just after a screen changes (often to
  // the Back button, top-left). So we place focus a few times over the first
  // second — and stop the moment you press anything yourself.
  function holdFocus(screen, getEl) {
    const since = Date.now();
    const put = () => {
      if (current !== screen || lastKeyAt > since) return;
      const el = getEl();
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    };
    [0, 80, 250, 600, 1200].forEach((ms) => setTimeout(put, ms));
  }

  // Home always opens with an empty "Where to?" box, focused and ready.
  function focusHome() {
    $('search-input').value = '';
    holdFocus('home', () => $('search-input'));
  }

  function focusScreen(name) {
    if (name === 'home') { focusHome(); return; }
    if (name === 'preview') { holdFocus('preview', () => $('btn-go')); return; }
    requestAnimationFrame(() => {
      let el = null;
      if (name === 'home') el = $('search-input');
      if (name === 'results') el = document.querySelector('#results-list .item') || $('research-input');
      if (name === 'phone') el = document.querySelector('#screen-phone .btn');
      if (name === 'loc') el = document.querySelector('#screen-loc .btn');
      if (name === 'preview') el = $('btn-go').disabled ? document.querySelector('#screen-preview .back') : $('btn-go');
      if (name === 'nav') el = $('nav-menu').hidden ? $('nav-focus') : document.querySelector('#nav-menu .btn');
      if (name === 'arrive') el = document.querySelector('#screen-arrive .btn');
      if (el) el.focus({ preventScroll: false });
    });
  }

  window.addEventListener('popstate', (e) => {
    const st = e.state || { s: 'home', d: 0 };
    if (current === 'nav' && nav && nav.active && st.s !== 'nav') {
      // Back pressed mid-route: don't silently abandon it — offer the menu.
      history.pushState({ s: 'nav', d: st.d + 1 }, '', '#nav');
      openMenu();
      return;
    }
    if (st.s === 'nav' && !(nav && nav.active)) { goHome(); return; }
    if (st.s === 'home') renderHome();
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.dataset.screen !== st.s; });
    current = st.s;
    focusScreen(st.s);
  });

  // ------------------------------------------------------------------ icons
  const ICON = {
    pin: '<path d="M12 2C8 2 5 5 5 8.8 5 14 12 22 12 22s7-8 7-13.2C19 5 16 2 12 2z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="9" r="2.6" fill="currentColor"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill="currentColor"/>',
    clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7v5.5l3.5 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  };
  const svgIcon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

  function head(x, y, angleDeg, size = 24) {
    const a = rad(angleDeg), s = size;
    const bx = x - Math.cos(a) * s, by = y - Math.sin(a) * s;
    const px = Math.cos(a + Math.PI / 2) * s * 0.62, py = Math.sin(a + Math.PI / 2) * s * 0.62;
    return `<polygon points="${x},${y} ${bx + px},${by + py} ${bx - px},${by - py}" fill="currentColor"/>`;
  }
  const stroke = (d, w = 12) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

  function maneuverSVG(kind) {
    switch (kind) {
      case 'left': return stroke('M62 92 V56 Q62 40 46 40 H34') + head(12, 40, 180);
      case 'right': return stroke('M38 92 V56 Q38 40 54 40 H66') + head(88, 40, 0);
      case 'slight-left': case 'keep-left': return stroke('M60 92 V62 L38 40') + head(24, 26, -135);
      case 'slight-right': case 'keep-right': return stroke('M40 92 V62 L62 40') + head(76, 26, -45);
      case 'sharp-left': return stroke('M66 92 V36 L44 60') + head(30, 75, 133);
      case 'sharp-right': return stroke('M34 92 V36 L56 60') + head(70, 75, 47);
      case 'uturn': return stroke('M68 92 V42 Q68 20 49 20 Q30 20 30 42 V58') + head(30, 82, 90);
      case 'roundabout': return `<circle cx="50" cy="44" r="17" fill="none" stroke="currentColor" stroke-width="10"/>` +
        stroke('M50 92 V64') + stroke('M62 32 L72 22', 10) + head(84, 10, -45, 20);
      case 'stairs': return stroke('M14 84 H34 V66 H52 V48 H70 V30 H88', 10);
      case 'ferry': return stroke('M14 62 H86 L74 80 H26 Z', 9) + stroke('M50 62 V22 L72 50 H50', 8);
      case 'depart': return `<circle cx="50" cy="84" r="9" fill="currentColor"/>` + stroke('M50 70 V30') + head(50, 10, -90);
      case 'arrive': return '<path d="M50 8C33 8 20 21 20 37.5 20 60 50 92 50 92s30-32 30-54.5C80 21 67 8 50 8z" fill="none" stroke="currentColor" stroke-width="9" stroke-linejoin="round"/><circle cx="50" cy="38" r="11" fill="currentColor"/>';
      default: return stroke('M50 92 V34') + head(50, 10, -90);
    }
  }

  // ------------------------------------------------------------------ home
  const favs = () => store.get('favs', []);
  const recents = () => store.get('recents', []);
  const sameSpot = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

  function placeButton(place, icon, meta) {
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = `${svgIcon(icon)}<span class="txt"><span class="name">${esc(place.name)}</span>` +
      (place.sub ? `<span class="sub">${esc(place.sub)}</span>` : '') + `</span>` +
      (meta ? `<span class="meta">${esc(meta)}</span>` : '');
    b.addEventListener('click', () => openPreview(place));
    return b;
  }

  function renderHome() {
    const f = favs(), r = recents().filter((x) => !f.some((y) => sameSpot(x, y)));
    $('fav-list').replaceChildren(...f.map((p) => placeButton(p, 'star')));
    $('recent-list').replaceChildren(...r.map((p) => placeButton(p, 'clock')));
    $('fav-label').hidden = !f.length;
    $('recent-label').hidden = !r.length;
    $('home-empty').hidden = !!(f.length || r.length);
  }

  // ------------------------------------------------------------------ location badge + help screen
  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }

  // The word "Waypoint" shows location status: white = all good (or still
  // finding you), red = a problem — select it to see why.
  function renderLocBadge() {
    const b = $('brand-btn');
    if (!b) return;
    const st = Loc.status.state, f = Loc.fresh(120000);
    let cls = 'wait', say = 'finding you';
    if (DEMO || f) { cls = 'ok'; say = f ? 'good, accurate to ' + Math.round(f.accuracy || 0) + ' metres' : 'demo'; }
    else if (Loc.phoneFresh()) { cls = 'ok'; say = 'using your phone'; }
    else if (st === 'denied') { cls = 'bad'; say = 'blocked'; }
    else if ((st === 'searching' || st === 'idle') && Date.now() - (Loc.firstStartAt || Date.now()) < 30000) { cls = 'wait'; }
    else { cls = 'bad'; say = 'no signal'; }
    b.className = 'brand ' + cls;
    b.setAttribute('aria-label', 'Waypoint. Location: ' + say + '. Select for details.');
    if (current === 'loc') renderLocInfo();
  }

  function renderLocInfo() {
    const f = Loc.last, ph = Loc.phone;
    const rows = [
      ['Backup', Backup.label()],
      ['Location', Loc.status.msg],
      ['Permission', Loc.perm],
      ['Last fix', f ? `${ago(f.t)}, ±${Math.round(f.accuracy || 0)} m` : 'none yet'],
      ['Fixes', String(Loc.fixes)],
      ['Auto-retries', String(Math.max(0, Loc.restarts - 1))],
      ['Phone', ph ? `${ago(ph.t)}, ±${Math.round(ph.accuracy || 0)} m` : 'not sent'],
    ];
    if (Loc.lastErr && !Loc.fresh(30000)) rows.push(['Last error', `${Loc.lastErr.code} ${Loc.lastErr.msg || ''} (${ago(Loc.lastErr.at)})`]);
    if (false) rows.push(['Error code', String(Loc.status.code) + (Loc.status.code === 1 ? ' (blocked)' : Loc.status.code === 2 ? ' (unavailable)' : Loc.status.code === 3 ? ' (timed out)' : '')]);
    $('loc-info').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  setInterval(renderLocBadge, 5000);

  // ------------------------------------------------------------------ search
  // The heavy lifting (postcode fixing, categories, multi-service matching)
  // lives in search.js so the phone page can share it.
  let searchSeq = 0;
  let lastQuery = { q: '', at: 0 };

  function showResults(list, near, status, keepFocus = false) {
    // When the list grows while you're looking at it, keep your place.
    const items = [...$('results-list').children];
    const idx = items.indexOf(document.activeElement);
    $('results-status').textContent = status || '';
    $('results-list').replaceChildren(...list.map((p) => {
      const meta = near ? fmtDist(finite(p.dist) ? p.dist : haversine([near.lat, near.lon], [p.lat, p.lon])) : '';
      return placeButton(p, 'pin', meta);
    }));
    if (current !== 'results') return;
    if (keepFocus && idx >= 0) { const el = $('results-list').children[Math.min(idx, list.length - 1)]; if (el) el.focus({ preventScroll: true }); }
    else if (!keepFocus || !$('screen-results').contains(document.activeElement) || document.activeElement === $('research-input')) focusScreen('results');
  }

  async function doSearch(raw, mode = 'push') {
    raw = (raw || '').trim();
    if (!raw) return;
    if (raw === lastQuery.q && Date.now() - lastQuery.at < 1500) return;
    lastQuery = { q: raw, at: Date.now() };
    const seq = ++searchSeq;

    $('research-input').value = raw;
    $('results-heard').hidden = true;
    $('results-status').textContent = 'Searching…';
    $('results-list').replaceChildren();
    show('results', current === 'results' ? 'replace' : mode);

    let near = null;
    // Use whatever position we have; don't hold the search up waiting for GPS.
    near = Loc.fresh(10 * 60000) || Loc.phoneFresh();
    if (!near) { try { near = await Loc.getOnce(1500); } catch { /* search without location bias */ } }

    try {
      const res = await WPSearch.find(raw, near);
      if (seq !== searchSeq) return;
      // Show what the glasses heard, and what we actually searched for.
      const heard = $('results-heard');
      const changed = res.searched && WPSearch.clean(res.heard).toLowerCase() !== res.searched.toLowerCase();
      heard.innerHTML = changed ? `Heard “${esc(res.heard)}” → <b>${esc(res.searched)}</b>` : '';
      heard.hidden = !changed;

      if (!res.results.length) {
        showResults([], near, res.kind === 'postcode' ? 'That postcode wasn’t found. Try saying it letter by letter.'
          : 'No places found. Try again, add the town, or send it from your phone.');
        Voice.say('Nothing found.', true, { kind: 'info' });
        return;
      }
      showResults(res.results, near, near ? '' : 'Location unavailable — results may be far away.');
      const top = res.results[0];
      const d = near ? ', ' + spokenDist(finite(top.dist) ? top.dist : haversine([near.lat, near.lon], [top.lat, top.lon])) : '';
      Voice.say((res.results.length > 1 ? 'Top result: ' : '') + top.name + d + '.', true);
    } catch (e) {
      if (seq !== searchSeq) return;
      console.error(e);
      $('results-status').textContent = 'Search failed: ' + e.message;
    }
  }

  async function doCategory(key) {
    const cat = WPSearch.CATEGORIES.find((c) => c.key === key);
    if (!cat) return;
    const seq = ++searchSeq;
    $('research-input').value = '';
    $('results-heard').innerHTML = `Nearest <b>${esc(cat.label.toLowerCase())}</b>`;
    $('results-heard').hidden = false;
    $('results-status').textContent = 'Finding your location…';
    $('results-list').replaceChildren();
    show('results');
    let near;
    try { near = await Loc.getOnce(12000); }
    catch (e) {
      if (seq !== searchSeq) return;
      $('results-status').textContent = e.message + ' Nearby needs your location — press Location at the top of the home screen for help.';
      return;
    }
    if (seq !== searchSeq) return;
    $('results-status').textContent = 'Looking nearby…';
    let shown = false;
    try {
      const list = await WPSearch.category(key, near, (partial) => {
        if (seq !== searchSeq) return;
        showResults(partial, near, 'Looking for more…', shown);
        shown = true;
      });
      if (seq !== searchSeq) return;
      showResults(list, near, list.length ? (list.length + ' nearby' + (near.src === 'phone' ? ' · using your phone\u2019s location' : '')) : 'Nothing found nearby.', shown);
    } catch (e) {
      if (seq !== searchSeq) return;
      $('results-status').textContent = e.message || 'Nearby search failed.';
    }
  }

  function renderChips() {
    $('chips').replaceChildren(...WPSearch.CATEGORIES.map((c) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = c.label;
      b.addEventListener('click', () => doCategory(c.key));
      return b;
    }));
  }

  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('search-input').value); });
  $('search-input').addEventListener('change', () => doSearch($('search-input').value));
  $('research-form').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('research-input').value, 'replace'); });
  $('research-input').addEventListener('change', () => doSearch($('research-input').value, 'replace'));

  // ------------------------------------------------------------------ send from phone (relay)
  // The phone page publishes a place to a private ntfy.sh topic named after
  // your pairing code; the glasses listen on the same topic.
  const Relay = {
    base: String(CFG.RELAY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
    code: null, es: null, connected: false, seen: store.get('relaySeen', []),

    newCode() {
      const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      const r = new Uint32Array(8);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(r) : r.forEach((_, i) => { r[i] = Math.random() * 1e9; });
      return Array.from(r, (n) => A[n % A.length]).join('');
    },
    topic() { return 'waypoint-' + Relay.code.toLowerCase(); },
    pretty() { return Relay.code.slice(0, 4) + '-' + Relay.code.slice(4); },

    start(reset = false) {
      if (reset) store.set('pairCode', Relay.newCode());
      // A first-time code is automatic, not a change worth backing up (and it
      // mustn't make a freshly wiped device look newer than its backup).
      else if (!store.get('pairCode', null)) try { localStorage.setItem('wp.pairCode', JSON.stringify(Relay.newCode())); } catch { /* ignore */ }
      Relay.code = store.get('pairCode', null);
      if (Relay.es) { Relay.es.close(); Relay.es = null; }
      Relay.setStatus(false);
      // Anything sent while the app was closed (last 15 min)?
      fetch(`${Relay.base}/${Relay.topic()}/json?poll=1&since=15m`).then((r) => r.text()).then((txt) => {
        const msgs = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((m) => m && m.event === 'message');
        const fresh = msgs.filter((m) => !Relay.seen.includes(m.id));
        fresh.forEach((m) => Relay.markSeen(m.id));
        if (fresh.length) Relay.deliver(fresh[fresh.length - 1]);
      }).catch(() => {});
      if (!('EventSource' in window)) return;
      try {
        const es = new EventSource(`${Relay.base}/${Relay.topic()}/sse`);
        es.onopen = () => Relay.setStatus(true);
        es.onerror = () => Relay.setStatus(false);
        es.onmessage = (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          Relay.setStatus(true);
          if (m.event !== 'message' || Relay.seen.includes(m.id)) return;
          Relay.markSeen(m.id);
          Relay.deliver(m);
        };
        Relay.es = es;
      } catch (e) { console.warn('relay', e); }
    },

    markSeen(id) { Relay.seen = [id, ...Relay.seen].slice(0, 30); store.set('relaySeen', Relay.seen); },

    setStatus(on) {
      Relay.connected = on;
      const el = $('phone-status');
      if (!el) return;
      el.classList.toggle('on', on);
      $('phone-status-text').textContent = on ? 'Ready — waiting for your phone' : 'Connecting…';
    },

    deliver(m) {
      if (m.time && Date.now() / 1000 - m.time > 15 * 60) return;
      let p; try { p = JSON.parse(m.message); } catch { p = { q: m.message }; }
      if (!p) return;
      if (p.from && finite(p.from.lat) && finite(p.from.lon)) {
        Loc.phone = { lat: p.from.lat, lon: p.from.lon, accuracy: p.from.acc || 50, heading: null, speed: null, t: Date.now(), src: 'phone' };
        renderLocBadge();
        if (nav && nav.active && !Loc.fresh(30000)) onPosition(Loc.phone);
      }
      if (typeof p.voiceKey === 'string') {
        Voice.setKey(p.voiceKey, p.voiceName);
        toast(p.voiceKey ? 'Natural voice set ✓' : 'Natural voice removed', 3500);
        Voice.say(p.voiceKey ? 'Hello. This is your new Waypoint voice.' : '', true, { kind: 'info' });
        return;
      }
      if (p.ping) { toast('Phone paired ✓', 3000); Voice.say('Phone paired.', false, { kind: 'info' }); return; }
      const place = (finite(p.lat) && finite(p.lon)) ? { name: p.name || 'Pinned location', sub: p.sub || '', lat: p.lat, lon: p.lon } : null;
      const label = place ? place.name : p.q;
      if (!label) return;
      if (nav && nav.active) {
        if (place) addRecent(place);
        toast('From phone: ' + label + (place ? ' (in Recent)' : ''), 5000);
        return;
      }
      Voice.say('From your phone: ' + label + '.', true, { kind: 'info' });
      if (place) openPreview(place, current === 'preview' ? 'replace' : 'push');
      else doSearch(p.q);
    },
  };

  function openPhone() {
    const dir = location.origin + location.pathname.replace(/[^/]*$/, '');
    $('phone-url').textContent = (dir + 'send.html').replace(/^https?:\/\//, '');
    $('phone-code').textContent = Relay.pretty();
    Relay.setStatus(Relay.connected);
    show('phone');
  }

  // ------------------------------------------------------------------ preview
  let preview = null; // { place, route, from }

  function updateSaveBtn() {
    const saved = preview && favs().some((f) => sameSpot(f, preview.place));
    $('btn-save').textContent = saved ? '★ Saved' : '☆ Save';
  }

  async function openPreview(place, mode = 'push') {
    preview = { place, route: null, from: null };
    $('pv-name').textContent = place.name;
    $('pv-addr').textContent = place.sub || '';
    $('pv-time').textContent = '–'; $('pv-dist').textContent = '–'; $('pv-eta').textContent = '–';
    $('pv-status').textContent = 'Finding a walking route…';
    $('btn-go').disabled = false;   // Go works straight away; the route is planned as soon as we can
    updateSaveBtn();
    show('preview', mode);

    const token = preview;
    let from = null;
    try { from = await Loc.getOnce(12000); }
    catch (e) {
      if (preview !== token) return;
      $('pv-status').textContent = e.message + ' Press Go and the route will start as soon as you’re found.';
      $('btn-go').disabled = false;
      return;
    }
    try {
      const route = await getRoute(from, place);
      if (preview !== token) return;
      preview.route = route; preview.from = from;
      $('pv-time').textContent = fmtDur(route.duration);
      $('pv-dist').textContent = fmtDist(route.total);
      $('pv-eta').textContent = fmtClock(new Date(Date.now() + route.duration * 1000));
      $('pv-status').textContent = (from.src === 'phone' ? 'Starting from your phone’s location · ' : '') +
        (USE_MAPBOX ? 'Route by Mapbox' : 'Route by OpenStreetMap / Valhalla');
    } catch (e) {
      if (preview !== token) return;
      console.error(e);
      preview.from = from;
      $('pv-status').textContent = (e.message || 'Couldn’t find a route.') + ' Press Go to try again.';
    }
  }

  function toggleSave() {
    if (!preview) return;
    let f = favs();
    if (f.some((x) => sameSpot(x, preview.place))) { f = f.filter((x) => !sameSpot(x, preview.place)); toast('Removed from Saved'); }
    else { f.unshift(pickPlace(preview.place)); f = f.slice(0, 12); toast('Saved'); }
    store.set('favs', f);
    updateSaveBtn();
  }
  const pickPlace = (p) => ({ name: p.name, sub: p.sub || '', lat: p.lat, lon: p.lon });

  function addRecent(place) {
    const r = [pickPlace(place), ...recents().filter((x) => !sameSpot(x, place))].slice(0, 8);
    store.set('recents', r);
  }

  // ------------------------------------------------------------------ navigation
  let nav = null;

  async function startNav() {
    if (!preview) return;
    $('btn-go').disabled = true;
    await Heading.request();          // must follow the Go press (user gesture)

    nav = {
      active: true,
      dest: preview.place,
      route: preview.route,
      pos: preview.from,
      along: 0, seg: 0, offDist: 0, offCount: 0,
      stepIdx: 1, announced: {},
      lastReroute: 0, rerouting: false,
      peek: null, peekTimer: null,
      zoom: 1, mapMode: store.get('mapMode', 'auto'), lastCourse: null,
    };
    addRecent(nav.dest);
    $('search-input').value = '';
    $('nav-menu').hidden = true;
    $('btn-voice').textContent = 'Sound: ' + Voice.label();
    show('nav');
    keepAwake(true);

    if (nav.route) {
      prefetchRoute(nav.route);
      const first = nav.route.steps[0];
      if (first) { Voice.say(first.verbal, true, { kind: 'straight' }); toast(first.text, 5000); }
    } else Voice.say('Finding your location.', true, { kind: 'info' });

    Loc.watch(onPosition);
    const startPos = nav.pos || Loc.fresh(10 * 60000) || Loc.phoneFresh();
    if (startPos) onPosition(startPos); else renderNav();
    staleCheck();
  }

  // Navigation started before we had a route (no location yet): plan it now.
  function ensureRoute(p) {
    if (nav.routing || Date.now() - (nav.routeFailAt || 0) < 8000) return;
    nav.routing = true;
    renderNav();
    getRoute(p, nav.dest).then((r) => {
      if (!nav || !nav.active) return;
      Object.assign(nav, { route: r, routing: false, along: 0, seg: 0, stepIdx: 1, announced: {}, lastReroute: Date.now() });
      const first = r.steps[0];
      prefetchRoute(r);
      if (first) { Voice.say(first.verbal, true, { kind: 'straight' }); toast(first.text, 5000); }
      onPosition(nav.pos);
      staleCheck();
    }).catch((e) => {
      if (!nav) return;
      nav.routing = false; nav.routeFailAt = Date.now();
      toast('Route failed: ' + e.message + ' — retrying', 4000);
      renderNav();
    });
  }

  function onPosition(p) {
    if (!nav || !nav.active) return;
    // A real glasses fix always beats the phone's position.
    if (p.src === 'phone' && nav.pos && nav.pos.src !== 'phone' && Date.now() - nav.pos.t < 60000) return;
    nav.pos = p;
    if (!nav.route) { ensureRoute(p); renderNav(); return; }
    const r = nav.route;
    const here = [p.lat, p.lon];
    const snap = snapToRoute(r, here, nav.seg, nav.along);
    if (snap) {
      nav.offDist = snap.dist;
      const tolerance = Math.max(CFG.OFF_ROUTE_METRES, Math.min(60, (p.accuracy || 0) * 1.2));
      if (snap.dist <= tolerance) {
        nav.offCount = 0;
        // Only move forward (GPS jitter shouldn't rewind progress much).
        if (snap.along >= nav.along - 10) { nav.along = snap.along; nav.seg = snap.seg; }
      } else {
        nav.offCount++;
        if (nav.offCount >= 3 && !nav.rerouting && Date.now() - nav.lastReroute > 10000) reroute(p);
      }
    }

    // Arrival
    const end = r.shape[r.shape.length - 1];
    if (r.total - nav.along < CFG.ARRIVE_METRES || haversine(here, end) < CFG.ARRIVE_METRES) { arrive(); return; }

    // Which maneuver is next?
    let idx = r.steps.length - 1;
    for (let i = 1; i < r.steps.length; i++) {
      if (r.cum[r.steps[i].beginIdx] > nav.along + 3) { idx = i; break; }
    }
    if (idx !== nav.stepIdx) {
      const prevIdx = nav.stepIdx;
      nav.stepIdx = idx;
      // Just completed a turn: tell them how long the next stretch is, if it's long.
      const legLen = r.cum[r.steps[idx].beginIdx] - nav.along;
      if (idx > prevIdx && legLen > 150 && r.steps[idx].kind !== 'arrive') Voice.say(continuePhrase(r, idx));
    }
    announce();
    renderNav();
  }

  // Fixed wording so phrases can be fetched ahead of time (no waiting at a junction).
  const farPhrase = (verbal) => 'In ' + spokenDist(FAR_ANNOUNCE) + ', ' + lcFirst(trimDot(verbal)) + '.';
  function continuePhrase(r, idx) {
    const prev = r.steps[idx - 1];
    const legLen = r.cum[r.steps[idx].beginIdx] - r.cum[prev ? prev.beginIdx : 0];
    return 'Continue for ' + spokenDist(legLen) + '.';
  }
  function prefetchRoute(r) {
    const t = [];
    r.steps.forEach((s, i) => {
      if (i === 0) { t.push(s.verbal); return; }
      const verbal = s.kind === 'arrive' ? 'Your destination is ahead.' : s.verbal;
      t.push(trimDot(verbal) + '.', farPhrase(verbal), continuePhrase(r, i));
    });
    t.push('Re-routing.');
    Voice.prefetch(t);
  }

  function announce() {
    const r = nav.route, i = nav.stepIdx, step = r.steps[i];
    if (!step) return;
    const d = r.cum[step.beginIdx] - nav.along;
    const legLen = r.cum[step.beginIdx] - r.cum[r.steps[i - 1] ? r.steps[i - 1].beginIdx : 0];
    const a = nav.announced[i] || (nav.announced[i] = {});
    const verbal = step.kind === 'arrive' ? 'Your destination is ahead.' : step.verbal;
    const dir = DIR_KIND[step.kind] || 'straight';
    if (!a.far && d <= FAR_ANNOUNCE && d > NEAR_ANNOUNCE + 15 && legLen > FAR_ANNOUNCE + 20) {
      a.far = true;
      Voice.say(farPhrase(verbal), false, { kind: dir === 'left' ? 'prepare-left' : dir === 'right' ? 'prepare-right' : 'prepare' });
    }
    if (!a.near && d <= NEAR_ANNOUNCE + 5) {
      a.near = true; a.far = true;
      Voice.say(trimDot(verbal) + '.', true, { kind: dir === 'arrive' ? 'prepare' : dir });
    }
  }

  async function reroute(p) {
    if (!nav || nav.rerouting) return;
    if (!nav.route) { if (nav.pos) ensureRoute(nav.pos); return; }
    nav.rerouting = true;
    nav.lastReroute = Date.now();
    toast('Re-planning route…', 2500);
    Voice.say('Re-routing.', true, { kind: 'reroute' });
    try {
      const route = await getRoute(p || nav.pos, nav.dest);
      if (!nav || !nav.active) return;
      Object.assign(nav, { route, along: 0, seg: 0, offCount: 0, stepIdx: 1, announced: {}, peek: null });
      renderNav();
    } catch (e) {
      console.error(e);
      toast('Couldn’t re-plan: ' + e.message, 4000);
    } finally {
      if (nav) { nav.rerouting = false; nav.lastReroute = Date.now(); }
    }
  }

  function arrive() {
    const name = nav.dest.name;
    stopNav();
    Voice.say('You have arrived at ' + name + '.', true, { kind: 'arrive' });
    $('arrive-name').textContent = name;
    show('arrive', 'replace');
  }

  function stopNav() {
    if (nav) { nav.active = false; clearTimeout(nav.peekTimer); }
    Loc.stop();
    Heading.detach();
    keepAwake(false);
    clearTimeout(staleTimer);
  }

  function endRoute() {
    stopNav();
    Voice.stop();
    nav = null;
    $('nav-menu').hidden = true;
    goHome();
  }

  let staleTimer = null;
  function staleCheck() {
    clearTimeout(staleTimer);
    if (!nav || !nav.active) return;
    const stale = !DEMO && Date.now() - (Loc.lastFixAt || 0) > 15000;
    const weak = nav.pos && nav.pos.accuracy > 40;
    const w = $('gps-warn');
    w.hidden = !(stale || weak);
    w.textContent = stale ? 'Waiting for GPS' : 'Weak GPS';
    staleTimer = setTimeout(staleCheck, 3000);
  }

  // Peek at other steps with Left / Right
  function peek(delta) {
    const r = nav.route;
    if (!r) return;
    const base = nav.peek == null ? nav.stepIdx : nav.peek;
    const next = clamp(base + delta, 1, r.steps.length - 1);
    nav.peek = next === nav.stepIdx ? null : next;
    clearTimeout(nav.peekTimer);
    if (nav.peek != null) nav.peekTimer = setTimeout(() => { nav.peek = null; renderNav(); }, 8000);
    renderNav();
  }

  function zoom(delta) {
    if (!nav.route) return;
    nav.zoom = clamp(nav.zoom + delta, 0, ZOOMS.length - 1);
    toast('Map: ' + fmtDist(ZOOMS[nav.zoom] * 200) + ' ahead', 1200);
    requestDraw();
  }

  function openMenu() {
    $('nav-menu').hidden = false;
    $('toast').hidden = true;
    // The glasses may move focus after Back, so put it on Resume a few times.
    const resume = () => { if (!$('nav-menu').hidden) document.querySelector('#nav-menu [data-action="resume"]').focus(); };
    [0, 60, 200, 450].forEach((ms) => setTimeout(resume, ms));
    $('btn-voice').textContent = 'Sound: ' + Voice.label();
    const mm = document.querySelector('[data-action="mapmode"]');
    if (mm) mm.textContent = 'Map: ' + (nav && nav.mapMode === 'north' ? 'North up' : 'Facing up');
    focusScreen('nav');
  }
  function closeMenu() { $('nav-menu').hidden = true; focusScreen('nav'); }

  function renderNav() {
    if (!nav) return;
    const r = nav.route;
    if (!r) {
      $('instr-icon').innerHTML = maneuverSVG('depart');
      $('instr-dist').textContent = '–';
      $('instr-street').textContent = nav.routing ? 'Planning your route…' : 'Waiting for your location…';
      $('instr').classList.remove('soon', 'peek');
      $('peek-tag').hidden = true;
      $('nav-remaining').textContent = nav.dest.name;
      $('nav-eta').textContent = '';
      $('gps-warn').hidden = false;
      $('gps-warn').textContent = 'Waiting for GPS';
      requestDraw();
      return;
    }
    const i = nav.peek != null ? nav.peek : nav.stepIdx;
    const step = r.steps[i];
    if (step) {
      const d = Math.max(0, r.cum[step.beginIdx] - nav.along);
      $('instr-icon').innerHTML = maneuverSVG(step.kind);
      $('instr-dist').textContent = fmtDist(d);
      $('instr-street').textContent = step.kind === 'arrive' ? 'Arrive at ' + nav.dest.name : step.text;
      $('instr').classList.toggle('soon', nav.peek == null && d < 25);
      $('instr').classList.toggle('peek', nav.peek != null);
    }
    const tag = $('peek-tag');
    tag.hidden = nav.peek == null;
    if (nav.peek != null) tag.textContent = `Step ${nav.peek} of ${r.steps.length - 1}  ·  ‹ › to browse`;

    const remain = Math.max(0, r.total - nav.along);
    const secs = r.total > 0 ? r.duration * (remain / r.total) : 0;
    $('nav-remaining').textContent = fmtDist(remain) + ' · ' + fmtDur(secs);
    $('nav-eta').textContent = 'Arrive ' + fmtClock(new Date(Date.now() + secs * 1000));
    requestDraw();
  }

  // ------------------------------------------------------------------ mini map
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawMap(); });
  }

  function drawMap() {
    const c = $('map');
    if (!c || current !== 'nav' || !nav) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const r = nav.route;
    if (!r) return;
    const css = getComputedStyle(document.documentElement);
    const ACCENT = css.getPropertyValue('--accent').trim() || '#4fe3c1';

    const onRoute = nav.offCount === 0;
    const snapped = pointAt(r, nav.along);
    const raw = nav.pos ? [nav.pos.lat, nav.pos.lon] : snapped;
    const center = onRoute ? snapped : raw;

    const hdg = Heading.current();
    const th = rad(hdg == null ? 0 : hdg);
    const cos = Math.cos(th), sin = Math.sin(th);
    const cx = w / 2, cy = h * 0.66;
    let scale = ZOOMS[nav.zoom];
    // Off the route? Zoom out enough to show the way back to it.
    if (!onRoute && finite(nav.offDist)) scale = Math.max(scale, Math.min(20, (nav.offDist * 1.25) / (h * 0.55)));
    const S = (p) => {
      const [x, y] = project(p, center);
      return [cx + (x * cos - y * sin) / scale, cy - (x * sin + y * cos) / scale];
    };

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // travelled
    ctx.beginPath();
    for (let i = 0; i <= nav.seg; i++) { const [x, y] = S(r.shape[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    { const [x, y] = S(snapped); ctx.lineTo(x, y); }
    ctx.strokeStyle = '#3a454d'; ctx.lineWidth = 5; ctx.stroke();

    // remaining
    ctx.beginPath();
    { const [x, y] = S(snapped); ctx.moveTo(x, y); }
    for (let i = nav.seg + 1; i < r.shape.length; i++) { const [x, y] = S(r.shape[i]); ctx.lineTo(x, y); }
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 8; ctx.stroke();

    // off-route connector
    if (!onRoute) {
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); const a = S(raw), b = S(snapped);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 3; ctx.stroke();
      ctx.setLineDash([]);
    }

    // next maneuver + peeked maneuver
    const ring = (p, rad_, col, lw) => { const [x, y] = S(p); ctx.beginPath(); ctx.arc(x, y, rad_, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); };
    const nextStep = r.steps[nav.stepIdx];
    if (nextStep && nextStep.kind !== 'arrive') ring(r.shape[nextStep.beginIdx], 7, '#ffffff', 3);
    if (nav.peek != null) ring(r.shape[r.steps[nav.peek].beginIdx], 11, '#ffffff', 2);

    // destination
    {
      const [x, y] = S(r.shape[r.shape.length - 1]);
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.strokeStyle = ACCENT; ctx.lineWidth = 4; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill();
    }

    // accuracy halo + you
    const [ux, uy] = S(raw);
    const acc = nav.pos && nav.pos.accuracy;
    if (finite(acc) && acc > 10) {
      ctx.beginPath(); ctx.arc(ux, uy, Math.min(acc / scale, w), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79,227,193,0.10)'; ctx.fill();
    }
    ctx.save();
    ctx.translate(ux, uy);
    if (hdg != null) {
      ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(11, 11); ctx.lineTo(0, 5); ctx.lineTo(-11, 11); ctx.closePath();
      ctx.fillStyle = '#ffffff'; ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    }
    ctx.restore();

    // north indicator
    ctx.save();
    ctx.translate(w - 20, 20);
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.strokeStyle = '#3a454d'; ctx.lineWidth = 2; ctx.stroke();
    ctx.rotate(-th);
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(5, -3); ctx.lineTo(-5, -3); ctx.closePath();
    ctx.fillStyle = '#ff6b6b'; ctx.fill();
    ctx.fillStyle = '#f2f5f7'; ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, 5);
    ctx.restore();
  }

  window.addEventListener('resize', requestDraw);

  // ------------------------------------------------------------------ focus movement
  // The glasses move focus with the arrow keys. The built-in spatial navigation
  // can get stuck at the edge of a scrolling list (e.g. never reaching Recent),
  // so Waypoint moves focus itself: nearest control in the pressed direction,
  // scrolled into view.
  const FocusNav = {
    scope() {
      if (current === 'nav') return $('nav-menu').hidden ? null : $('nav-menu');
      return document.querySelector('.screen:not([hidden])');
    },
    items(scope) {
      return [...scope.querySelectorAll('button, input, [tabindex="0"]')].filter((el) =>
        !el.disabled && el.id !== 'nav-focus' && !el.closest('[hidden]') && el.getClientRects().length);
    },
    move(dir) {
      const scope = FocusNav.scope();
      if (!scope) return false;
      const items = FocusNav.items(scope);
      if (!items.length) return false;
      const cur = document.activeElement;
      if (!cur || !scope.contains(cur) || cur === document.body) { items[0].focus(); return true; }

      // A focused scroll area scrolls first, then hands focus on at its edge.
      if (cur.classList.contains('scroll') && (dir === 'down' || dir === 'up')) {
        const before = cur.scrollTop;
        cur.scrollBy({ top: (dir === 'down' ? 1 : -1) * cur.clientHeight * 0.6 });
        if (cur.scrollTop !== before) return true;
      }

      const r = cur.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let best = null, bestScore = Infinity;
      for (const el of items) {
        if (el === cur) continue;
        const b = el.getBoundingClientRect();
        const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
        let along, across;
        if (dir === 'down') { if (b.top < r.bottom - 6) continue; along = b.top - r.bottom; across = overlapGap(r.left, r.right, b.left, b.right, cx, ex); }
        else if (dir === 'up') { if (b.bottom > r.top + 6) continue; along = r.top - b.bottom; across = overlapGap(r.left, r.right, b.left, b.right, cx, ex); }
        else if (dir === 'right') { if (b.left < r.right - 6) continue; along = b.left - r.right; across = overlapGap(r.top, r.bottom, b.top, b.bottom, cy, ey); }
        else { if (b.right > r.left + 6) continue; along = r.left - b.right; across = overlapGap(r.top, r.bottom, b.top, b.bottom, cy, ey); }
        const score = Math.max(0, along) + across * 2.5;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) {
        best.focus({ preventScroll: true });
        best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return true;
      }
      return true;   // at the edge: stay put rather than letting the page jump
    },
  };
  // 0 when the two ranges overlap; otherwise how far apart they are (falls back to centre distance)
  function overlapGap(a1, a2, b1, b2, ca, cb) {
    if (b1 < a2 && b2 > a1) return Math.abs(ca - cb) * 0.05;
    return Math.min(Math.abs(b1 - a2), Math.abs(a1 - b2), Math.abs(ca - cb));
  }

  document.addEventListener('keydown', (e) => {
    const dir = { ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir) return;
    if (current === 'nav' && $('nav-menu').hidden) return;   // the route screen has its own keys
    if (FocusNav.move(dir)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ------------------------------------------------------------------ input
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) {
      const a = el.dataset.action;
      if (a === 'back') history.back();
      else if (a === 'go') startNav();
      else if (a === 'save') toggleSave();
      else if (a === 'resume') closeMenu();
      else if (a === 'voice') Voice.cycle();
      else if (a === 'mapmode') {
        nav.mapMode = nav.mapMode === 'north' ? 'auto' : 'north';
        store.set('mapMode', nav.mapMode);
        el.textContent = 'Map: ' + (nav.mapMode === 'north' ? 'North up' : 'Facing up');
        requestDraw();
      }
      else if (a === 'reroute') { closeMenu(); reroute(nav && nav.pos); }
      else if (a === 'end') endRoute();
      else if (a === 'done') { nav = null; goHome(); }
      else if (a === 'phone') openPhone();
      else if (a === 'loc') { renderLocInfo(); show('loc'); }
      else if (a === 'locretry') { Loc.ensure(true); toast('Looking for your location…'); renderLocInfo(); }
      else if (a === 'newcode') { Relay.start(true); $('phone-code').textContent = Relay.pretty(); toast('New code — enter it on your phone'); }
      return;
    }
    if (e.target.id === 'nav-focus') openMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (current !== 'nav' || !nav || !nav.active) return;
    if (!$('nav-menu').hidden) return;            // let spatial nav drive the menu
    const k = e.key;
    if (k === 'ArrowLeft') { peek(-1); e.preventDefault(); }
    else if (k === 'ArrowRight') { peek(1); e.preventDefault(); }
    else if (k === 'ArrowUp') { zoom(-1); e.preventDefault(); }
    else if (k === 'ArrowDown') { zoom(1); e.preventDefault(); }
    else if (k === 'Enter' && document.activeElement !== $('nav-focus')) { openMenu(); e.preventDefault(); }
  });

  // ------------------------------------------------------------------ boot
  // Add the map-orientation option to the nav menu
  {
    const b = document.createElement('button');
    b.className = 'btn'; b.dataset.action = 'mapmode'; b.textContent = 'Map: Facing up';
    $('btn-voice').after(b);
  }
  // Keep a #sync= key across Waypoint's own screen changes by moving it into the query.
  let bootSearch = location.search;
  if (Backup.token && !new URLSearchParams(location.search).get('sync')) {
    const qs = new URLSearchParams(location.search); qs.set('sync', Backup.token); bootSearch = '?' + qs.toString();
  }
  history.replaceState({ s: 'home', d: 0 }, '', location.pathname + bootSearch + '#home');
  renderHome();
  renderChips();
  show('home', 'none');
  Relay.start();
  Loc.start();
  Backup.start();
  try { if (sessionStorage.getItem('wp.restored')) { sessionStorage.removeItem('wp.restored'); setTimeout(() => toast('Restored your saved places and settings from GitHub ✓', 4500), 600); } } catch { /* ignore */ }
  renderLocBadge();
  if (DEMO) toast('Demo mode: walking is simulated', 3000);
  console.info('Waypoint', USE_MAPBOX ? 'using Mapbox' : 'using OpenStreetMap (Photon + Valhalla)', DEMO ? '[demo]' : '');
})();
