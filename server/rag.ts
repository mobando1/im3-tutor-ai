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
 * Uses a combined strategy:
 * 1. Keyword search (ILIKE) — finds chunks containing query words
 * 2. Trigram similarity — finds fuzzy matches
 * Results are merged and deduplicated.
 */
export async function searchChunks(
  tutorId: string,
  query: string,
  limit: number = 10
): Promise<ChunkSearchResult[]> {
  // Extract meaningful keywords (3+ chars) for ILIKE search
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !["como", "que", "para", "por", "los", "las", "del", "una", "con", "este", "esta", "the", "how", "what", "does", "can"].includes(w));

  // Build keyword conditions
  let keywordCondition = "FALSE";
  const params: (string | number)[] = [tutorId];
  let paramIdx = 2;

  if (keywords.length > 0) {
    const conditions = keywords.map((kw) => {
      params.push(`%${kw}%`);
      return `lower(chunk->>'text') LIKE $${paramIdx++}`;
    });
    keywordCondition = conditions.join(" OR ");
  }

  // Add query for trigram
  params.push(query);
  const trigramParam = paramIdx++;
  params.push(limit);
  const limitParam = paramIdx;

  const result = await pool.query<{
    document_id: string;
    document_name: string;
    chunk_index: number;
    chunk_text: string;
    score: number;
  }>(
    `
    WITH keyword_matches AS (
      SELECT
        d.id AS document_id,
        d.name AS document_name,
        (chunk->>'index')::int AS chunk_index,
        chunk->>'text' AS chunk_text,
        1.0 AS score
      FROM tutor_documents d,
           json_array_elements(d.chunks::json) AS chunk
      WHERE d.tutor_id = $1
        AND (${keywordCondition})
      LIMIT 20
    ),
    trigram_matches AS (
      SELECT
        d.id AS document_id,
        d.name AS document_name,
        (chunk->>'index')::int AS chunk_index,
        chunk->>'text' AS chunk_text,
        similarity(chunk->>'text', $${trigramParam}) AS score
      FROM tutor_documents d,
           json_array_elements(d.chunks::json) AS chunk
      WHERE d.tutor_id = $1
        AND similarity(chunk->>'text', $${trigramParam}) > 0.005
      ORDER BY score DESC
      LIMIT 20
    ),
    combined AS (
      SELECT * FROM keyword_matches
      UNION
      SELECT * FROM trigram_matches
    )
    SELECT DISTINCT ON (document_id, chunk_index)
      document_id, document_name, chunk_index, chunk_text,
      MAX(score) AS score
    FROM combined
    GROUP BY document_id, document_name, chunk_index, chunk_text
    ORDER BY score DESC
    LIMIT $${limitParam}
    `,
    params
  );

  return result.rows.map((row) => ({
    documentId: row.document_id,
    documentName: row.document_name,
    chunkIndex: row.chunk_index,
    text: row.chunk_text,
    similarity: row.score,
  }));
}
