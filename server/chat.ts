import Anthropic from "@anthropic-ai/sdk";
import { eq, and, desc } from "drizzle-orm";
import { db } from "./db.js";
import { tutors, tutorConversations, tutorMessages } from "../shared/schema.js";
import { searchChunks } from "./rag.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface ChatResult {
  reply: string;
  conversationId: string;
  messageId: string;
  docsUsed: Array<{ documentId: string; chunkIndex: number }>;
}

const FALLBACK_MESSAGES: Record<string, string> = {
  es: "No tengo información sobre eso en los documentos disponibles. Te sugiero contactar al equipo de soporte.",
  en: "I don't have information about that in the available documents. I suggest contacting the support team.",
};

/**
 * Handle a chat message: search chunks, build prompt, call Claude, store conversation.
 */
export async function handleChat(
  tutorId: string,
  sessionId: string,
  userMessage: string
): Promise<ChatResult> {
  // 1. Get tutor config
  const tutor = await db.query.tutors.findFirst({
    where: eq(tutors.id, tutorId),
  });

  if (!tutor) throw new Error("Tutor not found");
  if (!tutor.isActive) throw new Error("Tutor is inactive");

  // 2. Search relevant chunks
  const chunks = await searchChunks(tutorId, userMessage, 10);

  const docsUsed = chunks.map((c) => ({
    documentId: c.documentId,
    chunkIndex: c.chunkIndex,
  }));

  // 3. Get or create conversation
  let conversation = await db.query.tutorConversations.findFirst({
    where: and(
      eq(tutorConversations.tutorId, tutorId),
      eq(tutorConversations.sessionId, sessionId)
    ),
  });

  if (!conversation) {
    const [newConv] = await db
      .insert(tutorConversations)
      .values({ tutorId, sessionId })
      .returning();
    conversation = newConv!;
  }

  // 4. Load conversation history (last 20 messages)
  const history = await db.query.tutorMessages.findMany({
    where: eq(tutorMessages.conversationId, conversation.id),
    orderBy: [desc(tutorMessages.createdAt)],
    limit: 20,
  });

  // Reverse to chronological order
  history.reverse();

  // 5. Build context from chunks
  let contextBlock = "";
  if (chunks.length > 0) {
    contextBlock = chunks
      .map(
        (c) =>
          `--- Documento: ${c.documentName} ---\n${c.text}`
      )
      .join("\n\n");
  }

  const fallback =
    FALLBACK_MESSAGES[tutor.language] ?? FALLBACK_MESSAGES["es"]!;

  // 6. Build system prompt
  const systemPrompt = [
    `Eres un tutor virtual del proyecto "${tutor.projectName}".`,
    tutor.systemPrompt ? tutor.systemPrompt : "",
    "",
    "REGLAS ESTRICTAS:",
    "- Responde ÚNICAMENTE usando información de los documentos proporcionados abajo.",
    `- Si la respuesta NO está en los documentos, responde exactamente: "${fallback}"`,
    `- Siempre responde en ${tutor.language === "en" ? "inglés" : "español"}.`,
    "- Sé útil, conciso y profesional.",
    "- NUNCA inventes información que no esté en los documentos.",
    "",
    contextBlock.length > 0
      ? `DOCUMENTOS RELEVANTES:\n${contextBlock}`
      : "No se encontraron documentos relevantes para esta consulta.",
  ]
    .filter(Boolean)
    .join("\n");

  // 7. Build messages array
  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    { role: "user", content: userMessage },
  ];

  // 8. Call Claude
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    temperature: 0.3,
    system: systemPrompt,
    messages,
  });

  const assistantReply =
    response.content[0]?.type === "text"
      ? response.content[0].text
      : fallback;

  // 9. Store user message
  await db.insert(tutorMessages).values({
    conversationId: conversation.id,
    role: "user",
    content: userMessage,
  });

  // 10. Store assistant message
  const [assistantMsg] = await db
    .insert(tutorMessages)
    .values({
      conversationId: conversation.id,
      role: "assistant",
      content: assistantReply,
      docsUsed,
    })
    .returning();

  return {
    reply: assistantReply,
    conversationId: conversation.id,
    messageId: assistantMsg!.id,
    docsUsed,
  };
}
