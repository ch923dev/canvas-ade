-- Phase 1 accounts — identity + (forward-looking) subscription tables.
--
-- WorkOS owns authentication entirely (PKCE, in the Electron main process). These tables are the
-- ENTITLEMENT bridge the `license` Edge Function reads. Phase 1: the function returns plan='free'
-- for any verified user and needs NO row here. Phase 2 (Stripe): webhooks upsert `subscriptions`
-- and the function returns the real plan/status.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  workos_user_id text unique not null,
  email text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  workos_user_id text primary key,
  plan text not null default 'free',
  status text not null default 'none',
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  updated_at timestamptz not null default now()
);

-- RLS: these tables are read/written ONLY by the service-role (Edge Functions now; Phase 2 Stripe
-- webhooks later) — never by an end-user anon key. Enable RLS with NO public policies so the anon
-- key can't touch them; the service-role key bypasses RLS. (The Phase 1 `license` function doesn't
-- even query these — it returns 'free' off a verified token — so no service-role is wired yet.)
alter table public.users enable row level security;
alter table public.subscriptions enable row level security;
