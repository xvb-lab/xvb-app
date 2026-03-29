/**
 * XVB3 — config.js
 * Per ora URL hardcoded, in futuro gestiti da Settings.
 */

export const CONFIG = {

  // ── M3U playlist URL ───────────────────────────
  M3U_URL: "",

  EPG_URLS: [""],

  // ── Server ─────────────────────────────────────
  SERVER_URL: "https://render-com-a2ck.onrender.com",
  STATS_URL:  "https://serverpi5.ddns.net/stats",

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
  ],

  // ── EPG refresh ────────────────────────────────
  EPG_REFRESH_MS:    15 * 60 * 1000,  // 15 min
  EPG_UI_REFRESH_MS: 15 * 1000,       // 15 sec aggiorna UI

};