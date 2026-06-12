/**
 * XVB3 — epg.js
 * Fetch e parsing guida TV (XMLTV).
 * L'API sg101 è stata rimossa per problemi CORS.
 * I canali con epg-id numerico vengono ora risolti tramite XMLTV
 * (es. epg.zappr.stream che usa channel id numerici).
 */

import { CONFIG } from './config.js';
import { state }  from './state.js';

// ── Controlla se epg-id è numerico (canali Zappr) ────────────────
function isNumericId(id) {
  if (!id) return false;
  return /^[0-9]+(\+[0-9.]+)?$/.test(String(id).trim());
}

// ── Lookup sincrono da XMLTV per id numerico ─────────────────────
function lookupNumericId(epgId) {
  if (!state.epgData.size) return [];
  const cacheKey = String(epgId);

  let timeshift = 0;
  let numId = cacheKey;
  if (/^[0-9]+\+[0-9.]+$/.test(cacheKey)) {
    const parts = cacheKey.split('+');
    numId = parts[0];
    timeshift = parseFloat(parts[1]);
  }

  for (const v of [numId, normalize(numId)]) {
    if (state.epgData.has(v)) {
      const progs = state.epgData.get(v);
      if (!timeshift) return progs;
      return progs.map(p => ({
        ...p,
        start: p.start + timeshift * 3600000,
        stop:  p.stop  + timeshift * 3600000,
      }));
    }
  }
  return [];
}

// ── Normalizzazione chiave canale ─────────────────────────────────
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
  if (ch.tvgId) {
    keys.add(normalize(ch.tvgId));
    keys.add(ch.tvgId.trim().split('@')[0]); // raw, senza normalizzare
  }
  if (ch.name)  keys.add(normalize(ch.name));
  if (ch.epgId) {
    const rawEpgId = String(ch.epgId).split('+')[0];
    keys.add(rawEpgId);
    keys.add(normalize(rawEpgId));
  }
  return keys;
}

// ── Parsing data XMLTV ────────────────────────────────────────────
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

// ── Parsing XML ───────────────────────────────────────────────────
function parseXml(xml) {
  const result   = new Map();
  const programs = Array.from(xml.getElementsByTagName('programme'));

  programs.forEach(p => {
    const rawId = p.getAttribute('channel') || '';
    if (!rawId) return;

    const start = parseDate(p.getAttribute('start'));
    const stop  = parseDate(p.getAttribute('stop'));
    if (!start || !stop) return;

    const title = p.getElementsByTagName('title')[0]?.textContent || '';
    const desc  = p.getElementsByTagName('desc')[0]?.textContent  || '';
    const icon  = p.getElementsByTagName('icon')[0]?.getAttribute('src') || '';

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

    const dateRaw = p.getElementsByTagName('date')[0]?.textContent?.trim() || '';
    const year = dateRaw ? dateRaw.substring(0, 4) : '';
    const duration = Math.round((stop - start) / 60000);

    const prog = { start, stop, title, desc, icon, rating, year, duration };

    // Indicizza per id grezzo (numerico o stringa) E normalizzato
    const keys = new Set([rawId, normalize(rawId)]);
    // Se l'id contiene solo cifre, indicizza anche solo la parte numerica
    const numMatch = rawId.match(/^(\d+)/);
    if (numMatch) keys.add(numMatch[1]);

    for (const key of keys) {
      if (!key) continue;
      if (!result.has(key)) result.set(key, []);
      // Evita duplicati
      const arr = result.get(key);
      if (!arr.find(x => x.start === start && x.title === title)) {
        arr.push(prog);
      }
    }
  });

  for (const [, arr] of result) arr.sort((a, b) => a.start - b.start);
  return result;
}

// ── Fetch singolo URL EPG (con supporto .gz) ─────────────────────
async function fetchOneEpg(url) {
  const bust = url.includes('?') ? `&_t=${Date.now()}` : `?_t=${Date.now()}`;
  const res  = await fetch(url + bust, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const lower = url.toLowerCase().split('?')[0];
  const isGz  = lower.endsWith('.gz') || lower.endsWith('.gzip');

  let text;
  if (isGz && typeof DecompressionStream !== 'undefined') {
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

// ── Fetch principale ──────────────────────────────────────────────
export async function fetchEpg() {
  // Migrazione da vecchia chiave
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

  let savedUrls = [];
  try {
    const raw = localStorage.getItem('xvb3.epg_saved');
    const arr = raw ? JSON.parse(raw) : [];
    savedUrls = Array.isArray(arr) ? arr.map(e => e.url).filter(Boolean) : [];
  } catch {}

  const configUrls = CONFIG.EPG_URLS || [];
  const extraUrls = savedUrls.filter(u => !configUrls.includes(u));
  const demoDismissed = localStorage.getItem(CONFIG.DEMO_DISMISSED_KEY) === '1';
  const demoEpg = (!demoDismissed && CONFIG.DEMO_EPG_URL) ? [CONFIG.DEMO_EPG_URL] : [];
  const allUrls = [...configUrls, ...extraUrls, ...demoEpg].filter(Boolean);
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

// ── Demo channel detection ────────────────────────────────────────
function isDemoChannel(ch) {
  const id = (ch?.tvgId || ch?.epgId || '');
  return id.endsWith('.demo');
}

// ── getCurrent ────────────────────────────────────────────────────
export async function getCurrent(ch) {
  if (!ch) return null;
  const now = Date.now();

  // Canali con epg-id numerico (Zappr) → cerca nell'XMLTV
  if (isNumericId(ch.epgId)) {
    const progs = lookupNumericId(ch.epgId);
    const p = progs.find(x => x.start <= now && x.stop > now);
    if (!p) return null;
    const pct = Math.min(100, Math.round(((now - p.start) / (p.stop - p.start)) * 100));
    return { ...p, pct, startDate: new Date(p.start), stopDate: new Date(p.stop) };
  }

  // Altrimenti usa XMLTV con chiavi normalizzate
  if (!state.epgData.size) return null;
  for (const key of epgKeys(ch)) {
    const progs = state.epgData.get(key);
    if (!progs) continue;

    if (isDemoChannel(ch)) {
      const p = progs[0];
      if (!p) continue;
      return { ...p, pct: 0, startDate: new Date(p.start), stopDate: new Date(p.stop) };
    }

    const p = progs.find(x => x.start <= now && x.stop > now);
    if (p) {
      const pct = Math.min(100, Math.round(((now - p.start) / (p.stop - p.start)) * 100));
      return { ...p, pct, startDate: new Date(p.start), stopDate: new Date(p.stop) };
    }
  }
  return null;
}

// ── getNext ───────────────────────────────────────────────────────
export async function getNext(ch, limit = 5) {
  if (!ch) return [];
  const now = Date.now();

  if (isNumericId(ch.epgId)) {
    const progs = lookupNumericId(ch.epgId);
    return progs.filter(x => x.start > now).slice(0, limit);
  }

  if (!state.epgData.size) return [];
  for (const key of epgKeys(ch)) {
    const progs = state.epgData.get(key);
    if (!progs) continue;
    if (isDemoChannel(ch)) return [];
    const list = progs.filter(x => x.start > now).slice(0, limit);
    if (list.length) return list;
  }
  return [];
}

// ── Auto refresh ──────────────────────────────────────────────────
export function startAutoRefresh() {
  clearInterval(state.epgTimer);
  state.epgTimer = setInterval(fetchEpg, CONFIG.EPG_REFRESH_MS);
}
