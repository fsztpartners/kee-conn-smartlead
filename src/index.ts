// Smartlead — a keemakr marketplace connector.
//
// Smartlead v1 API quirks this code encodes:
//   - Auth is an `api_key` QUERY PARAMETER on every URL — no header auth.
//   - GET /campaigns returns a direct array with NO pagination (Smartlead
//     support recommends client-side filtering).
//   - Lead import de-dupes server-side (already_added_to_campaign in the
//     summary), so leads.add is idempotent at the campaign level. The old
//     ignore_duplicate_leads_in_campaign setting now 400s if sent.
//   - The analytics response schema is undocumented — returned as-is (opaque).

import { defineProvider, OperationError } from '@keemakr/operator-sdk';
import { z } from 'zod';

const BASE = 'https://server.smartlead.ai/api/v1';

function url(path: string, apiKey: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE}${path}${sep}api_key=${encodeURIComponent(apiKey)}`;
}

// Map a Smartlead HTTP status to the platform error taxonomy.
function opError(status: number, path: string): OperationError {
  if (status === 401 || status === 403) {
    return new OperationError(`smartlead rejected the API key (${status}) on ${path}`, 401, 'auth_revoked');
  }
  if (status === 429) {
    return new OperationError(`smartlead rate limit hit on ${path}`, 429, 'rate_limited');
  }
  if (status >= 500) {
    return new OperationError(`smartlead answered ${status} on ${path}`, 502, 'provider_unavailable');
  }
  return new OperationError(`smartlead answered ${status} on ${path}`, status, 'connector_error');
}

type Ctx = { fetch: typeof fetch } | undefined;

async function call(ctx: Ctx, apiKey: string, path: string, init?: RequestInit): Promise<unknown> {
  if (!ctx) throw new OperationError('no execution context', 500, 'connector_error');
  const res = await ctx.fetch(url(path, apiKey), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw opError(res.status, path);
  return res.json().catch(() => ({}));
}

const leadSchema = z.object({
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  custom_fields: z.record(z.string(), z.string()).optional(),
});

export const provider = defineProvider({
  provider: 'smartlead',
  displayName: 'Smartlead',
  authKind: 'api_key',
  category: 'email',
  publisher: 'keemakr',
  allowedDomains: ['server.smartlead.ai'],

  connectFields: [{ target: 'access_token', label: 'Smartlead API key', secret: true }],

  // Validate-on-save: the cheapest authenticated read. Bad key → clean {ok:false}.
  async test(cred, ctx) {
    if (!ctx) return { ok: false, detail: 'no execution context' };
    try {
      const res = await ctx.fetch(url('/campaigns', cred.accessToken));
      return res.ok ? { ok: true } : { ok: false, detail: `smartlead answered ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : 'unreachable' };
    }
  },

  operations: {
    'campaigns.list': {
      description: 'List all email campaigns for the connected Smartlead account (id, name, status, schedule).',
      access: 'read',
      idempotent: true,
      inputSchema: z.object({}),
      async call(cred, _args, ctx) {
        const raw = await call(ctx, cred.accessToken, '/campaigns');
        // Project Smartlead's ~25-field campaign objects down to a STABLE shape.
        // Wire ids are numbers — stringified so callers compare without coercion.
        const arr = Array.isArray(raw) ? raw : [];
        return arr
          .filter((c): c is Record<string, unknown> => c != null && (c as Record<string, unknown>).id != null)
          .map((c) => ({
            id: String(c.id),
            name: typeof c.name === 'string' ? c.name : null,
            status: typeof c.status === 'string' ? c.status : null,
            created_at: typeof c.created_at === 'string' ? c.created_at : null,
          }));
      },
    },

    'campaign.create': {
      description: "Create a new (empty) email campaign. Returns Smartlead's raw create-campaign response ({ ok, id, name }). Configure sequence/schedule separately.",
      access: 'write',
      idempotent: false,
      inputSchema: z.object({ name: z.string().min(1).max(200) }),
      async call(cred, args, ctx) {
        return call(ctx, cred.accessToken, '/campaigns/create', {
          method: 'POST',
          body: JSON.stringify({ name: args.name }),
        });
      },
    },

    'campaign.analytics': {
      description: "Fetch a campaign's aggregate analytics (sent, opens, replies, bounces, etc.) by campaign id.",
      access: 'read',
      idempotent: true,
      inputSchema: z.object({ campaign_id: z.union([z.string().trim().min(1), z.number()]) }),
      async call(cred, args, ctx) {
        // Response schema is undocumented by Smartlead — passed through opaque.
        return call(ctx, cred.accessToken, `/campaigns/${encodeURIComponent(String(args.campaign_id))}/analytics`);
      },
    },

    'leads.add': {
      description: 'Import leads into a campaign (max 400 per request). Each lead needs an email; other fields and custom_fields feed the template merge tags.',
      access: 'write',
      idempotent: true,
      inputSchema: z.object({
        campaign_id: z.union([z.string().trim().min(1), z.number()]),
        lead_list: z.array(leadSchema).min(1).max(400),
      }),
      async call(cred, args, ctx) {
        return call(ctx, cred.accessToken, `/campaigns/${encodeURIComponent(String(args.campaign_id))}/leads`, {
          method: 'POST',
          body: JSON.stringify({
            lead_list: args.lead_list,
            settings: { ignore_global_block_list: false },
          }),
        });
      },
    },

    'email-accounts.list': {
      description: 'List the sending email accounts (mailboxes) connected to the Smartlead account, with warmup + health status.',
      access: 'read',
      idempotent: true,
      inputSchema: z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(100),
      }),
      async call(cred, args, ctx) {
        const raw = await call(ctx, cred.accessToken, `/email-accounts/?offset=${args.offset}&limit=${args.limit}`);
        const arr = Array.isArray(raw) ? raw : [];
        return arr
          .filter((a): a is Record<string, unknown> => a != null && (a as Record<string, unknown>).id != null)
          .map((a) => ({
            id: String(a.id),
            from_email: typeof a.from_email === 'string' ? a.from_email : null,
            from_name: typeof a.from_name === 'string' ? a.from_name : null,
            warmup_status: (a.warmup_details as Record<string, unknown> | undefined)?.status ?? null,
            is_smtp_success: typeof a.is_smtp_success === 'boolean' ? a.is_smtp_success : null,
            is_imap_success: typeof a.is_imap_success === 'boolean' ? a.is_imap_success : null,
            daily_sent_count: typeof a.daily_sent_count === 'number' ? a.daily_sent_count : null,
            message_per_day: typeof a.message_per_day === 'number' ? a.message_per_day : null,
          }));
      },
    },
  },
});
