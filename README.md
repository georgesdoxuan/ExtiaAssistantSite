<<<<<<< HEAD
# ExtiaAssistantSite
=======
# Mailchimp Read-Only Audit

This project reads Mailchimp automations and uses OpenAI to detect potentially outdated automated emails after a business update.

## Safety (Very Important)

- This app is designed to be **read-only**.
- It only performs Mailchimp `GET` requests.
- Any non-read-only mode is blocked.
- It never calls Mailchimp write endpoints (`POST`, `PATCH`, `PUT`, `DELETE`).

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

3. Fill:

- `MAILCHIMP_API_KEY`
- `OPENAI_API_KEY`
- optional `OPENAI_MODEL`

## Usage

### Command line (JSON reports)

Run with your latest company update:

```bash
npm run audit -- --update "We changed pricing and support hours to 24/7."
```

Outputs:

- `output/mailchimp-automations-snapshot.json`
- `output/mailchimp-audit-report.json`

### UI (Next.js)

Start the full app (Express API + Next UI) in one command:

```bash
npm run dev
```

Open:

- `http://localhost:3000`

## Security Note

If API keys were shared in chat or committed by mistake, rotate them immediately in provider dashboards.
>>>>>>> 017efc4 (Initial project import for Extia assistant.)
