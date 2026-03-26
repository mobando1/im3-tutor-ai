import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  json,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { z } from "zod";

// ============================================================
// Tables
// ============================================================

export const tutors = pgTable("tutors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectName: text("project_name").notNull(),
  clientName: text("client_name").notNull(),
  welcomeMessage: text("welcome_message")
    .notNull()
    .default("Hola, soy tu tutor virtual. ¿En qué puedo ayudarte?"),
  systemPrompt: text("system_prompt").notNull().default(""),
  theme: text("theme").notNull().default("light"),
  accentColor: text("accent_color").notNull().default("#2FA4A9"),
  language: text("language").notNull().default("es"),
  apiKey: text("api_key").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tutorDocuments = pgTable("tutor_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tutorId: uuid("tutor_id")
    .notNull()
    .references(() => tutors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(), // "pdf" | "text" | "url"
  content: text("content").notNull(), // extracted full text
  chunks: json("chunks").$type<Array<{ index: number; text: string }>>().notNull(),
  originalUrl: text("original_url"), // Supabase Storage URL (null for plain text)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tutorConversations = pgTable("tutor_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tutorId: uuid("tutor_id")
    .notNull()
    .references(() => tutors.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tutorMessages = pgTable("tutor_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => tutorConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  docsUsed: json("docs_used").$type<Array<{ documentId: string; chunkIndex: number }>>(),
  rating: text("rating"), // "up" | "down" | null
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// Relations
// ============================================================

export const tutorsRelations = relations(tutors, ({ many }) => ({
  documents: many(tutorDocuments),
  conversations: many(tutorConversations),
}));

export const tutorDocumentsRelations = relations(tutorDocuments, ({ one }) => ({
  tutor: one(tutors, { fields: [tutorDocuments.tutorId], references: [tutors.id] }),
}));

export const tutorConversationsRelations = relations(tutorConversations, ({ one, many }) => ({
  tutor: one(tutors, { fields: [tutorConversations.tutorId], references: [tutors.id] }),
  messages: many(tutorMessages),
}));

export const tutorMessagesRelations = relations(tutorMessages, ({ one }) => ({
  conversation: one(tutorConversations, {
    fields: [tutorMessages.conversationId],
    references: [tutorConversations.id],
  }),
}));

// ============================================================
// Zod Validation Schemas
// ============================================================

export const createTutorSchema = z.object({
  projectName: z.string().min(1).max(200),
  clientName: z.string().min(1).max(200),
  welcomeMessage: z.string().max(1000).optional(),
  systemPrompt: z.string().max(5000).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  language: z.enum(["es", "en"]).optional(),
});

export const updateTutorSchema = createTutorSchema.partial();

export const chatMessageSchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string().uuid(),
});

export const feedbackSchema = z.object({
  messageId: z.string().uuid(),
  rating: z.enum(["up", "down"]),
});
