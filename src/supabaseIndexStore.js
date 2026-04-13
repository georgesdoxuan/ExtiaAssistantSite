import { Pool } from "pg";

let pool = null;

function getPool() {
  const connectionString = process.env.SUPABASE_POOLER_URL;
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_POOLER_URL);
}

export async function ensureSupabaseSchema() {
  const p = getPool();
  if (!p) return false;

  await p.query(`
    CREATE TABLE IF NOT EXISTS extia_site_pages (
      url TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT,
      h1 TEXT,
      meta_description TEXT,
      text_snippet TEXT,
      image_text TEXT,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_site TEXT
    );
  `);

  // Idempotent migration: add image_text if table already existed without it.
  await p.query(`
    ALTER TABLE extia_site_pages ADD COLUMN IF NOT EXISTS image_text TEXT;
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS extia_site_pages_category_idx
    ON extia_site_pages (category);
  `);

  return true;
}

export async function writeIndexToSupabase(siteIndex) {
  const p = getPool();
  if (!p) return false;
  await ensureSupabaseSchema();

  const pages = Object.values(siteIndex?.grouped_pages || {}).flat();
  if (!pages.length) return true;

  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const page of pages) {
      await client.query(
        `
          INSERT INTO extia_site_pages (
            url, category, title, h1, meta_description, text_snippet, image_text, indexed_at, source_site
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
          ON CONFLICT (url) DO UPDATE SET
            category = EXCLUDED.category,
            title = EXCLUDED.title,
            h1 = EXCLUDED.h1,
            meta_description = EXCLUDED.meta_description,
            text_snippet = EXCLUDED.text_snippet,
            image_text = EXCLUDED.image_text,
            indexed_at = NOW(),
            source_site = EXCLUDED.source_site
        `,
        [
          String(page.url || ""),
          String(page.category || "autre"),
          String(page.title || ""),
          String(page.h1 || ""),
          String(page.meta_description || ""),
          String(page.text_snippet || ""),
          String(page.image_text || ""),
          String(siteIndex?.site || "https://www.extia.fr")
        ]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function readIndexFromSupabase() {
  const p = getPool();
  if (!p) return null;
  await ensureSupabaseSchema();

  const { rows } = await p.query(`
    SELECT url, category, title, h1, meta_description, text_snippet, image_text, indexed_at, source_site
    FROM extia_site_pages
    ORDER BY indexed_at DESC
  `);

  if (!rows.length) return null;

  const grouped = {};
  for (const r of rows) {
    const category = r.category || "autre";
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push({
      url: r.url,
      category,
      title: r.title || "",
      h1: r.h1 || "",
      meta_description: r.meta_description || "",
      text_snippet: r.text_snippet || "",
      image_text: r.image_text || ""
    });
  }

  return {
    site: rows[0]?.source_site || "https://www.extia.fr",
    built_at: rows[0]?.indexed_at ? new Date(rows[0].indexed_at).toISOString() : new Date().toISOString(),
    total_pages: rows.length,
    total_errors: 0,
    categories: Object.keys(grouped).sort(),
    grouped_pages: grouped,
    errors: []
  };
}
