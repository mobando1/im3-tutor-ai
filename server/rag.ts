import pdfParse from "pdf-parse";
import { pool } from "./db.js";

// ============================================================
// PDF Text Extraction
// ============================================================

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text;
}

// ============================================================
// Text Chunking
// ============================================================

interface Chunk {
  index: number;
  text: string;
}

/**
 * Split text into chunks of approximately `maxChars` characters.
 * Strategy: split by paragraphs first, fall back to sentences if a paragraph is too long.
 * Adds `overlap` characters from the end of the previous chunk to the start of the next.
 */
export function chunkText(
  text: string,
  maxChars: number = 2000,
  overlap: number = 100
): Chunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length === 0) return [];

  const paragraphs = cleaned.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let currentText = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;

    // If a single paragraph exceeds maxChars, split it by sentences
    if (trimmed.length > maxChars) {
      // Flush current buffer first
      if (currentText.length > 0) {
        chunks.push({ index: chunks.length, text: currentText.trim() });
        const overlapText = currentText.slice(-overlap);
        currentText = overlapText;
      }

      const sentences = trimmed.match(/[^.!?]+[.!?]+\s*/g) ?? [trimmed];
      for (const sentence of sentences) {
        if (currentText.length + sentence.length > maxChars && currentText.length > 0) {
          chunks.push({ index: chunks.length, text: currentText.trim() });
          const overlapText = currentText.slice(-overlap);
          currentText = overlapText + sentence;
        } else {
          currentText += sentence;
        }
      }
      continue;
    }

    // Normal paragraph — accumulate
    const candidate = currentText.length > 0 ? currentText + "\n\n" + trimmed : trimmed;

    if (candidate.length > maxChars) {
      chunks.push({ index: chunks.length, text: currentText.trim() });
      const overlapText = currentText.slice(-overlap);
      currentText = overlapText + trimmed;
    } else {
      currentText = candidate;
    }
  }

  // Flush remaining text
  if (currentText.trim().length > 0) {
    chunks.push({ index: chunks.length, text: currentText.trim() });
  }

  return chunks;
}

// ============================================================
// Chunk Search (Trigram Matching)
// ============================================================

interface ChunkSearchResult {
  documentId: string;
  documentName: string;
  chunkIndex: number;
  text: string;
  similarity: number;
}

/**
 * Search for the most relevant chunks across all documents of a tutor.
 * Uses keyword search (ILIKE) which works better than trigrams for code.
 */
export async function searchChunks(
  tutorId: string,
  query: string,
  limit: number = 10
): Promise<ChunkSearchResult[]> {
  // Extract meaningful keywords (3+ chars), filter stop words
  const stopWords = new Set(["como", "que", "para", "por", "los", "las", "del", "una", "con", "este", "esta", "esto", "funciona", "sirve", "donde", "dice", "puedo", "hacer", "the", "how", "what", "does", "can", "this", "that"]);
  const keywords = query
    .toLowerCase()
    .replace(/[^a-záéíóúñü\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !stopWords.has(w));

  if (keywords.length === 0) {
    // If no keywords, return first chunks (usually overview/description)
    const result = await pool.query<{
      document_id: string;
      document_name: string;
      chunk_index: number;
      chunk_text: string;
    }>(
      `SELECT d.id AS document_id, d.name AS document_name,
              (chunk->>'index')::int AS chunk_index, chunk->>'text' AS chunk_text
       FROM tutor_documents d, json_array_elements(d.chunks::json) AS chunk
       WHERE d.tutor_id = $1
       ORDER BY (chunk->>'index')::int ASC
       LIMIT $2`,
      [tutorId, limit]
    );
    return result.rows.map((r) => ({
      documentId: r.document_id, documentName: r.document_name,
      chunkIndex: r.chunk_index, text: r.chunk_text, similarity: 0.5,
    }));
  }

  // Build ILIKE conditions for each keyword
  const conditions = keywords.map((_, i) => `lower(chunk->>'text') LIKE $${i + 2}`);
  const params: (string | number)[] = [tutorId, ...keywords.map((kw) => `%${kw}%`), limit];

  const result = await pool.query<{
    document_id: string;
    document_name: string;
    chunk_index: number;
    chunk_text: string;
    match_count: string;
  }>(
    `SELECT d.id AS document_id, d.name AS document_name,
            (chunk->>'index')::int AS chunk_index, chunk->>'text' AS chunk_text,
            (${conditions.map((c) => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(" + ")}) AS match_count
     FROM tutor_documents d, json_array_elements(d.chunks::json) AS chunk
     WHERE d.tutor_id = $1
       AND (${conditions.join(" OR ")})
     ORDER BY match_count DESC, (chunk->>'index')::int ASC
     LIMIT $${keywords.length + 2}`,
    params
  );

  return result.rows.map((r) => ({
    documentId: r.document_id, documentName: r.document_name,
    chunkIndex: r.chunk_index, text: r.chunk_text,
    similarity: Number(r.match_count) / keywords.length,
  }));
}
