import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { eq, desc, sql, count } from "drizzle-orm";

import { db, initializeDatabase } from "./db.js";
import { adminAuth } from "./auth.js";
import { uploadDocument, deleteDocument } from "./storage.js";
import { extractTextFromPdf, chunkText } from "./rag.js";
import { handleChat } from "./chat.js";
import { scrapeUrl } from "./scraper.js";
import { fetchGitHubRepo, formatRepoAsDocument } from "./github.js";
import {
  tutors,
  tutorDocuments,
  tutorConversations,
  tutorMessages,
  createTutorSchema,
  updateTutorSchema,
  chatMessageSchema,
  feedbackSchema,
} from "../shared/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5001;

/** Safely extract a route param as string (Express 5 types param as string | string[]) */
function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// ============================================================
// Logger
// ============================================================

export function log(message: string): void {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${message}`);
}

// ============================================================
// Express Setup
// ============================================================

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve compiled widget as static file
import { existsSync } from "fs";

app.get("/widget.js", (_req, res) => {
  const candidates = [
    path.resolve(process.cwd(), "dist", "widget.js"),
    path.resolve(__dirname, "..", "dist", "widget.js"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.sendFile(p);
      return;
    }
  }

  log("Widget not found. Searched: " + candidates.join(", "));
  res.status(404).send("// widget.js not found — run: npm run build:widget");
});

// Multer for file uploads (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

// ============================================================
// PUBLIC ROUTES (widget → server)
// ============================================================

// GET /api/tutor/:id/config — widget fetches tutor config
app.get("/api/tutor/:id/config", async (req, res) => {
  try {
    const tutor = await db.query.tutors.findFirst({
      where: eq(tutors.id, param(req.params.id)),
    });

    if (!tutor || !tutor.isActive) {
      res.status(404).json({ error: "Tutor not found or inactive" });
      return;
    }

    res.json({
      id: tutor.id,
      projectName: tutor.projectName,
      welcomeMessage: tutor.welcomeMessage,
      theme: tutor.theme,
      accentColor: tutor.accentColor,
      language: tutor.language,
    });
  } catch (err) {
    log(`Error fetching tutor config: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/tutor/:id/chat — send message, get AI response
app.post("/api/tutor/:id/chat", async (req, res) => {
  try {
    const parsed = chatMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const { message, sessionId } = parsed.data;
    const result = await handleChat(param(req.params.id), sessionId, message);

    res.json(result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    log(`Error in chat: ${errMsg}`);

    if (errMsg === "Tutor not found" || errMsg === "Tutor is inactive") {
      res.status(404).json({ error: errMsg });
      return;
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/tutor/:id/feedback — rate a message
app.post("/api/tutor/:id/feedback", async (req, res) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const { messageId, rating } = parsed.data;

    await db
      .update(tutorMessages)
      .set({ rating })
      .where(eq(tutorMessages.id, messageId));

    res.json({ success: true });
  } catch (err) {
    log(`Error saving feedback: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================
// ADMIN ROUTES (CRM → server, require API key)
// ============================================================

const adminRouter = express.Router();
adminRouter.use(adminAuth);

// POST /api/admin/tutors — create new tutor
adminRouter.post("/tutors", async (req, res) => {
  try {
    const parsed = createTutorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const apiKey = `tutor-${uuidv4()}`;

    const [tutor] = await db
      .insert(tutors)
      .values({ ...parsed.data, apiKey })
      .returning();

    log(`Tutor created: ${tutor!.id} (${tutor!.projectName})`);
    res.status(201).json(tutor);
  } catch (err) {
    log(`Error creating tutor: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/admin/tutors/:id — update tutor
adminRouter.patch("/tutors/:id", async (req, res) => {
  try {
    const parsed = updateTutorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const [updated] = await db
      .update(tutors)
      .set(parsed.data)
      .where(eq(tutors.id, param(req.params.id)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Tutor not found" });
      return;
    }

    log(`Tutor updated: ${updated.id}`);
    res.json(updated);
  } catch (err) {
    log(`Error updating tutor: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/admin/tutors/:id — delete tutor (cascade)
adminRouter.delete("/tutors/:id", async (req, res) => {
  try {
    // Delete associated files from Supabase Storage first
    const docs = await db.query.tutorDocuments.findMany({
      where: eq(tutorDocuments.tutorId, param(req.params.id)),
    });

    for (const doc of docs) {
      if (doc.originalUrl) {
        try {
          await deleteDocument(doc.originalUrl);
        } catch {
          log(`Warning: failed to delete storage file for doc ${doc.id}`);
        }
      }
    }

    const [deleted] = await db
      .delete(tutors)
      .where(eq(tutors.id, param(req.params.id)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Tutor not found" });
      return;
    }

    log(`Tutor deleted: ${deleted.id}`);
    res.json({ success: true });
  } catch (err) {
    log(`Error deleting tutor: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/tutors/:id/documents — upload document
adminRouter.post("/tutors/:id/documents", upload.single("file"), async (req, res) => {
  try {
    const tutorId = param(req.params.id);

    // Verify tutor exists
    const tutor = await db.query.tutors.findFirst({
      where: eq(tutors.id, tutorId),
    });
    if (!tutor) {
      res.status(404).json({ error: "Tutor not found" });
      return;
    }

    const file = req.file;
    const textContent = req.body.content as string | undefined;
    const docName = req.body.name as string | undefined;

    let extractedText: string;
    let docType: string;
    let originalUrl: string | null = null;

    if (file) {
      // PDF or text file upload
      if (file.mimetype === "application/pdf") {
        extractedText = await extractTextFromPdf(file.buffer);
        docType = "pdf";

        // Upload to Supabase Storage
        originalUrl = await uploadDocument(
          tutorId,
          file.originalname,
          file.buffer,
          file.mimetype
        );
      } else {
        // Treat as plain text
        extractedText = file.buffer.toString("utf-8");
        docType = "text";
      }
    } else if (textContent) {
      // Plain text sent in body
      extractedText = textContent;
      docType = "text";
    } else {
      res.status(400).json({ error: "No file or text content provided" });
      return;
    }

    if (extractedText.trim().length === 0) {
      res.status(400).json({ error: "Document has no extractable text content" });
      return;
    }

    const chunks = chunkText(extractedText);

    const [doc] = await db
      .insert(tutorDocuments)
      .values({
        tutorId,
        name: docName ?? file?.originalname ?? "Untitled",
        type: docType,
        content: extractedText,
        chunks,
        originalUrl,
      })
      .returning();

    log(`Document uploaded: ${doc!.id} (${chunks.length} chunks) for tutor ${tutorId}`);
    res.status(201).json({
      ...doc,
      chunkCount: chunks.length,
    });
  } catch (err) {
    log(`Error uploading document: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/admin/tutors/:id/documents/:docId — delete document
adminRouter.delete("/tutors/:id/documents/:docId", async (req, res) => {
  try {
    const doc = await db.query.tutorDocuments.findFirst({
      where: eq(tutorDocuments.id, param(req.params.docId)),
    });

    if (!doc || doc.tutorId !== param(req.params.id)) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Delete from Supabase Storage if it has a URL
    if (doc.originalUrl) {
      try {
        await deleteDocument(doc.originalUrl);
      } catch {
        log(`Warning: failed to delete storage file for doc ${doc.id}`);
      }
    }

    await db.delete(tutorDocuments).where(eq(tutorDocuments.id, doc.id));

    log(`Document deleted: ${doc.id}`);
    res.json({ success: true });
  } catch (err) {
    log(`Error deleting document: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/tutors/:id/documents/url — ingest from URL (scraping)
adminRouter.post("/tutors/:id/documents/url", async (req, res) => {
  try {
    const tutorId = param(req.params.id);
    const { url } = req.body as { url?: string };

    if (!url) {
      res.status(400).json({ error: "URL is required" });
      return;
    }

    const tutor = await db.query.tutors.findFirst({
      where: eq(tutors.id, tutorId),
    });
    if (!tutor) {
      res.status(404).json({ error: "Tutor not found" });
      return;
    }

    const { title, text } = await scrapeUrl(url);
    const chunks = chunkText(text);

    const [doc] = await db
      .insert(tutorDocuments)
      .values({
        tutorId,
        name: title,
        type: "url",
        content: text,
        chunks,
        originalUrl: url,
      })
      .returning();

    log(`URL scraped: ${url} (${chunks.length} chunks) for tutor ${tutorId}`);
    res.status(201).json({ ...doc, chunkCount: chunks.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scraping failed";
    log(`Error scraping URL: ${msg}`);
    res.status(400).json({ error: msg });
  }
});

// POST /api/admin/tutors/:id/documents/github — ingest from GitHub repo
adminRouter.post("/tutors/:id/documents/github", async (req, res) => {
  try {
    const tutorId = param(req.params.id);
    const { repoUrl, githubToken } = req.body as { repoUrl?: string; githubToken?: string };

    if (!repoUrl) {
      res.status(400).json({ error: "GitHub repository URL is required" });
      return;
    }

    const tutor = await db.query.tutors.findFirst({
      where: eq(tutors.id, tutorId),
    });
    if (!tutor) {
      res.status(404).json({ error: "Tutor not found" });
      return;
    }

    const repoContent = await fetchGitHubRepo(repoUrl, githubToken);
    const fullText = formatRepoAsDocument(repoContent);
    const chunks = chunkText(fullText);

    const [doc] = await db
      .insert(tutorDocuments)
      .values({
        tutorId,
        name: `GitHub: ${repoContent.repoName}`,
        type: "url",
        content: fullText,
        chunks,
        originalUrl: repoUrl,
      })
      .returning();

    log(`GitHub repo ingested: ${repoContent.repoName} (${repoContent.files.length} files, ${chunks.length} chunks) for tutor ${tutorId}`);
    res.status(201).json({
      ...doc,
      chunkCount: chunks.length,
      filesProcessed: repoContent.files.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "GitHub ingestion failed";
    log(`Error ingesting GitHub repo: ${msg}`);
    res.status(400).json({ error: msg });
  }
});

// GET /api/admin/tutors/:id/analytics — basic stats
adminRouter.get("/tutors/:id/analytics", async (req, res) => {
  try {
    const tutorId = param(req.params.id);

    const conversations = await db
      .select({ total: count() })
      .from(tutorConversations)
      .where(eq(tutorConversations.tutorId, tutorId));

    const messages = await db
      .select({ total: count() })
      .from(tutorMessages)
      .innerJoin(
        tutorConversations,
        eq(tutorMessages.conversationId, tutorConversations.id)
      )
      .where(eq(tutorConversations.tutorId, tutorId));

    const positiveRatings = await db
      .select({ total: count() })
      .from(tutorMessages)
      .innerJoin(
        tutorConversations,
        eq(tutorMessages.conversationId, tutorConversations.id)
      )
      .where(
        sql`${tutorConversations.tutorId} = ${tutorId} AND ${tutorMessages.rating} = 'up'`
      );

    const negativeRatings = await db
      .select({ total: count() })
      .from(tutorMessages)
      .innerJoin(
        tutorConversations,
        eq(tutorMessages.conversationId, tutorConversations.id)
      )
      .where(
        sql`${tutorConversations.tutorId} = ${tutorId} AND ${tutorMessages.rating} = 'down'`
      );

    const totalConvs = conversations[0]?.total ?? 0;
    const totalMsgs = messages[0]?.total ?? 0;

    res.json({
      totalConversations: totalConvs,
      totalMessages: totalMsgs,
      avgMessagesPerConversation:
        totalConvs > 0 ? Math.round(totalMsgs / totalConvs) : 0,
      ratings: {
        positive: positiveRatings[0]?.total ?? 0,
        negative: negativeRatings[0]?.total ?? 0,
      },
    });
  } catch (err) {
    log(`Error fetching analytics: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/tutors/:id/conversations — paginated conversation history
adminRouter.get("/tutors/:id/conversations", async (req, res) => {
  try {
    const tutorId = param(req.params.id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const convos = await db.query.tutorConversations.findMany({
      where: eq(tutorConversations.tutorId, tutorId),
      orderBy: [desc(tutorConversations.createdAt)],
      limit,
      offset,
      with: {
        messages: {
          orderBy: [desc(tutorMessages.createdAt)],
        },
      },
    });

    // Reverse messages to chronological order within each conversation
    const result = convos.map((c) => ({
      ...c,
      messages: [...c.messages].reverse(),
    }));

    res.json({ page, limit, conversations: result });
  } catch (err) {
    log(`Error fetching conversations: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/tutors — list all tutors
adminRouter.get("/tutors", async (_req, res) => {
  try {
    const allTutors = await db.query.tutors.findMany({
      orderBy: [desc(tutors.createdAt)],
    });
    res.json(allTutors);
  } catch (err) {
    log(`Error listing tutors: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/tutors/:id — get single tutor with document count
adminRouter.get("/tutors/:id", async (req, res) => {
  try {
    const tutor = await db.query.tutors.findFirst({
      where: eq(tutors.id, param(req.params.id)),
      with: { documents: true },
    });

    if (!tutor) {
      res.status(404).json({ error: "Tutor not found" });
      return;
    }

    res.json(tutor);
  } catch (err) {
    log(`Error fetching tutor: ${err}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Mount admin routes
app.use("/api/admin", adminRouter);

// ============================================================
// Landing page + Health check
// ============================================================

app.get("/", (_req, res) => {
  const candidates = [
    path.resolve(process.cwd(), "server", "public", "admin.html"),
    path.resolve(__dirname, "public", "admin.html"),
  ];
  const adminPath = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  res.sendFile(adminPath);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================
// Start Server
// ============================================================

async function start(): Promise<void> {
  try {
    await initializeDatabase();
    log("Database initialized (pg_trgm extension ready)");

    // Create HTTP server and attach WebSocket
    const server = http.createServer(app);

    const { initWebSocket } = await import("./websocket.js");
    initWebSocket(server);

    server.listen(PORT, "0.0.0.0", () => {
      log(`IM3 Tutor server running on port ${PORT}`);
      log("WebSocket ready at ws://localhost:" + PORT + "/ws/tutor");
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
