// Probe: does a Live API model read provided text verbatim, or paraphrase it?
// Run: bun run probe-tts.ts
// Outputs: /tmp/probe-<modelTag>.wav for each candidate.
// Listen and compare to the SAMPLE text below.

import { GoogleGenAI, Modality } from "@google/genai";

const SAMPLE = `The corridor narrows ahead. Brass fittings line the walls, tarnished green at the joints. A faint hum pulses from somewhere below the floor — slow, regular, almost a heartbeat. To the north, a door stands ajar. To the east, a stairwell descends into shadow.`;

const SYSTEM_INSTRUCTION =
  "You are a text-to-speech engine, not a chat partner. Your sole job is to read the user's input aloud, exactly as written, word for word. Do NOT respond to the content. Do NOT paraphrase. Do NOT add words. Do NOT remove words. Do NOT comment. Speak only the words the user provides, in the order they appear.";

const VOICE = "Kore";

const CANDIDATES = [
  { tag: "3-1-flash-live", model: "gemini-3.1-flash-live-preview" },
  { tag: "native-12-2025", model: "gemini-2.5-flash-native-audio-preview-12-2025" },
  { tag: "native-09-2025", model: "gemini-2.5-flash-native-audio-preview-09-2025" },
  { tag: "native-latest", model: "gemini-2.5-flash-native-audio-latest" },
];

function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  header.writeUInt16LE(channels * (bitDepth / 8), 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

async function probe(model: string, tag: string): Promise<{ ok: boolean; bytes: number; ms: number; firstChunkMs: number; error?: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });
  const chunks: Uint8Array[] = [];
  const t0 = performance.now();
  let firstChunkMs = -1;

  return new Promise((resolve) => {
    let closed = false;
    let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (closed) return;
      closed = true;
      session?.close();
      resolve(result);
    };

    ai.live.connect({
      model,
      config: {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        },
      },
      callbacks: {
        onmessage(msg) {
          const parts = msg.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            const b64 = part.inlineData?.data;
            if (b64) {
              if (firstChunkMs < 0) firstChunkMs = performance.now() - t0;
              chunks.push(new Uint8Array(Buffer.from(b64, "base64")));
            }
          }
          if (msg.serverContent?.turnComplete) {
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            const wav = pcmToWav(merged);
            Bun.write(`/tmp/probe-${tag}.wav`, wav);
            finish({ ok: true, bytes: total, ms: performance.now() - t0, firstChunkMs });
          }
        },
        onerror(e) {
          finish({ ok: false, bytes: 0, ms: performance.now() - t0, firstChunkMs, error: String(e) });
        },
        onclose(e) {
          if (!closed) {
            const total = chunks.reduce((n, c) => n + c.length, 0);
            if (total > 0) {
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { merged.set(c, off); off += c.length; }
              Bun.write(`/tmp/probe-${tag}.wav`, pcmToWav(merged));
            }
            finish({ ok: total > 0, bytes: total, ms: performance.now() - t0, firstChunkMs, error: e ? `closed: ${JSON.stringify(e)}` : "closed early" });
          }
        },
      },
    }).then((s) => {
      session = s;
      s.sendClientContent({
        turns: [{ role: "user", parts: [{ text: SAMPLE }] }],
        turnComplete: true,
      });
    }).catch((err) => {
      finish({ ok: false, bytes: 0, ms: performance.now() - t0, firstChunkMs, error: String(err) });
    });

    setTimeout(() => finish({ ok: chunks.length > 0, bytes: chunks.reduce((n, c) => n + c.length, 0), ms: performance.now() - t0, firstChunkMs, error: "timeout 30s" }), 30000);
  });
}

async function main() {
  console.log(`SAMPLE:\n${SAMPLE}\n`);
  console.log(`SYSTEM:\n${SYSTEM_INSTRUCTION}\n`);
  console.log("---");

  for (const { tag, model } of CANDIDATES) {
    process.stdout.write(`[${tag}] ${model} ... `);
    try {
      const r = await probe(model, tag);
      if (r.ok) {
        console.log(`ok | ${r.bytes} bytes | first chunk ${Math.round(r.firstChunkMs)}ms | total ${Math.round(r.ms)}ms | /tmp/probe-${tag}.wav`);
      } else {
        console.log(`FAIL: ${r.error}`);
      }
    } catch (err) {
      console.log(`THREW: ${err}`);
    }
  }

  console.log("\nListen to each /tmp/probe-*.wav. Look for:");
  console.log("  - VERBATIM: matches SAMPLE text exactly, no extra words");
  console.log("  - PARAPHRASE: same meaning but different words");
  console.log("  - CONVERSATIONAL: model responded to text instead of reading it");
}

main();
