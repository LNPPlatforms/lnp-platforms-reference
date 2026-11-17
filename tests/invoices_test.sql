-- 069: invoices, payments, the shared document view, lead source revenue. Run with tests/run_db.sh tests/invoices_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a0000000-0000-0000-0000-000000000001', 'Acme', 'acme'), ('a0000000-0000-0000-0000-000000000002', 'Other', 'other');
insert into app_users (id, full_name, email, tenant_id, is_admin) values
  ('b0000000-0000-0000-0000-000000000001', 'Ann Admin', 'ann@x.com', 'a0000000-0000-0000-0000-000000000001', true),
  ('b0000000-0000-0000-0000-000000000002', 'Ray Rep', 'ray@x.com', 'a0000000-0000-0000-0000-000000000001', false),
  ('b0000000-0000-0000-0000-000000000003', 'Oz Other', 'oz@x.com', 'a0000000-0000-0000-0000-000000000002', true),
  ('b0000000-0000-0000-0000-000000000004', 'Fay Field', 'fay@x.com', 'a0000000-0000-0000-0000-000000000001', false),
  ('b0000000-0000-0000-0000-000000000005', 'Al Accounting', 'al@x.com', 'a0000000-0000-0000-0000-000000000001', false);
insert into roles (id, tenant_id, name, preset_key, perms) values
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Sales rep', 'sales_rep', public.role_presets()->'sales_rep'->'perms'),
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Field', 'field_worker', public.role_presets()->'field_worker'->'perms'),
  ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Accounting', 'accounting', public.role_presets()->'accounting'->'perms');
update app_users set role_id = 'c0000000-0000-0000-0000-000000000001' where id = 'b0000000-0000-0000-0000-000000000002';
update app_users set role_id = 'c0000000-0000-0000-0000-000000000002' where id = 'b0000000-0000-0000-0000-000000000004';
update app_users set role_id = 'c0000000-0000-0000-0000-000000000003' where id = 'b0000000-0000-0000-0000-000000000005';
select 'invoices' = any(private.perm_areas()) as area_listed;

-- permission defaults
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000004', false);
select not private.can('invoices', 1) as field_worker_off;
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000005', false);
select private.can('invoices', 4) and private.perm('invoices')->>'scope' = 'all' as accounting_manages;
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000002', false);
select private.can('invoices', 2) and not private.can('invoices', 3) and private.perm('invoices')->>'scope' = 'own' as rep_edits_own;

-- Ray makes one by hand
insert into companies (id, tenant_id, name, lead_source_channel, main_email, address, city, state, zip)
  values ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Oak Apartments', 'Form: Contact us', 'ap@oak.com', '1 Oak St', 'Biloxi', 'MS', '39530');
insert into invoices (company_id, lines, discount) values ('e0000000-0000-0000-0000-000000000001',
  '[{"code":"MOW","name":"Mowing","desc":"Front and back","qty":"2","price":"50","tax":"10"},{"name":"Haul off","qty":1,"price":100}]', 20) returning id as inv \gset
select number = 1001 and status = 'draft' and subtotal = 200 and discount = 20 and tax_total = 9 and total = 189 and balance = 189 and lead_source = 'Form: Contact us'
  and owner_id = 'b0000000-0000-0000-0000-000000000002' and due_date = current_date + 30 as hand_invoice_math from invoices where id = :'inv';
select (lines->0->>'total')::numeric = 100 and (lines->0->>'tax_amt')::numeric = 10 as line_math from invoices where id = :'inv';
-- trying to set it paid by hand does nothing
update invoices set status = 'paid', paid_total = 189 where id = :'inv';
select status = 'draft' and paid_total = 0 as cant_fake_paid from invoices where id = :'inv';
select public.invoice_mark_sent(:'inv', 'ap@oak.com');
select status = 'sent' and sent_at is not null and last_emailed_to = 'ap@oak.com' as marked_sent from invoices where id = :'inv';

-- Ray records a check: waits in Review
select public.invoice_payment_record(:'inv', '{"amount":"89","method":"check","reference":"1042"}')->>'status' = 'pending' as rep_payment_waits;
select balance = 189 and status = 'sent' as pending_not_counted from invoices where id = :'inv';
do $$ begin perform public.invoice_payment_record((select id from invoices limit 1), '{"amount":"5000","method":"cash"}'); raise exception 'overpaid'; exception when others then
  if sqlerrm = 'overpaid' then raise; end if; end $$;
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
select jsonb_array_length(public.invoice_review_list()) = 1 as in_review;
select public.invoice_payment_decide((public.invoice_review_list()->0->>'id')::uuid, true);
select status = 'partial' and paid_total = 89 and balance = 100 as partial_after_approval from invoices where id = :'inv';
-- Ann's own payment posts right away and pays it off
select public.invoice_payment_record(:'inv', '{"amount":"100","method":"cash"}')->>'status' = 'posted' as admin_posts;
select status = 'paid' and balance = 0 and paid_at is not null as paid_off from invoices where id = :'inv';
select count(*) = 1 and min(title) like 'Invoice 1001 paid%' as timeline_invoice_paid from contact_events where kind = 'invoice_paid' and company_id = 'e0000000-0000-0000-0000-000000000001';
do $$ begin update invoices set lines = '[]' where number = 1001; raise exception 'edited paid'; exception when others then if sqlerrm = 'edited paid' then raise; end if; end $$;
do $$ begin update invoices set status = 'void' where number = 1001; raise exception 'voided paid'; exception when others then if sqlerrm = 'voided paid' then raise; end if; end $$;

-- the customer's link, signed out
select set_config('test.uid', '', false);
select (public.doc_view(share_token)->>'title') = 'Invoice' and (public.doc_view(share_token)->>'number') = '1001'
  and jsonb_array_length(public.doc_view(share_token)->'payments') = 2 and public.doc_view(share_token)->'pay' = 'null'::jsonb
  and public.doc_view(share_token)->'brand'->>'name' = 'Acme' and public.doc_view(share_token)->'brand'->>'color' = '#1A2A52'
  and public.doc_view(share_token)->'lines'->0->>'code' is null and public.doc_view(share_token)->'lines'->0->>'job_id' is null as doc_view_ok from invoices where id = :'inv';

-- settings: item codes on, a pay link, a prefix
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
select public.doc_settings_save('{"show_item_code":true,"prefix":"A-","next_number":2000,"pay_link":"https://square.link/u/abc","company":{"name":"Acme Lawn","phone":"555-1212"}}')->>'pay_method' = 'link' as link_method;
do $$ begin perform public.doc_settings_save('{"next_number":5,"pay_link":"https://x.com"}'); raise exception 'low number'; exception when others then if sqlerrm = 'low number' then raise; end if; end $$;
insert into brand_kits (tenant_id, logos, colors) values ('a0000000-0000-0000-0000-000000000001', '{"square":"https://x/sq.png","wide":"https://x/wide.png","default":"square"}', '[{"name":"Accent","hex":"#123456"},{"name":"Primary","hex":"#AA0000"}]');
insert into invoices (company_id, lines) values ('e0000000-0000-0000-0000-000000000001', '[{"code":"X1","name":"Thing","qty":1,"price":40}]') returning id as inv2 \gset
select number = 2000 as next_number_used from invoices where id = :'inv2';
select set_config('test.uid', '', false);
select public.doc_view(share_token) is null as draft_hidden from invoices where id = :'inv2';
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
select public.invoice_mark_sent(:'inv2');
select set_config('test.uid', '', false);
select d->>'number' = 'A-2000' and d->'pay'->>'method' = 'link' and d->'pay'->>'link' = 'https://square.link/u/abc' and d->'lines'->0->>'code' = 'X1'
  and d->'brand'->>'logo' = 'https://x/wide.png' and d->'brand'->>'color' = '#AA0000' and d->'brand'->>'name' = 'Acme Lawn' as doc_branded
  from (select public.doc_view(share_token) d from invoices where id = :'inv2') x;
-- Stripe Connect ready: stripe wins; checkout posts once
select public.pay_processor_set('a0000000-0000-0000-0000-000000000001', '{"stripe_account_id":"acct_1","stripe_ready":true}');
select public.invoice_pay_info(share_token)->>'method' = 'stripe' and public.invoice_pay_info(share_token)->>'stripe_account' = 'acct_1' as stripe_method from invoices where id = :'inv2';
select public.invoice_stripe_paid(:'inv2', 'cs_1', 40, 'card') and not public.invoice_stripe_paid(:'inv2', 'cs_1', 40, 'card') as stripe_once;
select status = 'paid' as stripe_paid from invoices where id = :'inv2';
select public.pay_processor_set('a0000000-0000-0000-0000-000000000001', '{"clear":true}');

-- from approved jobs; voiding frees them
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000001', false);
insert into jobs (id, tenant_id, company_id, title, price, approval, status) values
  ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Cleanout', 350, 'approved', 'left'),
  ('f0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Pickup', 120, 'none', 'scheduled');
do $$ begin perform public.invoice_from_jobs(array['f0000000-0000-0000-0000-000000000002'::uuid]); raise exception 'billed unapproved'; exception when others then if sqlerrm = 'billed unapproved' then raise; end if; end $$;
select public.invoice_from_jobs(array['f0000000-0000-0000-0000-000000000001'::uuid]) as jinv \gset
select total = 350 and lines->0->>'job_id' = 'f0000000-0000-0000-0000-000000000001' as job_invoice from invoices where id = :'jinv';
select billed_at is not null and invoice_id = :'jinv' as job_billed from jobs where id = 'f0000000-0000-0000-0000-000000000001';
update invoices set status = 'void' where id = :'jinv';
select billed_at is null and invoice_id is null as job_freed from jobs where id = 'f0000000-0000-0000-0000-000000000001';

-- from an accepted proposal (paid online at signing becomes the deposit)
insert into proposals (id, tenant_id, company_id, status, accepted_version, owner_id, contact_name, contact_email, pay_status, pay_version, paid_amount)
  values ('ab000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'sent', 1, 'b0000000-0000-0000-0000-000000000002', 'Pam', 'pam@oak.com', 'paid', 1, 500);
update proposals set status = 'accepted' where id = 'ab000000-0000-0000-0000-000000000001';
select lead_source = 'Form: Contact us' as proposal_lead_source from proposals where id = 'ab000000-0000-0000-0000-000000000001';
insert into proposal_versions (proposal_id, version, setup_total, quote) values ('ab000000-0000-0000-0000-000000000001', 1, 1500,
  '{"lines":[{"title":"Website","sub":"5 pages","setup":1750,"mo":0},{"title":"Hosting","setup":0,"mo":99}],"setup":{"disc":250}}');
select public.invoice_from_proposal('ab000000-0000-0000-0000-000000000001') as pinv \gset
select jsonb_array_length(lines) = 1 and total = 1500 and deposit = 500 and balance = 1000 and bill_to->>'email' = 'pam@oak.com'
  and owner_id = 'b0000000-0000-0000-0000-000000000002' as proposal_invoice from invoices where id = :'pinv';

-- deals carry lead source; reports
insert into opportunities (tenant_id, company_id, status, estimated_value, owner_id) values ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Won', 900, 'b0000000-0000-0000-0000-000000000001');
select lead_source = 'Form: Contact us' as deal_lead_source from opportunities;
select (public.report_run('{"source":"invoices","group":"lead_source","measure":"revenue","range":"all"}')->'rows'->0->>'value')::numeric = 229 as revenue_by_source;
select public.report_run('{"source":"deals","group":"lead_source","measure":"value","range":"all"}')->'rows'->0->>'label' = 'Form: Contact us' as deals_by_source;
select public.report_options()->'sources' ? 'invoices' as invoices_source_listed;

-- row rules: Ray sees only his own; Oz sees nothing from Acme; Fay can't add one
set role authenticated;
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000002', false);
select count(*) = 2 as rep_sees_own from invoices;   -- the hand one and the proposal one
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000003', false);
select count(*) = 0 as other_account_sees_none from invoices;
select count(*) = 0 as other_account_no_payments from invoice_payments;
select set_config('test.uid', 'b0000000-0000-0000-0000-000000000004', false);
do $$ begin insert into invoices (company_id, lines) values ('e0000000-0000-0000-0000-000000000001', '[]'); raise exception 'field added'; exception when others then
  if sqlerrm = 'field added' then raise; end if; end $$;
reset role;
select 'all invoice tests ran' as done;
