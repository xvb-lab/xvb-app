/**
 * XVB3 — quality.js
 * Portato da v2.3 quality.js — identico
 */

import { state } from './state.js';

const $ = id => document.getElementById(id);

let _activeQuality = { isAuto: true, index: -1, label: 'Auto', height: 0 };

const qBadge = () => $('qualityBadge');

export function keyFromHeight(h) {
  h = Number(h) || 0;
  if (h >= 15360) return '16k';
  if (h >= 7680)  return '8k';
  if (h >= 5120)  return '5k';
  if (h >= 2160)  return '4k';
  if (h >= 1440)  return '1440p';
  if (h >= 1080)  return '1080p';
  if (h >= 720)   return '720p';
  if (h >= 576)   return '576p';
  if (h >= 480)   return '480p';
  if (h >= 360)   return '360p';
  if (h >= 240)   return '240p';
  if (h > 0)      return h + 'p';
  return '';
}

export function labelFromHeight(h) {
  h = Number(h) || 0;
  if (h >= 15360) return '16K';
  if (h >= 7680)  return '8K';
  if (h >= 5120)  return '5K';
  if (h >= 2160)  return '4K';
  if (h >= 1440)  return '1440p';
  if (h >= 1080)  return '1080p';
  if (h >= 720)   return '720p';
  if (h >= 576)   return '576p';
  if (h >= 480)   return '480p';
  if (h >= 360)   return '360p';
  if (h >= 240)   return '240p';
  if (h > 0)      return h + 'p';
  return 'AUTO';
}

function _setActiveQuality(q) {
  _activeQuality = q;
  const badge = qBadge();
  if (q.isAuto) {
    if (q.height > 0 && badge) {
      badge.style.display = 'inline-flex';
      badge.setAttribute('data-q', 'auto');
      badge.innerHTML = `${labelFromHeight(q.height)} <span style="opacity:0.6;font-size:0.78em;margin-left:3px;">auto</span>`;
    }
  } else {
    showQualityBadge(q.label, { key: keyFromHeight(q.height) });
  }
  const qv = $('qualityValue');
  if (qv) qv.textContent = q.isAuto
    ? (q.height ? `Auto · ${labelFromHeight(q.height)}` : 'Auto')
    : q.label;
  const menu = $('settingsMenu');
  if (menu?.classList.contains('open')) renderQualityMenu();
}

export function showQualityBadge(label, opts = {}) {
  const badge = qBadge(); if (!badge) return;
  if (!label) {
    badge.style.display = 'none'; badge.textContent = '';
    badge.removeAttribute('data-q'); return;
  }
  badge.style.display = 'inline-flex';
  badge.setAttribute('data-q', opts.key || 'custom');
  badge.title = opts.title || '';
  badge.textContent = label;
}

export function showLoadStatus(stateName, opts = {}) {
  const badge = qBadge(); if (!badge) return;
  if (opts.token != null && opts.token !== state._playToken) return;
  badge.style.display = 'inline-flex';
  if (stateName === 'loading') {
    badge.setAttribute('data-q', 'loading');
    badge.title = opts.title || 'Loading…';
    badge.innerHTML = `<span class="material-symbols-outlined">progress_activity</span>`;
  } else if (stateName === 'error') {
    badge.setAttribute('data-q', 'error');
    badge.title = opts.title || 'Error';
    badge.innerHTML = `<span class="material-symbols-outlined">warning</span>`;
  }
}

export function hideLoadStatus(token) {
  const badge = qBadge(); if (!badge) return;
  if (token != null && token !== state._playToken) return;
  if (badge.getAttribute('data-q') === 'loading') {
    badge.style.display = 'none';
    badge.removeAttribute('data-q');
    badge.innerHTML = ''; badge.title = '';
  }
}

export function detectQualityFromName(name) {
  const n = (name || '').toUpperCase();
  let h = 0;
  if (n.includes('4K') || n.includes('UHD') || n.includes('2160')) h = 2160;
  else if (n.includes('1080') || n.includes('FHD') || n.includes('HDR')) h = 1080;
  else if (n.includes('720') || n.includes('HD')) h = 720;
  else if (n.includes('SD') || n.includes('480')) h = 480;
  const key = keyFromHeight(h);
  if (key) showQualityBadge(labelFromHeight(h), { key });
  else showQualityBadge('');
}

export function showIframeBadge() {
  const badge = qBadge(); if (!badge) return;
  badge.style.display = 'inline-flex';
  badge.setAttribute('data-q', 'web');
  badge.textContent = 'WEB';
}

export function getCurrentQualityLabel() {
  const qv = $('qualityValue'); if (!qv) return;
  qv.textContent = _activeQuality.isAuto
    ? (_activeQuality.height ? `Auto · ${labelFromHeight(_activeQuality.height)}` : 'Auto')
    : _activeQuality.label;
}

export function getAvailableQualities() {
  if (state.hlsInst && Array.isArray(state.hlsInst.levels) && state.hlsInst.levels.length) {
    const levels = state.hlsInst.levels;
    const items = levels.map((level, index) => {
      const h = Number(level.height) || 0;
      const bw = Number(level.bitrate) || 0;
      const hasDupes = levels.some((l, i) => i !== index && (Number(l.height) || 0) === h);
      const bwLabel = bw ? ` · ${Math.round(bw / 1000)}k` : '';
      const label = h ? `${h}p${hasDupes ? bwLabel : ''}` : (bw ? `${Math.round(bw / 1000)}k` : `Level ${index}`);
      return { type: 'hls', label, height: h, index };
    });
    items.sort((a, b) => b.height - a.height || (levels[b.index]?.bitrate || 0) - (levels[a.index]?.bitrate || 0));
    return [{ type: 'hls-auto', label: 'Auto' }, ...items];
  }
  if (state.dashInst) {
    try {
      const list = state.dashInst.getBitrateInfoListFor('video') || [];
      if (list.length) {
        const items = list.map((item, index) => {
          const h = Number(item.height) || 0;
          const bw = Number(item.bitrate) || 0;
          const hasDupes = list.some((l, i) => i !== index && (Number(l.height) || 0) === h);
          const bwLabel = bw ? ` · ${Math.round(bw / 1000)}k` : '';
          const label = h ? `${h}p${hasDupes ? bwLabel : ''}` : (bw ? `${Math.round(bw / 1000)}k` : `Level ${index}`);
          return { type: 'dash', label, height: h, index };
        });
        items.sort((a, b) => b.height - a.height);
        return [{ type: 'dash-auto', label: 'Auto' }, ...items];
      }
    } catch {}
  }
  return [];
}

export function applyQualitySelection(item) {
  if (!item) return;
  if (item.type === 'hls-auto' && state.hlsInst) {
    state.hlsInst.currentLevel = -1;
    _setActiveQuality({ isAuto: true, index: -1, label: 'Auto', height: 0 });
    return;
  }
  if (item.type === 'hls' && state.hlsInst) {
    state.hlsInst.currentLevel = item.index;
    _setActiveQuality({ isAuto: false, index: item.index, label: item.label, height: item.height });
    return;
  }
  if (item.type === 'dash-auto' && state.dashInst) {
    try { state.dashInst.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } }); } catch {}
    _setActiveQuality({ isAuto: true, index: -1, label: 'Auto', height: 0 });
    return;
  }
  if (item.type === 'dash' && state.dashInst) {
    try {
      state.dashInst.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      state.dashInst.setQualityFor('video', item.index);
    } catch {}
    _setActiveQuality({ isAuto: false, index: item.index, label: item.label, height: item.height });
  }
}

export function renderQualityMenu() {
  const qualityList = $('qualityList'); if (!qualityList) return;
  const list = getAvailableQualities();
  qualityList.innerHTML = '';
  if (!list.length) {
    qualityList.innerHTML = `<div class="settings-item" style="opacity:.6;pointer-events:none;">Not available</div>`;
    getCurrentQualityLabel(); return;
  }
  list.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'settings-item';
    btn.textContent = item.label;
    const isActive = item.type.endsWith('-auto')
      ? _activeQuality.isAuto
      : !_activeQuality.isAuto && item.index === _activeQuality.index;
    btn.classList.toggle('is-active', isActive);
    btn.onclick = (e) => { e.stopPropagation(); applyQualitySelection(item); };
    qualityList.appendChild(btn);
  });
  getCurrentQualityLabel();
}

export function attachHlsQualityListeners(name) {
  if (!state.hlsInst) return;
  state.hlsInst.on(Hls.Events.MANIFEST_PARSED, () => {
    if (!state.hlsInst.levels?.length) { detectQualityFromName(name); return; }
    const best = state.hlsInst.levels.reduce((a, b) => ((b.height||0) > (a.height||0) ? b : a), state.hlsInst.levels[0]);
    const h = best.height || 0;
    if (h > 0) _setActiveQuality({ isAuto: true, index: -1, label: labelFromHeight(h), height: h });
    renderQualityMenu();
  });
  state.hlsInst.on(Hls.Events.LEVEL_SWITCHING, (_, data) => {
    if (!_activeQuality.isAuto) return;
    const lvl = state.hlsInst.levels?.[data.level]; if (!lvl) return;
    const h = lvl.height || 0; const hLabel = h ? labelFromHeight(h) : '';
    const badge = qBadge();
    if (badge && hLabel) {
      badge.style.display = 'inline-flex';
      badge.setAttribute('data-q', 'auto');
      badge.innerHTML = `${hLabel} <span style="opacity:0.6;font-size:0.78em;margin-left:3px;">auto</span>`;
    }
    const qv = $('qualityValue'); if (qv && hLabel) qv.textContent = `Auto · ${hLabel}`;
  });
  state.hlsInst.on(Hls.Events.ERROR, () => detectQualityFromName(name));
}

export function attachDashQualityListeners(name) {
  if (!state.dashInst) return;
  const ev = dashjs.MediaPlayer.events;
  const update = () => {
    try {
      const isAuto = !!state.dashInst.getSettings?.()?.streaming?.abr?.autoSwitchBitrate?.video;
      const q = state.dashInst.getQualityFor('video');
      const list = state.dashInst.getBitrateInfoListFor('video') || [];
      const info = list[q]; if (!info) { detectQualityFromName(name); return; }
      const h = info.height || 0; const hLabel = labelFromHeight(h);
      const badge = qBadge();
      if ((isAuto || _activeQuality.isAuto) && hLabel && badge) {
        badge.style.display = 'inline-flex';
        badge.setAttribute('data-q', 'auto');
        badge.innerHTML = `${hLabel} <span style="opacity:0.6;font-size:0.78em;margin-left:3px;">auto</span>`;
        const qv = $('qualityValue'); if (qv) qv.textContent = `Auto · ${hLabel}`;
      }
    } catch { detectQualityFromName(name); }
    renderQualityMenu();
  };
  state.dashInst.on(ev.STREAM_INITIALIZED, update);
  state.dashInst.on(ev.QUALITY_CHANGE_RENDERED, update);
  state.dashInst.on(ev.PLAYBACK_STARTED, update);
  state.dashInst.on(ev.ERROR, () => detectQualityFromName(name));
}
