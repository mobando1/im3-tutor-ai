import { log } from "./index.js";

/**
 * Fetch a URL and extract its text content.
 * Strips HTML tags, scripts, styles, and navigation elements.
 */
export async function scrapeUrl(url: string): Promise<{ title: string; text: string }> {
  log(`Scraping URL: ${url}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "IM3-Tutor-Bot/1.0 (Document Ingestion)",
      "Accept": "text/html,application/xhtml+xml,text/plain,application/json",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch URL (${res.status}): ${url}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();

  // JSON response — stringify nicely
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body);
      return { title: url, text: JSON.stringify(json, null, 2) };
    } catch {
      return { title: url, text: body };
    }
  }

  // Plain text
  if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
    return { title: url, text: body };
  }

  // HTML — extract text
  const title = extractHtmlTitle(body) || url;
  const text = extractTextFromHtml(body);

  if (text.trim().length < 50) {
    throw new Error("URL has very little extractable text content");
  }

  return { title, text };
}

/**
 * Scrape multiple URLs and concatenate their content.
 */
export async function scrapeMultipleUrls(
  urls: string[]
): Promise<Array<{ url: string; title: string; text: string }>> {
  const results: Array<{ url: string; title: string; text: string }> = [];

  for (const url of urls) {
    try {
      const { title, text } = await scrapeUrl(url);
      results.push({ url, title, text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log(`Skipping URL ${url}: ${msg}`);
    }
  }

  return results;
}

// ============================================================
// HTML Text Extraction (no external dependencies)
// ============================================================

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]!.trim()) : "";
}

function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove scripts, styles, svg, nav, header, footer
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, " ");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // Replace block elements with newlines
  text = text.replace(/<\/?(p|div|h[1-6]|li|br|tr|td|th|blockquote|pre|hr)[^>]*>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex as string, 16)));
}
