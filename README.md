# kee-conn-smartlead

keemakr marketplace connector for [Smartlead](https://smartlead.ai) — cold-email
campaign sequencing. Auth is the tenant's Smartlead API key (query-parameter
auth on Smartlead's side; the key never leaves the platform).

## Operations

| Operation | Access | Returns |
|---|---|---|
| `campaigns.list` | read | `[{ id, name, status, created_at }]` — all campaigns, no pagination (Smartlead has none on this endpoint) |
| `campaign.create` | write | Smartlead's raw create response `{ ok, id, name }` — campaign is created empty; author sequence/schedule in Smartlead |
| `campaign.analytics` | read | Smartlead's aggregate analytics object (undocumented schema, passed through opaque) |
| `leads.add` | write | Smartlead's upload summary (`upload_count`, `already_added_to_campaign`, …) — max 400 leads/request, server-side de-dupe makes it idempotent |
| `email-accounts.list` | read | `[{ id, from_email, from_name, warmup_status, is_smtp_success, is_imap_success, daily_sent_count, message_per_day }]` |

## Develop

```bash
npm install
npx @keemakr/connector-cli lint
npx @keemakr/connector-cli certify   # same suite as the publish gate
# live calls (real key in .kee/fixtures.json: {"accessToken": "..."})
npx @keemakr/connector-cli dev test
npx @keemakr/connector-cli dev campaigns.list '{}'
npx @keemakr/connector-cli pack      # → smartlead.zip
```
