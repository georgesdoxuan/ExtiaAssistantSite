export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in environment.`);
  return value;
}

export function buildAssistantResponse({ target, userMessage, summary, issues, snapshotStats }) {
  const findings = (Array.isArray(issues) ? issues : []).slice(0, 10).map((it) => ({
    severity: String(it?.severity || "low").toLowerCase(),
    title: it?.title || it?.category || "Point a verifier",
    reason: it?.reason || "",
    evidence: it?.evidence || "",
    source:
      target === "mailchimp"
        ? {
            workflow_title: it?.workflow_title || "",
            email_title: it?.email_title || "",
            email_id: it?.email_id || ""
          }
        : { url: it?.url || "", category: it?.category || "" }
  }));

  const hasFindings = findings.length > 0;
  const answer = hasFindings
    ? `J'ai analyse votre demande: "${userMessage}". ${summary} Je vous liste les points avec preuve ci-dessous.`
    : `J'ai analyse votre demande: "${userMessage}". ${summary} Aucun point incoherent verifiable n'a ete trouve.`;

  return {
    readonly_enforced: true,
    write_operations_attempted: 0,
    target,
    answer,
    findings,
    actions: hasFindings
      ? [
          "Verifier les elements cites avec les equipes metier.",
          "Mettre a jour les contenus identifies dans votre outil source (manuellement).",
          "Relancer l'assistant pour confirmer que les incoherences ont disparu."
        ]
      : ["Aucune action urgente. Surveillez les prochaines mises a jour avec cette meme requete."],
    limitations: [
      "Mode strict lecture seule: aucune modification automatique n'est effectuee.",
      "Les conclusions sont basees uniquement sur les contenus accessibles via les APIs/URLs disponibles."
    ],
    confidence: hasFindings ? "medium" : "high",
    snapshot_stats: snapshotStats || {}
  };
}

export function detectAssistantIntent(message) {
  const t = String(message || "").toLowerCase();
  if (/\b(conseil|conseils|recommand|am[eé]lior|optimis|best practice|strategie)\b/.test(t)) {
    return "advice";
  }
  return "audit";
}

export function detectMailchimpIntent(message) {
  const t = String(message || "").toLowerCase();
  if (/\b(signification|veut dire|definition|c[' ]?est quoi|meaning|explique)\b/.test(t)) {
    return "explain_api_terms";
  }
  if (
    /\b(dernier|plus recent|latest)\b/.test(t) &&
    /\b(programm|planifi|schedule|scheduled)\b/.test(t)
  ) {
    return "latest_scheduled";
  }
  return "audit";
}

export function isThinContentIssue(issue) {
  const reason = String(issue?.reason || "").toLowerCase();
  const evidence = String(issue?.evidence || "").toLowerCase();
  return (
    reason.includes("contenu mince") ||
    (reason.includes("charg") && reason.includes("dynami")) ||
    (evidence.includes("charg") && evidence.includes("dynami"))
  );
}

export function getMailchimpApiDictionary() {
  return {
    campaign_types: {
      scheduled_campaign: "Campagne programmee avec une date/heure d'envoi (send_time).",
      draft_campaign: "Brouillon (status souvent 'save'), non programme tant qu'aucun send_time futur n'est defini.",
      automation_flow: "Flow/Journey d'automation (Customer Journey)."
    },
    status_common_meaning: {
      save: "Brouillon non envoye. Ce statut seul ne prouve pas une programmation.",
      schedule: "Campagne planifiee pour envoi futur.",
      scheduled: "Equivalent de schedule (selon endpoint/version).",
      sending: "En cours d'envoi.",
      sent: "Deja envoye.",
      canceled: "Envoi annule.",
      archived: "Archive/inactive."
    },
    time_fields: {
      send_time: "Date/heure d'envoi retenue en priorite pour determiner si une campagne est programmee.",
      scheduled_time: "Variante possible selon endpoint.",
      schedule_time: "Variante possible selon endpoint.",
      settings_send_time: "Variante dans settings.",
      settings_scheduled_time: "Variante dans settings.",
      settings_schedule_time: "Variante dans settings."
    },
    rules_used_by_assistant: [
      "Une campagne est consideree 'programmee' seulement si type/status est schedule/scheduled ET date d'envoi future valide.",
      "Un brouillon 'save' sans date d'envoi future n'est pas considere programme.",
      "Mode lecture seule strict: aucune operation d'ecriture API n'est effectuee."
    ]
  };
}

