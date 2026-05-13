import type { TTSEngine, RenderResult } from "./tts";

export type ControllerState = "idle" | "streaming" | "rendering";

// Minimal interface the controller needs from TTSEngine. Listed explicitly
// so the controller is unit-testable against a shim.
type TTSCore = Pick<
  TTSEngine,
  "stopAll" | "cancelStream" | "startStream" | "addChunk" | "endStream" | "render" | "cache"
>;

export class PlaybackController {
  private _state: ControllerState = "idle";
  private _currentTurnId: number | null = null;
  private _abort: AbortController | null = null;

  constructor(private tts: TTSCore) {}

  get state(): ControllerState { return this._state; }
  get currentTurnId(): number | null { return this._currentTurnId; }

  // WebSocket streaming path: server pushes audio-start, audio-chunk*, audio-end.
  beginStream(turnId: number): void {
    if (this._state !== "idle") this.abortCurrent();
    this.tts.startStream(turnId);
    this._state = "streaming";
    this._currentTurnId = turnId;
  }

  addChunk(bytes: Uint8Array): void {
    if (this._state !== "streaming" || this._currentTurnId === null) return;
    this.tts.addChunk(bytes);
  }

  endStream(): { turnId: number; url: string } | null {
    if (this._state !== "streaming") return null;
    const result = this.tts.endStream();
    this._state = "idle";
    this._currentTurnId = null;
    return result;
  }

  // HTTP path: manual replay before audio is cached, or system briefings.
  async renderManual(turnId: number, text: string, voice?: string): Promise<RenderResult> {
    if (this._state !== "idle") this.abortCurrent();
    const ac = new AbortController();
    this._abort = ac;
    this._state = "rendering";
    this._currentTurnId = turnId;
    try {
      const result = await this.tts.render(turnId, text, voice, ac.signal);
      if (this._abort === ac) {
        this._state = "idle";
        this._currentTurnId = null;
        this._abort = null;
      }
      return result;
    } catch (err) {
      if (this._abort === ac) {
        this._state = "idle";
        this._currentTurnId = null;
        this._abort = null;
      }
      throw err;
    }
  }

  // Stop everything in flight: HTTP fetch, Web Audio, <audio> elements.
  abortCurrent(): void {
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
    this.tts.cancelStream();
    this.tts.stopAll();
    this._state = "idle";
    this._currentTurnId = null;
  }

  // Config-change entry points.
  setVoice(_voice: string): void {
    this.abortCurrent();
    this.tts.cache.clear();
  }

  setEnabled(on: boolean): void {
    if (!on) this.abortCurrent();
  }
}
