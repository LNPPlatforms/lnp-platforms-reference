-- 065 and 066: templates, timeline and lead source, automations, links, webhooks. Run with tests/run_db.sh tests/grow_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a0000000-0000-0000-0000-000000000001', 'Acme', 'acme'), ('a0000000-0000-0000-0000-000000000002', 'Other', 'other');
insert into app_users (id, full_name, email, tenant_id, is_admin) values
  ('b0000000-0000-0000-0000-000000000001', 'Ann Admin', 'ann@x.com', 'a0000000-0000-0000-0000-000000000001', true),
  ('b0000000-0000-0000-0000-000000000002', 'Ray Rep', 'ray@x.com', 'a0000000-0000-0000-0000-000000000001', false),
  ('b0000000-0000-0000-0000-000000000003', 'Oz Other', 'oz@x.com', 'a0000000-0000-0000-0000-000000000002', true);
-- Ray is a sales rep
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
insert into roles (id, tenant_id, name, preset_key, perms) values ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Sales rep', 'sales_rep',
  public.role_presets()->'sales_rep'->'perms');
update app_users set role_id = 'c0000000-0000-0000-0000-000000000001' where id = 'b0000000-0000-0000-0000-000000000002';

-- templates: Ray can save personal, not company
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000002', false);
select public.template_save(null, '{"name":"My hi","body":"Hi {contact.first_name}","scope":"personal"}') is not null as ray_personal;
do $$ begin perform public.template_save(null, '{"name":"Co","body":"x","scope":"company"}'); raise exception 'ray published'; exception when others then
  if sqlerrm = 'ray published' then raise; end if; end $$;
select count(*) >= 10 as sees_starters from templates;
-- Ray can't share a Shortcut
do $$ begin insert into shortcuts (screen, name, shared) values ('contacts', 'x', true); raise exception 'ray shared'; exception when others then
  if sqlerrm = 'ray shared' then raise; end if; end $$;

-- Ann: company template, automation, link, hook
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
select public.template_save(null, '{"name":"Welcome","kind":"email","subject":"Welcome {contact.first_name}","body":"Hi {contact.first_name} from {account.name}","scope":"company"}') as tpl \gset
select count(*) = 2 as ray_template_hidden_from_ann_no from templates where tenant_id is not null;  -- Ann sees company only (1) + not Ray's personal
-- automation: when tag "vip" added -> set field, wait 1 day, if field equals gold then email else task
select public.automation_save(null, jsonb_build_object('name', 'VIP flow', 'active', true, 'trigger', '{"kind":"tag_added","tag":"vip"}'::jsonb,
  'steps', jsonb_build_array(
    '{"type":"set_field","field":"contact.tier","value":"gold"}'::jsonb,
    jsonb_build_object('type', 'if', 'field', 'contact.tier', 'op', 'equals', 'value', 'gold',
      'then', jsonb_build_array(jsonb_build_object('type', 'email', 'template_id', :'tpl'), '{"type":"wait","amount":1,"unit":"days"}'::jsonb, '{"type":"add_tag","tag":"emailed"}'::jsonb),
      'else', jsonb_build_array('{"type":"task","title":"Call {contact.first_name}"}'::jsonb)),
    '{"type":"task","title":"After the if for {contact.first_name}"}'::jsonb))) as auto \gset
insert into people (id, tenant_id, first_name, personal_email) values ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Pat', 'pat@x.com');
select lead_source = 'Added by hand' as lead_source_set from people where id = 'd0000000-0000-0000-0000-000000000001';
update people set tags = array['vip'] where id = 'd0000000-0000-0000-0000-000000000001';
select count(*) = 1 as run_started from automation_runs where automation_id = :'auto';
update people set tags = array['vip', 'x'] where id = 'd0000000-0000-0000-0000-000000000001';
select count(*) = 1 as no_double_start from automation_runs where automation_id = :'auto';
select private.automation_tick() as ticked;
select status = 'waiting' as waiting, pos = '[1, "then", 2]'::jsonb as pos_ok from automation_runs where automation_id = :'auto';
select custom->>'tier' = 'gold' as field_set from people where id = 'd0000000-0000-0000-0000-000000000001';
select count(*) = 1 and min(subject) = 'Welcome Pat' and min(body) = 'Hi Pat from Acme' as email_rendered from email_outbox;
select count(*) = 1 as hook_called from net.calls where url like '%automation-send%';
-- jump ahead a day
update automation_runs set wake_at = now() - interval '1 minute' where automation_id = :'auto';
select private.automation_tick();
select status = 'done' as finished from automation_runs where automation_id = :'auto';
select 'emailed' = any(tags) as tag_added from people where id = 'd0000000-0000-0000-0000-000000000001';
select count(*) = 1 and min(title) = 'After the if for Pat' as after_if_task from tasks;
select count(*) >= 4 as timeline_has_events from contact_events where person_id = 'd0000000-0000-0000-0000-000000000001';
select jsonb_array_length(public.timeline('d0000000-0000-0000-0000-000000000001', null)) >= 4 as timeline_rpc;
-- bad steps are refused
do $$ begin perform public.automation_save(null, '{"name":"bad","trigger":{"kind":"manual"},"steps":[{"type":"wait","amount":0,"unit":"days"}]}'); raise exception 'saved bad'; exception when others then
  if sqlerrm = 'saved bad' then raise; end if; end $$;

-- tracked link: click with a known contact sets a field and fires link_clicked
select (public.link_save(null, '{"name":"Spring promo","url":"https://example.com/spring","kind":"qr","actions":{"set_field":{"field":"contact.promo","value":"spring"},"add_tag":"promo"}}'))->>'slug' as slug \gset
select set_config('test.uid', '', false);
select public.link_hit(:'slug', 'd0000000-0000-0000-0000-000000000001', null) = 'https://example.com/spring' as redirects;
select public.link_hit(:'slug', null, null) is not null as anon_click_ok;
select clicks = 2 as counted from tracked_links where slug = :'slug';
select custom->>'promo' = 'spring' and 'promo' = any(tags) as link_actions from people where id = 'd0000000-0000-0000-0000-000000000001';
select count(*) = 1 as qr_event from contact_events where kind = 'qr_scanned';

-- incoming webhook creates a contact with mapped fields
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
select (public.hook_save(null, '{"name":"Zapier leads","field_map":{"contact.email":"lead.email","contact.first_name":"lead.first","contact.budget":"budget"}}'))->>'token' as tok \gset
select set_config('test.uid', '', false);
select (public.hook_receive(:'tok', '{"lead":{"email":"New@Y.com","first":"Nia"},"budget":"5000"}'))->>'created' = 'true' as hook_created;
select first_name = 'Nia' and custom->>'budget' = '5000' and lead_source = 'Webhook: Zapier leads' as hook_mapped from people where personal_email = 'new@y.com';
select (public.hook_receive(:'tok', '{"lead":{"email":"new@y.com","first":"Nia2"}}'))->>'created' = 'false' as hook_matched;

-- account separation: Oz sees none of it
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000003', false);
set role authenticated;
select (select count(*) from automations) = 0 and (select count(*) from contact_events) = 0 and (select count(*) from tracked_links) = 0
   and (select count(*) from templates where tenant_id is not null) = 0 as separated;
reset role;
-- unsubscribe stops the email step
select (public.email_unsubscribe('d0000000-0000-0000-0000-000000000001'))->>'ok' = 'true' as unsubscribed;

-- 067 chat assignment: Ray and Ann customer facing, widget round robin; Sue is Ray's manager
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
insert into app_users (id, full_name, email, tenant_id, is_admin) values ('b0000000-0000-0000-0000-000000000004', 'Sue Boss', 'sue@x.com', 'a0000000-0000-0000-0000-000000000001', false);
update app_users set customer_facing = true, last_seen_at = now() where id in ('b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002');
update app_users set manager_id = 'b0000000-0000-0000-0000-000000000004', last_seen_at = now() where id = 'b0000000-0000-0000-0000-000000000002';
update app_users set last_seen_at = now() where id = 'b0000000-0000-0000-0000-000000000004';
insert into chat_widgets (tenant_id, key, name, is_default, mode, user_ids) values ('a0000000-0000-0000-0000-000000000001', 'main', 'Main', true, 'round_robin',
  array['b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002']::uuid[]);
insert into chat_threads (id, tenant_id, visitor_key, visitor_name, visitor_email) values ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'k1', 'V1', 'v1@x.com');
insert into chat_threads (id, tenant_id, visitor_key, visitor_name, visitor_email) values ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'k2', 'V2', 'v2@x.com');
select count(distinct assigned_to) = 2 as round_robin_spreads from chat_threads where id in ('e0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002');
-- returning visitor goes back to the same person
insert into chat_threads (id, tenant_id, visitor_key, visitor_name, visitor_email) values ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'k3', 'V1', 'V1@x.com');
select (select assigned_to from chat_threads where id = 'e0000000-0000-0000-0000-000000000003') = (select assigned_to from chat_threads where id = 'e0000000-0000-0000-0000-000000000001') as returning_same;
-- nobody picks up: blast after the wait; Ray's chat blasts to Sue (his manager)
update chat_threads set assigned_at = now() - interval '3 minutes';
select private.chat_tick() = 3 as blasted;
select count(*) >= 1 as sue_notified from notifications where user_id = 'b0000000-0000-0000-0000-000000000004' and title like 'Chat waiting%';
select (public.chat_wait_state('e0000000-0000-0000-0000-000000000001', 'k1'))->>'waiting' = 'true' as visitor_sees_wait;
-- Sue replies first and takes it
insert into chat_messages (tenant_id, thread_id, sender, staff_id, body) values ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'staff', 'b0000000-0000-0000-0000-000000000004', 'Hi');
select assigned_to = 'b0000000-0000-0000-0000-000000000004' and picked_up_at is not null as first_reply_takes from chat_threads where id = 'e0000000-0000-0000-0000-000000000001';
-- Ray hands off to his manager by default
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000002', false);
update app_users set customer_facing = true where id = 'b0000000-0000-0000-0000-000000000004';
select (public.chat_handoff('e0000000-0000-0000-0000-000000000002'))->>'name' = 'Sue Boss' as handoff_to_manager;

-- 068 reports
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
select jsonb_array_length((public.report_run('{"source":"contacts","group":"lead_source","range":"all"}'))->'rows') >= 2 as report_groups;
select ((public.report_run('{"source":"chats","group":"person","measure":"count","range":"30d"}'))->'rows'->0->>'value')::int >= 1 as chat_report;
select jsonb_array_length((public.report_run('{"source":"contacts","group":"tag"}'))->'rows') >= 1 as tag_report;
do $$ begin perform public.report_run('{"source":"contacts","group":"x; drop table people"}'); raise exception 'ran bad'; exception when others then if sqlerrm = 'ran bad' then raise; end if; end $$;
set role authenticated;
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000003', false);
select jsonb_array_length((public.report_run('{"source":"contacts","group":"lead_source","range":"all"}'))->'rows') = 0 as report_separated;
reset role;
