import OpenAI from "openai";

// Strip HTML tags and normalize whitespace to get readable plain text.
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Build a lean representation of a campaign for the LLM (no raw HTML, only useful fields).
function compactCampaign(c) {
  const rawHtml = c?.content?.html || "";
  const plainText = c?.content?.plain_text || htmlToText(rawHtml);
  return {
    type: c.type,
    id: c.id,
    name: c.name || null,
    status: c.status,
    send_time: c.send_time || null,
    subject: c?.content?.subject || c?.settings?.subject_line || null,
    from_name: c?.settings?.from_name || null,
    reply_to: c?.settings?.reply_to || null,
    // Plain text content, capped at 3000 chars — enough to catch names/numbers/dates
    content_text: plainText.slice(0, 3000) || null
  };
}

function extractJsonObjectText(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return s;

  // Common failure mode: the model wraps the JSON in Markdown fences.
  // Examples:
  // ```json { ... } ```
  // ``` { ... } ```
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/m, "").trim();

  // Another common issue: extra text before/after JSON.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }

  return s.trim();
}

export async function runAuditWithOpenAI({
  openaiApiKey,
  model,
  businessUpdate,
  automations,
  scheduledCampaigns,
  automationFlows
}) {
  const client = new OpenAI({ apiKey: openaiApiKey });
  const apiGlossary = {
    campaign_types: {
      scheduled_campaign: "Campagne programmee avec date/heure d'envoi (send_time).",
      draft_campaign: "Brouillon (status save), non programme sans date d'envoi future."
    },
    statuses: {
      save: "Brouillon non envoye.",
      schedule: "Planifie pour envoi futur.",
      scheduled: "Equivalent de schedule.",
      sending: "En cours d'envoi.",
      sent: "Deja envoye."
    },
    time_fields_priority: [
      "send_time",
      "scheduled_time",
      "schedule_time",
      "settings.send_time",
      "settings.scheduled_time",
      "settings.schedule_time"
    ]
  };

  const prompt = [
    "Tu es un auditeur spécialisé dans Mailchimp.",
    "Tu dois analyser les emails Mailchimp (automations, campagnes planifiées ET brouillons 'save') et détecter ce qui semble potentiellement PAS A JOUR par rapport à la requête utilisateur.",
    "Les campagnes de type 'draft_campaign' sont des brouillons non encore envoyés — ils doivent être audités au même titre que les campagnes planifiées.",
    "Tu dois UNIQUEMENT signaler les incohérences/discrepances directement liées à la requête utilisateur. Ne signale PAS d’autres problèmes hors scope (ex: si la requête parle de renommage, ne signale pas les dates de copyright obsolètes sauf si elles contiennent aussi l’ancien nom). Ne propose jamais d’opérations d’écriture API (pas de modification/suppression).",
    "Toutes les chaînes textuelles du JSON (summary, reason, evidence, etc.) doivent être en FRANCAIS.",
    "Retourne UNIQUEMENT du JSON strict (pas de texte autour), sans aucun bloc Markdown (pas de ```json, pas de ```).",
    "Le premier caractère de la réponse doit être '{' et le dernier caractère doit être '}'.",
    "",
    "Glossaire API Mailchimp (reference obligatoire):",
    JSON.stringify(apiGlossary),
    "Avec ce schéma :",
    "{",
    '  "summary": string,',
    '  "issues": [',
    "    {",
    '      "severity": "high" | "medium" | "low",',
    '      "workflow_id": string,',
    '      "workflow_title": string,',
    '      "email_id": string,',
    '      "email_title": string,',
    '      "reason": string,',
    '      "evidence": string',
    "    }",
    "  ]",
    "}",
    "",
    `Changement métier à valider: ${businessUpdate}`,
    "",
    ...(automations?.total_emails > 0 ? [
      "Automatisations Mailchimp (Classic Automations) :",
      JSON.stringify(automations),
      ""
    ] : []),
    "Campagnes Mailchimp à analyser (planifiées + brouillons) :",
    JSON.stringify((scheduledCampaigns?.campaigns || []).map(compactCampaign)),
    "",
    "Automation flows (Customer Journeys) :",
    JSON.stringify((automationFlows?.flows || []).map((f) => ({
      id: f.id, title: f.title, status: f.status
    })))
  ].join("\n");

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0
  });

  const raw = response.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI returned an empty response.");
  }

  const normalized = extractJsonObjectText(raw);

  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(
      `Failed to parse OpenAI JSON output: ${error.message}\nRaw output:\n${raw}\n\nExtracted:\n${normalized}`
    );
  }
}
