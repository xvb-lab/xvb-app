/**
 * XVB3 — player.js
 * Motore video completo — logica DRM identica alla v2.3
 * HLS · DASH/ClearKey (dashjs + Shaka fallback) · MPEGTS · Native · Iframe
 */

import { CONFIG } from './config.js';
import { state }  from './state.js';
import { attachHlsQualityListeners, attachDashQualityListeners, detectQualityFromName, showLoadStatus, hideLoadStatus, showIframeBadge } from './quality.js';

let _video    = null;
let _iframe   = null;
let _shield   = null;
let _onPlay   = null;
let _onStop   = null;
let _onError  = null;
let _onProgress = null;

// ── Progress ──────────────────────────────────────
let _progressTimer = null;

function _startProgress() {
  clearInterval(_progressTimer);
  _progressTimer = setInterval(() => {
    if (!_video || !_onProgress) return;
    const v = _video;
    const d = v.duration;
    let pct = 0;
    if (isFinite(d) && d > 0) {
      pct = (v.currentTime / d) * 100;
    } else {
      try {
        if (v.buffered?.length) {
          const ahead = Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime);
          pct = (Math.min(ahead, CONFIG.PLAYER.LIVE_BUFFER_WINDOW) / CONFIG.PLAYER.LIVE_BUFFER_WINDOW) * 100;
        }
      } catch {}
    }
    _onProgress(Math.max(0, Math.min(100, pct)));
  }, CONFIG.PLAYER.PROGRESS_TICK_MS);
}

function _stopProgress() {
  clearInterval(_progressTimer);
  _progressTimer = null;
}

// ── Destroy engines ───────────────────────────────
function _destroyEngines() {
  if (state.hlsInst) {
    try { state.hlsInst.destroy(); } catch {}
    state.hlsInst = null;
  }
  if (state.dashInst) {
    try { state.dashInst.reset(); } catch {}
    state.dashInst = null;
  }
  if (state.mpegtsInst) {
    try {
      state.mpegtsInst.pause();
      state.mpegtsInst.unload();
      state.mpegtsInst.detachMediaElement();
      state.mpegtsInst.destroy();
    } catch {}
    state.mpegtsInst = null;
  }
  if (window.__shakaPlayer) {
    try { window.__shakaPlayer.destroy(); } catch {}
    window.__shakaPlayer = null;
  }
}

// ── DRM helpers (identici v2.3) ───────────────────
const hexToB64Url = (hex) => {
  const clean = String(hex || '').trim().toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
  const bytes = clean.match(/.{1,2}/g) || [];
  const bin   = bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const parseKidKey = (licStr) => {
  if (!licStr || !licStr.includes(':')) return null;
  const [kidHex, keyHex] = licStr.split(':').map(s => s.trim());
  if (!kidHex || !keyHex) return null;
  return { kidB64: hexToB64Url(kidHex), keyB64: hexToB64Url(keyHex) };
};

// ── Format sniff (identico v2.3) ──────────────────
const sniffByUrl = (url) => {
  const u = url.toLowerCase();
  if (u.includes('.mpd'))                              return 'dash';
  if (u.includes('.m3u8'))                             return 'hls';
  if (u.includes('.ts'))                               return 'mpegts';
  if (u.match(/\.(mp3|aac|m4a)/))                     return 'audio';
  return '';
};

const sniffByContentType = async (url) => {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return (r.headers.get('content-type') || '').toLowerCase();
  } catch { return ''; }
};

const decideFromCt = (ct) => {
  if (ct.includes('dash') || ct.includes('mpd'))  return 'dash';
  if (ct.includes('mpegurl'))                      return 'hls';
  if (ct.includes('video/mp2t'))                   return 'mpegts';
  if (ct.startsWith('video/'))                     return 'native';
  return '';
};

// ── PLAY ──────────────────────────────────────────
export async function play(ch) {
  if (!ch?.url) return;

  const url    = String(ch.url);
  const name   = String(ch.name   || '');
  const lic    = ch['license-details'] || ch.license || '';
  const isDRM  = !!lic;
  const isIframe = CONFIG.IFRAME_PATTERNS.some(p => url.includes(p));
  const token  = ++state._playToken;

  _destroyEngines();
  _stopProgress();
  state.isLoading = true;

  // Reset video
  try { _video.pause(); _video.removeAttribute('src'); _video.load(); } catch {}

  // ── IFRAME ────────────────────────────────────
  if (isIframe && _iframe) {
    // Aggiungi autoplay all'URL
    const iframeSrc = url.includes('?') ? `${url}&autoplay=1` : `${url}?autoplay=1`;
    _iframe.src = iframeSrc;
    _iframe.style.display = 'block';
    if (_shield) _shield.style.display = 'block';
    state.isLoading = false;
    state.isPlaying = true;
    state.playerOpen = true;
    _onPlay?.(ch);
    return;
  }

  if (_iframe) { _iframe.src = 'about:blank'; _iframe.style.display = 'none'; }
  if (_shield) _shield.style.display = 'none';

  // ── Watchdog (identico v2.3) ──────────────────
  let startedOk  = false;
  let startTimer = null;

  const clearWatchdogs = () => { if (startTimer) { clearTimeout(startTimer); startTimer = null; } };

  const armStartWatchdog = () => {
    clearWatchdogs();
    startedOk = false;
    startTimer = setTimeout(() => {
      if (token !== state._playToken) return;
      if (!startedOk) {
        _onError?.('Timeout — stream non disponibile');
        failAndSkip('Timeout loading');
      }
    }, CONFIG.PLAYER.TIMEOUT_MS);
  };

  const markStarted = () => {
    if (token !== state._playToken) return;
    startedOk = true;
    clearWatchdogs();
    state.isLoading = false;
    state.isPlaying = true;
    state.playerOpen = true;
    _onPlay?.(ch);
    _startProgress();
  };

  const failAndSkip = (msg) => {
    if (token !== state._playToken) return;
    _onError?.(msg || 'Stream non disponibile');
  };

  // Video event handlers
  _video.onplaying = () => { if (token !== state._playToken) return; markStarted(); };
  _video.oncanplay = () => { if (token !== state._playToken) return; markStarted(); };
  _video.onerror   = () => { if (token !== state._playToken) return; clearWatchdogs(); failAndSkip('Errore playback'); };

  armStartWatchdog();

  // ── Shaka ClearKey fallback (identico v2.3) ───
  const tryShakaClearKey = async () => {
    const kk = parseKidKey(lic);
    if (!kk) return false;
    if (!window.shaka?.Player) return false;
    try {
      shaka.polyfill.installAll();
      const player = new shaka.Player(_video);
      window.__shakaPlayer = player;
      player.configure({ drm: { clearKeys: { [kk.kidB64]: kk.keyB64 } } });
      player.addEventListener('error', () => {
        if (token !== state._playToken) return;
        clearWatchdogs();
        failAndSkip('DASH DRM error');
      });
      await player.load(url);
      _video.play().catch(() => {});
      return true;
    } catch (e) {
      console.warn('[XVB3] Shaka fallback failed:', e);
      return false;
    }
  };

  // ── Engine starters (identici v2.3) ──────────
  const startDash = () => {
    state.dashInst = dashjs.MediaPlayer().create();
    const kk = parseKidKey(lic);
    if (kk) {
      state.dashInst.setProtectionData({
        'org.w3.clearkey': { clearkeys: { [kk.kidB64]: kk.keyB64 } }
      });
    }
    state.dashInst.initialize(_video, url, true);
    attachDashQualityListeners(name);
    state.dashInst.on(dashjs.MediaPlayer.events.ERROR, async (e) => {
      if (token !== state._playToken) return;
      const msg = (e?.event?.message || e?.error?.message || '').toString().toLowerCase();
      const isLicenseMissing = msg.includes('license') || msg.includes('drm') || msg.includes('key');
      if (parseKidKey(lic) && isLicenseMissing) {
        try { state.dashInst.reset(); } catch {}
        state.dashInst = null;
        const ok = await tryShakaClearKey();
        if (ok) return;
        clearWatchdogs();
        failAndSkip('DASH DRM error');
        return;
      }
      failAndSkip('DASH error');
    });
  };

  const startHls = () => {
    if (window.Hls && Hls.isSupported()) {
      state.hlsInst = new Hls({ enableWorker: true });
      state.hlsInst.on(Hls.Events.ERROR, (_, data) => {
        if (token !== state._playToken) return;
        if (data?.fatal) { clearWatchdogs(); failAndSkip('HLS fatal error'); }
      });
      state.hlsInst.loadSource(url);
      state.hlsInst.attachMedia(_video);
      attachHlsQualityListeners(name);
      state.hlsInst.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token === state._playToken) _video.play().catch(() => {});
      });
    } else {
      // Safari nativo
      _video.src = url; _video.load(); _video.play().catch(() => {});
      detectQualityFromName(name);
    }
  };

  const startMpegTs = () => {
    if (window.mpegts?.getFeatureList().mseLivePlayback) {
      state.mpegtsInst = mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
      try {
        state.mpegtsInst.on(mpegts.Events.ERROR, () => {
          if (token !== state._playToken) return;
          clearWatchdogs();
          failAndSkip('MPEGTS error');
        });
      } catch {}
      state.mpegtsInst.attachMediaElement(_video);
      state.mpegtsInst.load();
      state.mpegtsInst.play().catch(() => {});
    } else {
      _video.src = url; _video.load(); _video.play().catch(() => {});
    }
  };

  const startNative = () => {
    _video.src = url; _video.load(); _video.play().catch(() => {});
  };

  // ── Selezione engine (identica v2.3) ─────────
  const hinted = sniffByUrl(url);
  if (hinted === 'dash' || isDRM) { startDash(); return; }
  if (hinted === 'hls')           { startHls();    return; }
  if (hinted === 'mpegts')        { startMpegTs(); return; }
  if (hinted === 'audio')         { startNative(); return; }

  // HEAD request fallback
  const ct      = await sniffByContentType(url);
  if (token !== state._playToken) return;
  const decided = decideFromCt(ct);

  if (decided === 'dash')   { startDash();    return; }
  if (decided === 'hls')    { startHls();     return; }
  if (decided === 'mpegts') { startMpegTs();  return; }

  startNative();
}

// ── Controlli ─────────────────────────────────────
export function stop() {
  _destroyEngines();
  _stopProgress();
  state._playToken++;
  state.isPlaying  = false;
  state.isLoading  = false;
  state.playerOpen = false;
  try { _video.pause(); _video.removeAttribute('src'); _video.load(); } catch {}
  if (_iframe) { _iframe.src = 'about:blank'; _iframe.style.display = 'none'; }
  if (_shield) _shield.style.display = 'none';
  _onStop?.();
}

export function togglePlay() {
  if (!_video) return;
  if (_video.paused) _video.play().catch(() => {});
  else _video.pause();
}

export function rewind(sec = 10) {
  if (!_video) return;
  _video.currentTime = Math.max(0, _video.currentTime - sec);
}

export function forward(sec = 10) {
  if (!_video) return;
  const d = _video.duration;
  _video.currentTime = isFinite(d) ? Math.min(d, _video.currentTime + sec) : _video.currentTime + sec;
}

export function setVolume(val) {
  const v = Math.max(0, Math.min(1, val));
  if (_video) _video.volume = v;
}

export function getVideoEl() { return _video; }

// ── Init ──────────────────────────────────────────
export function initPlayer({ video, iframe, shield, onPlay, onStop, onError, onProgress }) {
  _video      = video;
  _iframe     = iframe;
  _shield     = shield;
  _onPlay     = onPlay;
  _onStop     = onStop;
  _onError    = onError;
  _onProgress = onProgress;
}