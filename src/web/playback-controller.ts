/**
 * Coordinates the single audio element across turns.
 *
 * State machine:
 *   idle    — nothing playing, nothing paused
 *   playing — el.play() in flight, currentTurnId set
 *   paused  — el is paused mid-clip, currentTurnId preserved so resume works
 *
 * Transitions fire onStateChange so consumers can render play/pause UI.
 */

export type ControllerState = "idle" | "playing" | "paused";

export class PlaybackController {
  private _state: ControllerState = "idle";
  private _currentTurnId: number | null = null;
  private _element: HTMLAudioElement | null = null;
  private _enabled = true;
  private _volume = 1.0;

  /** Called on every state transition. Consumers use this to derive UI state. */
  onStateChange?: (state: ControllerState, currentTurnId: number | null) => void;

  get state(): ControllerState { return this._state; }
  get currentTurnId(): number | null { return this._currentTurnId; }

  attachElement(el: HTMLAudioElement | null): void {
    this._element = el;
    if (el) {
      el.volume = this._volume;
      el.addEventListener("ended", () => this.onEnded());
      el.addEventListener("error", () => this.onEnded());
    }
  }

  private setState(state: ControllerState, turnId: number | null): void {
    this._state = state;
    this._currentTurnId = turnId;
    this.onStateChange?.(state, turnId);
  }

  private onEnded(): void {
    this.setState("idle", null);
  }

  /**
   * Play a URL for a turn. If we're already paused on the same turn with the
   * same URL, resume from the pause point. Otherwise fully reset and start
   * from time 0.
   */
  async play(turnId: number, url: string): Promise<void> {
    if (!this._enabled) return;
    const el = this._element;
    if (!el) return;

    const isResumeSameClip =
      this._state === "paused" &&
      this._currentTurnId === turnId &&
      el.src.endsWith(url);

    if (isResumeSameClip) {
      this.setState("playing", turnId);
      try {
        await el.play();
      } catch (err) {
        this.setState("idle", null);
        if ((err as Error)?.name !== "NotAllowedError") {
          console.warn("[narration] resume failed", err);
        }
      }
      return;
    }

    try { el.pause(); } catch { /* ignore */ }
    el.src = url;
    el.currentTime = 0;
    this.setState("playing", turnId);
    try {
      await el.play();
    } catch (err) {
      this.setState("idle", null);
      if ((err as Error)?.name !== "NotAllowedError") {
        console.warn("[narration] play failed", err);
      }
    }
  }

  pause(): void {
    if (this._state !== "playing") return;
    const el = this._element;
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
    }
    this.setState("paused", this._currentTurnId);
  }

  resume(): void {
    if (this._state !== "paused") return;
    const el = this._element;
    if (!el) return;
    const turnId = this._currentTurnId;
    // Set state optimistically before the async play() so callers
    // see "playing" synchronously (mirrors how play() behaves).
    this.setState("playing", turnId);
    el.play().catch((err) => {
      this.setState("idle", null);
      if ((err as Error)?.name !== "NotAllowedError") {
        console.warn("[narration] resume failed", err);
      }
    });
  }

  abortCurrent(): void {
    const el = this._element;
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
    }
    this.setState("idle", null);
  }

  setVoice(_voice: string): void {
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

  isPaused(): boolean { return this._state === "paused"; }
}
