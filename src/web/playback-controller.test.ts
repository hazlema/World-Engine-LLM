import { test, expect, describe, beforeEach } from "bun:test";
import { PlaybackController } from "./playback-controller";

// Minimal fake of HTMLAudioElement — enough surface for the controller.
function makeFakeAudio() {
  const listeners: Record<string, Array<() => void>> = {};
  const el: any = {
    src: "",
    currentTime: 0,
    volume: 1,
    paused: true,
    pause() { el.paused = true; },
    async play() { el.paused = false; },
    addEventListener(name: string, fn: () => void) {
      (listeners[name] ??= []).push(fn);
    },
    fire(name: string) { (listeners[name] ?? []).forEach((fn) => fn()); },
  };
  return el as HTMLAudioElement & { fire: (name: string) => void };
}

describe("PlaybackController", () => {
  let pc: PlaybackController;
  let el: ReturnType<typeof makeFakeAudio>;

  beforeEach(() => {
    pc = new PlaybackController();
    el = makeFakeAudio();
    pc.attachElement(el);
  });

  test("starts idle", () => {
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
    expect(pc.isAudible()).toBe(false);
  });

  test("play(turn, url) sets src and starts playback", async () => {
    await pc.play(1, "/media/audio/abc.wav");
    expect(el.src).toBe("/media/audio/abc.wav");
    expect(el.paused).toBe(false);
    expect(pc.state).toBe("playing");
    expect(pc.currentTurnId).toBe(1);
    expect(pc.isAudible()).toBe(true);
  });

  test("play() while already playing: pauses prior then plays new", async () => {
    await pc.play(1, "/a.wav");
    await pc.play(2, "/b.wav");
    expect(el.src).toBe("/b.wav");
    expect(el.currentTime).toBe(0);
    expect(pc.currentTurnId).toBe(2);
  });

  test("abortCurrent() pauses + returns to idle", async () => {
    await pc.play(1, "/a.wav");
    pc.abortCurrent();
    expect(el.paused).toBe(true);
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
  });

  test("setVoice() aborts current", async () => {
    await pc.play(1, "/a.wav");
    pc.setVoice("warm");
    expect(el.paused).toBe(true);
    expect(pc.state).toBe("idle");
  });

  test("setEnabled(false) aborts and blocks future play", async () => {
    await pc.play(1, "/a.wav");
    pc.setEnabled(false);
    expect(el.paused).toBe(true);
    expect(pc.state).toBe("idle");
    await pc.play(2, "/b.wav");
    // setEnabled(false) means play is a no-op until re-enabled
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
  });

  test("setEnabled(true) restores play", async () => {
    pc.setEnabled(false);
    pc.setEnabled(true);
    await pc.play(1, "/a.wav");
    expect(pc.state).toBe("playing");
  });

  test("ended event from element returns to idle", async () => {
    await pc.play(1, "/a.wav");
    el.fire("ended");
    expect(pc.state).toBe("idle");
    expect(pc.currentTurnId).toBeNull();
  });

  test("setVolume sets the element volume immediately", () => {
    pc.setVolume(0.5);
    expect(el.volume).toBe(0.5);
  });
});
