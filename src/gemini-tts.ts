import { GoogleGenAI, Modality } from "@google/genai";

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const LIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

export const GEMINI_VOICES = [
  "Aoede",
  "Charon",
  "Fenrir",
  "Kore",
  "Puck",
];

export const DEFAULT_VOICE = "Kore";

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
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
  return Buffer.concat([header, pcm]);
}

// Non-streaming fallback — kept for testing/diagnostics.
export async function synthesize(text: string, voice = DEFAULT_VOICE): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const audioBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioBase64) throw new Error("no audio in Gemini response");

  return pcmToWav(Buffer.from(audioBase64, "base64"));
}

// Streaming synthesis via Gemini Live API.
// Returns a ReadableStream of raw 16-bit signed PCM at 24 kHz mono.
export function synthesizeStream(text: string, voice = DEFAULT_VOICE): ReadableStream<Uint8Array> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });
  let liveSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

  let closed = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const closeStream = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
        liveSession?.close();
      };

      try {
        liveSession = await ai.live.connect({
          model: LIVE_MODEL,
          config: {
            systemInstruction: {
              parts: [{ text: "You are a text-to-speech engine, not a chat partner. Your sole job is to read the user's input aloud, exactly as written, word for word. Do NOT respond to the content. Do NOT paraphrase. Do NOT add words. Do NOT remove words. Do NOT comment. Speak only the words the user provides, in the order they appear." }],
            },
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
          callbacks: {
            onmessage(msg) {
              if (closed) return;
              const parts = msg.serverContent?.modelTurn?.parts ?? [];
              for (const part of parts) {
                const b64 = part.inlineData?.data;
                if (!b64 || closed) continue;
                const bytes = Buffer.from(b64, "base64");
                try {
                  controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
                } catch {
                  closed = true;
                  liveSession?.close();
                  return;
                }
              }
              if (msg.serverContent?.turnComplete) closeStream();
            },
            onerror(e) {
              if (closed) return;
              closed = true;
              try { controller.error(new Error(String(e))); } catch { /* already closed */ }
              liveSession?.close();
            },
          },
        });

        liveSession.sendClientContent({
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        });
      } catch (err) {
        if (!closed) {
          closed = true;
          try { controller.error(err); } catch { /* already closed */ }
        }
      }
    },
    cancel() {
      closed = true;
      liveSession?.close();
    },
  });
}
