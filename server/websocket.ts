import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { buildTutorContext, GeminiLiveSession } from "./gemini-live.js";
import { log } from "./index.js";

interface ActiveSession {
  ws: WebSocket;
  gemini: GeminiLiveSession;
  tutorId: string;
}

const activeSessions = new Map<WebSocket, ActiveSession>();

/**
 * Initialize WebSocket server attached to the HTTP server.
 *
 * Protocol (JSON messages):
 *   Client → Server:
 *     { type: "init", tutorId: string }       // start live session
 *     { type: "audio", data: string }          // base64 PCM16 16kHz audio
 *     { type: "screen", data: string }         // base64 JPEG frame
 *     { type: "text", message: string }        // text input
 *     { type: "end" }                          // end session
 *
 *   Server → Client:
 *     { type: "ready", projectName: string }   // session initialized
 *     { type: "audio", data: string }          // base64 PCM16 24kHz audio response
 *     { type: "text", message: string }        // text transcript
 *     { type: "turn_complete" }                // Gemini done responding
 *     { type: "error", message: string }
 */
export function initWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/tutor" });

  wss.on("connection", (ws: WebSocket) => {
    log("WebSocket client connected");

    ws.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          tutorId?: string;
          data?: string;
          message?: string;
        };

        switch (msg.type) {
          case "init":
            await handleInit(ws, msg.tutorId ?? "");
            break;
          case "audio":
            handleAudio(ws, msg.data ?? "");
            break;
          case "screen":
            handleScreen(ws, msg.data ?? "");
            break;
          case "text":
            handleText(ws, msg.message ?? "");
            break;
          case "end":
            handleEnd(ws);
            break;
          default:
            send(ws, { type: "error", message: "Unknown message type" });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        log(`WebSocket error: ${errMsg}`);
        send(ws, { type: "error", message: errMsg });
      }
    });

    ws.on("close", () => {
      handleEnd(ws);
      log("WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
      handleEnd(ws);
    });
  });

  log("WebSocket server initialized on /ws/tutor");
}

// ============================================================
// Handlers
// ============================================================

async function handleInit(ws: WebSocket, tutorId: string): Promise<void> {
  // Clean up existing session
  const existing = activeSessions.get(ws);
  if (existing) {
    existing.gemini.close();
    activeSessions.delete(ws);
  }

  // Build tutor context with documents
  const context = await buildTutorContext(tutorId);
  if (!context) {
    send(ws, { type: "error", message: "Tutor not found or inactive" });
    return;
  }

  // Create Gemini Live session with handlers that forward to the client
  const gemini = new GeminiLiveSession(context, {
    onAudio: (data) => send(ws, { type: "audio", data }),
    onText: (message) => send(ws, { type: "text", message }),
    onTurnComplete: () => send(ws, { type: "turn_complete" }),
    onError: (message) => send(ws, { type: "error", message }),
  });

  try {
    await gemini.connect();
    activeSessions.set(ws, { ws, gemini, tutorId });
    send(ws, { type: "ready", projectName: context.projectName });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Connection failed";
    send(ws, { type: "error", message: errMsg });
  }
}

function handleAudio(ws: WebSocket, base64Data: string): void {
  const session = activeSessions.get(ws);
  if (!session) {
    send(ws, { type: "error", message: "Session not initialized" });
    return;
  }
  session.gemini.sendAudio(base64Data);
}

function handleScreen(ws: WebSocket, base64Data: string): void {
  const session = activeSessions.get(ws);
  if (!session) {
    send(ws, { type: "error", message: "Session not initialized" });
    return;
  }
  session.gemini.sendScreenFrame(base64Data);
}

function handleText(ws: WebSocket, message: string): void {
  const session = activeSessions.get(ws);
  if (!session) {
    send(ws, { type: "error", message: "Session not initialized" });
    return;
  }
  session.gemini.sendText(message);
}

function handleEnd(ws: WebSocket): void {
  const session = activeSessions.get(ws);
  if (session) {
    session.gemini.close();
    activeSessions.delete(ws);
    log(`Live session ended for tutor ${session.tutorId}`);
  }
}

// ============================================================
// Helpers
// ============================================================

function send(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
