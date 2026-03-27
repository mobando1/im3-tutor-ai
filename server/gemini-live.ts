import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { tutors, tutorDocuments } from "../shared/schema.js";
import { log } from "./index.js";

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const MODEL = "models/gemini-2.0-flash-live-001";

export interface TutorContext {
  tutorId: string;
  projectName: string;
  language: string;
  systemInstruction: string;
}

/**
 * Build system instruction for a tutor by loading config + all document chunks.
 */
export async function buildTutorContext(tutorId: string): Promise<TutorContext | null> {
  const tutor = await db.query.tutors.findFirst({
    where: eq(tutors.id, tutorId),
  });

  if (!tutor || !tutor.isActive) return null;

  const docs = await db.query.tutorDocuments.findMany({
    where: eq(tutorDocuments.tutorId, tutorId),
  });

  let documentContext = "";
  for (const doc of docs) {
    const chunks = doc.chunks as Array<{ index: number; text: string }>;
    const docText = chunks.map((c) => c.text).join("\n\n");
    documentContext += `\n\n--- Documento: ${doc.name} ---\n${docText}`;
  }

  const lang = tutor.language === "en" ? "English" : "español";

  const systemInstruction = [
    `Eres un tutor virtual en vivo del proyecto "${tutor.projectName}".`,
    `Tu nombre es "Tutor de ${tutor.projectName}".`,
    tutor.systemPrompt || "",
    "",
    "REGLAS ESTRICTAS:",
    `- Siempre responde en ${lang}.`,
    "- Eres amigable, paciente y profesional — como un profesor particular.",
    "- El usuario te está compartiendo su pantalla y hablándote por voz.",
    "- Puedes VER lo que hay en su pantalla. Úsalo para dar indicaciones precisas.",
    '- Cuando veas la pantalla, describe lo que ves y guía al usuario: "Veo que estás en la pantalla de..., ahora haz clic en..."',
    "- Responde de forma concisa y clara. No des explicaciones largas — ve al punto.",
    "- Responde ÚNICAMENTE con información de los documentos proporcionados.",
    '- Si no sabes algo, di: "No tengo información sobre eso. Te sugiero contactar al equipo de soporte."',
    "- NUNCA inventes información que no esté en los documentos.",
    "",
    documentContext.length > 0
      ? `DOCUMENTACIÓN DEL PROYECTO:\n${documentContext}`
      : "No hay documentos cargados para este proyecto todavía.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    tutorId,
    projectName: tutor.projectName,
    language: tutor.language,
    systemInstruction,
  };
}

/**
 * Gemini Live session — wraps a WebSocket connection to Gemini's BidiGenerateContent endpoint.
 */
export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private context: TutorContext;
  private onAudio: (base64: string) => void;
  private onText: (text: string) => void;
  private onTurnComplete: () => void;
  private onError: (msg: string) => void;

  constructor(
    context: TutorContext,
    handlers: {
      onAudio: (base64: string) => void;
      onText: (text: string) => void;
      onTurnComplete: () => void;
      onError: (msg: string) => void;
    }
  ) {
    this.context = context;
    this.onAudio = handlers.onAudio;
    this.onText = handlers.onText;
    this.onTurnComplete = handlers.onTurnComplete;
    this.onError = handlers.onError;
  }

  async connect(): Promise<void> {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      this.onError("GOOGLE_AI_API_KEY not configured");
      return;
    }

    const url = `${GEMINI_WS_URL}?key=${apiKey}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        // Send setup message with system instruction and config
        const setupMessage = {
          setup: {
            model: MODEL,
            generationConfig: {
              responseModalities: ["AUDIO", "TEXT"],
              temperature: 0.3,
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.context.language === "en" ? "Kore" : "Aoede",
                  },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: this.context.systemInstruction }],
            },
          },
        };

        this.ws!.send(JSON.stringify(setupMessage));
        log(`Gemini Live session connected for tutor ${this.context.tutorId}`);
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleGeminiMessage(msg);
        } catch (err) {
          log(`Gemini parse error: ${err}`);
        }
      });

      this.ws.on("error", (err) => {
        log(`Gemini WS error: ${err.message}`);
        this.onError(`Gemini connection error: ${err.message}`);
        reject(err);
      });

      this.ws.on("close", () => {
        log("Gemini Live session closed");
      });
    });
  }

  private handleGeminiMessage(msg: Record<string, unknown>): void {
    // Setup complete acknowledgment
    if (msg.setupComplete !== undefined) {
      log("Gemini setup complete");
      return;
    }

    // Server content (model responses)
    const serverContent = msg.serverContent as {
      modelTurn?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
      turnComplete?: boolean;
    } | undefined;

    if (serverContent) {
      const parts = serverContent.modelTurn?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData?.data) {
            this.onAudio(part.inlineData.data);
          }
          if (part.text) {
            this.onText(part.text);
          }
        }
      }

      if (serverContent.turnComplete) {
        this.onTurnComplete();
      }
    }
  }

  /** Send real-time audio chunk (PCM16 base64) */
  sendAudio(base64Data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: "audio/pcm;rate=16000",
              data: base64Data,
            },
          ],
        },
      })
    );
  }

  /** Send screen frame (JPEG base64) */
  sendScreenFrame(base64Data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: "image/jpeg",
              data: base64Data,
            },
          ],
        },
      })
    );
  }

  /** Send text message */
  sendText(message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [{ text: message }],
            },
          ],
          turnComplete: true,
        },
      })
    );
  }

  /** Close the session */
  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
