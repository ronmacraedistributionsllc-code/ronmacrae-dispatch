/**
 * A short, synthesized alert tone for new offers/assignments/SOS — no audio
 * asset to ship, works offline, and is loud/short enough to notice without
 * being obnoxious. Browsers block audio until the page has had some user
 * interaction (a tap/click/keypress); we don't try to detect that ourselves —
 * we just attempt to play and quietly swallow the rejection when blocked, per
 * "where the browser permits". The AudioContext is created lazily (and only
 * once) so this file has no effect just by being imported.
 */
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** `urgent` uses a higher, double-beep pattern; the default is a single softer tone. */
export function playAlertSound(urgent = false): void {
  try {
    const audioCtx = getContext();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    const beep = (startAt: number, freq: number, durationS: number) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(urgent ? 0.35 : 0.2, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(startAt);
      osc.stop(startAt + durationS);
    };
    const now = audioCtx.currentTime;
    beep(now, urgent ? 880 : 660, 0.18);
    if (urgent) beep(now + 0.22, 880, 0.18);
  } catch {
    // Autoplay restrictions, no Web Audio support, etc. — the toast/badge still
    // carry the alert; sound is a nice-to-have layered on top, never required.
  }
}
