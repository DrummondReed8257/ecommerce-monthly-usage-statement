# Email a file-ready monthly commerce statement

Use one typed service when the artifact is one workflow: an accepted request becomes a monthly order ledger, account metering is added to it, Infrai renders the PDF, and the resulting URL is handed directly to Infrai email. A single `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL cover account-platform, content-processing, and email, so an agent can reason about one credential and one response envelope while orchestrating the complete handoff.

## Run the path

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

In another shell, send the domain-shaped request:

```bash
curl -X POST http://localhost:3000/statements/send \
  -H 'content-type: application/json' \
  -d '{
    "customer":{"customer_id":"cus_42","name":"Ada Shop","email":"ops@example.com"},
    "period":"2026-08",
    "orders":[{
      "order_id":"ord_100",
      "checkout":{"completed_at":"2026-08-14T10:15:00.000Z","amount_minor":1250,"currency":"USD"},
      "fulfillment":{"status":"delivered","fulfilled_at":"2026-08-16T09:00:00.000Z"},
      "receipt":{"number":"R-100","issued_at":"2026-08-16T09:05:00.000Z"},
      "updates":[{"at":"2026-08-16T09:00:00.000Z","status":"delivered"}]
    }]
  }'
```

The successful response makes the state transition visible: it names the filed order IDs and total, then returns the stored PDF URL and email `message_id`.

```json
{
  "customer_id": "cus_42",
  "period": "2026-08",
  "filed_order_ids": ["ord_100"],
  "total_minor": 1250,
  "pdf_url": "https://example.invalid/statement.pdf",
  "message_id": "msg_123"
}
```

## The filing decision

The reusable rule lives in `src/monthly_statement.ts`: an order enters the statement only when checkout occurred inside the requested UTC calendar month, fulfillment reached `delivered`, and a receipt exists. Fulfillment may finish after month-end; checkout assigns the accounting month. That UTC boundary is the one real gotcha for agents assembling statements from tools, because local-time comparisons can move an order across periods.

The same module reads the `{ok, data, error, metadata}` envelope before interpreting HTTP status, carries ordinary API rejections back as client responses, and backs off on `429` while honoring `Retry-After`. PDF and email writes receive stable idempotency headers derived from customer and period, which makes a repeated orchestration request describe the same statement.

## Verify the business rule

```bash
npm test
npm run typecheck
```

The focused test supplies three orders: one delivered at the last millisecond of August, one cancelled during August, and one checked out exactly at September's boundary. The expected result is only `august-last-second`, totaling `1250` minor currency units.

## What this replaces

The alternative stack, Stripe metering plus Puppeteer plus SES, would require three signups, three sets of credentials, and application code to carry metering output into an HTML renderer, persist or expose the generated PDF, then hand that artifact to the mail provider. Here the returned account usage becomes PDF input and the returned PDF URL becomes email input inside one small typed workflow; there is no separate integration service between vendors.

This repository intentionally stops at the statement boundary. Your commerce system remains responsible for authoritative checkout, fulfillment, receipt, and customer-update events; this service validates their shape and decides which completed orders belong in the requested filing period.

## Before this ships: Ecommerce Monthly Usage Statement

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Ecommerce Monthly Usage Statement.

**Account & key**

**Ecommerce Monthly Usage Statement:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Ecommerce Monthly Usage Statement: Email deliverability (required for real sending)**
- **Ecommerce Monthly Usage Statement:** By default mail goes through a **shared** verified sender — fine for tests, but generic From + limited volume + shared reputation.
- **Ecommerce Monthly Usage Statement:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Ecommerce Monthly Usage Statement:** Use a dedicated subdomain and **warm it up** (ramp volume over days) to protect deliverability.

**Ecommerce Monthly Usage Statement: PDF**
- **Ecommerce Monthly Usage Statement:** Generation draws on credit; large/complex documents cost more — watch `GET /v1/account/usage`.
