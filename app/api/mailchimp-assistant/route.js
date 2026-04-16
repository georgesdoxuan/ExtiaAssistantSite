import { getAutomationsReadOnly, getScheduledCampaignsReadOnly, getAutomationFlowsReadOnly } from "../../../src/mailchimpClient.js";
import { runAuditWithOpenAI } from "../../../src/audit.js";
import {
  buildAssistantResponse,
  detectMailchimpIntent,
  getMailchimpApiDictionary,
  requireEnv
} from "../../../src/assistantCore.js";

function getApiBase() {
  return process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "";
}

export async function POST(request) {
  const apiBase = getApiBase();
  if (apiBase) {
    const body = await request.text();
    const resp = await fetch(`${apiBase}/api/mailchimp-assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || "{}"
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("content-type") || "application/json" }
    });
  }

  try {
    const payload = await request.json().catch(() => ({}));
    const message = String(payload?.message ?? payload?.update ?? "").trim();
    if (!message) {
      return new Response(JSON.stringify({ error: "Missing 'message' field." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const mode = (process.env.MAILCHIMP_MODE || "readonly").toLowerCase();
    if (mode !== "readonly") {
      return new Response(JSON.stringify({ error: 'MAILCHIMP_MODE must be "readonly".' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const mailchimpApiKey = requireEnv("MAILCHIMP_API_KEY");
    const openaiApiKey = requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const workflowsCount = Number(process.env.MAILCHIMP_WORKFLOWS_COUNT || "200");
    const campaignsCount = Number(process.env.MAILCHIMP_CAMPAIGNS_COUNT || "200");
    const maxCampaignsToAudit = Number(process.env.MAILCHIMP_MAX_CAMPAIGNS_TO_AUDIT || "200");

    const [automations, scheduledCampaigns] = await Promise.all([
      getAutomationsReadOnly(mailchimpApiKey, workflowsCount),
      getScheduledCampaignsReadOnly(mailchimpApiKey, campaignsCount, maxCampaignsToAudit)
    ]);

    const automationFlows = await getAutomationFlowsReadOnly(
      mailchimpApiKey,
      Number(process.env.MAILCHIMP_FLOWS_COUNT || "200"),
      Number(process.env.MAILCHIMP_MAX_FLOWS_TO_AUDIT || "20")
    );

    const allCampaigns = scheduledCampaigns?.campaigns ?? [];
    const scheduledOnly = allCampaigns
      .filter((c) => c.type === "scheduled_campaign" && c.send_time)
      .sort((a, b) => Date.parse(String(b.send_time || 0)) - Date.parse(String(a.send_time || 0)));

    const snapshotStats = {
      workflows: automations?.total_items ?? automations?.workflows?.length ?? 0,
      emails: automations?.total_emails ?? 0,
      scheduled_campaigns: allCampaigns.filter((c) => c.type === "scheduled_campaign").length,
      draft_campaigns: allCampaigns.filter((c) => c.type === "draft_campaign").length,
      campaigns_audited: allCampaigns.length
    };

    const intent = detectMailchimpIntent(message);
    if (intent === "latest_scheduled") {
      if (scheduledOnly.length === 0) {
        return Response.json({
          readonly_enforced: true,
          write_operations_attempted: 0,
          target: "mailchimp",
          answer: "Aucun mail n'est actuellement programme pour un envoi futur dans les donnees Mailchimp disponibles.",
          findings: [],
          actions: [
            "Verifier dans Mailchimp les campagnes au statut 'schedule/scheduled'.",
            "Verifier que la date d'envoi est bien renseignee (send_time)."
          ],
          limitations: [
            "Les campagnes en brouillon (status 'save') ne sont pas considerees comme programmees.",
            "Mode lecture seule strict: aucune modification automatique."
          ],
          confidence: "high",
          api_dictionary: getMailchimpApiDictionary(),
          snapshot_stats: snapshotStats
        });
      }

      const latest = scheduledOnly[0];
      return Response.json({
        readonly_enforced: true,
        write_operations_attempted: 0,
        target: "mailchimp",
        answer: `Le dernier mail programme est "${latest.name || "(sans titre)"}", prevu pour ${latest.send_time}.`,
        findings: [{
          severity: "low",
          title: latest.name || "(sans titre)",
          reason: "Campagne planifiee detectee avec date d'envoi future.",
          evidence: `status=${latest.status || "unknown"} ; send_time=${latest.send_time || ""}`,
          source: { workflow_title: "", email_title: latest.name || "", email_id: latest.id || "" }
        }],
        actions: ["Verifier que le contenu et l'objet sont bien a jour avant l'envoi."],
        limitations: ["Mode lecture seule strict: aucune modification automatique."],
        confidence: "high",
        api_dictionary: getMailchimpApiDictionary(),
        snapshot_stats: snapshotStats
      });
    }

    if (intent === "explain_api_terms") {
      return Response.json({
        readonly_enforced: true,
        write_operations_attempted: 0,
        target: "mailchimp",
        answer: "Voici les significations principales des ecritures/champs API Mailchimp utilises par l'assistant.",
        findings: [],
        actions: ["Utiliser ces definitions comme reference pour interpreter les resultats."],
        limitations: ["Les noms exacts peuvent varier selon endpoint/version Mailchimp."],
        confidence: "high",
        api_dictionary: getMailchimpApiDictionary(),
        snapshot_stats: snapshotStats
      });
    }

    const noAutomations = (automations?.total_emails ?? 0) === 0;
    const noCampaigns = (scheduledCampaigns?.campaigns?.length ?? 0) === 0;
    const noAutomationFlows = (automationFlows?.flows?.length ?? 0) === 0;
    const noAuditableContent = noAutomations && noCampaigns && noAutomationFlows;

    const audit = noAuditableContent
      ? { summary: "Aucun contenu auditable n'a ete trouve (automations/campagnes/flows).", issues: [] }
      : await runAuditWithOpenAI({
          openaiApiKey,
          model,
          businessUpdate: message,
          automations,
          scheduledCampaigns,
          automationFlows
        });

    const out = buildAssistantResponse({
      target: "mailchimp",
      userMessage: message,
      summary: audit?.summary || "",
      issues: audit?.issues || [],
      snapshotStats
    });
    out.api_dictionary = getMailchimpApiDictionary();
    return Response.json(out);
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

