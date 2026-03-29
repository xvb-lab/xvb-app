/**
 * XVB3 — playlist.js
 * Fetch e parsing M3U.
 */

import { CONFIG } from './config.js';
import { state }  from './state.js';

// ── Parsing M3U ───────────────────────────────────
export function parseM3U(text, sourceName = 'Channels', sourceType = 'url') {
  const lines    = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const channels = [];
  let current    = {};

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      current = {};

      const tvgId    = line.match(/tvg-id="([^"]*)"/i)?.[1]    || '';
      const tvgName  = line.match(/tvg-name="([^"]*)"/i)?.[1]  || '';
      const tvgLogo  = line.match(/tvg-logo="([^"]*)"/i)?.[1]  || '';
      const group    = line.match(/group-title="([^"]*)"/i)?.[1] || sourceName;
      const license  = line.match(/license-details="([^"]*)"/i)?.[1] || '';

      const comma   = line.lastIndexOf(',');
      const rawName = comma >= 0 ? line.slice(comma + 1).trim() : '';

      current = {
        name:    tvgName || rawName || 'Channel',
        tvgId,
        logo:    tvgLogo,
        group:   group.trim(),
        license,
        _source: sourceType,
      };

    } else if (!line.startsWith('#') && (line.startsWith('http') || line.startsWith('/'))) {
      current.url = line;
      if (current.name && current.url) channels.push({ ...current });
      current = {};
    }
  }

  return channels;
}

// ── Storage keys v2.3 (identiche al PM) ──────────────
const PLAYLIST_INDEX_KEY  = 'xvb.playlists.index.v2';
const PLAYLIST_ITEM_PRE   = 'xvb.playlists.item.v2.';

function _getStoredPlaylists() {
  try {
    const raw = localStorage.getItem(PLAYLIST_INDEX_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _readItem(id) {
  try {
    const raw = localStorage.getItem(PLAYLIST_ITEM_PRE + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Fetch ─────────────────────────────────────────
export async function loadPlaylist() {
  const stored = _getStoredPlaylists();
  const allChannels = [];

  // Leggi playlist salvate nel PM (localStorage)
  if (stored.length) {
    const fetches = stored.map(async (it) => {
      if (!it?.id) return [];
      const item = _readItem(it.id);

      // Locale: testo già salvato
      if (it.type === 'local' && item?.m3uText) {
        return parseM3U(item.m3uText, it.name, 'local');
      }

      // URL: usa testo cached se disponibile, altrimenti fetch
      if (it.type === 'url' && it.url) {
        // Determina se è un server XVB
        const isXvb = it.url.includes('jonathansanfilippo') || it.url.includes('xvb-server');
        const srcType = isXvb ? 'server' : 'url';

        if (item?.m3uText) {
          setTimeout(async () => {
            try {
              const r = await fetch(it.url + (it.url.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
              if (!r.ok) return;
              const text = await r.text();
              item.m3uText = text;
              localStorage.setItem(PLAYLIST_ITEM_PRE + it.id, JSON.stringify(item));
            } catch {}
          }, 2000);
          return parseM3U(item.m3uText, it.name, srcType);
        }
        try {
          const r = await fetch(it.url + (it.url.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const text = await r.text();
          if (item) { item.m3uText = text; localStorage.setItem(PLAYLIST_ITEM_PRE + it.id, JSON.stringify(item)); }
          return parseM3U(text, it.name, srcType);
        } catch (e) {
          console.warn('[XVB3] Playlist fetch failed:', it.url, e);
          return [];
        }
      }
      return [];
    });

    const results = await Promise.allSettled(fetches);
    results.forEach(r => { if (r.status === 'fulfilled') allChannels.push(...r.value); });
  }

  // Fallback: CONFIG.M3U_URL se non ci sono playlist nel PM
  if (!allChannels.length && CONFIG.M3U_URL) {
    try {
      const url = CONFIG.M3U_URL;
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      allChannels.push(...parseM3U(text));
    } catch (e) {
      console.error('[XVB3] CONFIG.M3U_URL fetch failed:', e);
    }
  }

  state.allChannels = allChannels;
  return allChannels;
}

// ── Categorie ─────────────────────────────────────
export function getCategories() {
  return [...new Set(state.allChannels.map(ch => ch.group || 'Other'))];
}

export function getByCategory(cat) {
  return state.allChannels.filter(ch => (ch.group || 'Other') === cat);
}