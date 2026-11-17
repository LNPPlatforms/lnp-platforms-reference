-- 069a: invoices, part 1. The Invoices role area, document settings per account (numbers, tax, item codes,
-- company info for the footer) and the payment processor each account connects (Stripe Connect or a pasted link).
-- Decisions: BACKLOG.md "Waiting on Chris" (document layout) and "Oct 30 morning voice decisions" (payments).

create or replace function private.perm_areas() returns text[] language sql immutable set search_path = pg_catalog as $$
  select array['contacts', 'sales', 'proposals', 'inbox', 'sites', 'jobs', 'dispatch', 'timeclock', 'costs', 'pay', 'review', 'reports', 'settings', 'team',
               'automations', 'marketing', 'templates', 'media', 'invoices']
$$;

create or replace function private.area_default(p_preset text, area text) returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(case area
    when 'automations' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":2,"scope":"division"}' end
    when 'marketing' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":2,"scope":"division"}' when 'sales_rep' then '{"level":2,"scope":"own"}' end
    when 'templates' then case p_preset when 'manager' then '{"level":3,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}' when 'accounting' then '{"level":2,"scope":"all"}' else '{"level":2,"scope":"own"}' end
    when 'media' then case p_preset when 'manager' then '{"level":3,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}' when 'accounting' then '{"level":1,"scope":"all"}' else '{"level":2,"scope":"own"}' end
    when 'invoices' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}'
      when 'accounting' then '{"level":4,"scope":"all"}' when 'sales_rep' then '{"level":2,"scope":"own"}' end
  end, '{"level":0,"scope":"own"}')::jsonb
$$;

-- one row per account: how its documents look and number
create table if not exists private.doc_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  show_item_code boolean not null default false,
  show_tax boolean not null default false,               -- tax is always figured per line; this only shows the column
  default_tax_rate numeric(6,3) not null default 0 check (default_tax_rate between 0 and 100),
  due_days int not null default 30 check (due_days between 0 and 365),
  prefix text not null default '' check (length(prefix) <= 10),
  next_number bigint not null default 1001 check (next_number between 1 and 999999999),
  company jsonb not null default '{}'::jsonb,            -- {name, address, phone, email} for the header and footer
  notes text, terms text, pay_instructions text,
  pay_link text check (pay_link is null or pay_link ~ '^https://'),   -- fallback processor: Square, PayPal, any link
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table private.doc_settings enable row level security;

-- Stripe Connect (Standard accounts, no platform fee). The account id isn't a secret but stays private anyway.
create table if not exists private.pay_processors (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stripe_account_id text,
  stripe_ready boolean not null default false,          -- charges_enabled on the connected account
  stripe_name text,
  connected_by uuid, connected_at timestamptz, checked_at timestamptz
);
alter table private.pay_processors enable row level security;

-- how this account's customers pay: 'stripe' (own connected Stripe), 'platform' (GELP's own Stripe, GELP's account only,
-- same switch as proposals), 'link' (pasted link) or null (no pay button at all)
create or replace function private.pay_method(p_tenant uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select case
    when exists (select 1 from private.pay_processors where tenant_id = p_tenant and stripe_ready and stripe_account_id is not null) then 'stripe'
    when private.pay_on(p_tenant) then 'platform'
    when exists (select 1 from private.doc_settings where tenant_id = p_tenant and pay_link is not null) then 'link'
  end
$$;
revoke execute on function private.pay_method(uuid) from public, anon, authenticated;

create or replace function private.can_doc_settings() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_admin() or private.can('settings', 4) or private.can('invoices', 4)
$$;

create or replace function public.doc_settings_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then
    coalesce((select to_jsonb(d) - 'tenant_id' from private.doc_settings d where d.tenant_id = private.current_tenant()),
             jsonb_build_object('show_item_code', false, 'show_tax', false, 'default_tax_rate', 0, 'due_days', 30, 'prefix', '', 'next_number', 1001,
               'company', jsonb_build_object('name', (select name from tenants where id = private.current_tenant())), 'notes', null, 'terms', null, 'pay_instructions', null, 'pay_link', null))
    || jsonb_build_object('can_edit', private.can_doc_settings(), 'pay_method', private.pay_method(private.current_tenant()),
       'stripe', (select jsonb_build_object('account', stripe_account_id is not null, 'ready', stripe_ready, 'name', stripe_name, 'checked_at', checked_at)
                    from private.pay_processors where tenant_id = private.current_tenant()))
  end
$$;

create or replace function public.doc_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); c jsonb := coalesce(p->'company', '{}'::jsonb); link text := nullif(trim(coalesce(p->>'pay_link', '')), '');
begin
  if not private.can_doc_settings() then raise exception 'Your role can''t change invoice settings'; end if;
  if link is not null and link !~ '^https://[^\s]+$' then raise exception 'The payment link needs to start with https://'; end if;
  if coalesce((p->>'default_tax_rate')::numeric, 0) not between 0 and 100 then raise exception 'Tax runs from 0 to 100 percent'; end if;
  if coalesce((p->>'due_days')::int, 30) not between 0 and 365 then raise exception 'Due in 0 to 365 days'; end if;
  if coalesce((p->>'next_number')::bigint, 1001) < 1 then raise exception 'The next number has to be 1 or more'; end if;
  if coalesce((p->>'next_number')::bigint, 1001) <= coalesce((select max(number) from invoices where tenant_id = t), 0) then
    raise exception 'The next number has to be higher than your last invoice number';
  end if;
  insert into private.doc_settings as d (tenant_id, show_item_code, show_tax, default_tax_rate, due_days, prefix, next_number, company, notes, terms, pay_instructions, pay_link, updated_at, updated_by)
  values (t, coalesce((p->>'show_item_code')::boolean, false), coalesce((p->>'show_tax')::boolean, false), coalesce((p->>'default_tax_rate')::numeric, 0),
    coalesce((p->>'due_days')::int, 30), left(trim(coalesce(p->>'prefix', '')), 10), coalesce((p->>'next_number')::bigint, 1001),
    jsonb_build_object('name', left(trim(coalesce(c->>'name', '')), 120), 'address', left(trim(coalesce(c->>'address', '')), 300),
      'phone', left(trim(coalesce(c->>'phone', '')), 40), 'email', left(trim(coalesce(c->>'email', '')), 120)),
    nullif(left(trim(coalesce(p->>'notes', '')), 4000), ''), nullif(left(trim(coalesce(p->>'terms', '')), 8000), ''),
    nullif(left(trim(coalesce(p->>'pay_instructions', '')), 2000), ''), link, now(), auth.uid())
  on conflict (tenant_id) do update set show_item_code = excluded.show_item_code, show_tax = excluded.show_tax, default_tax_rate = excluded.default_tax_rate,
    due_days = excluded.due_days, prefix = excluded.prefix, next_number = excluded.next_number, company = excluded.company, notes = excluded.notes,
    terms = excluded.terms, pay_instructions = excluded.pay_instructions, pay_link = excluded.pay_link, updated_at = now(), updated_by = auth.uid();
  return public.doc_settings_get();
end $$;
revoke execute on function public.doc_settings_get(), public.doc_settings_save(jsonb), private.can_doc_settings() from public, anon;
grant execute on function public.doc_settings_get(), public.doc_settings_save(jsonb), private.can_doc_settings() to authenticated;
