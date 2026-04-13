import { createWorker } from "tesseract.js";

// Patterns that identify decorative/non-content images — skip OCR on these.
const SKIP_PATTERNS = [
  /\.(svg|ico|gif)$/i,
  /\/(favicon|icon[-_]|sprite|placeholder|blank|pixel|1x1|arrow|chevron|bullet|spacer)/i,
  /^data:/i,
  /tracking|analytics|beacon/i,
  /(facebook|twitter|linkedin|instagram|youtube|tiktok|social)[-_]/i,
  /logo[-_](footer|header|nav|white|noir|blanc|dark|light)/i,
];

/**
 * Extract up to maxImages candidate image URLs from raw HTML.
 * Resolves relative URLs against pageUrl.
 */
export function extractImageUrls(html, pageUrl, maxImages = 3) {
  const base = (() => { try { return new URL(pageUrl); } catch { return null; } })();
  const seen = new Set();
  const urls = [];

  const pattern = /<img[^>]+?(?:src|data-src)=["']([^"']+)["']/gi;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    if (urls.length >= maxImages) break;
    let raw = m[1].trim();
    if (!raw) continue;
    if (raw.startsWith("//")) raw = "https:" + raw;

    let abs;
    try {
      abs = base ? new URL(raw, base).toString() : raw;
    } catch { continue; }

    if (!/^https?:\/\//i.test(abs)) continue;
    if (SKIP_PATTERNS.some((p) => p.test(abs))) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    urls.push(abs);
  }

  return urls;
}

/**
 * Create a Tesseract worker for French + English.
 * Call terminateOCRWorker() when done with the indexing run.
 */
export async function createOCRWorker() {
  const worker = await createWorker(["fra", "eng"], 1, {
    logger: (m) => {
      // Suppress routine Tesseract noise (resolution warnings, progress, etc.)
      if (m?.status === "recognizing text") return;
      if (typeof m?.userJobId === "string") return;
    }
  });
  return worker;
}

export async function terminateOCRWorker(worker) {
  if (worker) {
    try { await worker.terminate(); } catch { /* ignore */ }
  }
}

/**
 * Run OCR on each image URL using a shared Tesseract worker.
 * Returns all extracted texts joined by " | ", or "" if nothing found.
 * Never throws — failures are silently skipped.
 */
export async function extractTextFromImages(imageUrls, worker) {
  if (!imageUrls.length || !worker) return "";

  const texts = [];
  for (const url of imageUrls) {
    try {
      const { data } = await worker.recognize(url);
      const text = (data?.text || "").replace(/\s+/g, " ").trim();
      // Only keep if there's meaningful content (>5 chars, not just noise)
      if (text.length > 5) texts.push(text);
    } catch (err) {
      console.log(`[ocr] skip ${url.slice(0, 80)}: ${err?.message || err}`);
    }
  }

  return texts.join(" | ");
}
