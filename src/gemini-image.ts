import { GoogleGenAI, Modality } from "@google/genai";

const IMAGE_MODEL = "gemini-2.5-flash-image";

export async function generateImage(narrative: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey: key });
  const prompt = [
    "Render this scene as a cinematic 21:9 ultrawide image.",
    "Atmospheric, moody, painterly. No text, captions, or watermarks.",
    "",
    "Scene:",
    narrative,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.IMAGE],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) return Buffer.from(data, "base64");
  }

  // Surface the textual response (often a refusal or safety block) so caller can log it.
  const textParts = parts.map((p) => p.text).filter(Boolean).join(" ");
  throw new Error(`no image in response${textParts ? `: ${textParts.slice(0, 200)}` : ""}`);
}
