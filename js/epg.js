/**
 * XVB3 — epg.js
 * Fetch e parsing guida TV (XMLTV + API sg101 per canali Zappr).
 */

import { CONFIG } from './config.js';
import { state }  from './state.js';

// ── Cache API sg101 (in memoria, per sessione) ────
const _sg101Cache = new Map(); // id numerico → programmi

// ── Controlla se tvg-id è numerico (Zappr) ────────
function isNumericId(id) {
  if (!id) return false;
  // Supporta anche "178+1" (timeshift)
  return /^[0-9]+(\+[0-9.]+)?$/.test(String(id).trim());
}

// ── Fetch EPG da API sg101 per canale numerico ────
async function fetchSg101(id) {
  const cacheKey = String(id);
  if (_sg101Cache.has(cacheKey)) return _sg101Cache.get(cacheKey);

  // Gestione timeshift (es. "178+1")
  let timeshift = 0;
  let numId = cacheKey;
  if (/^[0-9]+\+[0-9.]+$/.test(cacheKey)) {
    const parts = cacheKey.split('+');
    numId = parts[0];
    timeshift = parseFloat(parts[1]);
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}0000`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const nextWeek  = new Date(now); nextWeek.setDate(now.getDate() + 7);
  const start = fmt(yesterday);
  const end   = fmt(nextWeek);

  const url = `https://services.sg101.prd.sctv.ch/catalog/tv/channels/list/(ids=${numId};start=${start};end=${end};level=normal)`;

  try {
    const res  = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const items = json?.Nodes?.Items?.[0]?.Content?.Nodes?.Items || [];
    const progs = items.flatMap(entry => {
      try {
        const avail = entry.Availabilities?.[0];
        if (!avail) return [];

        const startMs = new Date(avail.AvailabilityStart).getTime() + timeshift * 3600000;
        const stopMs  = new Date(avail.AvailabilityEnd).getTime()   + timeshift * 3600000;
        if (isNaN(startMs) || isNaN(stopMs)) return [];

        const desc = entry.Content?.Description;
        const title = desc?.Title || '';
        const description = desc?.Summary?.trim() || '';

        // Immagine programma
        const imgItem = entry.Content?.Nodes?.Items?.find(i => i.Role === 'Lane');
        const icon = imgItem
          ? `https://services.sg101.prd.sctv.ch/content/images/${imgItem.ContentPath.trim()}_w1920.webp`
          : '';

        // Anno
        const year = desc?.Year ? String(desc.Year) : '';

        // Durata in minuti
        const duration = Math.round((stopMs - startMs) / 60000);

        // Stagione/Episodio
        const season  = entry.Content?.Series?.Season  || null;
        const episode = entry.Content?.Series?.Episode || null;

        // Rating
        const ratingRaw = desc?.AgeRestrictionRating;
        const rating = (ratingRaw && ratingRaw !== '0+') ? ratingRaw : '';

        return [{ start: startMs, stop: stopMs, title, desc: description, icon, year, duration, season, episode, rating }];
      } catch { return []; }
    }).filter(p => p.stop > Date.now() - 86400000);

    progs.sort((a, b) => a.start - b.start);
    _sg101Cache.set(cacheKey, progs);
    return progs;
  } catch (e) {
    console.warn(`[XVB3 EPG sg101] Errore canale ${id}:`, e);
    return [];
  }
}

// ── Normalizzazione chiave canale ─────────────────
function normalize(s) {
  if (!s) return '';
  s = String(s).trim().split('@')[0].split('?')[0];
  s = s.replace(/\[.*?\]|\(.*?\)/g, ' ')
       .replace(/[._\-]+/g, ' ')
       .replace(/[^a-zA-Z0-9\s]/g, ' ')
       .replace(/\s+/g, ' ').trim()
       .toLowerCase()
       .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\b(uhd|fhd|hdr|hd|sd|1080p|720p|480p)\b/g, ' ');
  s = s.replace(/\b(uk|it|us|gb|row|emea)\b$/g, '').trim();
  return s.replace(/[^a-z0-9]/g, '');
}

function epgKeys(ch) {
  const keys = new Set();
  if (ch.tvgId) keys.add(normalize(ch.tvgId));
  if (ch.name)  keys.add(normalize(ch.name));
  return keys;
}

// ── Parsing data XMLTV ────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  if (tz) iso += `${tz[0]}${tz.slice(1,3)}:${tz.slice(3,5)}`;
  else    iso += 'Z';
  const ts = Date.parse(iso);
  return isNaN(ts) ? null : ts;
}

// ── Parsing XML ───────────────────────────────────
function parseXml(xml) {
  const result   = new Map();
  const programs = Array.from(xml.getElementsByTagName('programme'));

  programs.forEach(p => {
    const chId = normalize(p.getAttribute('channel'));
    if (!chId) return;

    const start = parseDate(p.getAttribute('start'));
    const stop  = parseDate(p.getAttribute('stop'));
    if (!start || !stop) return;

    const title = p.getElementsByTagName('title')[0]?.textContent || '';
    const desc  = p.getElementsByTagName('desc')[0]?.textContent  || '';
    const icon  = p.getElementsByTagName('icon')[0]?.getAttribute('src') || '';

    // Rating / age — supporta <rating><value>TV-MA</value></rating> e <age>18</age>
    let rating = '';
    const ratingEl = p.getElementsByTagName('rating')[0];
    if (ratingEl) {
      const val = ratingEl.getElementsByTagName('value')[0]?.textContent?.trim();
      if (val) rating = val;
    }
    if (!rating) {
      const ageEl = p.getElementsByTagName('age')[0];
      if (ageEl) rating = ageEl.textContent?.trim() || '';
    }

    if (!result.has(chId)) result.set(chId, []);
    // Anno — <date>2016</date> o <date>20161201000000</date>
    const dateRaw = p.getElementsByTagName('date')[0]?.textContent?.trim() || '';
    const year = dateRaw ? dateRaw.substring(0, 4) : '';

    // Durata in minuti da start/stop
    const duration = (stop && start) ? Math.round((stop - start) / 60000) : 0;

    result.get(chId).push({ start, stop, title, desc, icon, rating, year, duration });
  });

  for (const [, arr] of result) arr.sort((a, b) => a.start - b.start);
  return result;
}

// ── Fetch singolo URL EPG (con supporto .gz) ─────
async function fetchOneEpg(url) {
  const bust = url.includes('?') ? `&_t=${Date.now()}` : `?_t=${Date.now()}`;
  const res  = await fetch(url + bust, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const lower = url.toLowerCase().split('?')[0];
  const isGz  = lower.endsWith('.gz') || lower.endsWith('.gzip');

  let text;
  if (isGz && typeof DecompressionStream !== 'undefined') {
    // Decomprimi gzip nel browser
    const ds     = new DecompressionStream('gzip');
    const blob   = await res.blob();
    const stream = blob.stream().pipeThrough(ds);
    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    text = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const tmp = new Uint8Array(acc.length + chunk.length);
        tmp.set(acc); tmp.set(chunk, acc.length);
        return tmp;
      }, new Uint8Array(0))
    );
  } else if (isGz) {
    throw new Error('.gz not supported in this browser (no DecompressionStream)');
  } else {
    text = await res.text();
  }

  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('XML non valido');
  return parseXml(xml);
}

// ── Fetch ─────────────────────────────────────────
export async function fetchEpg() {
  // Migrazione da vecchia chiave xvb3.custom_epg → xvb3.epg_saved
  try {
    const oldRaw = localStorage.getItem('xvb3.custom_epg');
    if (oldRaw) {
      const oldArr = JSON.parse(oldRaw) || [];
      if (Array.isArray(oldArr) && oldArr.length) {
        const savedRaw = localStorage.getItem('xvb3.epg_saved');
        const saved = savedRaw ? JSON.parse(savedRaw) : [];
        const existingUrls = new Set(saved.map(e => e.url));
        oldArr.forEach(e => {
          if (e.url && !existingUrls.has(e.url)) {
            saved.push({ url:e.url, name:e.name||e.url, type:'custom', gz:e.gz||false, savedAt:Date.now() });
          }
        });
        localStorage.setItem('xvb3.epg_saved', JSON.stringify(saved));
      }
      localStorage.removeItem('xvb3.custom_epg');
    }
  } catch {}

  // Leggi EPG salvate dall'utente (built-in attivate + custom)
  let savedUrls = [];
  try {
    const raw = localStorage.getItem('xvb3.epg_saved');
    const arr = raw ? JSON.parse(raw) : [];
    savedUrls = Array.isArray(arr) ? arr.map(e => e.url).filter(Boolean) : [];
  } catch {}

  // De-duplica rispetto a CONFIG.EPG_URLS
  const configUrls = CONFIG.EPG_URLS || [];
  const extraUrls = savedUrls.filter(u => !configUrls.includes(u));
  const allUrls = [...configUrls, ...extraUrls];
  if (!allUrls.length) return;

  try {
    const results = await Promise.allSettled(allUrls.map(url => fetchOneEpg(url)));

    state.epgData.clear();

    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        console.warn(`[XVB3 EPG] Failed: ${allUrls[i]}`, r.reason);
        return;
      }
      for (const [key, progs] of r.value) {
        if (!state.epgData.has(key)) state.epgData.set(key, []);
        state.epgData.get(key).push(...progs);
      }
    });

    for (const [, arr] of state.epgData) arr.sort((a, b) => a.start - b.start);
    console.log(`[XVB3 EPG] Caricati ${state.epgData.size} canali da ${allUrls.length} sorgenti`);
  } catch (e) {
    console.error('[XVB3 EPG] Errore:', e);
  }
}

// ── Query ─────────────────────────────────────────
export async function getCurrent(ch) {
  if (!ch) return null;
  const now = Date.now();

  // Se epgId è numerico → usa API sg101
  if (isNumericId(ch.epgId)) {
    const progs = await fetchSg101(ch.epgId);
    const p = progs.find(x => x.start <= now && x.stop > now);
    if (!p) return null;
    const pct = Math.min(100, Math.round(((now - p.start) / (p.stop - p.start)) * 100));
    return { ...p, pct, startDate: new Date(p.start), stopDate: new Date(p.stop) };
  }

  // Altrimenti usa XMLTV
  if (!state.epgData.size) return null;
  for (const key of epgKeys(ch)) {
    const progs = state.epgData.get(key);
    if (!progs) continue;
    const p = progs.find(x => x.start <= now && x.stop > now);
    if (p) {
      const pct = Math.min(100, Math.round(((now - p.start) / (p.stop - p.start)) * 100));
      return { ...p, pct, startDate: new Date(p.start), stopDate: new Date(p.stop) };
    }
  }
  return null;
}

export async function getNext(ch, limit = 5) {
  if (!ch) return [];
  const now = Date.now();

  // Se epgId è numerico → usa API sg101
  if (isNumericId(ch.epgId)) {
    const progs = await fetchSg101(ch.epgId);
    return progs.filter(x => x.start > now).slice(0, limit);
  }

  // Altrimenti usa XMLTV
  if (!state.epgData.size) return [];
  for (const key of epgKeys(ch)) {
    const progs = state.epgData.get(key);
    if (!progs) continue;
    const list = progs.filter(x => x.start > now).slice(0, limit);
    if (list.length) return list;
  }
  return [];
}

// ── Auto refresh ──────────────────────────────────
export function startAutoRefresh() {
  clearInterval(state.epgTimer);
  state.epgTimer = setInterval(fetchEpg, CONFIG.EPG_REFRESH_MS);
}