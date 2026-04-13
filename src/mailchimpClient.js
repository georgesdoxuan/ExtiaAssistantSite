const DISALLOWED_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseDataCenterFromApiKey(apiKey) {
  if (!apiKey || !apiKey.includes("-")) {
    throw new Error("MAILCHIMP_API_KEY is invalid. Expected key format with datacenter suffix.");
  }
  const parts = apiKey.split("-");
  const dataCenter = parts[parts.length - 1];
  if (!dataCenter) {
    throw new Error("Unable to parse Mailchimp datacenter from API key.");
  }
  return dataCenter;
}

function buildAuthHeader(apiKey) {
  const encoded = Buffer.from(`readonly:${apiKey}`).toString("base64");
  return `Basic ${encoded}`;
}

async function requestReadOnly(url, apiKey, method = "GET") {
  const upperMethod = method.toUpperCase();
  if (DISALLOWED_HTTP_METHODS.has(upperMethod)) {
    throw new Error(`Blocked unsafe HTTP method: ${upperMethod}. This app is read-only.`);
  }
  if (upperMethod !== "GET") {
    throw new Error(`Only GET is allowed. Received: ${upperMethod}`);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: buildAuthHeader(apiKey),
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailchimp API error ${response.status}: ${body}`);
  }
  return response.json();
}

export async function getAutomationsReadOnly(apiKey, count = 1000) {
  const dataCenter = parseDataCenterFromApiKey(apiKey);
  const baseUrl = `https://${dataCenter}.api.mailchimp.com/3.0`;

  const workflowResp = await requestReadOnly(
    `${baseUrl}/automations?count=${encodeURIComponent(String(count))}`,
    apiKey
  );

  const workflows = workflowResp.automations ?? [];

  const enriched = [];
  let totalEmails = 0;
  for (const workflow of workflows) {
    const workflowId = workflow.id;
    let emails = [];
    if (workflowId) {
      const emailResp = await requestReadOnly(
        `${baseUrl}/automations/${encodeURIComponent(workflowId)}/emails?count=1000`,
        apiKey
      );
      emails = emailResp.emails ?? [];
    }

    totalEmails += Array.isArray(emails) ? emails.length : 0;
    enriched.push({
      id: workflow.id,
      title: workflow.title,
      create_time: workflow.create_time,
      start_time: workflow.start_time,
      status: workflow.status,
      trigger_settings: workflow.trigger_settings,
      emails: emails.map((email) => ({
        id: email.id,
        workflow_id: email.workflow_id,
        title: email.title,
        status: email.status,
        delay: email.delay,
        send_time: email.send_time,
        content_type: email.content_type,
        recipients: email.recipients,
        settings: email.settings
      }))
    });
  }

  return {
    total_items: workflowResp.total_items ?? workflows.length,
    total_emails: totalEmails,
    workflows: enriched
  };
}

function truncateString(s, maxLen) {
  const str = String(s ?? "");
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `…(tronqué ${str.length - maxLen} caractères)`;
}

function truncateDeep(value, { maxLen = 8000, maxDepth = 4 } = {}, depth = 0) {
  if (depth > maxDepth) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncateString(value, maxLen);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    // Keep array size bounded to reduce prompt size.
    const maxItems = 25;
    return value.slice(0, maxItems).map((v) => truncateDeep(v, { maxLen, maxDepth }, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value);
    const maxKeys = 30;
    for (const [k, v] of entries.slice(0, maxKeys)) {
      out[k] = truncateDeep(v, { maxLen, maxDepth }, depth + 1);
    }
    return out;
  }

  return String(value);
}

function isScheduledCandidate(campaign) {
  const status = String(campaign?.status || "").toLowerCase();
  // Mailchimp uses values like "schedule" for scheduled campaigns (but we allow a fuzzy match).
  return status === "schedule" || status === "scheduled" || status.includes("sched");
}

function pickCampaignSendTime(campaign) {
  return (
    campaign?.send_time ||
    campaign?.scheduled_time ||
    campaign?.schedule_time ||
    campaign?.settings?.send_time ||
    campaign?.settings?.schedule_time ||
    campaign?.settings?.scheduled_time ||
    null
  );
}

function timingFields(campaign) {
  return {
    status: campaign?.status ?? null,
    send_time: campaign?.send_time ?? null,
    scheduled_time: campaign?.scheduled_time ?? null,
    schedule_time: campaign?.schedule_time ?? null,
    settings_send_time: campaign?.settings?.send_time ?? null,
    settings_scheduled_time: campaign?.settings?.scheduled_time ?? null,
    settings_schedule_time: campaign?.settings?.schedule_time ?? null
  };
}

function extractTimeLikeKeys(obj, { maxKeys = 60, depth = 3 } = {}) {
  const out = {};
  const visited = new Set();
  const isObject = (v) => v && typeof v === "object";
  const matches = (key) => /time/i.test(key) || /schedule/i.test(key);

  function walk(value, prefix, d) {
    if (d > depth) return;
    if (!isObject(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (matches(k)) {
        // keep value small
        out[p] = typeof v === "string" ? v.slice(0, 200) : v;
      }
      if (typeof out === "object" && Object.keys(out).length >= maxKeys) return;
      if (isObject(v)) walk(v, p, d + 1);
    }
  }

  walk(obj, "", 0);
  return out;
}

export async function getScheduledCampaignsReadOnly(apiKey, count = 200, maxCampaignsToAudit = 30) {
  const dataCenter = parseDataCenterFromApiKey(apiKey);
  const baseUrl = `https://${dataCenter}.api.mailchimp.com/3.0`;
  const now = Date.now();
  const totalToScan = Math.max(1, Number(count || 200));
  const pageSize = Math.min(100, totalToScan);
  const campaigns = [];
  let offset = 0;
  while (campaigns.length < totalToScan) {
    const remaining = totalToScan - campaigns.length;
    const thisCount = Math.min(pageSize, remaining);
    const resp = await requestReadOnly(
      `${baseUrl}/campaigns?count=${encodeURIComponent(String(thisCount))}&offset=${encodeURIComponent(String(offset))}&sort_field=create_time&sort_dir=DESC`,
      apiKey
    );
    const page = resp.campaigns ?? [];
    if (!page.length) break;
    campaigns.push(...page);
    offset += page.length;
    if (page.length < thisCount) break;
  }

  const statusCounts = {};
  let listHasSendTime = 0;
  for (const c of campaigns) {
    const st = String(c?.status || "unknown").toLowerCase();
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (pickCampaignSendTime(c)) listHasSendTime += 1;
  }

  // Candidate selection: scheduled campaigns AND drafts (save).
  // Sent/archived/cancelled are excluded (already delivered or abandoned).
  const excluded = new Set(["sent", "archive", "archived", "canceled", "cancelled", "cancel"]);
  const candidatesForDetail = campaigns.filter((c) => {
    const st = String(c?.status || "").toLowerCase();
    if (excluded.has(st)) return false;
    return st === "schedule" || st === "scheduled" || st.includes("sched") || st === "save";
  });

  const maxCandidatesToDetail = Number(process.env.MAILCHIMP_MAX_CAMPAIGNS_TO_DETAIL || "200");
  const toDetail = candidatesForDetail.slice(0, maxCandidatesToDetail);

  const items = [];
  let candidatesWithSendTimeAfterDetail = 0;
  let candidatesAudited = 0;
  const debugSamples = [];
  for (const c of toDetail) {
    if (!c?.id) continue;

    const campaignInfo = await requestReadOnly(`${baseUrl}/campaigns/${encodeURIComponent(c.id)}`, apiKey);
    const sendTime = pickCampaignSendTime(campaignInfo) || pickCampaignSendTime(c);
    const statusDetail = String(campaignInfo?.status ?? c?.status ?? "").toLowerCase();

    if (debugSamples.length < 3) {
      debugSamples.push({
        id: c.id,
        name: campaignInfo?.settings?.title || campaignInfo?.settings?.subject_line || c.settings?.title || c.settings?.subject_line || null,
        listTiming: timingFields(c),
        detailTiming: timingFields(campaignInfo),
        computedSendTime: sendTime
      });
    }

    const isDraft = statusDetail === "save";
    const isScheduled = statusDetail === "schedule" || statusDetail === "scheduled" || statusDetail.includes("sched");

    if (!isDraft && !isScheduled) continue;

    // For scheduled campaigns: require a future send_time.
    if (isScheduled && sendTime) {
      const sendTs = Date.parse(String(sendTime));
      const isFuture = Number.isFinite(sendTs) && sendTs > now;
      if (!isFuture) continue;
    }

    if (isScheduled) candidatesWithSendTimeAfterDetail += 1;

    const contentResp = await requestReadOnly(
      `${baseUrl}/campaigns/${encodeURIComponent(c.id)}/content`,
      apiKey
    ).catch(() => ({}));
    const content = contentResp ?? {};

    items.push({
      type: isDraft ? "draft_campaign" : "scheduled_campaign",
      id: c.id,
      name: campaignInfo?.settings?.title || campaignInfo?.settings?.subject_line || c.settings?.title || c.settings?.subject_line || c.name || c.title || null,
      status: campaignInfo?.status ?? c.status,
      send_time: sendTime || null,
      settings: truncateDeep(campaignInfo?.settings ?? c.settings, { maxLen: 2000, maxDepth: 3 }),
      content: truncateDeep(
        {
          html: content?.html,
          plain_text: content?.plain_text,
          subject: content?.subject ?? campaignInfo?.settings?.subject_line ?? c?.settings?.subject_line,
          ...content
        },
        { maxLen: 6000, maxDepth: 3 }
      )
    });

    candidatesAudited += 1;
    if (candidatesAudited >= maxCampaignsToAudit) break;
  }

  return {
    total_campaigns_fetched: campaigns.length,
    total_campaigns_candidates_for_detail: candidatesForDetail.length,
    list_has_send_time: listHasSendTime,
    status_breakdown: statusCounts,
    scheduled_campaigns_after_detail: candidatesWithSendTimeAfterDetail,
    campaigns: items,
    debug_save_campaign_samples: debugSamples
  };
}

export async function probeAutomationFlowsListEndpointsReadOnly(apiKey, count = 20) {
  const dataCenter = parseDataCenterFromApiKey(apiKey);
  const baseUrl = `https://${dataCenter}.api.mailchimp.com/3.0`;

  const candidates = [
    `/customer-journeys/journeys?count=${encodeURIComponent(String(count))}`,
    `/customer-journeys/journeys`,
    `/journeys?count=${encodeURIComponent(String(count))}`,
    `/automation-flows/journeys?count=${encodeURIComponent(String(count))}`,
    `/automation-flows/flows?count=${encodeURIComponent(String(count))}`,
    `/automation-flows/flows`
  ];

  const results = [];
  for (const p of candidates) {
    const url = `${baseUrl}${p}`;
    try {
      const json = await requestReadOnly(url, apiKey, "GET");
      results.push({
        path: p,
        ok: true,
        // Keep payload small
        keys: json && typeof json === "object" ? Object.keys(json).slice(0, 30) : typeof json,
        sample: Array.isArray(json?.journeys)
          ? json.journeys.slice(0, 3)
          : json?.automations?.slice
            ? json.automations.slice(0, 3)
            : json?.flows?.slice
              ? json.flows.slice(0, 3)
              : null
      });
    } catch (e) {
      results.push({
        path: p,
        ok: false,
        error: e?.message || String(e)
      });
    }
  }

  return { results };
}

async function tryRequestReadOnly(url, apiKey) {
  try {
    const json = await requestReadOnly(url, apiKey, "GET");
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function getArrayFromPossible(obj) {
  if (!obj || typeof obj !== "object") return [];
  const candidates = ["journeys", "flows", "automations", "items"];
  for (const k of candidates) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

export async function getAutomationFlowsReadOnly(apiKey, count = 200, maxFlowsToAudit = 20) {
  const dataCenter = parseDataCenterFromApiKey(apiKey);
  const baseUrl = `https://${dataCenter}.api.mailchimp.com/3.0`;

  // Try a few plausible list endpoints.
  const listPaths = [
    `/customer-journeys/journeys?count=${encodeURIComponent(String(count))}`,
    `/customer-journeys/journeys`,
    `/journeys?count=${encodeURIComponent(String(count))}`,
    `/automation-flows/journeys?count=${encodeURIComponent(String(count))}`,
    `/automation-flows/flows?count=${encodeURIComponent(String(count))}`,
    `/automation-flows/flows`
  ];

  let journeys = [];
  const listProbe = [];

  for (const p of listPaths) {
    const url = `${baseUrl}${p}`;
    const result = await tryRequestReadOnly(url, apiKey);
    if (result.ok) {
      const arr = getArrayFromPossible(result.json);
      journeys = arr;
      listProbe.push({ path: p, ok: true, sampleCount: arr.length });
      if (arr.length) break;
    } else {
      listProbe.push({ path: p, ok: false, error: result.error });
    }
  }

  const selected = journeys.slice(0, maxFlowsToAudit);
  const flows = [];

  for (const j of selected) {
    const id = j?.id;
    if (!id) continue;

    // Try to get full details (may include steps/actions).
    const detailPaths = [
      `/customer-journeys/journeys/${encodeURIComponent(id)}`,
      `/journeys/${encodeURIComponent(id)}`,
      `/automation-flows/journeys/${encodeURIComponent(id)}`,
      `/automation-flows/flows/${encodeURIComponent(id)}`
    ];

    let detail = null;
    for (const dp of detailPaths) {
      const url = `${baseUrl}${dp}`;
      const r = await tryRequestReadOnly(url, apiKey);
      if (r.ok) {
        detail = r.json;
        break;
      }
    }

    // Also try steps list if detail didn't include them.
    const stepsCandidates = [];
    const stepsPaths = [
      `/customer-journeys/journeys/${encodeURIComponent(id)}/steps?count=200`,
      `/customer-journeys/journeys/${encodeURIComponent(id)}/steps`,
      `/journeys/${encodeURIComponent(id)}/steps?count=200`,
      `/journeys/${encodeURIComponent(id)}/steps`,
      `/automation-flows/journeys/${encodeURIComponent(id)}/steps?count=200`,
      `/automation-flows/journeys/${encodeURIComponent(id)}/steps`
    ];

    const stepsFromDetail = detail ? (Array.isArray(detail?.steps) ? detail.steps : getArrayFromPossible(detail)) : [];
    if (Array.isArray(stepsFromDetail) && stepsFromDetail.length) {
      stepsCandidates.push({ source: "detail", count: stepsFromDetail.length });
      // we will include in truncated detail anyway
    } else {
      for (const sp of stepsPaths) {
        const url = `${baseUrl}${sp}`;
        const r = await tryRequestReadOnly(url, apiKey);
        if (r.ok) {
          const stepsArr = getArrayFromPossible(r.json);
          if (stepsArr.length) {
            stepsCandidates.push({ source: sp, count: stepsArr.length });
            // keep stepsArr separately if needed
            detail = { ...(detail ?? {}), steps: stepsArr };
            break;
          }
        } else {
          // ignore
        }
      }
    }

    flows.push({
      type: "automation_flow",
      id,
      title: j?.title ?? j?.name ?? detail?.title ?? detail?.name ?? null,
      status: j?.status ?? detail?.status ?? null,
      create_time: j?.create_time ?? detail?.create_time ?? null,
      start_time: j?.start_time ?? detail?.start_time ?? null,
      raw: truncateDeep(detail ?? j, { maxLen: 8000, maxDepth: 5 }),
      debug_steps_sources: stepsCandidates
    });
  }

  return {
    total_flows_fetched: journeys.length,
    total_flows_selected: selected.length,
    list_probe: listProbe,
    flows
  };
}
