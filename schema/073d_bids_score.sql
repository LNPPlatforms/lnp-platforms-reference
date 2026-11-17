-- 073d: bids, part 3. The go/no-go score. Each account picks what matters and ranks each one 1, 2 or 3.
-- Rank becomes weight: rank 1 counts 3 times, rank 2 twice, rank 3 once. Each answered metric gets 1 to 5 points:
--   value     job size in dollars, more is better (good at or above "good", poor at or below "poor", straight line between)
--   distance  miles from the account's base to the bid site (haversine), closer is better
--   margin    expected margin in percent, more is better
--   lead_time days from when the bid came in to when it's due, more is better
--   crew      crew free in the work window: 5 yes, 3 tight, 1 no (someone answers it)
--   yesno     a custom yes or no question (yes_good says which answer is the good one)
--   scale     a custom 1 to 5 question
-- Score = 100 x sum(weight x (points - 1) / 4) / sum(weight), over the metrics that have an answer.
-- Result: go at or above go_at, maybe at or above maybe_at, otherwise no-go. Nothing answered: no score yet.

create or replace function private.bid_miles(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    round((3958.7613 * 2 * asin(least(1, sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))))::numeric, 1) end
$$;

-- 1 to 5 on a straight line from poor to good (works both ways: for distance good is the smaller number)
create or replace function private.bid_points(v numeric, good numeric, poor numeric) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select case when v is null or good is null or poor is null then null
              when good = poor then case when (good >= 0 and v >= good) then 5 else 1 end
              else 1 + 4 * greatest(0, least(1, (v - poor) / (good - poor))) end
$$;

create or replace function private.bid_score(p_set private.bid_settings, b public.bids) returns jsonb
language plpgsql stable set search_path = public, private as $$
declare m jsonb; w int; pts numeric; v numeric; a text; tot numeric := 0; wsum int := 0; parts jsonb := '[]'::jsonb; sc numeric; res text;
  defs jsonb := '{"value":[50000,5000],"distance":[25,100],"margin":[30,10],"lead_time":[14,3]}';
begin
  if p_set.tenant_id is null then return jsonb_build_object('score', null, 'result', null, 'parts', '[]'::jsonb); end if;
  for m in select e from jsonb_array_elements(coalesce(p_set.metrics, '[]'::jsonb)) e loop
    if coalesce((m->>'off')::boolean, false) then continue; end if;
    w := 4 - greatest(1, least(3, coalesce((m->>'rank')::int, 2)));
    a := nullif(b.answers->>(m->>'key'), '');
    v := case m->>'kind'
      when 'value' then b.est_value
      when 'distance' then b.distance_mi
      when 'margin' then b.est_margin
      when 'lead_time' then case when b.due_at is not null then (b.due_at::date - coalesce(b.created_at, now())::date) end
      when 'crew' then case a when 'yes' then 5 when 'tight' then 3 when 'no' then 1 end
      when 'yesno' then case when a in ('yes', 'no') then case when (a = 'yes') = coalesce((m->>'yes_good')::boolean, true) then 5 else 1 end end
      when 'scale' then case when a ~ '^[1-5]$' then a::numeric end
    end;
    pts := case when m->>'kind' in ('value', 'distance', 'margin', 'lead_time')
      then private.bid_points(v, coalesce((m->>'good')::numeric, (defs->(m->>'kind')->>0)::numeric), coalesce((m->>'poor')::numeric, (defs->(m->>'kind')->>1)::numeric))
      else v end;
    if pts is not null then tot := tot + w * (pts - 1) / 4; wsum := wsum + w; end if;
    parts := parts || jsonb_build_array(jsonb_build_object('key', m->>'key', 'kind', m->>'kind', 'label', m->>'label', 'rank', 4 - w, 'weight', w,
      'value', case when m->>'kind' in ('value', 'distance', 'margin', 'lead_time') then to_jsonb(v) else to_jsonb(a) end, 'points', round(pts, 2)));
  end loop;
  if wsum > 0 then
    sc := round(100 * tot / wsum, 1);
    res := case when sc >= p_set.go_at then 'go' when sc >= p_set.maybe_at then 'maybe' else 'no_go' end;
  end if;
  return jsonb_build_object('score', sc, 'result', res, 'parts', parts);
end $$;
revoke execute on function private.bid_score(private.bid_settings, public.bids), private.bid_points(numeric, numeric, numeric) from public, anon, authenticated;

