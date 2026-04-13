import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { getAutomationsReadOnly } from "./mailchimpClient.js";
import { runAuditWithOpenAI } from "./audit.js";
import nodeFs from "node:fs";

// Load environment variables from `.env.local` (preferred) or fallback to `.env`.
const envLocalPath = path.resolve(process.cwd(), ".env.local");
const envPath = path.resolve(process.cwd(), ".env");
const chosenPath = nodeFs.existsSync(envLocalPath) ? envLocalPath : envPath;
dotenv.config({ path: chosenPath });

function getArgValue(flag) {
  const index = process.argv.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

function assertReadOnlyMode() {
  const mode = (process.env.MAILCHIMP_MODE || "readonly").toLowerCase();
  if (mode !== "readonly") {
    throw new Error('MAILCHIMP_MODE must remain "readonly". Any other mode is blocked.');
  }
}

async function writeJsonReport(filename, data) {
  const outputDir = path.resolve(process.cwd(), "output");
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

async function main() {
  assertReadOnlyMode();

  const mailchimpApiKey = process.env.MAILCHIMP_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const businessUpdate =
    getArgValue("--update") ??
    "No update provided. Please pass --update \"your company change here\"";

  if (!mailchimpApiKey) {
    throw new Error("Missing MAILCHIMP_API_KEY in environment.");
  }
  if (!openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY in environment.");
  }

  console.log("Reading Mailchimp automations in read-only mode...");
  const automations = await getAutomationsReadOnly(mailchimpApiKey, 1000);
  const snapshotPath = await writeJsonReport("mailchimp-automations-snapshot.json", automations);
  console.log(`Snapshot saved: ${snapshotPath}`);

  console.log("Running OpenAI audit...");
  const audit = await runAuditWithOpenAI({
    openaiApiKey,
    model,
    businessUpdate,
    automations
  });
  const auditPath = await writeJsonReport("mailchimp-audit-report.json", audit);
  console.log(`Audit report saved: ${auditPath}`);

  const issueCount = Array.isArray(audit.issues) ? audit.issues.length : 0;
  console.log(`Done. Detected issues: ${issueCount}`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exitCode = 1;
});
