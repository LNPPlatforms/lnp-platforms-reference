-- 083: not every organization is a lead. Each account picks which organization types start in Lead when they're added
-- (Settings > Pipelines). Accounts that never set it keep the old rule (everything except a lone Referral Partner).

-- account_settings_save learns pipeline_types: a list of organization type names. Swaps one line of the live function.
do $$
declare d text; b text;
  old_ text := $q$    else raise exception 'Unknown setting %', k;$q$;
  new_ text := $q$    elsif k = 'pipeline_types' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 50
         or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string' or length(e #>> '{}') not between 1 and 60) then
        raise exception 'Pick organization types for the pipeline';
      end if;
      clean := clean || jsonb_build_object(k, v);
    else raise exception 'Unknown setting %', k;$q$;
begin
  d := replace(pg_get_functiondef('public.account_settings_save(jsonb)'::regprocedure), E'\r\n', E'\n');
  if position($q$elsif k = 'pipeline_types' then$q$ in d) > 0 then return; end if;
  b := d; d := replace(d, old_, new_);
  if d = b then raise exception 'pipeline_types settings patch did not match'; end if;
  execute d;
end $$;

-- new organizations start in the default pipeline's Lead stage only when one of their types is on the account's list
create or replace function private.company_stage() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare types jsonb;
begin
  if tg_op = 'INSERT' and new.pipeline_stage_id is null then
    select settings->'pipeline_types' into types from account_settings where tenant_id = new.tenant_id;
    if (types is null and not ('Referral Partner' = any(coalesce(new.org_types, '{}')) and coalesce(array_length(new.org_types, 1), 0) = 1))
       or (jsonb_typeof(types) = 'array' and exists (select 1 from jsonb_array_elements_text(types) t where t = any(coalesce(new.org_types, '{}')))) then
      select s.id into new.pipeline_stage_id from pipeline_stages s join pipelines p on p.id = s.pipeline_id
       where p.tenant_id = new.tenant_id and p.is_default and p.archived_at is null and s.system_key = 'lead';
    end if;
  end if;
  if new.pipeline_stage_id is not null and not exists (select 1 from pipeline_stages where id = new.pipeline_stage_id and tenant_id = new.tenant_id) then
    raise exception 'That stage belongs to a different account';
  end if;
  if tg_op = 'INSERT' or new.pipeline_stage_id is distinct from old.pipeline_stage_id then new.stage_changed_at := now(); end if;
  return new;
end $$;
