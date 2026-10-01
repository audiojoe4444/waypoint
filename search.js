/* Waypoint search engine — shared by the glasses app (index.html) and the
 * phone companion (send.html).
 *
 *   WPSearch.find(text, near)      → { kind, heard, searched, results[] }
 *   WPSearch.category(key, near)   → results[]
 *   WPSearch.parseMapLink(text)    → place | { short:true } | null
 *
 * A place is { name, sub, lat, lon, src }.
 *
 * What makes it forgiving:
 *  1. Postcode fixer — turns whatever dictation/handwriting produced
 *     ("sw one a two a a", "S.W.1A2AA", "SW1A ZAA") into real UK postcodes,
 *     checked against postcodes.io (free, official ONS data).
 *  2. Category words ("coffee", "nearest chemist", "loo") → nearby places.
 *  3. Names go to several services at once (Mapbox if you have a key, Photon,
 *     Nominatim), merged and ranked by how close they are to you. If nothing
 *     matches, it retries with likely mis-heard words dropped.
 */
(function () {
  'use strict';

  const CFG = window.WAYPOINT_CONFIG || {};
  const TOKEN = /^pk\./.test((CFG.MAPBOX_TOKEN || '').trim()) ? CFG.MAPBOX_TOKEN.trim() : '';
  const LANG = CFG.LANGUAGE || 'en-GB';
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  // ------------------------------------------------------------ utils
  async function getJSON(url, opts = {}, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
      const body = await res.json().catch(() => null);
      if (!res.ok) { const e = new Error((body && (body.error || body.message)) || 'HTTP ' + res.status); e.status = res.status; throw e; }
      return body;
    } finally { clearTimeout(t); }
  }

  function distM(a, b) {
    const r = (d) => d * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  // ------------------------------------------------------------ query clean-up
  const FILLER_START = /^(?:(?:please|ok|okay|hey|um+|uh+)\s+)*(?:(?:can you\s+)?(?:take me|navigate|directions|direct me|get me|guide me|walk me|go|walk|head)\s+to|find(?: me)?|search(?: for)?|look(?:ing)? for|show me|where(?: is|'s| s)|i want to go to|i need(?: to go to)?|i'm going to|im going to)\s+/i;
  const FILLER_END = /\s+(?:please|thanks|thank you)$/i;

  function clean(text) {
    let q = String(text || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 2; i++) q = q.replace(FILLER_START, '').replace(FILLER_END, '').trim();
    return q.replace(/^[.,!?"']+|[.,!?"']+$/g, '').trim();
  }

  // ------------------------------------------------------------ categories
  const CATEGORIES = [
    { key: 'coffee',   label: 'Coffee',   words: ['coffee', 'coffee shop', 'cafe', 'cafes', 'caff', 'tea'],                        osm: ['amenity=cafe'],                     mapbox: 'coffee' },
    { key: 'food',     label: 'Food',     words: ['food', 'restaurant', 'restaurants', 'something to eat', 'eat', 'lunch', 'dinner', 'breakfast', 'takeaway', 'fast food'], osm: ['amenity=restaurant', 'amenity=fast_food'], mapbox: 'restaurant' },
    { key: 'pub',      label: 'Pub',      words: ['pub', 'pubs', 'bar', 'bars', 'beer', 'a drink', 'drink'],                       osm: ['amenity=pub', 'amenity=bar'],       mapbox: 'pub' },
    { key: 'station',  label: 'Station',  words: ['station', 'stations', 'train station', 'railway station', 'tube', 'tube station', 'underground', 'train', 'trains', 'overground'], osm: ['railway=station', 'railway=halt'], mapbox: 'train_station' },
    { key: 'shop',     label: 'Shop',     words: ['shop', 'shops', 'supermarket', 'supermarkets', 'grocery', 'groceries', 'corner shop', 'convenience store', 'off licence'], osm: ['shop=supermarket', 'shop=convenience'], mapbox: 'supermarket' },
    { key: 'pharmacy', label: 'Pharmacy', words: ['pharmacy', 'pharmacies', 'chemist', 'chemists', 'drugstore'],                   osm: ['amenity=pharmacy'],                 mapbox: 'pharmacy' },
    { key: 'cash',     label: 'Cash',     words: ['cash', 'atm', 'atms', 'cashpoint', 'cash point', 'cash machine', 'bank', 'banks'], osm: ['amenity=atm', 'amenity=bank'],      mapbox: 'atm' },
    { key: 'toilets',  label: 'Toilets',  words: ['toilet', 'toilets', 'loo', 'loos', 'restroom', 'bathroom', 'wc', 'public toilet', 'public toilets', 'lavatory'], osm: ['amenity=toilets'], mapbox: 'toilets' },
  ];

  function matchCategory(q) {
    let n = norm(q).replace(/^(?:the |a |an |some )?(?:nearest|closest|nearby|local)?\s*/, '')
      .replace(/\s+(?:near me|nearby|near here|around here|close by)$/, '').trim();
    if (!n) return null;
    return CATEGORIES.find((c) => c.words.includes(n)) || null;
  }

  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

  async function overpass(cat, near, radius) {
    const parts = cat.osm.map((t) => { const [k, v] = t.split('='); return `nwr["${k}"="${v}"](around:${radius},${near.lat},${near.lon});`; }).join('');
    const ql = `[out:json][timeout:12];(${parts});out center tags 80;`;
    let lastErr;
    for (const ep of OVERPASS) {
      try {
        const data = await getJSON(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(ql),
        }, 14000);
        return (data.elements || []).map((el) => {
          const t = el.tags || {};
          const lat = finite(el.lat) ? el.lat : el.center && el.center.lat;
          const lon = finite(el.lon) ? el.lon : el.center && el.center.lon;
          const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
          let extra = '';
          if (cat.key === 'station') extra = t.station === 'subway' ? 'Underground' : (t.network || 'Station');
          if (cat.key === 'toilets') extra = t.fee === 'no' ? 'Free' : t.fee === 'yes' ? 'Paid' : '';
          if (cat.key === 'cash' && t.amenity === 'bank') extra = 'Bank';
          return {
            name: t.name || t.brand || t.operator || cat.label,
            sub: [extra, street].filter(Boolean).join(' · '),
            lat, lon, src: 'osm',
          };
        }).filter((p) => finite(p.lat) && finite(p.lon));
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Nearby search failed');
  }

  async function mapboxCategory(cat, near) {
    const url = `https://api.mapbox.com/search/searchbox/v1/category/${cat.mapbox}?limit=20&language=${LANG.split('-')[0]}` +
      `&proximity=${near.lon},${near.lat}&access_token=${TOKEN}`;
    const data = await getJSON(url);
    return (data.features || []).map(mapboxFeature);
  }

  async function category(key, near) {
    const cat = typeof key === 'string' ? CATEGORIES.find((c) => c.key === key) : key;
    if (!cat) return [];
    if (!near) throw new Error('Nearby search needs your location.');
    let list = [];
    try {
      list = await overpass(cat, near, 900);
      if (list.length < 3) list = await overpass(cat, near, 2500);
    } catch (e) {
      if (!TOKEN) throw e;
      list = await mapboxCategory(cat, near);
    }
    list.forEach((p) => { p.dist = distM(near, p); });
    list.sort((a, b) => a.dist - b.dist);
    // Drop exact duplicates (a node and a building for the same place)
    const out = [];
    for (const p of list) if (!out.some((o) => norm(o.name) === norm(p.name) && distM(o, p) < 40)) out.push(p);
    return out.slice(0, 12);
  }

  // ------------------------------------------------------------ postcodes
  const NUM = { zero: '0', oh: '0', o: '0', nought: '0', nil: '0', one: '1', won: '1', two: '2', to: '2', too: '2',
    three: '3', tree: '3', free: '3', four: '4', for: '4', fore: '4', five: '5', six: '6', sicks: '6', seven: '7',
    eight: '8', ate: '8', nine: '9', nein: '9' };
  const LET = { a: 'A', ay: 'A', eh: 'A', b: 'B', bee: 'B', be: 'B', c: 'C', see: 'C', sea: 'C', cee: 'C', d: 'D', dee: 'D',
    e: 'E', ee: 'E', f: 'F', ef: 'F', eff: 'F', g: 'G', gee: 'G', h: 'H', aitch: 'H', haitch: 'H', i: 'I', eye: 'I',
    j: 'J', jay: 'J', k: 'K', kay: 'K', l: 'L', el: 'L', ell: 'L', m: 'M', em: 'M', n: 'N', en: 'N', p: 'P', pee: 'P', pea: 'P',
    q: 'Q', queue: 'Q', cue: 'Q', r: 'R', are: 'R', ar: 'R', s: 'S', es: 'S', ess: 'S', t: 'T', tee: 'T', tea: 'T',
    u: 'U', you: 'U', v: 'V', vee: 'V', w: 'W', x: 'X', ex: 'X', y: 'Y', why: 'Y', z: 'Z', zed: 'Z', zee: 'Z',
    alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I',
    juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R',
    sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', whisky: 'W', xray: 'X', yankee: 'Y', zulu: 'Z' };

  const PC_FULL = /^(GIR0AA|(?:[A-PR-UWYZ][0-9][0-9]?|[A-PR-UWYZ][A-HK-Y][0-9][0-9]?|[A-PR-UWYZ][0-9][A-HJKPSTUW]|[A-PR-UWYZ][A-HK-Y][0-9][ABEHMNPRVWXY])[0-9][ABD-HJLNP-UW-Z]{2})$/;
  const PC_OUT = /^(?:[A-PR-UWYZ][0-9][0-9]?|[A-PR-UWYZ][A-HK-Y][0-9][0-9]?|[A-PR-UWYZ][0-9][A-HJKPSTUW]|[A-PR-UWYZ][A-HK-Y][0-9][ABEHMNPRVWXY])$/;
  const OUT_PATTERNS = { 2: ['LD'], 3: ['LDD', 'LLD', 'LDL'], 4: ['LLDD', 'LLDL'] };
  const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
  const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G', 4: 'A' };

  const fmtPC = (s) => s.slice(0, -3) + ' ' + s.slice(-3);

  // Turn spoken/handwritten tokens into postcode-ish character runs.
  function tokenRuns(text) {
    const toks = String(text).toLowerCase().replace(/x-ray/g, 'xray').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    const mapped = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if ((t === 'double' || t === 'triple') && toks[i + 1]) {
        const n = t === 'double' ? 2 : 3;
        if (toks[i + 1] === 'you' || toks[i + 1] === 'u') { mapped.push(n === 2 ? 'W' : null); i++; continue; } // "double you" = W
        const c = LET[toks[i + 1]] || NUM[toks[i + 1]] || (/^[a-z0-9]$/.test(toks[i + 1]) ? toks[i + 1].toUpperCase() : null);
        if (c) { mapped.push(c.repeat(n)); i++; continue; }
      }
      if (NUM[t] || LET[t]) { mapped.push(NUM[t] && !LET[t] ? NUM[t] : (LET[t] || NUM[t])); continue; }
      if (/^[a-z0-9]{1,8}$/.test(t) && /\d/.test(t)) { mapped.push(t.toUpperCase()); continue; }
      if (/^[a-z]{2}$/.test(t)) { mapped.push(t.toUpperCase()); continue; }   // area letters: "sw", "ec"
      const prev = mapped[mapped.length - 1];
      if (/^[a-z]{3}$/.test(t) && prev && /\d/.test(prev)) { mapped.push(t.toUpperCase()); continue; } // "sw1a zaa"
      mapped.push(null);
    }
    // contiguous runs of non-null tokens
    const runs = [];
    let cur = [];
    for (const m of mapped.concat([null])) {
      if (m == null) { if (cur.length) runs.push(cur); cur = []; } else cur.push(m);
    }
    return { runs, total: mapped.length };
  }

  function coerce(s, pattern) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i], want = pattern[i];
      if (want === 'D') { const d = /\d/.test(c) ? c : TO_DIGIT[c]; if (!d) return null; out += d; }
      else { const l = /[A-Z]/.test(c) ? c : TO_LETTER[c]; if (!l) return null; out += l; }
    }
    return out;
  }

  // All plausible full postcodes from a raw string of 5–7 chars.
  function fullCandidates(s) {
    const set = new Set();
    if (PC_FULL.test(s)) set.add(s);
    const inward = coerce(s.slice(-3), 'DLL');
    const outRaw = s.slice(0, -3);
    if (inward && OUT_PATTERNS[outRaw.length]) {
      for (const pat of OUT_PATTERNS[outRaw.length]) {
        const o = coerce(outRaw, pat);
        if (o && PC_FULL.test(o + inward)) set.add(o + inward);
      }
    }
    return [...set];
  }

  function postcodeCandidates(text) {
    const { runs, total } = tokenRuns(text);
    const full = new Map(), outs = new Set();   // candidate -> characters of input it used
    let wholeRun = false;
    for (const run of runs) {
      // try every contiguous slice of tokens in this run
      for (let i = 0; i < run.length; i++) {
        let s = '';
        for (let j = i; j < run.length; j++) {
          s += run[j];
          if (s.length > 8) break;
          if (s.length >= 5 && s.length <= 7) fullCandidates(s).forEach((c) => full.set(c, Math.max(full.get(c) || 0, j - i + 1)));
        }
      }
      const joined = run.join('');
      if (run.length === total) wholeRun = true;
      if (run.length === total && joined.length >= 2 && joined.length <= 4) {
        for (const pat of OUT_PATTERNS[joined.length] || []) {
          const o = coerce(joined, pat);
          if (o && PC_OUT.test(o) && /\d/.test(joined)) outs.add(o);
        }
      }
    }
    const ranked = [...full.entries()].sort((a, b) => b[1] - a[1]);
    return { full: ranked.map((e) => e[0]).slice(0, 40), span: Object.fromEntries(ranked), outs: [...outs].slice(0, 6), wholeRun };
  }

  async function reverseStreet(lat, lon) {
    try {
      const d = await getJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1&lang=en`, {}, 3500);
      const p = d.features && d.features[0] && d.features[0].properties;
      return p ? (p.street || p.name || '') : '';
    } catch { return ''; }
  }

  async function lookupPostcodes(text) {
    const { full, span, outs, wholeRun } = postcodeCandidates(text);
    const out = [];
    if (full.length) {
      try {
        const data = await getJSON('https://api.postcodes.io/postcodes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postcodes: full.map(fmtPC) }),
        }, 8000);
        let best = 0;
        const valid = (data.result || []).filter((r) => r.result && finite(r.result.latitude));
        valid.forEach((r) => { best = Math.max(best, span[r.query.replace(/\s/g, '')] || 0); });
        for (const r of valid) {
          const d = r.result;
          if ((span[r.query.replace(/\s/g, '')] || 0) < best) continue;   // prefer the reading that uses the most of what you said
          out.push({
            name: d.postcode,
            sub: [d.admin_ward, d.admin_district].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
            lat: d.latitude, lon: d.longitude, src: 'postcode',
          });
        }
      } catch (e) { console.warn('postcodes.io', e); }
    }
    if (!out.length && outs.length) {
      for (const oc of outs) {
        try {
          const d = (await getJSON('https://api.postcodes.io/outcodes/' + oc, {}, 6000)).result;
          if (d && finite(d.latitude)) out.push({ name: d.outcode + ' (area)', sub: (d.admin_district || []).slice(0, 2).join(', '), lat: d.latitude, lon: d.longitude, src: 'postcode' });
        } catch { /* not a real outcode */ }
      }
    }
    // Add the street name to each postcode result — easier to recognise.
    await Promise.all(out.slice(0, 4).map(async (p) => {
      const street = await reverseStreet(p.lat, p.lon);
      if (street) p.sub = street + (p.sub ? ', ' + p.sub : '');
    }));
    return { results: out, wholeRun };
  }

  // ------------------------------------------------------------ name search providers
  function mapboxFeature(f) {
    const p = f.properties || {}, c = p.coordinates || {};
    return {
      name: p.name || p.full_address || 'Unnamed place',
      sub: p.feature_type === 'poi' ? (p.full_address || p.place_formatted || '') : (p.place_formatted || p.full_address || ''),
      lat: finite(c.latitude) ? c.latitude : f.geometry.coordinates[1],
      lon: finite(c.longitude) ? c.longitude : f.geometry.coordinates[0],
      src: 'mapbox',
    };
  }

  async function mapboxForward(q, near) {
    let url = 'https://api.mapbox.com/search/searchbox/v1/forward?limit=8&auto_complete=true&language=' + LANG.split('-')[0] +
      '&q=' + encodeURIComponent(q) + '&access_token=' + TOKEN;
    url += near ? `&proximity=${near.lon.toFixed(5)},${near.lat.toFixed(5)}` : '&proximity=ip';
    const data = await getJSON(url);
    return (data.features || []).map(mapboxFeature);
  }

  async function photon(q, near) {
    const lang = /^en/i.test(LANG) ? 'en' : 'default';
    let url = 'https://photon.komoot.io/api/?limit=8&lang=' + lang + '&q=' + encodeURIComponent(q);
    if (near) url += `&lat=${near.lat.toFixed(5)}&lon=${near.lon.toFixed(5)}&location_bias_scale=0.4`;
    const data = await getJSON(url);
    return (data.features || []).map((f) => {
      const p = f.properties || {};
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const name = p.name || street || p.city || p.county || 'Unnamed place';
      const parts = [p.name ? street : null, p.district || p.locality, p.city, p.postcode].filter((x) => x && x !== name);
      return { name, sub: [...new Set(parts)].join(', '), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], src: 'photon' };
    });
  }

  async function nominatim(q, near) {
    let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' + encodeURIComponent(q);
    if (near) { const d = 0.4; url += '&viewbox=' + [near.lon - d, near.lat + d, near.lon + d, near.lat - d].map((n) => n.toFixed(4)).join(','); }
    const data = await getJSON(url, { headers: { 'Accept-Language': LANG } });
    return (data || []).map((r) => {
      const bits = String(r.display_name || '').split(',').map((s) => s.trim());
      const name = r.name || bits[0];
      return { name, sub: bits.filter((b) => b !== name).slice(0, 3).join(', '), lat: +r.lat, lon: +r.lon, src: 'nominatim' };
    });
  }

  // Merge several ranked lists into one, nearest-and-best first, no duplicates.
  function merge(lists, near, q) {
    const nq = norm(q);
    const all = [];
    lists.forEach((list) => list.forEach((p, idx) => {
      if (!finite(p.lat) || !finite(p.lon)) return;
      let score = idx;
      if (p.src === 'mapbox') score -= 0.8;
      if (p.src === 'nominatim') score += 0.5;
      if (near) { p.dist = distM(near, p); score += Math.min(8, Math.log2(1 + p.dist / 1000) * 1.1); }
      const nn = norm(p.name);
      if (nn === nq) score -= 1.5; else if (nn.startsWith(nq) || nq.startsWith(nn)) score -= 0.7;
      all.push(Object.assign({}, p, { score }));
    }));
    all.sort((a, b) => a.score - b.score);
    const out = [];
    for (const p of all) {
      const dup = out.find((o) => distM(o, p) < 30 || (distM(o, p) < 120 && (norm(o.name).includes(norm(p.name)) || norm(p.name).includes(norm(o.name)))));
      if (dup) { if (!dup.sub && p.sub) dup.sub = p.sub; continue; }
      out.push(p);
    }
    return out.slice(0, 10);
  }

  async function searchName(q, near) {
    const jobs = [photon(q, near).catch((e) => { console.warn('photon', e); return []; })];
    if (TOKEN) jobs.unshift(mapboxForward(q, near).catch((e) => { console.warn('mapbox', e); return []; }));
    const lists = await Promise.all(jobs);
    if (lists.reduce((n, l) => n + l.length, 0) < 3) lists.push(await nominatim(q, near).catch(() => []));
    return merge(lists, near, q);
  }

  // Words dictation tends to add or mangle; try without each one.
  function variants(q) {
    const words = q.split(/\s+/);
    if (words.length < 2) return [];
    const out = [];
    for (let i = 0; i < words.length && out.length < 3; i++) {
      const v = words.filter((_, j) => j !== i).join(' ');
      if (v.length >= 3) out.push(v);
    }
    return out;
  }

  // ------------------------------------------------------------ main entry
  async function find(text, near) {
    const heard = String(text || '').trim();
    const q = clean(heard);
    if (!q) return { kind: 'empty', heard, searched: '', results: [] };

    // 1. Postcode?
    const pcs = await lookupPostcodes(q);
    if (pcs.results.length && pcs.wholeRun) {
      return { kind: 'postcode', heard, searched: pcs.results.map((r) => r.name).join(' / '), results: pcs.results };
    }

    // 2. Category word?
    const cat = matchCategory(q);
    if (cat && near) {
      try { return { kind: 'category', heard, searched: 'Nearest ' + cat.label.toLowerCase(), category: cat.key, results: await category(cat, near) }; }
      catch (e) { console.warn('category', e); }
    }

    // 3. Names (postcode results found inside a longer phrase go first)
    let results = await searchName(q, near);
    let searched = q;
    if (results.length < 2) {
      for (const v of variants(q)) {
        const more = await searchName(v, near);
        if (more.length) { results = merge([results, more], near, v); searched = v; break; }
      }
    }
    if (pcs.results.length) results = pcs.results.concat(results).slice(0, 10);
    return { kind: 'name', heard, searched, results };
  }

  // ------------------------------------------------------------ shared map links (phone page)
  function parseMapLink(text) {
    const s = String(text || '').trim();
    const urlMatch = s.match(/https?:\/\/\S+/);
    if (!urlMatch) return null;
    let u;
    try { u = new URL(urlMatch[0]); } catch { return null; }
    const host = u.hostname.replace(/^www\./, '');
    if (/^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/.test(host)) return { short: true };
    if (host === 'maps.apple' && /^\/p\//.test(u.pathname)) return { short: true, apple: true };

    const sp = u.searchParams;
    const ll = (v) => { const m = String(v || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? [+m[1], +m[2]] : null; };
    let coords = null, name = '';

    if (/maps\.apple\.com$/.test(host) || /^maps\.apple$/.test(host)) {
      coords = ll(sp.get('coordinate')) || ll(sp.get('ll')) || ll(sp.get('daddr')) || ll(sp.get('q')) || ll(sp.get('sll'));
      name = sp.get('name') || (ll(sp.get('q')) ? '' : sp.get('q')) || sp.get('address') || '';
    } else if (/google\./.test(host) || /goo\.gl/.test(host)) {
      const place = u.pathname.match(/\/place\/([^/]+)/);
      coords = ll((u.pathname.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || []).slice(1).join(',')) ||
        ll(sp.get('q')) || ll(sp.get('query')) || ll(sp.get('destination')) || ll(sp.get('ll')) ||
        ll((u.pathname.match(/@(-?\d+\.\d+,-?\d+\.\d+)/) || [])[1]);
      name = place ? decodeURIComponent(place[1].replace(/\+/g, ' ')) : (sp.get('q') && !ll(sp.get('q')) ? sp.get('q') : sp.get('query') || sp.get('destination') || '');
    } else return null;

    name = (name || '').replace(/\+/g, ' ').trim();
    if (coords && finite(coords[0]) && finite(coords[1])) {
      const addr = (sp.get('address') || '').replace(/\+/g, ' ').trim();
      const sub = addr && addr !== name ? addr : (name.includes(',') ? name.split(',').slice(1).join(',').trim() : '');
      return { name: name.split(',')[0] || 'Pinned location', sub, lat: coords[0], lon: coords[1], src: 'link' };
    }
    if (name) return { text: name };
    return null;
  }

  // Lighter search for as-you-type on the phone (no Nominatim — its rules forbid autocomplete).
  async function live(text, near) {
    const q = clean(text);
    if (q.length < 2) return [];
    const compact = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (compact.length >= 5 && compact.length <= 7 && /\d/.test(compact) && /^[A-Z]/.test(compact)) {
      const pcs = await lookupPostcodes(q);
      if (pcs.results.length) return pcs.results;
    }
    const list = TOKEN ? await mapboxForward(q, near).catch(() => photon(q, near)) : await photon(q, near);
    return merge([list], near, q);
  }

  window.WPSearch = { find, live, category, CATEGORIES, parseMapLink, clean, postcodeCandidates, distM, hasMapbox: !!TOKEN };
})();
