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
    set(k, v) { try { localStorage.setItem('wp.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };

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
  const Loc = {
    last: null,      // {lat, lon, accuracy, heading, speed, t}
    watchId: null,
    lastFixAt: 0,

    norm(pos) {
      const c = pos.coords;
      return { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, t: Date.now() };
    },

    getOnce(timeout = 15000) {
      if (DEMO) return Promise.resolve(Sim.current());
      if (Loc.last && Date.now() - Loc.last.t < 20000) return Promise.resolve(Loc.last);
      return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('Location is not available on this device.'));
        navigator.geolocation.getCurrentPosition(
          (pos) => { Loc.last = Loc.norm(pos); Loc.lastFixAt = Date.now(); resolve(Loc.last); },
          (err) => reject(new Error(locError(err))),
          { timeout }
        );
      });
    },

    watch(cb) {
      Loc.stop();
      if (DEMO) { Sim.start(cb); return; }
      if (!('geolocation' in navigator)) return;
      Loc.watchId = navigator.geolocation.watchPosition(
        (pos) => { Loc.last = Loc.norm(pos); Loc.lastFixAt = Date.now(); cb(Loc.last); },
        (err) => { if (err && err.code === 1) toast(locError(err), 4000); }, // brief dropouts: the GPS badge covers it
        { enableHighAccuracy: true }
      );
    },

    stop() {
      if (DEMO) Sim.stop();
      if (Loc.watchId != null) navigator.geolocation.clearWatch(Loc.watchId);
      Loc.watchId = null;
    },
  };

  function locError(err) {
    if (!err) return 'Location unavailable.';
    if (err.code === 1) return 'Location permission is off. Allow location for the Meta AI app on your phone.';
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
  const Voice = {
    on: store.get('voice', CFG.VOICE),
    ok: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    say(text, interrupt = false) {
      if (!Voice.on || !Voice.ok || !text) return;
      try {
        if (interrupt) speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = CFG.LANGUAGE;
        u.rate = 1.05;
        speechSynthesis.speak(u);
      } catch (e) { console.warn('TTS', e); }
    },
    toggle() {
      Voice.on = !Voice.on;
      store.set('voice', Voice.on);
      if (!Voice.on && Voice.ok) speechSynthesis.cancel();
      $('btn-voice').textContent = 'Voice: ' + (Voice.on ? 'On' : 'Off');
    },
  };

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

  function focusScreen(name) {
    requestAnimationFrame(() => {
      let el = null;
      if (name === 'home') el = $('search-input');
      if (name === 'results') el = document.querySelector('#results-list .item') || $('research-input');
      if (name === 'phone') el = document.querySelector('#screen-phone .btn');
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

  // ------------------------------------------------------------------ search
  // The heavy lifting (postcode fixing, categories, multi-service matching)
  // lives in search.js so the phone page can share it.
  let searchSeq = 0;
  let lastQuery = { q: '', at: 0 };

  function showResults(list, near, status) {
    $('results-status').textContent = status || '';
    $('results-list').replaceChildren(...list.map((p) => {
      const meta = near ? fmtDist(finite(p.dist) ? p.dist : haversine([near.lat, near.lon], [p.lat, p.lon])) : '';
      return placeButton(p, p.src === 'postcode' ? 'pin' : 'pin', meta);
    }));
    if (current === 'results') focusScreen('results');
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
    try { near = await Loc.getOnce(8000); } catch { /* search without location bias */ }

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
        Voice.say('Nothing found.', true);
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
    $('results-status').textContent = 'Looking nearby…';
    $('results-list').replaceChildren();
    show('results');
    try {
      const near = await Loc.getOnce(10000);
      const list = await WPSearch.category(key, near);
      if (seq !== searchSeq) return;
      showResults(list, near, list.length ? '' : 'Nothing found within 2.5 km.');
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
      if (reset || !store.get('pairCode', null)) store.set('pairCode', Relay.newCode());
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
      if (p.ping) { toast('Phone paired ✓', 3000); Voice.say('Phone paired.'); return; }
      const place = (finite(p.lat) && finite(p.lon)) ? { name: p.name || 'Pinned location', sub: p.sub || '', lat: p.lat, lon: p.lon } : null;
      const label = place ? place.name : p.q;
      if (!label) return;
      if (nav && nav.active) {
        if (place) addRecent(place);
        toast('From phone: ' + label + (place ? ' (in Recent)' : ''), 5000);
        return;
      }
      Voice.say('From your phone: ' + label + '.', true);
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
    $('btn-go').disabled = true;
    updateSaveBtn();
    show('preview', mode);

    const token = preview;
    try {
      const from = await Loc.getOnce(15000);
      const route = await getRoute(from, place);
      if (preview !== token) return;
      preview.route = route; preview.from = from;
      $('pv-time').textContent = fmtDur(route.duration);
      $('pv-dist').textContent = fmtDist(route.total);
      $('pv-eta').textContent = fmtClock(new Date(Date.now() + route.duration * 1000));
      $('pv-status').textContent = USE_MAPBOX ? 'Route by Mapbox' : 'Route by OpenStreetMap / Valhalla';
      $('btn-go').disabled = false;
      if (current === 'preview') $('btn-go').focus();
    } catch (e) {
      if (preview !== token) return;
      console.error(e);
      $('pv-status').textContent = e.message || 'Couldn’t find a route.';
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
    if (!preview || !preview.route) return;
    $('btn-go').disabled = true;
    await Heading.request();          // must follow the Go press (user gesture)

    nav = {
      active: true,
      dest: preview.place,
      route: preview.route,
      pos: preview.from,
      along: 0, seg: 0, offDist: 0, offCount: 0,
      stepIdx: 1, announced: {},
      lastReroute: Date.now(), rerouting: false,
      peek: null, peekTimer: null,
      zoom: 1, mapMode: store.get('mapMode', 'auto'), lastCourse: null,
    };
    addRecent(nav.dest);
    $('search-input').value = '';
    $('nav-menu').hidden = true;
    $('btn-voice').textContent = 'Voice: ' + (Voice.on ? 'On' : 'Off');
    show('nav');
    keepAwake(true);

    const first = nav.route.steps[0];
    if (first) { Voice.say(first.verbal, true); toast(first.text, 5000); }

    if (nav.pos) onPosition(nav.pos);
    Loc.watch(onPosition);
    staleCheck();
  }

  function onPosition(p) {
    if (!nav || !nav.active) return;
    nav.pos = p;
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
        if (nav.offCount >= 3 && !nav.rerouting && Date.now() - nav.lastReroute > 12000) reroute(p);
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
      if (idx > prevIdx && legLen > 150 && r.steps[idx].kind !== 'arrive') Voice.say('Continue for ' + spokenDist(legLen) + '.');
    }
    announce();
    renderNav();
  }

  function announce() {
    const r = nav.route, i = nav.stepIdx, step = r.steps[i];
    if (!step) return;
    const d = r.cum[step.beginIdx] - nav.along;
    const legLen = r.cum[step.beginIdx] - r.cum[r.steps[i - 1] ? r.steps[i - 1].beginIdx : 0];
    const a = nav.announced[i] || (nav.announced[i] = {});
    const verbal = step.kind === 'arrive' ? 'Your destination is ahead.' : step.verbal;
    if (!a.far && d <= FAR_ANNOUNCE && d > NEAR_ANNOUNCE + 15 && legLen > FAR_ANNOUNCE + 20) {
      a.far = true;
      Voice.say('In ' + spokenDist(d) + ', ' + lcFirst(verbal) + '.');
    }
    if (!a.near && d <= NEAR_ANNOUNCE + 5) {
      a.near = true; a.far = true;
      Voice.say(verbal + '.', true);
    }
  }

  async function reroute(p) {
    if (!nav || nav.rerouting) return;
    nav.rerouting = true;
    nav.lastReroute = Date.now();
    toast('Re-planning route…', 2500);
    Voice.say('Re-routing.', true);
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
    Voice.say('You have arrived at ' + name + '.', true);
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
    if (Voice.ok) speechSynthesis.cancel();
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
    const base = nav.peek == null ? nav.stepIdx : nav.peek;
    const next = clamp(base + delta, 1, r.steps.length - 1);
    nav.peek = next === nav.stepIdx ? null : next;
    clearTimeout(nav.peekTimer);
    if (nav.peek != null) nav.peekTimer = setTimeout(() => { nav.peek = null; renderNav(); }, 8000);
    renderNav();
  }

  function zoom(delta) {
    nav.zoom = clamp(nav.zoom + delta, 0, ZOOMS.length - 1);
    toast('Map: ' + fmtDist(ZOOMS[nav.zoom] * 200) + ' ahead', 1200);
    requestDraw();
  }

  function openMenu() {
    $('nav-menu').hidden = false;
    const mm = document.querySelector('[data-action="mapmode"]');
    if (mm) mm.textContent = 'Map: ' + (nav && nav.mapMode === 'north' ? 'North up' : 'Facing up');
    focusScreen('nav');
  }
  function closeMenu() { $('nav-menu').hidden = true; focusScreen('nav'); }

  function renderNav() {
    if (!nav) return;
    const r = nav.route;
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
    const css = getComputedStyle(document.documentElement);
    const ACCENT = css.getPropertyValue('--accent').trim() || '#4fe3c1';

    const onRoute = nav.offCount === 0;
    const snapped = pointAt(r, nav.along);
    const raw = nav.pos ? [nav.pos.lat, nav.pos.lon] : snapped;
    const center = onRoute ? snapped : raw;

    const hdg = Heading.current();
    const th = rad(hdg == null ? 0 : hdg);
    const cos = Math.cos(th), sin = Math.sin(th);
    const scale = ZOOMS[nav.zoom];
    const cx = w / 2, cy = h * 0.66;
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

  // ------------------------------------------------------------------ input
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) {
      const a = el.dataset.action;
      if (a === 'back') history.back();
      else if (a === 'go') startNav();
      else if (a === 'save') toggleSave();
      else if (a === 'resume') closeMenu();
      else if (a === 'voice') Voice.toggle();
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
  history.replaceState({ s: 'home', d: 0 }, '', location.pathname + location.search + '#home');
  renderHome();
  renderChips();
  show('home', 'none');
  Relay.start();
  if (DEMO) toast('Demo mode: walking is simulated', 3000);
  console.info('Waypoint', USE_MAPBOX ? 'using Mapbox' : 'using OpenStreetMap (Photon + Valhalla)', DEMO ? '[demo]' : '');
})();
