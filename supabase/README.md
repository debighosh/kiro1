# Supabase

Supabase project scaffold for **MSS LivePulse**. This directory holds the local
development configuration, database migrations, seed data, and Edge Functions
for the Supabase managed backend (PostgreSQL + RLS, Realtime, Auth, Edge
Functions). See `.kiro/specs/mss-livepulse/design.md` → *Architecture (Supabase
managed services)* and *Migrations and seed data*.

## Layout

```
supabase/
├── config.toml       # Local-dev configuration (ports, auth = admin-only, etc.)
├── seed.sql          # Demo seed data — placeholder; populated in task 9.1
├── migrations/       # SQL migrations — added in tasks 4.x / 5.x
└── functions/        # Edge Functions — implemented in tasks 7.2 / 7.3
```

## Local development

The [Supabase CLI](https://supabase.com/docs/guides/cli) drives the local stack:

```bash
supabase start        # boot the local Postgres + Auth + Realtime + Studio stack
supabase db reset     # re-run all migrations, then apply seed.sql
supabase functions serve  # run Edge Functions locally (once implemented)
```

> This scaffold was laid out to match the standard Supabase project structure.
> `migrations/` and `functions/` are currently empty (tracked via `.gitkeep`)
> and are filled in by later implementation tasks.
