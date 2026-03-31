/**
 * XVB3 — app.js
 */

import { state }                   from './state.js';
import { CONFIG }                  from './config.js';
import { loadPlaylist }            from './playlist.js';
import { fetchEpg, getCurrent, getNext, startAutoRefresh } from './epg.js';
import { initPlayer, play, stop, togglePlay, rewind, forward, setVolume } from './player.js';
import { renderQualityMenu, getCurrentQualityLabel } from './quality.js';

const $ = id => document.getElementById(id);

// ── Log broadcaster → settings Live Logs ─────────
function xvbLog(msg, level = 'info') {
  try {
    const bc = new BroadcastChannel('xvb_logs');
    bc.postMessage({ type: 'log', source: 'app', msg: String(msg), level });
    bc.close();
  } catch {}
}

// ── Orologio topbar ──
function updateClock() {
  const el = document.getElementById('topbarClock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}
updateClock();
setInterval(updateClock, 1000);

function fmtTime(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/* ── Player status pill ── */
function showSpinner(txt = '') {
  const pill = $('playerStatusPill');
  const ring = $('playerSpinnerInner');
  const msg  = $('playerStatusMsg');
  if (!pill) return;
  if (ring) ring.style.display = 'block';
  if (msg)  msg.textContent = txt;
  pill.hidden = false;
}
function showError(txt) {
  const pill = $('playerStatusPill');
  const ring = $('playerSpinnerInner');
  const msg  = $('playerStatusMsg');
  if (!pill) return;
  if (ring) ring.style.display = 'none';
  if (msg)  msg.innerHTML = `<span class="material-symbols-outlined" style="font-size:28px;vertical-align:middle;margin-right:5px;">warning</span>${txt || 'Stream non disponibile'}`;
  pill.hidden = false;
  try { const a = new Audio('assets/error.mp3'); a.volume = 0.5; a.play().catch(() => {}); } catch {}
  // Mostra overlay controlli così l'errore è leggibile
  $('playerOverlay')?.classList.add('show-controls');
}
function hideStatus() {
  const pill = $('playerStatusPill');
  if (pill) pill.hidden = true;
}

/* ── Material You — Color System ─────────────────
   Estrae seed color dal logo, genera tonal palette
   e applica ruoli corretti come da guida Android TV
   ─────────────────────────────────────────────── */
// ── CORS Proxy per estrazione colore ─────────────
// Sostituisci con il tuo Worker URL dopo il deploy
const CORS_PROXY = 'https://xvb-cors.tuodominio.workers.dev';

function proxyUrl(src) {
  if (!src || !CORS_PROXY) return src;
  return `${CORS_PROXY}?url=${encodeURIComponent(src)}`;
}

const _colorCache = new Map();

function extractDominantColor(src, callback, imgEl) {
  if (!src) { callback(null); return; }
  if (_colorCache.has(src)) { callback(_colorCache.get(src)); return; }

  const doCanvas = (el, source) => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const ctx = c.getContext('2d');
      ctx.drawImage(el, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      const buckets = {};
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a < 128) continue;
        const br = (r*299 + g*587 + b*114) / 1000;
        if (br < 20 || br > 235) continue;
        if (Math.max(r,g,b) - Math.min(r,g,b) < 30) continue;
        const key = `${Math.round(r/32)*32},${Math.round(g/32)*32},${Math.round(b/32)*32}`;
        buckets[key] = (buckets[key] || 0) + 1;
      }
      const sorted = Object.entries(buckets).sort((a,b) => b[1]-a[1]);
      if (!sorted.length) { _colorCache.set(src, null); callback(null); return true; }
      const [r,g,b] = sorted[0][0].split(',').map(Number);
      _colorCache.set(src, { r, g, b });
      callback({ r, g, b });
      return true;
    } catch(e) { return false; }
  };

  // 1. imgEl passato direttamente (già caricato nel DOM, nessun problema CORS)
  if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
    if (doCanvas(imgEl, 'imgEl')) return;
  }

  // 2. img già nel DOM con lo stesso src
  const domImg = document.querySelector(`img[src="${src}"]`);
  if (domImg && domImg.complete && domImg.naturalWidth > 0) {
    if (doCanvas(domImg, 'domImg')) return;
  }

  // 3. crossOrigin diretto (funziona su Chrome, fallisce su Safari/Opera/Brave)
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!doCanvas(img, 'crossOrigin')) {
      // 4. Solo se crossOrigin fallisce: fetch blob
      // Nota: su Safari il blob URL restituisce pixel uniformi, quindi
      // usiamo solo come ultimo tentativo
      fetch(src, { mode: 'no-cors', cache: 'force-cache' })
        .then(r => r.blob())
        .then(blob => {
          const blobUrl = URL.createObjectURL(blob);
          const img2 = new Image();
          img2.onload = () => {
            doCanvas(img2, 'fetch-blob');
            URL.revokeObjectURL(blobUrl);
          };
          img2.onerror = () => { _colorCache.set(src, null); callback(null); };
          img2.src = blobUrl;
        })
        .catch(() => { _colorCache.set(src, null); callback(null); });
    }
  };
  img.onerror = () => { _colorCache.set(src, null); callback(null); };
  img.src = src + (src.includes('?') ? '&' : '?') + '_xvb=' + Date.now();
}

// RGB → HSL
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      default: h = ((r-g)/d + 4)/6;
    }
  }
  return [h*360, s*100, l*100];
}

// HSL → RGB
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p+(q-p)*6*t;
    if (t < 1/2) return q;
    if (t < 2/3) return p+(q-p)*(2/3-t)*6;
    return p;
  };
  if (s === 0) { const v = Math.round(l*255); return [v,v,v]; }
  const q = l < 0.5 ? l*(1+s) : l+s-l*s;
  const p = 2*l-q;
  return [
    Math.round(hue2rgb(p,q,h+1/3)*255),
    Math.round(hue2rgb(p,q,h)*255),
    Math.round(hue2rgb(p,q,h-1/3)*255)
  ];
}

// Genera tonal palette da seed — tonalità T0→T100
// Material You: mantieni hue e saturation, varia solo lightness
function tonalPalette(r, g, b) {
  const [h, s] = rgbToHsl(r, g, b);
  // Clampa saturazione: TV usa valori più bassi per non stancare
  const ts = Math.min(s, 48);
  const tone = (l) => hslToRgb(h, ts, l);
  return {
    t0:   tone(0),
    t10:  tone(10),
    t20:  tone(20),
    t30:  tone(30),
    t40:  tone(40),   // primary
    t50:  tone(50),
    t60:  tone(60),
    t70:  tone(70),
    t80:  tone(80),   // primary container
    t90:  tone(90),
    t95:  tone(95),
    t99:  tone(99),
    t100: tone(100),
  };
}

function applyMaterialTheme(r, g, b) {
  const pal = tonalPalette(r, g, b);
  const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  // Ruoli Material You per dark theme TV:
  // primary         = T80  (container attivo, pill categoria)
  // on-primary      = T20  (testo su primary)
  // primary-container = T30 (surface elevata)
  // surface         = T10  (sfondo card)
  // surface-variant = T20  (sfondo card variante)

  const root = document.documentElement;
  root.style.setProperty('--md-primary',           css(pal.t80));
  root.style.setProperty('--md-on-primary',        css(pal.t20));
  root.style.setProperty('--md-primary-container', css(pal.t30));
  root.style.setProperty('--md-surface-tint',      css(pal.t40));
  root.style.setProperty('--md-card-bg',           css(pal.t10));
  root.style.setProperty('--glow-bottom-left',     `rgba(${pal.t40[0]},${pal.t40[1]},${pal.t40[2]},.65)`);
}

function resetMaterialTheme() {
  const root = document.documentElement;
  root.style.setProperty('--md-primary',           'rgb(208,188,255)');
  root.style.setProperty('--md-on-primary',        'rgb(30,20,60)');
  root.style.setProperty('--md-primary-container', 'rgb(40,30,80)');
  root.style.setProperty('--md-surface-tint',      'rgb(80,60,120)');
  root.style.setProperty('--md-card-bg',           'rgb(28,28,36)');
  root.style.setProperty('--glow-bottom-left',     'rgba(103,80,164,.65)');
}

/* ── Player background: colore logo + logo centrato 250px ── */
function updatePlayerBg(ch) {
  const bg = document.getElementById('playerBg');
  if (!bg) return;
  const logoSrc = ch?.logo || '';

  if (logoSrc) {
    extractDominantColor(logoSrc, color => {
      let dr, dg, db;
      if (color) {
        dr = Math.round(color.r * 0.3);
        dg = Math.round(color.g * 0.3);
        db = Math.round(color.b * 0.3);
      } else {
        // Logo bianco/neutro — usa primary container
        dr = 45; dg = 31; db = 90;
      }
      bg.style.background = `radial-gradient(ellipse 55% 55% at 50% 50%, rgb(${dr},${dg},${db}) 0%, #0a0a0f 70%)`;
      document.documentElement.style.setProperty('--player-bottom-gradient', `rgba(${dr},${dg},${db},0.95)`);
    });
    bg.dataset.logo = logoSrc;
  } else {
    bg.style.background = 'rgba(20,18,30,0.6)';
    bg.dataset.logo = '';
  }

  // Aggiorna logo centrato
  let logoEl = document.getElementById('playerBgLogo');
  if (!logoEl) {
    logoEl = document.createElement('img');
    logoEl.id = 'playerBgLogo';
    bg.appendChild(logoEl);
  }
  if (logoSrc) {
    logoEl.src = logoSrc;
    logoEl.style.display = 'block';
  } else {
    logoEl.style.display = 'none';
  }
}

/* ── Hero ── */
/* ── Favourites ── */
const FAVOURITES_KEY   = 'xvb.favourites';
const FAVOURITES_GROUP = 'Favourites';

function loadFavourites() {
  try { const r = localStorage.getItem(FAVOURITES_KEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveFavourites(favs) { try { localStorage.setItem(FAVOURITES_KEY, JSON.stringify(favs)); } catch {} }
function isFavourite(url) { return loadFavourites().some(f => f.url === url); }
function toggleFavourite(ch) {
  let favs = loadFavourites();
  if (favs.some(f => f.url === ch.url)) {
    favs = favs.filter(f => f.url !== ch.url);
  } else {
    favs.push({ url:ch.url, name:ch.name, group:ch.group, logo:ch.logo||'', tvgId:ch.tvgId||'', _source:ch._source||'url' });
  }
  saveFavourites(favs);
  return favs.some(f => f.url === ch.url);
}
function getFavouritesAsGroup() {
  return loadFavourites().map(f => ({ ...f, group: FAVOURITES_GROUP }));
}

function updateFavBtn(ch) {
  const btn  = $('heroFavBtn');
  const icon = $('heroFavIcon');
  if (!btn || !icon) return;
  const fav = isFavourite(ch?.url);
  icon.textContent = fav ? 'favorite' : 'favorite_border';
  icon.style.fontVariationSettings = fav ? "'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24" : "'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24";
  btn.classList.toggle('is-fav', fav);
}

/* ── Stream type detection ── */
function getStreamType(url) {
  if (!url) return null;
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.m3u8') || u.includes('/hls/') || u.includes('manifest.m3u8')) return 'HLS';
  if (u.endsWith('.mpd') || u.includes('/dash/')) return 'DASH';
  if (u.endsWith('.ts') || u.includes('/ts/')) return 'MPEG-TS';
  if (u.endsWith('.mp3') || u.endsWith('.aac') || u.endsWith('.ogg') || u.endsWith('.flac')) return 'AUDIO';
  return null;
}

function getAudioHint(url) {
  if (!url) return null;
  const u = url.toLowerCase().split('?')[0];
  if (u.includes('heaac') || u.includes('he-aac')) return 'HE-AAC';
  if (u.includes('eac3') || u.includes('e-ac3'))   return 'E-AC3';
  if (u.includes('ac3') || u.includes('dolby'))    return 'AC3';
  if (u.includes('aac') || u.endsWith('.aac'))     return 'AAC';
  if (u.includes('mp3') || u.endsWith('.mp3'))     return 'MP3';
  if (u.includes('opus'))                           return 'Opus';
  if (u.includes('flac') || u.endsWith('.flac'))   return 'FLAC';
  return null;
}

function getResolutionHint(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('4k') || u.includes('uhd') || u.includes('2160')) return '4K';
  if (u.includes('2k') || u.includes('1440'))                       return '2K';
  if (u.includes('1080') || u.includes('fhd'))                      return '1080p';
  if (u.includes('720') || u.includes('hd'))                        return '720p';
  if (u.includes('480') || u.includes('sd'))                        return '480p';
  return null;
}

function makeBadge(label, cls) {
  const b = document.createElement('div');
  b.className = cls ? `stream-badge ${cls}` : 'stream-badge';
  b.textContent = label;
  return b;
}

// Normalizza il rating EPG in etichetta leggibile + classe CSS
function normalizeRating(raw) {
  if (!raw) return null;
  const label = raw.trim();
  if (!label) return null;
  return { label, cls: 'badge-rating' };
}

async function updateStreamMeta(ch) {
  const el = $('heroStreamMeta');
  if (!el) return;
  el.innerHTML = '';

  // 1. Tipo flusso
  const type = getStreamType(ch?.url);
  if (type) el.appendChild(makeBadge(type));

  // 2. Audio codec dall'URL
  const audio = getAudioHint(ch?.url);
  if (audio) el.appendChild(makeBadge(audio));

  // 4. Metadati EPG: rating, anno, durata
  const epgCurrent = window._xvbEpgCurrent || null;
  if (epgCurrent) {
    if (epgCurrent.rating) {
      const r = normalizeRating(epgCurrent.rating);
      if (r) el.appendChild(makeBadge(r.label, r.cls));
    }
    if (epgCurrent.year) {
      el.appendChild(makeBadge(epgCurrent.year, 'badge-meta'));
    }
    if (epgCurrent.duration && epgCurrent.duration > 0) {
      const h = Math.floor(epgCurrent.duration / 60);
      const m = epgCurrent.duration % 60;
      const label = h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
      el.appendChild(makeBadge(label, 'badge-meta'));
    }
  }

  // Views badge
  if (ch?.url) {
    fetchViews(ch.url).then(views => {
      if (views === null || views === 0) return;
      const label = views >= 1000000
        ? (views / 1000000).toFixed(1).replace('.0', '') + 'M Views'
        : views >= 1000
        ? (views / 1000).toFixed(1).replace('.0', '') + 'K Views'
        : `${views} ${views !== 1 ? 'Views' : 'View'}`;
      const badge = makeBadge(label, 'badge-views');
      badge.style.display = 'inline-flex';
      badge.style.alignItems = 'center';
      badge.style.gap = '3px';
      badge.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24">visibility</span> ${label}`;
      el.appendChild(badge);
    });
  }
}

async function updateHero(ch) {
  if (!ch) return;
  state.activeChannel = ch;

  // Reset immediato colori — evita che rimanga il colore del canale precedente
  resetMaterialTheme();

  const epg  = await getCurrent(ch);
  window._xvbEpgCurrent = epg; // esposto per badge rating
  const next = await getNext(ch, 5);

  const img = epg?.icon || ch.logo || '';
  const isEpgIcon = !!epg?.icon;
  const heroEl = document.getElementById('hero');
  if (heroEl) {
    heroEl.classList.toggle('has-epg-image', isEpgIcon);
    heroEl.classList.toggle('has-logo', !isEpgIcon);
  }
  const heroBg     = $('heroBg');
  const heroBgBlur = $('heroBgBlur');

  function resetHeroBg() {
    if (!heroBg) return;
    heroBg.style.backgroundImage    = 'none';
    heroBg.style.backgroundSize     = 'cover';
    heroBg.style.backgroundPosition = 'center top';
    heroBg.style.backgroundRepeat   = 'no-repeat';
    heroBg.style.backgroundColor    = '';
    if (heroBgBlur) {
      heroBgBlur.style.opacity         = '0';
      heroBgBlur.style.backgroundImage = 'none';
      heroBgBlur.style.filter          = 'blur(40px) brightness(.5) saturate(1.4)';
      heroBgBlur.style.transform       = 'scale(1.08)';
    }
  }

  if (heroBg) {
    if (img) {
      heroBg.classList.add('skeleton');
      const probe = new Image();
      probe.onload = () => heroBg.classList.remove('skeleton');
      probe.onerror = () => heroBg.classList.remove('skeleton');
      probe.src = img;

      if (isEpgIcon) {
        resetHeroBg();
        heroBg.style.backgroundImage = `url(${img})`;
        const detectImg = new Image();
        detectImg.onload = () => {
          const isVertical = detectImg.naturalHeight > detectImg.naturalWidth;
          heroBg.style.backgroundColor = '';
          heroBg.style.backgroundRepeat = '';
          if (heroBgBlur) {
            heroBgBlur.style.filter    = 'blur(40px) brightness(.5) saturate(1.4)';
            heroBgBlur.style.transform = 'scale(1.08)';
            heroBgBlur.style.background = '';
          }
          if (isVertical) {
            heroBg.style.backgroundSize     = 'contain';
            heroBg.style.backgroundPosition = 'center center';
            if (heroBgBlur) {
              heroBgBlur.style.backgroundImage = `url(${img})`;
              heroBgBlur.style.opacity         = '1';
            }
          } else {
            heroBg.style.backgroundSize     = 'cover';
            heroBg.style.backgroundPosition = 'center top';
            // Blur attivo anche per orizzontali come fill di sfondo
            if (heroBgBlur) {
              heroBgBlur.style.backgroundImage = `url(${img})`;
              heroBgBlur.style.opacity         = '1';
            }
          }
        };
        detectImg.onerror = () => {
          heroBg.style.backgroundSize     = 'cover';
          heroBg.style.backgroundPosition = 'center top';
        };
        detectImg.src = img;
      } else {
        resetHeroBg();
        heroBg.style.backgroundImage    = `url(${img})`;
        heroBg.style.backgroundSize     = '300px';
        heroBg.style.backgroundPosition = 'center center';
        heroBg.style.backgroundRepeat   = 'no-repeat';
        heroBg.style.backgroundColor    = '#0a0a0f';
        extractDominantColor(img, color => {
          if (!heroBg) return;
          if (color) {
            heroBg.style.backgroundColor = `rgb(${Math.round(color.r*.25)},${Math.round(color.g*.25)},${Math.round(color.b*.25)})`;
          } else {
            // Logo bianco/neutro → primary container
            heroBg.style.backgroundColor = 'rgb(45,31,90)';
          }
        });
      }
    } else {
      resetHeroBg();
      heroBg.classList.remove('skeleton');
    }
  }

  const heroLogo = $('heroLogo');
  const heroLogoText = $('heroLogoText');

  if (heroLogo && heroLogoText) {
    if (ch.logo) {
      heroLogo.style.opacity = '0';
      heroLogo.onload = () => {
        heroLogo.style.opacity = '1';
        extractDominantColor(ch.logo, color => {
          if (color) applyMaterialTheme(color.r, color.g, color.b);
          else resetMaterialTheme();
        }, heroLogo);
      };
      heroLogo.src = ch.logo;
      heroLogo.style.display = 'block';
      heroLogoText.style.display = 'none';
    } else {
      heroLogo.style.display = 'none';
      heroLogoText.textContent = ch.name || '';
      heroLogoText.style.display = 'block';
    }
  }

  const heroMeta = $('heroMeta');
  if (heroMeta) heroMeta.textContent = ch.group || '';

  // Stream type badges
  updateStreamMeta(ch);

  const heroTitle = $('heroTitle');
  if (heroTitle) heroTitle.textContent = epg?.title || ch.name;

  const heroDesc = $('heroDesc');
  if (heroDesc) heroDesc.textContent = epg?.desc || '';

  // Aggiorna bottone preferiti
  updateFavBtn(ch);

  const heroProgressWrap = $('heroProgressWrap');
  const heroFill = $('heroFill');
  if (epg && heroFill) {
    heroFill.style.width = `${epg.pct}%`;
    heroProgressWrap?.classList.add('visible');
    const heroTimeStart = $('heroTimeStart');
    if (heroTimeStart) heroTimeStart.textContent = fmtTime(new Date(epg.start));
  } else {
    heroProgressWrap?.classList.remove('visible');
    const heroTimeStart = $('heroTimeStart');
    if (heroTimeStart) heroTimeStart.textContent = '';
  }

  const heroNext = $('heroNext');
  if (heroNext) {
    heroNext.innerHTML = next.map(p =>
      `<div class="next-item">
        <span class="next-time">${fmtTime(new Date(p.start))}</span>
        <span class="next-title">${p.title}</span>
      </div>`
    ).join('');
  }

  // Material You — gestito nell'onload del heroLogo sopra
  if (!ch.logo) resetMaterialTheme();
}

/* ── Card ── */
function buildCard(ch) {
  const isMobile = document.body.classList.contains('is-mobile');
  const card = document.createElement('div');
  card.className = 'channel-card';
  card.dataset.url = ch.url;
  if (ch.logo) card.dataset.logo = ch.logo;

  const wrap = document.createElement('div');
  wrap.className = 'card-img-wrap';

  if (ch.logo) {
    wrap.classList.add('skeleton');
    const img = document.createElement('img');
    img.alt = '';
    img.onload = () => {
      wrap.classList.remove('skeleton');
      extractDominantColor(ch.logo, color => {
        wrap.style.background = color ? `rgba(${color.r},${color.g},${color.b},0.15)` : `rgba(45,31,90,0.3)`;
      }, img);
    };
    img.onerror = () => {
      wrap.classList.remove('skeleton');
      wrap.innerHTML = `<span class="card-name-fallback">${ch.name || 'Sconosciuto'}</span>`;
    };
    img.src = ch.logo;
    wrap.appendChild(img);
  } else {
    wrap.innerHTML = `<span class="card-name-fallback">${ch.name || 'Sconosciuto'}</span>`;
  }

  card.appendChild(wrap);

  // Mobile: aggiungi riga dettagli stile YouTube (EPG caricata async dopo)
  if (isMobile) {
    getCurrent(ch).then(epg => {

    // ── Thumbnail: anteprima EPG se disponibile, altrimenti logo ──
    wrap.innerHTML = '';
    wrap.classList.add('skeleton');
    const thumbSrc = epg?.icon || ch.logo || '';
    const isEpgThumb = !!(epg?.icon);

    if (thumbSrc) {
      const img = document.createElement('img');
      img.alt = '';
      img.className = isEpgThumb ? 'thumb-epg' : 'thumb-logo';
      img.onload = () => {
        wrap.classList.remove('skeleton');
        if (!isEpgThumb) {
          extractDominantColor(thumbSrc, color => {
            wrap.style.background = color ? `rgba(${color.r},${color.g},${color.b},0.15)` : `rgba(45,31,90,0.3)`;
          });
        }
      };
      img.onerror = () => {
        wrap.classList.remove('skeleton');
        wrap.innerHTML = `<span class="card-name-fallback">${ch.name}</span>`;
      };
      img.src = thumbSrc;
      wrap.appendChild(img);
    } else {
      wrap.classList.remove('skeleton');
      wrap.innerHTML = `<span class="card-name-fallback">${ch.name}</span>`;
    }

    // Timestamp EPG in basso a destra sulla card (stile YouTube)
    if (epg) {
      const ts = document.createElement('div');
      ts.className = 'card-timestamp';
      ts.textContent = `${fmtTime(new Date(epg.start))} / ${fmtTime(new Date(epg.stop))}`;
      wrap.appendChild(ts);
    }

    // ── Riga dettagli sotto la card ──
    const details = document.createElement('div');
    details.className = 'video-details';

    // Avatar logo canale (piccolo, cerchio)
    const avatar = document.createElement('div');
    avatar.className = 'channel-avatar';
    if (ch.logo) {
      const aImg = document.createElement('img');
      aImg.src = ch.logo; aImg.alt = '';
      aImg.onerror = () => { avatar.innerHTML = `<span class="avatar-fallback">${(ch.name||'?')[0].toUpperCase()}</span>`; };
      avatar.appendChild(aImg);
    } else {
      avatar.innerHTML = `<span class="avatar-fallback">${(ch.name||'?')[0].toUpperCase()}</span>`;
    }

    // Testo: titolo EPG + nome canale
    const textDiv = document.createElement('div');
    textDiv.className = 'card-text';

    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = epg?.title || ch.name;

    const chanEl = document.createElement('div');
    chanEl.className = 'card-chan-name';
    chanEl.textContent = ch.name;

    textDiv.appendChild(titleEl);
    textDiv.appendChild(chanEl);

    // Views badge — a destra
    const viewsEl = document.createElement('div');
    viewsEl.className = 'card-views';
    viewsEl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:.82rem;font-weight:500;color:rgba(255,255,255,.6);flex-shrink:0;margin-left:auto;';
    viewsEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:17px;font-variation-settings:\'FILL\' 1,\'wght\' 400,\'GRAD\' 0,\'opsz\' 24">visibility</span><span class="card-views-count"></span>';

    details.appendChild(avatar);
    details.appendChild(textDiv);
    details.appendChild(viewsEl);
    card.appendChild(details);

    // Carica views async
    fetchViews(ch.url).then(views => {
      if (views === null || views === 0) { viewsEl.style.display = 'none'; return; }
      const countEl = viewsEl.querySelector('.card-views-count');
      if (countEl) countEl.textContent = views >= 1000000
        ? (views/1000000).toFixed(1).replace('.0','') + 'M'
        : views >= 1000
        ? (views/1000).toFixed(1).replace('.0','') + 'K'
        : String(views);
    });

    // Colore dinamico sul nome canale
    if (ch.logo) {
      extractDominantColor(ch.logo, color => {
        if (color) {
          const [h, s] = rgbToHsl(color.r, color.g, color.b);
          const [lr, lg, lb] = hslToRgb(h, Math.min(s, 60), 75);
          chanEl.style.color = `rgb(${lr},${lg},${lb})`;
        }
      });
    }
    }); // end getCurrent.then
  }

  card.addEventListener('click', async () => {
    document.querySelectorAll('.channel-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    if (isMobile) {
      // Mobile: seleziona canale e apri player direttamente
      state.activeChannel = ch;
      openPlayer();
      play(ch);
      showSpinner();
      // Registra view
      pingView(ch.url).then(views => {
        if (views === null) return;
        const countEl = viewsEl.querySelector('.card-views-count');
        if (countEl) countEl.textContent = views >= 1000000
          ? (views/1000000).toFixed(1).replace('.0','') + 'M'
          : views >= 1000
          ? (views/1000).toFixed(1).replace('.0','') + 'K'
          : String(views);
        viewsEl.style.display = 'flex';
      });
      const logoImgEl  = $('playerLogoImg');
      const logoTextEl = $('playerLogoText');
      if (logoImgEl && logoTextEl) {
        if (ch.logo) {
          logoImgEl.src = ch.logo; logoImgEl.style.display = 'block'; logoTextEl.style.display = 'none';
        } else {
          logoTextEl.textContent = (ch.name || '?').substring(0, 2).toUpperCase();
          logoImgEl.style.display = 'none'; logoTextEl.style.display = 'flex';
        }
      }
      const epg = await getCurrent(ch);
      const progEl2 = $('playerProgramTitle');
      if (progEl2) progEl2.textContent = epg?.title || ch.name || '';

      // Reset immediato colori
      resetMaterialTheme();
      const progressEl = $('playerProgress');
      if (progressEl) { progressEl.style.background = ''; progressEl.style.removeProperty('background'); }

      // Sfondo player
      const bg = $('playerBg');
      if (bg) bg.style.background = '#0a0a0f';
      let logoEl = document.getElementById('playerBgLogo');
      if (!logoEl) { logoEl = document.createElement('img'); logoEl.id = 'playerBgLogo'; bg?.appendChild(logoEl); }
      if (ch.logo) { logoEl.src = ch.logo; logoEl.style.display = 'block'; } else { logoEl.style.display = 'none'; }

      // Estrai colore fresco
      const _url = ch.url;
      if (ch.logo) {
        _colorCache.delete(ch.logo);
        extractDominantColor(ch.logo, color => {
          if (state.activeChannel?.url !== _url) return;
          if (color) {
            applyMaterialTheme(color.r, color.g, color.b);
            const pal = tonalPalette(color.r, color.g, color.b);
            const pb = $('playerProgress');
            if (pb) pb.style.background = `rgb(${pal.t80[0]},${pal.t80[1]},${pal.t80[2]})`;
            const dr = Math.round(color.r*0.3), dg = Math.round(color.g*0.3), db = Math.round(color.b*0.3);
            if (bg) bg.style.background = `radial-gradient(ellipse 55% 55% at 50% 50%, rgb(${dr},${dg},${db}) 0%, #0a0a0f 70%)`;
          }
        });
      }
    } else {
      updateHero(ch);
    }
  });

  return card;
}

/* ── Niente wheel custom — scroll normale ── */
function bindDragScroll(row) {}

function initWheelScroll() {}

/* ── Scroll → prima card visibile aggiorna hero ── */
function bindRowScroll(row, channels) {
  row.addEventListener('scroll', () => {
    const cards   = Array.from(row.querySelectorAll('.channel-card'));
    const rowRect = row.getBoundingClientRect();

    const first = cards.find(card => {
      const r = card.getBoundingClientRect();
      return r.right > rowRect.left + 10 && r.left < rowRect.right;
    });

    if (!first) return;
    const url = first.dataset.url;
    const ch  = channels.find(c => c.url === url);
    if (!ch || ch.url === state.activeChannel?.url) return;

    // Aggiorna active
    document.querySelectorAll('.channel-card').forEach(c => c.classList.remove('active'));
    first.classList.add('active');
    updateHero(ch);
  }, { passive: true });
}

/* ── Render channels ── */
function renderChannels(channels) {
  const container = $('channelsArea');
  if (!container) return;
  container.innerHTML = '';
  const isMobile = document.body.classList.contains('is-mobile');

  const cats = [...new Set(channels.map(ch => ch.group || 'Other'))];

  cats.forEach(cat => {
    const chs = channels.filter(ch => ch.group === cat);
    if (!chs.length) return;

    if (isMobile) {
      // Mobile: lista verticale senza row/arrows
      const section = document.createElement('div');
      section.className = 'channel-row';

      const title = document.createElement('div');
      title.className = 'channel-row-title';
      title.textContent = cat;
      section.appendChild(title);

      chs.forEach(ch => section.appendChild(buildCard(ch)));
      container.appendChild(section);
    } else {
      // Desktop: row orizzontale con frecce
      const section = document.createElement('div');
      section.className = 'category-section';

      const title = document.createElement('h3');
      title.className = 'category-title';
      title.textContent = cat;

      const rowWrap = document.createElement('div');
      rowWrap.className = 'row-wrap';

      const btnPrev = document.createElement('button');
      btnPrev.className = 'row-arrow row-arrow--prev';
      btnPrev.innerHTML = '<span class="material-symbols-outlined">chevron_left</span>';

      const btnNext = document.createElement('button');
      btnNext.className = 'row-arrow row-arrow--next';
      btnNext.innerHTML = '<span class="material-symbols-outlined">chevron_right</span>';

      const row = document.createElement('div');
      row.className = 'channel-row';

      chs.forEach(ch => row.appendChild(buildCard(ch)));

      const SCROLL_AMT = 240 * 3;
      btnPrev.addEventListener('click', () => row.scrollBy({ left: -SCROLL_AMT, behavior: 'smooth' }));
      btnNext.addEventListener('click', () => row.scrollBy({ left:  SCROLL_AMT, behavior: 'smooth' }));

      rowWrap.appendChild(btnPrev);
      rowWrap.appendChild(row);
      rowWrap.appendChild(btnNext);

      section.appendChild(title);
      section.appendChild(rowWrap);
      container.appendChild(section);
    }
  });

  // Prima card attiva
  const firstCard = container.querySelector('.channel-card');
  if (firstCard) {
    firstCard.classList.add('active');
    if (channels[0] && !isMobile) updateHero(channels[0]);
  }

  // Mobile: aggiorna colore tab attiva in base alla prima card visibile
  if (isMobile) {
    if (window._catScrollHandler) window.removeEventListener('scroll', window._catScrollHandler, true);
    const updateCatColor = () => {
      const cards = Array.from(container.querySelectorAll('.channel-card'));
      const topCard = cards.find(c => c.getBoundingClientRect().top >= 100);
      if (!topCard) return;
      const logo = topCard.dataset.logo;
      const activeBtn = document.querySelector('#categoriesBar .cat-btn.active');
      if (!logo || !activeBtn) return;
      extractDominantColor(logo, color => {
        if (!color) return;
        const [h, s] = rgbToHsl(color.r, color.g, color.b);
        const [lr, lg, lb] = hslToRgb(h, Math.min(s, 70), 70);
        const [dr, dg, db] = hslToRgb(h, Math.min(s, 70), 20);
        activeBtn.style.background = `rgb(${dr},${dg},${db})`;
        activeBtn.style.color      = `rgb(${lr},${lg},${lb})`;
      });
    };
    window._catScrollHandler = updateCatColor;
    window.addEventListener('scroll', updateCatColor, { passive: true, capture: true });
    setTimeout(updateCatColor, 500);
  }
}

/* ── Categorie ── */
function renderCategories(channels) {
  const bar = $('categoriesBar');
  if (!bar) return;

  const cats = [...new Set(channels.map(ch => ch.group || 'Other'))];
  bar.innerHTML = '';

  // Determina il tipo sorgente di ogni categoria per il dot
  const catSource = {};
  channels.forEach(ch => {
    const g = ch.group || 'Other';
    if (!catSource[g]) catSource[g] = ch._source || 'url';
  });

  cats.forEach((cat, i) => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (i === 0 ? ' active' : '');
    btn.dataset.cat = cat;

    // Dot colorato come v2.3
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.cat-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = '';
        b.style.color = '';
      });
      btn.classList.add('active');
      renderChannels(channels.filter(ch => ch.group === cat));
    });

    bar.appendChild(btn);
  });

  // Frecce — visibili solo se overflow
  updateCatArrows(bar);
  bar.addEventListener('scroll', () => updateCatArrows(bar), { passive: true });
}

function updateCatArrows(bar) {
  const prev = $('catPrev');
  const next = $('catNext');
  if (!prev || !next || !bar) return;
  // Forza reflow prima di misurare
  const hasOverflow = bar.scrollWidth > bar.offsetWidth + 4;
  prev.style.display = hasOverflow ? 'flex' : 'none';
  next.style.display = hasOverflow ? 'flex' : 'none';
}

/* ── Player ── */
let _controlsTimer = null;

function showControls() {
  const overlay = $('playerOverlay');
  if (!overlay) return;
  overlay.classList.add('show-controls');
  clearTimeout(_controlsTimer);
  // Mobile: timeout più lungo (5s), desktop 3s
  const timeout = document.body.classList.contains('is-mobile') ? 5000 : 3000;
  _controlsTimer = setTimeout(() => {
    overlay.classList.remove('show-controls');
  }, timeout);
}

function openPlayer() {
  const overlay = $('playerOverlay');
  overlay?.classList.add('active');
  state.playerOpen = true;
  showControls();

  // Mostra controlli su movimento mouse o touch
  overlay?.addEventListener('mousemove', showControls);
  overlay?.addEventListener('touchstart', showControls, { passive: true });

  // Mobile: tap sul video mostra/nasconde i controlli
  if (document.body.classList.contains('is-mobile')) {
    const video = $('videoEl');
    video?.addEventListener('click', showControls);
  }
}

function closePlayer() {
  $('playerOverlay')?.classList.remove('active');
  stop();
  state.playerOpen = false;

  // Ripristina hero e card attiva sull'ultimo canale visualizzato
  if (state.activeChannel) {
    updateHero(state.activeChannel);
    // Trova e riattiva la card corrispondente
    const cards = document.querySelectorAll('.channel-card');
    cards.forEach(card => {
      const isActive = card.dataset.url === state.activeChannel.url;
      card.classList.toggle('active', isActive);
      if (isActive) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  }
}

async function bindWatchNow() {
  $('watchNowBtn')?.addEventListener('click', async () => {
    if (!state.activeChannel) return;
    openPlayer();
    play(state.activeChannel);
    showSpinner();
    pingView(state.activeChannel.url).then(views => {
      const el = $('heroViewCount');
      if (el && views !== null) {
        el.textContent = views >= 1000
          ? (views / 1000).toFixed(1).replace('.0', '') + 'K'
          : String(views);
      }
    });
    
    updatePlayerBg(state.activeChannel);
    const ch = state.activeChannel;
    const epg = await getCurrent(ch);

    // Logo nel player
    const logoImgEl  = $('playerLogoImg');
    const logoTextEl = $('playerLogoText');
    if (logoImgEl && logoTextEl) {
      if (ch.logo) {
        logoImgEl.src = ch.logo; logoImgEl.style.display = 'block'; logoTextEl.style.display = 'none';
      } else {
        logoTextEl.textContent = (ch.name || '?').substring(0, 2).toUpperCase();
        logoImgEl.style.display = 'none'; logoTextEl.style.display = 'flex';
      }
    }

    const titleEl = $('playerProgramTitle');
    const fill = $('playerProgress');
    if (epg) {
      if (titleEl) titleEl.textContent = epg.title || '';
      if (fill) { fill.style.width = `${epg.pct}%`; fill.classList.remove('is-buffer'); }
    } else {
      if (titleEl) titleEl.textContent = 'Live';
      if (fill) { fill.style.width = '0%'; fill.classList.add('is-buffer'); }
    }
  });
}

async function bindPlayerControls() {
  const getVideo = () => document.getElementById('videoEl');

  $('playerClose')?.addEventListener('click', closePlayer);

  $('playerPlay')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const v = getVideo(); if (!v) return;
    if (v.paused) { 
      v.play().catch(()=>{}); 
      if ($('playerPlayIcon')) $('playerPlayIcon').textContent = 'pause'; 
    } else { 
      v.pause(); 
      if ($('playerPlayIcon')) $('playerPlayIcon').textContent = 'play_arrow'; 
    }
  });

  $('playerRewind')?.addEventListener('click',  (e) => { e.stopPropagation(); rewind(10); });
  $('playerForward')?.addEventListener('click', (e) => { e.stopPropagation(); forward(10); });

  // ── Time display — ora corrente / fine EPG ──
  const updateTimeDisplay = async () => {
    const el = $('playerTimeDisplay'); if (!el) return;
    const now = new Date();
    const nowStr = fmtTime(now);
    const epg = state.activeChannel ? await getCurrent(state.activeChannel) : null;
    if (epg) {
      el.textContent = `${nowStr} / ${fmtTime(new Date(epg.stop))}`;
    } else {
      const vid = getVideo();
      if (vid && isFinite(vid.duration) && vid.duration > 0) {
        const dur = vid.duration;
        const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
        el.textContent = `${nowStr} / ${fmt(dur)}`;
      } else {
        el.textContent = nowStr;
      }
    }
  };
  setInterval(updateTimeDisplay, 1000);

  // Stub speed — ridefiniti sotto nella sezione Speed Button
  let _speedIdx = 0;
  let updateSpeedBtn = () => {};

  // ── Logica Cambio Canale (Navigazione) ──
  const navigateChannel = async (direction) => {
    const allCh = state.allChannels;
    if (!allCh.length || !state.activeChannel) return;

    let currentIndex = allCh.findIndex(c => c.url === state.activeChannel.url);
    let nextIndex = currentIndex + direction;

    if (nextIndex >= allCh.length) nextIndex = 0;
    if (nextIndex < 0) nextIndex = allCh.length - 1;

    const nextCh = allCh[nextIndex];
    state.activeChannel = nextCh;
    play(nextCh);
    showSpinner();
    pingView(nextCh.url);
    
    updateHero(nextCh);
    updatePlayerBg(nextCh);

    // Reset + aggiorna colore dinamico
    resetMaterialTheme();
    const pb = $('playerProgress');
    if (pb) { pb.style.background = ''; pb.style.removeProperty('background'); }
    if (nextCh.logo) {
      _colorCache.delete(nextCh.logo);
      extractDominantColor(nextCh.logo, color => {
        if (state.activeChannel?.url !== nextCh.url) return;
        if (color) {
          applyMaterialTheme(color.r, color.g, color.b);
          const pal = tonalPalette(color.r, color.g, color.b);
          const p = $('playerProgress');
          if (p) p.style.background = `rgb(${pal.t80[0]},${pal.t80[1]},${pal.t80[2]})`;
        }
      });
    }

    // Reset velocità a 1x al cambio canale
    _speedIdx = 0;
    const vid2 = getVideo(); if (vid2) vid2.playbackRate = 1;
    updateSpeedBtn();

    const titleEl = $('playerProgramTitle');

    const logoImgEl = $('playerLogoImg');
    const logoTextEl = $('playerLogoText');
    if (logoImgEl && logoTextEl) {
      if (nextCh.logo) {
        logoImgEl.src = nextCh.logo;
        logoImgEl.style.display = 'block';
        logoTextEl.style.display = 'none';
      } else {
        logoTextEl.textContent = (nextCh.name || '?').substring(0, 2).toUpperCase();
        logoImgEl.style.display = 'none';
        logoTextEl.style.display = 'flex';
      }
    }

    const epg = await getCurrent(nextCh);
    const fill = $('playerProgress');

    if (epg) {
      if (titleEl) titleEl.textContent = epg.title || '';
      if (fill) { fill.style.width = `${epg.pct}%`; fill.classList.remove('is-buffer'); }
    } else {
      if (titleEl) titleEl.textContent = 'Live';
      if (fill) { fill.style.width = '0%'; fill.classList.add('is-buffer'); }
    }

    // Aggiorna il colore dinamico del volume dopo il cambio canale
    setTimeout(updateVolSlider, 150);
  };

  $('playerPrevChan')?.addEventListener('click', (e) => { e.stopPropagation(); navigateChannel(-1); });
  $('playerNextChan')?.addEventListener('click', (e) => { e.stopPropagation(); navigateChannel(1); });

  // ── Volume ──
  const VOLUME_KEY = 'xvb3.volume';
  const saveVol = (v) => { try { localStorage.setItem(VOLUME_KEY, String(v)); } catch {} };
  const loadVol = () => { try { const v = parseFloat(localStorage.getItem(VOLUME_KEY)); return isFinite(v) ? Math.max(0,Math.min(1,v)) : 1; } catch { return 1; } };
  
  let volTimer = null;
  const openVolUI = () => {
    const c = document.querySelector('.volume-container'); if (!c) return;
    c.classList.add('open'); clearTimeout(volTimer);
    volTimer = setTimeout(() => c.classList.remove('open'), 3000);
  };

  // ── Volume + Boost — barra unica ──
  // Slider range: 0–2
  //   0–1  → volume normale (0%–100%), boost = 1x
  //   1–2  → volume fisso a 1, boost da 1x a 3x (mappato linearmente)
  // Colore barra: primario nella zona 0–1, rosso nella zona 1–2

  let _audioCtx = null, _gainNode = null, _sourceNode = null, _boostReady = false, _boostDisabled = false;

  const ensureBoost = () => {
    if (_boostDisabled || _boostReady) return _boostReady;
    const vid = getVideo(); if (!vid) return false;
    try {
      _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      _sourceNode = _sourceNode || _audioCtx.createMediaElementSource(vid);
      _gainNode   = _gainNode   || _audioCtx.createGain();
      _sourceNode.connect(_gainNode);
      _gainNode.connect(_audioCtx.destination);
      _gainNode.gain.value = vid.volume;
      _boostReady = true;
      return true;
    } catch { _boostDisabled = true; return false; }
  };

  // Aggiorna la grafica della barra unica e applica volume + boost
  const updateVolSlider = async () => {
    const s = $('volumeSlider'); if (!s) return;
    const raw = parseFloat(s.value) || 0;          // 0–2
    const vid = getVideo();
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--md-primary').trim() || '#d0bcff';
    const SPLIT = 1;   // punto di separazione volume/boost nella barra
    const MAX   = 2;

    if (raw <= SPLIT) {
      // Zona volume: colore primario fino al valore, poi grigio
      const volPct = (raw / SPLIT) * (SPLIT / MAX) * 100;  // % sulla barra totale
      const splitPct = (SPLIT / MAX) * 100;                 // 50%
      s.style.background = `linear-gradient(to right,
        ${primaryColor} 0%,
        ${primaryColor} ${volPct}%,
        rgba(255,255,255,.12) ${volPct}%,
        rgba(255,255,255,.12) ${splitPct}%,
        rgba(255,255,255,.06) ${splitPct}%,
        rgba(255,255,255,.06) 100%)`;

      // Imposta volume, azzera boost
      if (vid) { vid.volume = raw; vid.muted = raw === 0; }
      if (_boostReady && _gainNode) _gainNode.gain.value = vid ? vid.volume : raw;

      const muteIcon = $('muteGlyph');
      if (muteIcon) muteIcon.textContent = raw === 0 ? 'volume_off' : raw <= 0.66 ? 'volume_down' : 'volume_up';
      if (raw > 0) saveVol(raw);

    } else {
      // Zona boost: volume fisso a 1, boost 1x–3x
      const boostMultiplier = 1 + ((raw - SPLIT) / (MAX - SPLIT)) * 2; // mappa 1–2 → 1x–3x
      const splitPct  = (SPLIT / MAX) * 100;  // 50%
      const boostPct  = (raw   / MAX) * 100;

      s.style.background = `linear-gradient(to right,
        ${primaryColor} 0%,
        ${primaryColor} ${splitPct}%,
        #ff4d4d ${splitPct}%,
        #ff4d4d ${boostPct}%,
        rgba(255,255,255,.12) ${boostPct}%,
        rgba(255,255,255,.12) 100%)`;

      // Mantieni volume al 100%
      if (vid) { vid.volume = 1; vid.muted = false; }
      const muteIcon = $('muteGlyph');
      if (muteIcon) muteIcon.textContent = 'volume_up';
      saveVol(1);

      // Applica boost
      if (ensureBoost()) {
        if (_audioCtx?.state === 'suspended') await _audioCtx.resume();
        if (_gainNode) _gainNode.gain.value = boostMultiplier;
      }

      // Aggiorna label nel menu settings
      const valNode = $('boostValue');
      if (valNode) valNode.textContent = `${Math.round(boostMultiplier * 100)}%`;
    }
  };

  // changeVolume ora è solo un helper che imposta lo slider e aggiorna
  const changeVolume = (val) => {
    const s = $('volumeSlider'); if (!s) return;
    // val è 0–1 (volume reale), lo mappiamo nella zona 0–1 dello slider
    const v = Math.max(0, Math.min(1, parseFloat(val) || 0));
    s.value = v;
    updateVolSlider();
  };

  const savedVol = loadVol();
  const volSlider = $('volumeSlider');
  if (volSlider) {
    volSlider.value = savedVol;
    setTimeout(updateVolSlider, 100);
  }
  changeVolume(savedVol);

  volSlider?.addEventListener('input', () => { updateVolSlider(); openVolUI(); });
  document.querySelector('.volume-container')?.addEventListener('mouseenter', openVolUI);

  $('muteBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const vid = getVideo(); if (!vid) return;
    const s = $('volumeSlider'); if (!s) return;
    const raw = parseFloat(s.value) || 0;
    if (raw > 0) {
      s.dataset.lastVal = String(raw);
      s.value = 0;
    } else {
      s.value = parseFloat(s.dataset.lastVal || '1');
    }
    updateVolSlider(); openVolUI();
  });

  // Sincronizza boost gain quando il volume cambia (usato da keyboard handler)
  let syncBoostGain = () => {
    if (!_boostReady || !_gainNode) return;
    const s = $('volumeSlider'); if (!s) return;
    const raw = parseFloat(s.value) || 0;
    if (raw > 1) {
      const boostMultiplier = 1 + ((raw - 1) / 1) * 2;
      _gainNode.gain.value = boostMultiplier;
    } else {
      const vid = getVideo();
      if (_gainNode) _gainNode.gain.value = vid ? vid.volume : raw;
    }
  };

  // Keyboard volume up/down lavora sulla barra unificata
  const getSliderVal = () => parseFloat($('volumeSlider')?.value || '0');
  const setSliderVal = (v) => { const s = $('volumeSlider'); if (s) { s.value = v; updateVolSlider(); } };


  // ── Speed button — cicla tra le velocità ──
  const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];
  _speedIdx = 0;
  updateSpeedBtn = () => {
    const rate = SPEEDS[_speedIdx];
    const lbl = $('speedLabel');
    const btn = $('speedBtn');
    if (lbl) lbl.textContent = rate === 1 ? '1×' : `${rate}×`;
    if (btn) btn.classList.toggle('is-active', rate !== 1);
  };
  $('speedBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _speedIdx = (_speedIdx + 1) % SPEEDS.length;
    const rate = SPEEDS[_speedIdx];
    const vid = getVideo(); if (vid) vid.playbackRate = rate;
    updateSpeedBtn();
  });
  updateSpeedBtn();

  // ── Fullscreen ──
  $('fullScreenBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const video = $('videoEl');
    // iOS Safari: usa webkitEnterFullscreen sul video element
    if (video && video.webkitEnterFullscreen && !document.fullscreenElement && !document.webkitFullscreenElement) {
      video.webkitEnterFullscreen();
      return;
    }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const isFull = !!document.fullscreenElement;
    const playerIcon = $('fullScreenBtn')?.querySelector('.material-symbols-outlined');
    if (playerIcon) playerIcon.textContent = isFull ? 'close_fullscreen' : 'open_in_full';
    const heroIcon = $('heroFullscreenBtn')?.querySelector('.material-symbols-outlined');
    if (heroIcon) heroIcon.textContent = isFull ? 'close_fullscreen' : 'open_in_full';
  });
  // iOS Safari webkitfullscreenchange
  document.addEventListener('webkitfullscreenchange', () => {
    const isFull = !!document.webkitFullscreenElement;
    const playerIcon = $('fullScreenBtn')?.querySelector('.material-symbols-outlined');
    if (playerIcon) playerIcon.textContent = isFull ? 'close_fullscreen' : 'open_in_full';
  });

  // ── Recording ──
  let _rec = null, _recChunks = [], _recTimer = null, _recStart = null;
  let _recAudioCtx = null, _recSrcNode = null, _recGainNode = null, _recDestNode = null;
  const updateRecUI = () => {
    const btn = $('recordBtn'), icon = $('recordIcon'), timer = $('recordTimer');
    const floating = $('recFloatingBadge'), fTimer = $('recFloatingTimer');
    const overlayVisible = $('playerOverlay')?.classList.contains('active');
    const active = _rec?.state === 'recording';
    if (btn) btn.classList.toggle('is-recording', active);
    if (icon) icon.textContent = active ? 'downloading' : 'radio_button_checked';
    if (!active) { if (timer) timer.textContent = ''; if (fTimer) fTimer.textContent = '00:00'; }
    else {
      const s = Math.max(0, Math.floor((Date.now() - _recStart) / 1000));
      const txt = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
      if (timer) timer.textContent = txt; if (fTimer) fTimer.textContent = txt;
    }
    if (floating) { const show = active && !overlayVisible; floating.hidden = !show; floating.style.display = show ? 'inline-flex' : 'none'; }
  };
  $('recordBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (_rec?.state === 'recording') { _rec.stop(); clearInterval(_recTimer); return; }
    const vid = getVideo(); if (!vid) return;
    const cs = vid.captureStream?.() || vid.mozCaptureStream?.(); if (!cs) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    _recAudioCtx = new AudioCtx();
    if (_recAudioCtx.state === 'suspended') await _recAudioCtx.resume();
    _recSrcNode = _recAudioCtx.createMediaElementSource(vid);
    _recGainNode = _recAudioCtx.createGain(); _recGainNode.gain.value = 1;
    _recDestNode = _recAudioCtx.createMediaStreamDestination();
    _recSrcNode.connect(_recGainNode); _recGainNode.connect(_recAudioCtx.destination); _recGainNode.connect(_recDestNode);
    const fs = new MediaStream([...cs.getVideoTracks(), ..._recDestNode.stream.getAudioTracks()]);
    _recChunks = [];
    const mime = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    _rec = new MediaRecorder(fs, mime ? { mimeType: mime } : {});
    _rec.ondataavailable = e => { if (e.data?.size) _recChunks.push(e.data); };
    _rec.onstop = () => {
      const blob = new Blob(_recChunks, { type: mime || 'video/webm' });
      if (blob.size > 0) {
        const chName = (state.activeChannel?.name || 'rec').replace(/[^a-z0-9]/gi,'_').slice(0,60);
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${chName}_${ts}.webm`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      _recChunks = []; _rec = null; clearInterval(_recTimer);
      try { _recSrcNode?.disconnect(_recDestNode); } catch {} updateRecUI();
    };
    _rec.start(1000); _recStart = Date.now();
    _recTimer = setInterval(updateRecUI, 1000); updateRecUI(); vid.play().catch(()=>{});
  });

  const obs = new MutationObserver(updateRecUI);
  const overlay = $('playerOverlay'); if (overlay) obs.observe(overlay, { attributes: true, attributeFilter: ['class'] });

  // ── Controlli da Tastiera ──
  document.addEventListener('keydown', (e) => {
    if (!state.playerOpen) return;
    if (e.key === 'Escape') {
      closePlayer();
      return;
    }
    if (document.activeElement.tagName === 'INPUT') return;

    switch (e.key) {
      case 'ArrowRight': { e.preventDefault(); navigateChannel(1); break; }
      case 'ArrowLeft':  { e.preventDefault(); navigateChannel(-1); break; }
      case 'ArrowUp': {
        e.preventDefault();
        const vUp = Math.min(2, (getSliderVal() || 0) + 0.05);
        setSliderVal(vUp); openVolUI();
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        const vDown = Math.max(0, (getSliderVal() || 0) - 0.05);
        setSliderVal(vDown); openVolUI();
        break;
      }
      case ' ': { e.preventDefault(); $('playerPlay').click(); break; }
    }
  });

  updateRecUI();
}
/* ── Views ── */
async function pingView(channelUrl) {
  if (!channelUrl || !CONFIG.STATS_URL) return;
  try {
    const res = await fetch(`${CONFIG.STATS_URL}/view`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelUrl }),
    });
    const data = await res.json();
    return data?.views ?? null;
  } catch { return null; }
}

async function fetchViews(channelUrl) {
  if (!channelUrl || !CONFIG.STATS_URL) return null;
  try {
    const res = await fetch(`${CONFIG.STATS_URL}/views?url=${encodeURIComponent(channelUrl)}`, { cache: 'no-store' });
    const data = await res.json();
    return data?.views ?? null;
  } catch { return null; }
}

function startOnlineRefresh() {
  // rimosso — solo views per canale
}

/* ── Hero refresh ── */
function startHeroRefresh() {
  setInterval(() => {
    if (state.activeChannel) updateHero(state.activeChannel);
  }, 30000);
}

/* ── Player EPG progress refresh ── */
function startPlayerProgressRefresh() {
  setInterval(async () => {
    if (!state.playerOpen || !state.activeChannel) return;
    const epg = await getCurrent(state.activeChannel);
    const fill = $('playerProgress');
    if (epg) {
      if (fill) { fill.style.width = `${epg.pct}%`; fill.classList.remove('is-buffer'); }
      const titleEl = $('playerProgramTitle');
      if (titleEl && !titleEl.textContent) titleEl.textContent = epg.title || '';
    } else {
      if (fill) fill.classList.add('is-buffer');
    }
  }, 10000);
}

/* ── Init ── */
/* ── Profile ── */
const AVATAR_KEY = 'xvb3.avatar';
const NAME_KEY   = 'xvb3.username';

function loadProfile() {
  const avatarBtn = $('avatarBtn');
  const avatar    = localStorage.getItem(AVATAR_KEY);
  const name      = localStorage.getItem(NAME_KEY) || '';
  const isMobile  = document.body.classList.contains('is-mobile');

  if (avatarBtn) {
    if (isMobile) {
      // Mobile: solo immagine rotonda o icona
      const img  = avatarBtn.querySelector('#topbarAvatarImg');
      const icon = avatarBtn.querySelector('#topbarAvatarIcon');
      if (avatar && img) {
        img.src = avatar;
        img.classList.add('loaded');
        if (icon) icon.style.display = 'none';
      }
      avatarBtn.onclick = () => { window.location.href = 'settings.html?tab=profile'; };
    } else {
      const img = avatar
        ? `<img src="${avatar}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<span class="material-symbols-outlined" style="font-size:26px">account_circle</span>`;
      const nameHtml = name
        ? `<span style="font-size:14px;font-weight:600;color:var(--md-primary);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>`
        : '';
      avatarBtn.innerHTML = img + nameHtml;
      avatarBtn.style.cssText = name
        ? 'display:flex;align-items:center;gap:7px;padding:0 12px 0 6px;border-radius:999px;width:auto;'
        : 'display:flex;align-items:center;justify-content:center;border-radius:50%;width:40px;height:40px;';
      avatarBtn.onclick = () => { window.location.href = 'settings.html?tab=profile'; };
    }
  }
}

/* ── Empty state (no playlists) ── */
function showEmptyState() {
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.style.display = 'none';

  let el = document.getElementById('xvb3Empty');
  if (!el) {
    el = document.createElement('div');
    el.id = 'xvb3Empty';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0f1014;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:"Google Sans","Roboto",sans-serif;';
    el.innerHTML = `
      <img src="assets/icon.jpg" alt="XVB" style="width:72px;height:72px;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,.5)">
      <div style="text-align:center">
        <div style="font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:8px">No playlists found</div>
        <div style="font-size:.88rem;color:rgba(255,255,255,.45)">Add a playlist in Settings to get started.</div>
      </div>
      <a href="settings.html" style="display:inline-flex;align-items:center;gap:8px;padding:12px 24px;background:#d0bcff;color:#1a0a3a;border-radius:999px;font-weight:700;font-size:.9rem;text-decoration:none">
        <span style="font-family:'Material Symbols Outlined';font-variation-settings:'FILL' 1">settings</span>
        Open Settings
      </a>`;
    document.body.appendChild(el);
  }

  // Ricarica automaticamente se l'utente aggiunge una playlist dal settings
  if ('BroadcastChannel' in window) {
    const bc = new BroadcastChannel('xvb_playlists_v2');
    bc.onmessage = async (ev) => {
      if (ev?.data?.type !== 'changed') return;
      bc.close();
      window.location.reload();
    };
  }
}

/* ── Loading screen ── */
function showLoading(msg = 'Loading…') {
  let el = document.getElementById('xvb3Loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'xvb3Loading';
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0f1014;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:"Google Sans","Roboto",sans-serif;transition:opacity .4s ease;';
    el.innerHTML = `
      <img src="assets/icon.jpg" alt="XVB" style="width:72px;height:72px;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,.5)">
      <div id="xvb3LoadingMsg" style="font-size:.9rem;color:rgba(255,255,255,.5)">${msg}</div>
      <div style="width:180px;height:2px;background:rgba(255,255,255,.1);border-radius:999px;overflow:hidden">
        <div id="xvb3LoadingBar" style="height:100%;background:#d0bcff;border-radius:999px;width:30%;animation:loadSlide 1.2s ease-in-out infinite alternate"></div>
      </div>`;
    const s = document.createElement('style');
    s.textContent = '@keyframes loadSlide{from{margin-left:0}to{margin-left:70%}}';
    el.appendChild(s);
    document.body.appendChild(el);
  }
  const msgEl = document.getElementById('xvb3LoadingMsg');
  if (msgEl) msgEl.textContent = msg;
}

function hideLoading() {
  const el = document.getElementById('xvb3Loading');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 400);
}

/* ── Init ── */
async function init() {
  // ── Mobile detection ──
  const isMobile = document.querySelector('meta[name="mobile-page"]') !== null;
  if (isMobile) document.body.classList.add('is-mobile');

  // ── openSettings redirect ──
  if (new URLSearchParams(window.location.search).get('openSettings') === '1') {
    window.location.replace('settings.html');
    return;
  }

  showLoading('Loading channels…');

  // ── Carica playlist ──
  const channels = await loadPlaylist();

  if (!channels.length) {
    hideLoading();

    // Prima visita assoluta → welcome step 1
    if (!localStorage.getItem('xvb3.firstRun')) {
      window.location.replace('welcome.html');
      return;
    }

    if (sessionStorage.getItem('xvb3.fromWelcome')) {
      sessionStorage.removeItem('xvb3.fromWelcome');
      showEmptyState();
      return;
    }

    sessionStorage.setItem('xvb3.fromWelcome', '1');
    window.location.replace('welcome.html?noPlaylists=1');
    return;
  }

  localStorage.setItem('xvb3.firstRun', 'done');
  loadProfile();
  showLoading('');

  initPlayer({
    video:      $('videoEl'),
    iframe:     $('videoIframe'),
    shield:     $('iframeShield'),
    onPlay: ch => {
      hideStatus();
      if (ch) ch._retried = false;
      $('playerOverlay')?.classList.remove('show-controls');
      xvbLog('[XVB3] Playing:', ch.name);
    },
    onStop: () => {
      hideStatus();
      xvbLog('[XVB3] Stopped');
    },
    onError: msg => {
      const ch = state.activeChannel;
      if (ch && !ch._retried) {
        ch._retried = true;
        showSpinner('Retrying…');
        setTimeout(() => {
          if (state.activeChannel?.url === ch.url) {
            play(ch).catch(() => showError(msg));
          }
        }, 2000);
      } else {
        if (ch) ch._retried = false;
        showError(msg);
      }
      xvbLog('[XVB3] Error:', msg);
    },
    onProgress: async (pct) => {
      if (!state.playerOpen || !state.activeChannel) return;
      const epg = await getCurrent(state.activeChannel);
      if (!epg) {
        const fill = $('playerProgress');
        if (fill) { fill.style.width = `${pct}%`; fill.classList.add('is-buffer'); }
      }
    },
  });

  bindWatchNow();
  bindPlayerControls();
  initWheelScroll();

  // Frecce categorie
  const catBar = $('categoriesBar');
  $('catPrev')?.addEventListener('click', () => { catBar?.scrollBy({ left: -200, behavior: 'smooth' }); setTimeout(() => updateCatArrows(catBar), 300); });
  $('catNext')?.addEventListener('click', () => { catBar?.scrollBy({ left:  200, behavior: 'smooth' }); setTimeout(() => updateCatArrows(catBar), 300); });

  // ── BroadcastChannel: playlist changes ──
  if ('BroadcastChannel' in window) {
    const bcPl = new BroadcastChannel('xvb_playlists_v2');
    bcPl.onmessage = async (ev) => {
      if (ev?.data?.type !== 'changed') return;
      const updated = await loadPlaylist();
      if (updated.length) {
        const favCh = getFavouritesAsGroup();
        const combined = [...favCh, ...updated];
        const cat = combined[0]?.group || 'Other';
        renderCategories(combined);
        renderChannels(combined.filter(ch => ch.group === cat));
      }
    };
    const bcProfile = new BroadcastChannel('xvb_profile');
    bcProfile.onmessage = (ev) => { if (ev?.data?.type === 'profile_updated') loadProfile(); };
  }

  // ── Bottone Preferiti ──
  $('heroFavBtn')?.addEventListener('click', () => {
    const ch = state.activeChannel;
    if (!ch) return;
    const nowFav = toggleFavourite(ch);
    updateFavBtn(ch);
    const allCh = state.allChannels;
    const favCh = getFavouritesAsGroup();
    const combined = [...favCh, ...allCh];
    renderCategories(combined);
    const activeCat = document.querySelector('.cat-btn.active')?.dataset.cat;
    if (activeCat) renderChannels(combined.filter(c => c.group === activeCat));
    setTimeout(() => updateCatArrows($('categoriesBar')), 150);
  });

  // ── Bottone Fullscreen Hero ──
  $('heroFullscreenBtn')?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const isFull = !!document.fullscreenElement;
    const heroIcon = $('heroFullscreenBtn')?.querySelector('.material-symbols-outlined');
    if (heroIcon) heroIcon.textContent = isFull ? 'close_fullscreen' : 'open_in_full';
    const playerIcon = $('fullScreenBtn')?.querySelector('.ctrl-icon');
    if (playerIcon) playerIcon.textContent = isFull ? 'close_fullscreen' : 'open_in_full';
  });

  // ── Render iniziale ──
  const favCh = getFavouritesAsGroup();
  const allWithFav = [...favCh, ...channels];
  const firstCat = allWithFav[0]?.group || 'Other';
  renderCategories(allWithFav);
  renderChannels(allWithFav.filter(ch => ch.group === firstCat));
  showLoading('');

  setTimeout(() => updateCatArrows($('categoriesBar')), 200);

  startAutoRefresh();
  startHeroRefresh();
  // Rende footer subito ma icone invisibili — animazione parte dopo hideLoading
  renderFooter(true);
  startPlayerProgressRefresh();
  startOnlineRefresh();

  // Search mobile — input fisso nella topbar
  if (isMobile) {
    const searchInput = $('searchInput');
    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        const activeCat = document.querySelector('.cat-btn.active')?.dataset.cat;
        renderChannels(channels.filter(ch => ch.group === (activeCat || firstCat)));
        return;
      }
      const results = channels.filter(ch => ch.name.toLowerCase().includes(q)).map(ch => ({ ...ch, group: 'Search Results' }));
      renderChannels(results);
    });
  }

  // Search toggle (mobile - legacy overlay, non usato con nuovo layout)
  $('searchToggleBtn')?.addEventListener('click', () => {
    const overlay = $('searchOverlay');
    if (overlay) { overlay.hidden = false; $('searchInput')?.focus(); }
  });
  $('searchClose')?.addEventListener('click', () => {
    const overlay = $('searchOverlay');
    if (overlay) { overlay.hidden = true; }
    const searchInput = $('searchInput');
    if (searchInput) { searchInput.value = ''; }
    const activeCat = document.querySelector('.cat-btn.active')?.dataset.cat;
    renderChannels(channels.filter(ch => ch.group === (activeCat || firstCat)));
  });

  // Drag scroll categorie su mobile
  if (isMobile) {
    const catBar = $('categoriesBar');
    if (catBar) {
      let isDown = false, startX = 0, scrollLeft = 0;
      catBar.addEventListener('touchstart', e => {
        isDown = true; startX = e.touches[0].pageX - catBar.offsetLeft;
        scrollLeft = catBar.scrollLeft; catBar.classList.add('dragging');
      }, { passive: true });
      catBar.addEventListener('touchmove', e => {
        if (!isDown) return;
        const x = e.touches[0].pageX - catBar.offsetLeft;
        catBar.scrollLeft = scrollLeft - (x - startX);
      }, { passive: true });
      catBar.addEventListener('touchend', () => { isDown = false; catBar.classList.remove('dragging'); });
    }
  }

  // Search toggle (desktop)
  const searchWrap = $('searchWrap');
  const searchInput = $('searchInput');
  searchWrap?.addEventListener('click', () => {
    if (!searchWrap.classList.contains('open')) {
      searchWrap.classList.add('open');
      searchInput?.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (searchWrap && !searchWrap.contains(e.target)) {
      searchWrap.classList.remove('open');
      if (searchInput) { searchInput.value = ''; searchInput.blur(); }
    }
  });
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      const activeCat = document.querySelector('.cat-btn.active')?.dataset.cat;
      renderChannels(channels.filter(ch => ch.group === (activeCat || firstCat)));
      return;
    }
    const results = channels.filter(ch => ch.name.toLowerCase().includes(q)).map(ch => ({ ...ch, group: 'Search Results' })); 
    renderChannels(results);
  });

  // ── NUOVO: Navigazione Home tramite Tastiera (Cards) ──
  document.addEventListener('keydown', (e) => {
    if (state.playerOpen || document.activeElement.tagName === 'INPUT') return;

    const activeCard = document.querySelector('.channel-card.active');
    if (!activeCard) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const row = activeCard.closest('.channel-row');
      const cards = Array.from(row.querySelectorAll('.channel-card'));
      const currentIndex = cards.indexOf(activeCard);
      let nextIndex = currentIndex + (e.key === 'ArrowRight' ? 1 : -1);

      if (nextIndex >= 0 && nextIndex < cards.length) {
        const nextCard = cards[nextIndex];
        nextCard.click();
        nextCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      $('watchNowBtn')?.click();
    }
  });

  // EPG in background — nasconde loading solo quando pronto
  fetchEpg().then(() => {
    hideLoading();
    setTimeout(() => {
      document.querySelectorAll('.app-icon').forEach((el, i) => {
        el.style.animationDelay = `${i * 60}ms`;
        el.classList.add('animate-in');
        el.addEventListener('animationend', () => {
          el.classList.remove('animate-in');
          el.style.animationDelay = '';
        }, { once: true });
      });
    }, 50);
    if (state.activeChannel) updateHero(state.activeChannel);
    // Mobile: re-renderizza le card con anteprime EPG ora disponibili
    if (isMobile) {
      const activeCat = document.querySelector('.cat-btn.active')?.dataset.cat || firstCat;
      const favCh2 = getFavouritesAsGroup();
      const combined2 = [...favCh2, ...channels];
      renderChannels(combined2.filter(ch => ch.group === activeCat));
    }
  }).catch(e => xvbLog('[XVB3] EPG background load failed:', e));
}

// ════ APP FOOTER ════
const DEFAULT_APPS = [
  { name: 'Netflix',          url: 'https://netflix.com',          img: 'https://www.google.com/s2/favicons?sz=128&domain=netflix.com' },
  { name: 'YouTube',          url: 'https://youtube.com',          img: 'https://www.google.com/s2/favicons?sz=128&domain=youtube.com' },
  { name: 'Prime Video',      url: 'https://primevideo.com',       img: 'https://www.google.com/s2/favicons?sz=128&domain=primevideo.com' },
  { name: 'Disney+',          url: 'https://disneyplus.com',       img: 'https://www.google.com/s2/favicons?sz=128&domain=disneyplus.com' },
  { name: 'Apple TV+',        url: 'https://tv.apple.com',         img: 'https://www.google.com/s2/favicons?sz=128&domain=tv.apple.com' },
  { name: 'Max',              url: 'https://max.com',              img: 'https://www.google.com/s2/favicons?sz=128&domain=max.com' },
  { name: 'Spotify',          url: 'https://open.spotify.com',     img: 'https://upload.wikimedia.org/wikipedia/commons/7/75/Spotify_icon.png' },
  { name: 'RaiPlay',          url: 'https://raiplay.it',           img: 'https://www.google.com/s2/favicons?sz=128&domain=raiplay.it' },
  { name: 'Mediaset Infinity',url: 'https://mediasetinfinity.it',  img: 'https://www.google.com/s2/favicons?sz=128&domain=mediasetinfinity.it' },
  { name: 'DAZN',             url: 'https://dazn.com',             img: 'https://www.google.com/s2/favicons?sz=128&domain=dazn.com' },
  { name: 'Now TV',           url: 'https://nowtv.it',             img: 'https://www.google.com/s2/favicons?sz=128&domain=nowtv.it' },
  { name: 'YouTube Music',    url: 'https://music.youtube.com',    img: 'https://www.google.com/s2/favicons?sz=128&domain=music.youtube.com' },
];

const APPS_KEY = 'xvb3.footer_apps';

function getFooterApps() {
  try {
    const raw = localStorage.getItem(APPS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length ? arr : DEFAULT_APPS;
  } catch { return DEFAULT_APPS; }
}

function updateFooterArrows() {
  const track = $('appFooterTrack');
  const prev  = $('appFooterPrev');
  const next  = $('appFooterNext');
  if (!track || !prev || !next) return;
  const hasOverflow = track.scrollWidth > track.clientWidth + 4;
  prev.classList.toggle('visible', hasOverflow && track.scrollLeft > 4);
  next.classList.toggle('visible', hasOverflow && track.scrollLeft < track.scrollWidth - track.clientWidth - 4);
}

function scrollFooter(dir) {
  const track = $('appFooterTrack');
  if (!track) return;
  track.scrollBy({ left: dir * 300, behavior: 'smooth' });
  setTimeout(updateFooterArrows, 350);
}

function renderFooter(noAnimate = false) {
  const track = $('appFooterTrack');
  if (!track) return;
  const apps = getFooterApps();
  track.innerHTML = '';
  apps.forEach((app, i) => {
    const a = document.createElement('a');
    a.className = 'app-icon';
    a.href = app.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = app.name;
    // animation handled after hideLoading
    if (app.img) {
      const img = document.createElement('img');
      img.src = app.img;
      img.alt = app.name;
      img.onerror = () => {
        img.remove();
        a.innerHTML = `<span class="app-icon-fallback">${app.name}</span>`;
      };
      img.onload = () => {
        extractDominantColor(app.img, color => {
          if (color) {
            a.style.setProperty('--app-icon-color', `rgb(${color.r},${color.g},${color.b})`);
          }
        }, img);
      };
      a.appendChild(img);
    } else {
      a.innerHTML = `<span class="app-icon-fallback">${app.name}</span>`;
    }
    // stagger handled after hideLoading
    track.appendChild(a);
  });
  // Copyright
  setTimeout(() => {
    track.scrollLeft = 0;
    updateFooterArrows();
  }, 50);
  track.addEventListener('scroll', updateFooterArrows, { passive: true });
}

document.addEventListener('DOMContentLoaded', init);