/**
 * Coordinates the single audio element across turns.
 *
 * The frontend only ever has one HTMLAudioElement being commanded at a time;
 * this class owns its lifecycle:
 *   - play(turnId, url): pause whatever was playing, point the element at
 *     the new URL, start playback.
 *   - abortCurrent(): pause.
 *   - setVoice(voice): voice change wipes the current playback (the audio
 *     was for the old voice; future turns will get fresh URLs).
 *   - setEnabled(on): when off, pause immediately.
 *   - isAudible(): true if the element is currently playing.
 *
 * No Web Audio API. No AudioContext. No buffer sources. Volume is set
 * directly on the audio element.
 */

export type ControllerState = "idle" | "playing";

export class PlaybackController {
  private _state: ControllerState = "idle";
  private _currentTurnId: number | null = null;
  private _element: HTMLAudioElement | null = null;
  private _enabled = true;
  private _volume = 1.0;

  get state(): ControllerState { return this._state; }
  get currentTurnId(): number | null { return this._currentTurnId; }

  /**
   * Attach the (single) audio element this controller commands.
   * Called once after React renders <audio ref={...} />.
   */
  attachElement(el: HTMLAudioElement | null): void {
    this._element = el;
    if (el) {
      el.volume = this._volume;
      el.addEventListener("ended", () => this.onEnded());
      el.addEventListener("error", () => this.onEnded());
    }
  }

  private onEnded(): void {
    this._state = "idle";
    this._currentTurnId = null;
  }

  /** Play a URL for a turn. Pauses any prior playback first. */
  async play(turnId: number, url: string): Promise<void> {
    if (!this._enabled) return;
    const el = this._element;
    if (!el) return;
    try {
      el.pause();
    } catch { /* ignore */ }
    el.src = url;
    el.currentTime = 0;
    this._state = "playing";
    this._currentTurnId = turnId;
    try {
      await el.play();
    } catch (err) {
      // Autoplay restrictions or src errors — fall back to idle.
      this._state = "idle";
      this._currentTurnId = null;
      if ((err as Error)?.name !== "NotAllowedError") {
        console.warn("[narration] play failed", err);
      }
    }
  }

  abortCurrent(): void {
    const el = this._element;
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
    }
    this._state = "idle";
    this._currentTurnId = null;
  }

  setVoice(_voice: string): void {
    // Voice change → cached audio is for the wrong voice; stop now,
    // future turns will get fresh URLs from the server.
    this.abortCurrent();
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    if (!on) this.abortCurrent();
  }

  setVolume(v: number): void {
    this._volume = v;
    if (this._element) this._element.volume = v;
  }

  isAudible(): boolean {
    if (!this._element) return false;
    return !this._element.paused;
  }
}
