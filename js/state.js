/**
 * XVB3 — state.js
 * Unica fonte di verità dell'app.
 */

export const state = {

  // ── Canali ─────────────────────────────────────
  allChannels:    [],     // tutti i canali caricati
  activeChannel:  null,   // canale selezionato nell'hero
  activeCategory: null,   // categoria attiva

  // ── Player ─────────────────────────────────────
  _playToken:  0,         // incrementale per evitare race condition
  isPlaying:   false,
  isLoading:   false,
  playerOpen:  false,     // true = overlay player visibile

  // Istanze engine
  hlsInst:     null,
  dashInst:    null,
  mpegtsInst:  null,

  // ── EPG ────────────────────────────────────────
  epgData:     new Map(), // Map<string, Programme[]>
  epgTimer:    null,

};