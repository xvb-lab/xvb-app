/**
 * XVB3 — config.js
 * Per ora URL hardcoded, in futuro gestiti da Settings.
 */

export const CONFIG = {

  // ── M3U playlist URL ───────────────────────────
  M3U_URL: "",

  EPG_URLS: [
    "https://raw.githubusercontent.com/xvb-lab/xvb-epg/refs/heads/main/epg/epg-it.xml",
    "https://raw.githubusercontent.com/xvb-lab/xvb-epg/refs/heads/main/epg/epg-plutotv-it.xml",
    "https://raw.githubusercontent.com/xvb-lab/xvb-epg/refs/heads/main/epg/epg-samsung-it.xml",
  ],

  // ── Server ─────────────────────────────────────
  STATS_URL:  "https://xvb-stats-wk.jonalinux-uk.workers.dev",

  // ── App ────────────────────────────────────────
  APP_NAME:    "XVB3",
  APP_VERSION: "3.0",

  // ── Player ─────────────────────────────────────
  PLAYER: {
    TIMEOUT_MS:         12000,  // timeout prima di mostrare errore
    LIVE_BUFFER_WINDOW: 20,     // secondi finestra buffer live
    PROGRESS_TICK_MS:   250,    // frequenza aggiornamento progress
  },

  // ── Iframe patterns ────────────────────────────
  IFRAME_PATTERNS: [
    "pluto.tv/live-tv/watch/",
    "app-philipsnovatek",
    "livetvuk.com/embed/",
    "livehdtv.com/",
  ],

  // ── EPG refresh ────────────────────────────────
  EPG_REFRESH_MS:    15 * 60 * 1000,  // 15 min
  EPG_UI_REFRESH_MS: 15 * 1000,       // 15 sec aggiorna UI

};