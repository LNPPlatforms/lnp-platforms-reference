// Click through the CRM against the fake backend and report any page errors or error toasts.
const { chromium } = require('playwright');
const fs = require('fs');
const FAKE = fs.readFileSync(__dirname + '/fake-supabase.js', 'utf8');
const FAKE_LEAFLET = fs.readFileSync(__dirname + '/fake-leaflet.js', 'utf8');
// pdf.js for the e-sign screens comes from the global npm folder (the real CDN isn't reachable from the test box)
const NPM_G = require('child_process').execSync('npm root -g').toString().trim();
const pdfjsFile = (name) => { try { return fs.readFileSync(`${NPM_G}/pdfjs-dist/build/${name}`, 'utf8'); } catch { return ''; } };
const mode = process.argv[2] || 'on';
const seedMode = mode === 'grow' || mode === 'docs' || mode === 'members' || mode === 'crews' || mode === 'measure' || mode === 'bids' || mode === 'portal' || mode === 'esign' || mode === 'calendars' || mode === 'phone' || mode === 'social' || mode === 'plans' || mode === 'today' ? 'on' : mode;
const seed = (mode) => `
  const now = new Date(); const iso = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  window.__DB = {
    app_users: [{ id: 'U1', full_name: 'Admin Al', email: 'admin@test.local', role: 'staff', active: true, is_admin: true, tenant_id: 'T1', divisions: [] },
                { id: 'U2', full_name: 'Worker Wes', email: 'wes@test.local', role: 'staff', active: true, is_admin: false, tenant_id: 'T1', divisions: ['D1'], role_id: 'R1' }],
    account_settings: [{ tenant_id: 'T1', settings: ${mode === 'on' ? `{ features: { jobs: true, dispatch: true, timeclock: true, pay: true, costs: true, custom_fields: true, parent_locations: true, accounting: true }, label_preset: 'home_service',
      labels: { organization: { one: 'Location', many: 'Locations' } }, gps_radius_ft: 500 }` : '{}'} }],
    divisions: [{ id: 'D1', name: 'Valet Trash', color: '#336', sort_order: 1 }, { id: 'D2', name: 'Junk Luggers', color: '#633', sort_order: 2 }],
    companies: [{ id: 'C1', name: 'Oak Apartments', city: 'Biloxi', state: 'MS', divisions: ['D1'], custom: {}, parent_company_id: 'C2', bill_to: 'parent', org_types: ['Customer'] },
                { id: 'C2', name: 'Gulf Mgmt Co', city: 'Gulfport', divisions: [], custom: {}, org_types: [] }],
    people: [{ id: 'P1', first_name: 'Pam', last_name: 'Smith', custom: { gate: '1234' }, divisions: [] }],
    company_people: [{ id: 'L1', company_id: 'C1', person_id: 'P1', title: 'Manager', is_billing: true, work_email: 'pat@oak.test' }],
    jobs: [{ id: 'J1', number: 1, company_id: 'C1', title: 'Nightly valet', status: 'arrived', approval: 'none', flags: ['far_arrive'], scheduled_start: iso(19), scheduled_end: iso(21), assigned_to: 'U2', price: 120, divisions: ['D1'], custom: {} },
           { id: 'J2', number: 2, company_id: 'C1', title: 'Pickup', status: 'scheduled', approval: 'none', flags: [], scheduled_start: iso(10), scheduled_end: iso(11), assigned_to: null, price: 200, divisions: ['D1'], custom: {} },
           { id: 'J3', number: 3, company_id: 'C1', title: 'Cleanout', status: 'left', approval: 'approved', flags: [], scheduled_start: iso(8), scheduled_end: iso(9), assigned_to: 'U2', price: 350, divisions: ['D2'], custom: {} }],
    job_events: [{ id: 'E1', job_id: 'J1', kind: 'status', status: 'arrived', lat: 30.4, lng: -89, distance_ft: 900, flagged: true, created_by: 'U2', created_at: iso(19) },
                 { id: 'E2', job_id: 'J1', kind: 'photo', photo_path: 'T1/jobs/a.jpg', created_by: 'U2', created_at: iso(19) }],
    job_costs: [{ id: 'K1', job_id: 'J1', item: 'Roller', qty: 1, unit_cost: 35, amount: 35, category: null, created_by: 'U2' }],
    cost_presets: [{ id: 'CP1', item: 'Parking bumper', default_cost: 45, category: 'parts', sort: 0 }],
    job_schedules: [{ id: 'S1', company_id: 'C1', title: 'Nightly valet', rule: { freq: 'weekly', every: 1, days: [1,2,3,4,5], start_time: '19:00', duration_min: 120 }, active: true, starts_on: '2026-10-01', divisions: ['D1'], assigned_to: 'U2' }],
    location_pins: [{ id: 'PN1', company_id: 'C1', label: 'Office', lat: 30.4, lng: -89, is_primary: true }],
    work_reviews: [{ id: 'W1', kind: 'job_done', ref_id: 'J1', job_id: 'J1', company_id: 'C1', worker_id: 'U2', status: 'pending', summary: 'Nightly valet', divisions: ['D1'], details: {}, created_at: iso(20) },
                   { id: 'W2', kind: 'pin_change', job_id: 'J1', company_id: 'C1', worker_id: 'U2', status: 'pending', summary: 'Dumpster is in the back', divisions: ['D1'], details: { lat: 30.401, lng: -89, photo: 'T1/pins/b.jpg', pin_id: 'PN1', feet: 900 }, created_at: iso(20) },
                   { id: 'W3', kind: 'cost_category', ref_id: 'K1', job_id: 'J1', company_id: 'C1', worker_id: 'U2', status: 'pending', summary: 'Roller', divisions: ['D1'], details: { qty: 1, unit_cost: 35 }, created_at: iso(20) },
                   { id: 'W4', kind: 'timesheet', ref_id: 'TE1', worker_id: 'U2', status: 'auto', summary: '8 hrs', divisions: ['D1'], details: { flags: [] }, created_at: iso(17) }],
    time_entries: [{ id: 'TE1', user_id: 'U2', clock_in: iso(9), clock_out: iso(17), break_min: 30, status: 'auto', flags: [], divisions: ['D1'] }],
    worker_pay_profiles: [{ user_id: 'U2', worker_class: 'w2', tax_doc: 'received', external_id: '100' }],
    pay_rates: [{ id: 'PR1', user_id: 'U2', kind: 'daily', rate: 150, effective_from: '2026-10-01', division_id: 'D1' }],
    pay_schedules: [{ id: 'PS1', name: 'Weekly', freq: 'weekly', anchor: '2026-10-26', cut_days: [], payday_lag_days: 4, is_default: true }],
    pay_batches: [{ id: 'B1', period_start: '2026-10-19', period_end: '2026-10-25', worker_class: 'w2', status: 'final', total: 750, pay_date: '2026-10-29' }],
    pay_lines: [{ id: 'PL1', batch_id: 'B1', user_id: 'U2', division_id: 'D1', kind: 'daily', hours: 40, days: 5, jobs: 0, rate: 150, amount: 750 },
                { id: 'PL2', batch_id: 'B1', user_id: 'U2', division_id: 'D1', kind: 'hourly', hours: 40, days: 0, jobs: 0, rate: 15, amount: 600 },
                { id: 'PL3', batch_id: 'B1', user_id: 'U2', division_id: 'D1', kind: 'overtime', hours: 2, days: 0, jobs: 0, rate: 22.5, amount: 45 }],
    export_templates: [], acct_connections: [], acct_mappings: [], acct_sync_queue: [{ id: 'Q1', entity_type: 'contractor_bill', amount: 300, status: 'failed', last_error: 'Not connected', created_at: iso(8) }],
    roles: [{ id: 'R1', name: 'Field worker', preset_key: 'field_worker', perms: { jobs: { level: 2, scope: 'own' } } }],
    custom_fields: [{ id: 'CF1', entity: 'companies', key: 'gate_code', label: 'Gate code', type: 'text', options: [], sort: 0 },
                    { id: 'CF2', entity: 'jobs', key: 'size', label: 'Dumpster size', type: 'select', options: ['Small', 'Large'], sort: 1 },
                    { id: 'CF3', entity: 'people', key: 'gate', label: 'Gate', type: 'text', options: [], sort: 2 }],
    automations: [{ id: 'A1', name: 'New lead follow up', active: true, trigger: { kind: 'form_submitted' }, steps: [{ type: 'email', body: 'Hi {contact.first_name}' }, { type: 'wait', amount: 1, unit: 'days' },
      { type: 'if', field: 'tag', op: 'has', value: 'vip', then: [{ type: 'task', title: 'Call' }], else: [] }], allow_repeat: false }],
    automation_runs: [{ id: 'AR1', automation_id: 'A1', person_id: 'P1', status: 'waiting', wake_at: iso(23), log: [{ at: iso(8), msg: 'Email queued' }], created_at: iso(8), people: { first_name: 'Pam', last_name: 'Smith' } }],
    tracked_links: [{ id: 'TL1', slug: 'spring1', name: 'Spring flyer', kind: 'qr', url: 'https://example.com', actions: { add_tag: 'spring' }, clicks: 3 }],
    inbound_hooks: [{ id: 'H1', name: 'Zapier', token: 'abc', field_map: { 'contact.email': 'email' }, match_on: 'email', active: true, hits: 2, last_body: { email: 'a@b.com', lead: { name: 'X' } } }],
    templates: [{ id: 'TP1', tenant_id: null, kind: 'reply', scope: 'starter', name: 'Greeting', shortcut: 'hi', body: 'Hi {contact.first_name}' },
                { id: 'TP2', tenant_id: 'T1', kind: 'email', scope: 'company', name: 'Welcome', subject: 'Welcome', body: 'Hello', owner_id: 'U1' }],
    departments: [{ id: 'DP1', name: 'Support', manager_id: 'U1' }], department_members: [{ department_id: 'DP1', user_id: 'U2' }],
    chat_widgets: [{ id: 'CW1', key: 'main', name: 'Website', is_default: true, mode: 'round_robin', style: 'even', user_ids: ['U1'], department_ids: ['DP1'], wait_seconds: 120, waiting_text: 'Sorry', offline_text: 'Away' }],
    reports: [{ id: 'RP1', name: 'Leads by source', spec: { source: 'contacts', group: 'lead_source', measure: 'count', range: '90d' }, shared: true, owner_id: 'U1' }],
    products: [{ id: 'PR1', name: 'Template Website', description: 'A complete website from a proven template.', code: '', price: 2500, unit: 'each', taxable: false, frequency: 'once', sort: 1 },
               { id: 'PR2', name: 'Dashboard', description: 'Monthly dashboard license.', code: '', price: 599, unit: 'month', taxable: false, frequency: 'monthly', sort: 2 }],
    invoices: [{ id: 'I1', number: 1001, status: 'partial', company_id: 'C1', share_token: 'tok1'.padEnd(64, 'x'), issue_date: '2026-10-01', due_date: '2026-10-15', po: 'PO-7',
        lines: [{ code: 'MOW', name: 'Mowing', desc: 'Front and back', qty: 2, price: 50, tax: 7, total: 100, tax_amt: 7 }, { name: 'Haul off', qty: 1, price: 250, tax: 0, total: 250, tax_amt: 0 }],
        subtotal: 350, discount: 0, tax_total: 7, total: 357, deposit: 0, paid_total: 100, balance: 257, bill_to: {}, sent_at: iso(8), last_emailed_to: 'ap@oak.com', owner_id: 'U1' },
      { id: 'I2', number: 1002, status: 'paid', company_id: 'C2', share_token: 'tok2'.padEnd(64, 'x'), issue_date: '2026-10-20', due_date: '2026-11-19', lines: [{ name: 'Cleanout', qty: 1, price: 350, tax: 0, total: 350 }],
        subtotal: 350, discount: 0, tax_total: 0, total: 350, deposit: 100, paid_total: 250, balance: 0, bill_to: {}, owner_id: 'U1' },
      { id: 'I3', number: 1003, status: 'draft', company_id: 'C1', share_token: 'tok3'.padEnd(64, 'x'), issue_date: '2026-10-30', lines: [], subtotal: 0, tax_total: 0, total: 0, deposit: 0, paid_total: 0, balance: 0, bill_to: {}, owner_id: 'U1' }],
    invoice_payments: [{ id: 'IP1', invoice_id: 'I1', amount: 100, method: 'check', reference: '1042', paid_on: '2026-10-05', status: 'posted', source: 'manual', created_at: iso(8) },
      { id: 'IP2', invoice_id: 'I1', amount: 57, method: 'cash', paid_on: '2026-10-29', status: 'pending', source: 'manual', created_at: iso(9) }],
    brand_kits: [], contact_events: [], site_forms: [{ id: 'F1', name: 'Contact us' }],
    shortcuts: [], tasks: [], escalations: [], notifications: [], chat_threads: [], review_items: [], suggestions: [], lookup_values: [], pipelines: [], pipeline_stages: [], opportunities: [], activities: [], proposals: [], media: [], company_assets: [], invites: [], vendors: [],
  };
  const all = (l) => Object.fromEntries(['contacts','sales','proposals','inbox','sites','jobs','dispatch','timeclock','costs','pay','review','reports','settings','team','automations','marketing','templates','media','invoices'].map((a) => [a, { level: l, scope: 'all' }]));
  window.__RPC = {
    current_account: () => ({ id: 'T1', name: 'Essential Services', is_gelp: false, plan: 'full', is_agency: false, home: 'T1', platform_admin: false }),
    directories_flags: () => ({}), member_home: () => ({ listings: [] }), team_unread: () => 0, directory_pending_count: () => 0,
    my_perms: () => ({ ...all(4), _aal: 'aal1' }), role_presets: () => ({ manager: { name: 'Manager', perms: all(3) }, field_worker: { name: 'Field worker', perms: { jobs: { level: 2, scope: 'own' } } } }),
    schedules_generate: () => 0, location_tree: () => ['C1', 'C2'], job_profit: () => [{ job_id: 'J3', division_id: 'D2', revenue: 350, labor: 150, other_costs: 20 }],
    acct_sync_summary: () => ({ queued: 0, sent: 2, failed: 1, sent_total: 500 }), company_facets: () => ({ states: [], specialties: [] }),
    job_step: (a) => { const j = window.__DB.jobs.find((x) => x.id === a.p_job); j.status = a.p_status; return { status: a.p_status, flag: null }; },
    work_review_decide: (a) => { const w = window.__DB.work_reviews.find((x) => x.id === a.p_id); w.status = 'approved'; return null; },
    account_settings_save: (a) => { const s = window.__DB.account_settings[0]; s.settings = { ...s.settings, ...a.p }; return s.settings; },
    media_library: () => [{ id: 'M1', url: 'https://example.com/a.png', title: 'logo.png', mime: 'image/png', scope: 'company', divisions: [], share_tenant_ids: [], mine: true }],
    report_options: () => ({ sources: { contacts: { groups: ['lead_source', 'tag', 'day', 'week', 'month'], measures: ['count'] }, deals: { groups: ['status', 'month'], measures: ['count', 'value'] } } }),
    report_run: () => ({ rows: [{ label: 'Form: Contact us', value: 12 }, { label: 'Live chat', value: 5 }] }),
    timeline: () => [{ id: 'EV1', kind: 'form_submitted', title: 'Submitted Contact us', at: iso(9), by: null }, { id: 'EV2', kind: 'note', title: 'Called', at: iso(10), by: 'Admin Al' }],
    customer_facing_people: () => [{ id: 'U1', name: 'Admin Al', online: true }, { id: 'U2', name: 'Worker Wes', online: false }],
    invoice_savings_default: () => true, invoice_savings_default_set: (a) => a.p_on,
    invoice_collect_settings: () => ({ reminders_on: true, late_fees_enabled: false, late_fee_kind: 'flat', late_fee_amount: 0, late_fee_days: 15 }),
    invoice_collect_settings_set: (a) => (window.__COLLECT = a.p),
    invoice_series_review: () => ({ drafts: [{ id: 'I1', number: '1001', org: 'Oak Apartments', total: 750, issue_date: '2026-11-03' }],
      failed: [{ id: 'I1', number: '1001', org: 'Oak Apartments', balance: 750, error: 'Your card was declined.', attempts: 1, at: '2026-11-03T14:07:00Z' }] }),
    invoice_schedule_get: (a) => (window.__SER || {})[a.p_invoice] || null,
    invoice_schedule_save: (a) => { const i = window.__DB.invoices.find((x) => x.id === a.p_invoice); window.__SER = window.__SER || {};
      if (a.p.status === 'ended') { window.__SER[a.p_invoice].status = 'ended'; return window.__SER[a.p_invoice]; }
      i.schedule_id = 'SC1'; return (window.__SER[a.p_invoice] = { id: 'SC1', ...a.p, custom_every: Number(a.p.custom_every), end_count: Number(a.p.end_count), runs_completed: 1, card_saved: false, status: 'active', invoices: 1 }); },
    doc_settings_get: () => ({ show_item_code: true, show_tax: true, default_tax_rate: 7, due_days: 30, prefix: '', next_number: 1004, company: { name: 'Essential Services', phone: '228-555-0100', address: '1 Main St, Biloxi MS' },
      pay_link: 'https://square.link/u/test', pay_method: 'link', can_edit: true, notes: 'Thanks!', terms: 'Net 30' }),
    doc_settings_save: (a) => ({ ...a.p, can_edit: true, pay_method: a.p.pay_link ? 'link' : null }),
    invoice_review_list: () => [{ id: 'IP2', invoice_id: 'I1', number: '1001', org: 'Oak Apartments', amount: 57, method: 'cash', paid_on: '2026-10-29', balance: 257, by: 'Worker Wes', at: iso(9) }],
    invoice_payment_record: () => ({ id: 'IP3', status: 'posted' }), invoice_payment_decide: () => null, invoice_mark_sent: () => null,
    invoice_from_jobs: () => 'I3', invoice_from_proposal: () => 'I3',
    doc_view: (a) => { const i = window.__DB.invoices.find((x) => x.share_token === a.p_token); if (!i) return null; return { kind: 'invoice', title: 'Invoice', token: i.share_token, number: String(i.number), status: i.status,
      issue_date: i.issue_date, due_date: i.due_date, po: i.po, customer: { name: 'Oak Apartments', org: 'Oak Apartments', address: '1 Oak St, Biloxi, MS 39530', email: 'ap@oak.com' }, show_code: true, show_tax: true,
      lines: i.lines, subtotal: i.subtotal, discount: i.discount, tax_total: i.tax_total, total: i.total, deposit: i.deposit, paid_total: i.paid_total, balance: i.balance,
      payments: window.__DB.invoice_payments.filter((p) => p.invoice_id === i.id && p.status === 'posted'), pictures: i.pictures || [], notes: 'Thanks for your business', terms: 'Net 30', pay_instructions: 'Checks to Essential Services',
      pay: i.balance > 0 ? { method: 'link', link: 'https://square.link/u/test' } : null, autopay: i.id === 'I1' ? { on: true, saved: true, label: 'Visa ending 4242', failed: false } : null, brand: { name: 'Essential Services', color: '#2A6B4F', address: '1 Main St, Biloxi MS', phone: '228-555-0100', email: 'office@es.com' } }; },
    job_cost_add: () => 'K2', job_note: () => 'E9', clock_in: () => 'TE2', pay_batch_set: () => null, start_steps: () => [],
  };
`;
// members mode: people from another account on this team. localStorage.scene picks who is looking:
// client (the client's admin, default), julie (the member, switched in) or agency (platform owner at home adding her)
// packages, plans and the billing gate (091). Scenes: agency (Cognix) and client billing states.
const plansSeed = () => {
  const scene = localStorage.getItem('scene') || 'agency';
  const D = window.__DB, R = window.__RPC;
  D.tenants = [{ id: 'T0', name: 'Cognix CRM', slug: 'cognix', created_at: '2026-11-01', agency_tenant_id: null, is_agency: true },
               { id: 'T1', name: 'Essential Services', slug: 'essential', created_at: '2026-11-02', agency_tenant_id: 'T0' }];
  D.packages ||= []; D.account_plans ||= [];
  D.invoice_schedules = [{ id: 'IS1', company_id: 'C1', frequency: 'monthly', status: 'active', lines: [{ name: 'CRM', qty: 1, price: 180 }], next_run_date: '2026-12-01' }];
  R.package_save = (a) => { const p = a.p; const row = { id: p.id || 'PK' + (D.packages.length + 1), tenant_id: 'T0', name: p.name, features: p.features, price: p.price === '' ? null : Number(p.price), price_per: p.price_per, sort: 1, archived_at: null };
    D.packages = D.packages.filter((x) => x.id !== row.id).concat(row); return row.id; };
  R.account_plan_save = (a) => { const cur = D.account_plans.find((x) => x.tenant_id === a.p_tenant) || { tenant_id: a.p_tenant };
    Object.assign(cur, a.p); D.account_plans = D.account_plans.filter((x) => x.tenant_id !== a.p_tenant).concat(cur); return cur; };
  R.account_plans_list = () => D.account_plans.map((p) => ({ ...p, billing: { state: 'setup' } }));
  R.account_logins = () => [{ id: 'U9', full_name: 'Owner Olive', email: 'olive@es.test', active: true, is_admin: true }];
  R.create_account = (a) => { D.tenants.push({ id: 'T9', name: a.p_name, slug: a.p_slug, agency_tenant_id: 'T0' }); window.__made = a; return { ok: true, id: 'T9', slug: a.p_slug }; };
  R.account_export = () => ({ account: 'Essential Services', tables: { companies: [] } });
  R.support_mine = () => ({ online: false, threads: (window.__SUP || []) });
  R.support_open = (a) => { (window.__SUP ||= []).unshift({ id: 'SP1', status: 'open', priority: a.p_priority, at: new Date().toISOString(), messages: [{ from: 'visitor', body: a.p_body, at: new Date().toISOString() }] }); return { ok: true, thread: 'SP1' }; };
  R.other_accounts_waiting = () => [{ tenant_id: 'TG', account: 'GELP', waiting: 2, latest: new Date().toISOString() }];
  R.team_rooms_list = () => [{ id: 'RT1', kind: 'team', here: true, tenant_id: 'T0', members: [], unread: 0 },
    { id: 'RG1', kind: 'team', here: false, account: 'GELP', tenant_id: 'TG', members: ['UJ'], people: { UJ: 'Julie Olivari' }, unread: 1, preview: { body: 'Team hello', sender_id: 'UJ' }, last_message_at: new Date().toISOString() },
    { id: 'RD1', kind: 'dm', here: false, account: 'GELP', tenant_id: 'TG', name: 'Julie Olivari', other_id: 'UJ', members: ['U1', 'UJ'], people: { UJ: 'Julie Olivari' }, unread: 1, preview: { body: 'Chris, call me', sender_id: 'UJ' }, last_message_at: new Date().toISOString() }];
  if (scene === 'agency') {
    R.current_account = () => ({ id: 'T0', name: 'Cognix CRM', is_gelp: false, plan: 'full', is_agency: true, home: 'T0', home_agency: 'Cognix CRM', platform_admin: true, platform_owner: true });
    R.my_accounts = () => [{ id: 'T0', name: 'Cognix CRM', kind: 'home' }, { id: 'T1', name: 'Essential Services', kind: 'managed' }, { id: 'TG', name: 'GELP Strategies', kind: 'member' }];
    R.my_plan = () => ({ allowed: null, billing: { state: 'ok' } });
  } else {
    const st = { setup: { state: 'setup', open: [{ token: 'tk1', balance: 3180 }], agency: 'Cognix CRM' }, locked: { state: 'locked', days_late: 12, open: [{ token: 'tk2', balance: 180 }], agency: 'Cognix CRM' },
      staff: { state: 'locked', agency: 'Cognix CRM' }, grace: { state: 'grace', days_late: 3, grace_left: 4, open: [{ token: 'tk3', balance: 180 }], agency: 'Cognix CRM' }, limited: { state: 'ok' } }[scene];
    R.my_plan = () => ({ allowed: scene === 'limited' ? ['sales', 'inbox'] : ['sales', 'inbox', 'sites', 'jobs', 'bids'], billing: st, billing_person: scene !== 'staff', billing_contact: 'Owner Olive' });
  }
};
const membersSeed = () => {
  const scene = localStorage.getItem('scene') || 'client';
  const D = window.__DB, R = window.__RPC;
  D.app_users.push({ id: 'U3', full_name: 'Julie Olivari', email: 'julie@gelp.test', role: 'staff', active: true, is_admin: true, tenant_id: 'T0', divisions: [] });
  const jul = { user_id: 'U3', full_name: 'Julie Olivari', email: 'julie@gelp.test', is_admin: true, role_id: null, divisions: [], customer_facing: null, from: 'GELP', added_at: new Date().toISOString() };
  D.tenants = [{ id: 'T0', name: 'GELP Strategies', slug: 'gelp', created_at: '2026-01-01', agency_tenant_id: null }, { id: 'T1', name: 'Demo Home Service Company', slug: 'demo', created_at: '2026-10-01', agency_tenant_id: 'T0' }];
  R.account_members_list = (a) => (scene === 'agency' && !a.p_tenant ? [] : [jul]);
  if (scene === 'client') R.my_accounts = () => [{ id: 'T1', name: 'Demo Home Service Company', kind: 'home' }];
  if (scene === 'julie') {
    R.current_account = () => ({ id: 'T1', name: 'Demo Home Service Company', is_gelp: false, plan: 'full', is_agency: false, home: 'T0', home_agency: 'GELP Strategies', platform_admin: true,
      member: { is_admin: true, role_id: null, divisions: [], customer_facing: null } });
    R.my_accounts = () => [{ id: 'T0', name: 'GELP Strategies', kind: 'home' }, { id: 'T1', name: 'Demo Home Service Company', kind: 'member' }];
  }
  if (scene === 'agency') {
    R.current_account = () => ({ id: 'T0', name: 'GELP Strategies', is_gelp: true, plan: 'full', is_agency: true, home: 'T0', home_agency: 'GELP Strategies', platform_admin: true, platform_owner: true });
    R.my_accounts = () => [{ id: 'T0', name: 'GELP Strategies', kind: 'home' }, { id: 'T1', name: 'Demo Home Service Company', kind: 'managed' }];
    R.platform_accounts = () => [{ id: 'T0', name: 'GELP Strategies', is_agency: true, users: 3, orgs: 2, created_at: '2026-01-01' }, { id: 'T1', name: 'Demo Home Service Company', is_agency: false, agency_id: 'T0', users: 2, orgs: 2, created_at: '2026-10-01' }];
    R.account_member_candidates = () => [{ id: 'U3', name: 'Julie Olivari', email: 'julie@gelp.test', from: 'GELP', member: false }, { id: 'U2', name: 'Worker Wes', email: 'wes@test.local', from: 'GELP', member: true }];
  }
  R.account_member_add = () => ({ ok: true }); R.account_member_set = () => ({ ok: true }); R.account_member_remove = () => ({ ok: true });
};
// crews mode: standing crews, a crew on a job, a missed clock-in and a swap waiting
// Nov 13: note notifications, quick filters, neutral defaults, What's new, Routes (Beta)
const todaySeed = () => {
  const D = window.__DB, R = window.__RPC;
  D.account_settings[0].settings.features.routes = true;
  D.app_users[0].release_seen = '2026-11-01';
  D.lookup_values = [{ list_name: 'org_type', label: 'Client', active: true, sort_order: 1 }, { list_name: 'org_type', label: 'Vendor', active: true, sort_order: 2 }, { list_name: 'org_type', label: 'Partner', active: true, sort_order: 3 }];
  D.shortcuts = [{ id: 'Q1', screen: 'orgs', name: 'Biloxi vendors', filters: { types: ['Vendor'], city: 'Biloxi', act: '30' }, shared: true, user_id: 'U1', sort: 0 }];
  D.routes = [{ id: 'R1', name: 'Biloxi loop', start_time: '08:00:00', repeat: 'weekly', days: [1, 2, 3, 4, 5], month_days: [], every_weeks: 1, grace_min: 15, escalate_min: 15, dispatcher_id: 'U1', active: true, starts_on: '2026-11-01', archived_at: null }];
  D.route_stops = [{ id: 'RS1', route_id: 'R1', company_id: 'C1', request: 'Empty the bins', sort: 1, archived_at: null }, { id: 'RS2', route_id: 'R1', company_id: 'C2', request: 'Check the gate', sort: 2, archived_at: null }];
  D.route_assignments = [{ id: 'RA1', route_id: 'R1', user_id: 'U2', from_date: null, to_date: null }];
  const stops = [{ id: 'X1', stop_id: 'RS1', company_id: 'C1', company: 'Oak Apartments', address: 'Biloxi, MS', lat: 30.4, lng: -89, request: 'Empty the bins', status: 'pending', media: [] },
    { id: 'X2', stop_id: 'RS2', company_id: 'C2', company: 'Gulf Mgmt Co', address: 'Gulfport', lat: 30.5, lng: -89.1, request: 'Check the gate', status: 'incomplete', reason: 'Locked', media: ['T1/routes/a.jpg'] }];
  const run = { id: 'RN1', route_id: 'R1', name: 'Biloxi loop', run_date: '2026-11-13', starts_at: new Date().toISOString(), status: 'scheduled', alerted: true, late_users: [], people: ['U2'], stops };
  R.my_routes = () => [run];
  R.route_board = () => ({ date: '2026-11-13', runs_today: true, run, exceptions: [{ id: 'EX1', company: 'Gulf Mgmt Co', scope: 'permanent', reason: 'Gate moved', lat: 30.5, lng: -89.1, feet: 900, user_id: 'U2', at: new Date().toISOString() }] });
  R.route_stop_tap = (a) => (a.p_run_stop === 'X1' && a.p_action === 'arrived' ? { ok: true, far: true, feet: 1200, radius: 500 } : { ok: true, far: false });
  R.route_location_report = () => 'EXN'; R.route_run_action = (a) => (a.p_action === 'push' ? { ok: true, customers: [{ company_id: 'C1', company: 'Oak Apartments', emails: [{ email: 'pam@oak.test', person_id: 'P1' }] }] } : { ok: true });
  R.route_notify_customers = () => 1; R.route_exception_decide = () => null; R.route_stops_order = () => null; R.gps_tracking_set = () => null;
  D.cal_feeds = [{ id: 'CF1', user_id: 'U1', label: 'Work Google', url_hint: 'calendar.google.com/…basic.ics', last_ok_at: new Date(Date.now() - 4 * 60000).toISOString(), events: 12 }];
  R.my_cal_feed_add = () => 'CF2'; R.my_cal_feed_remove = () => null;
  R.customer_for_person = () => ({ id: 'C1', name: 'Oak Apartments', divisions: [], person_id: 'P1' });
  R.timeline = () => []; R.timeline_note = () => 'EV1'; R.my_notify_via_set = () => null; R.my_release_seen_set = () => null;
};
const crewsSeed = () => {
  const D = window.__DB, R = window.__RPC;
  D.account_settings[0].settings.crews = { mode: 'standing', clock: 'self', steps: 'foreman', pay: 'split', by_service: { Striping: { clock: 'foreman', steps: 'each' } } };
  D.app_users.push({ id: 'U3', full_name: 'Bob Foreman', email: 'bob@test.local', role: 'staff', active: true, is_admin: false, tenant_id: 'T1', divisions: [] },
    { id: 'U4', full_name: 'Joe Member', email: 'joe@test.local', role: 'staff', active: true, is_admin: false, tenant_id: 'T1', divisions: [] });
  D.crews = [{ id: 'CR1', name: "Bob's crew", foreman_id: 'U3', member_ids: ['U4'], supervisor_id: 'U1', divisions: [], sort: 0 },
    { id: 'CR2', name: "Wes's crew", foreman_id: 'U2', member_ids: [], supervisor_id: null, divisions: [], sort: 1 }];
  D.jobs[0].crew_id = 'CR2';
  D.job_crew = [{ id: 'JC1', job_id: 'J1', user_id: 'U2', role: 'lead', from_crew_id: 'CR2', arrived_at: new Date().toISOString() },
    { id: 'JC2', job_id: 'J1', user_id: 'U4', role: 'member', from_crew_id: 'CR1', arrived_at: new Date().toISOString() },
    { id: 'JC3', job_id: 'J3', user_id: 'U2', role: 'lead' }];
  D.crew_flags = [{ id: 'CF1', kind: 'missed_clock', job_id: 'J1', user_id: 'U4', foreman_id: 'U1', supervisor_id: 'U1', status: 'open', summary: 'Worker Wes marked the crew arrived but Joe Member never clocked in', details: {}, created_at: new Date().toISOString() },
    { id: 'CF2', kind: 'swap', job_id: 'J1', user_id: 'U4', foreman_id: 'U3', supervisor_id: 'U1', status: 'open', summary: "Admin Al moved Joe Member off Bob's crew for one job", details: {}, created_at: new Date().toISOString() }];
  D.work_reviews.push({ id: 'W5', kind: 'timesheet', ref_id: 'TE1', job_id: 'J1', company_id: 'C1', worker_id: 'U4', status: 'pending', summary: 'Joe Member forgot to clock in, Worker Wes added these hours: 6.00 hrs', divisions: [],
    details: { flags: ['added_by_foreman'], added_by: 'U2', note: 'Phone died', hours: 6 }, created_at: new Date().toISOString() });
  R.job_crew_set = (a) => {
    const j = D.jobs.find((x) => x.id === a.p_job); const c = D.crews.find((x) => x.id === a.p_crew);
    const ppl = a.p_people || (c ? [c.foreman_id, ...c.member_ids] : []); const lead = a.p_lead || c?.foreman_id || ppl[0] || null;
    D.job_crew.filter((r) => r.job_id === j.id).forEach((r) => (r.removed_at = new Date().toISOString()));
    ppl.forEach((u, i) => D.job_crew.push({ id: 'JCx' + i + Math.random(), job_id: j.id, user_id: u, role: u === lead ? 'lead' : 'member' }));
    j.assigned_to = lead; j.crew_id = a.p_crew || null; return { lead, people: ppl, swaps: 0 };
  };
  R.crew_missed_answer = (a) => { const f = D.crew_flags.find((x) => x.id === a.p_flag); f.status = a.p_here ? 'was_here' : 'not_here'; return { status: f.status }; };
  R.crew_flag_seen = (a) => { D.crew_flags.find((x) => x.id === a.p_id).status = 'seen'; return null; };
  R.crew_save = () => 'CR1'; R.crew_archive = () => null; R.crew_mark = () => ({ step: 'arrived' }); R.crew_clock = () => 2; R.time_fix = () => null;
};
// measure mode: Measuring on, the plain item types with prices, a GELP style account so proposal drafts show too
const measureSeed = () => {
  const D = window.__DB, R = window.__RPC;
  D.account_settings[0].settings.features.measure = true;
  D.companies[0].address = '100 Beach Blvd';
  D.price_items = [{ id: 'PI1', name: 'Paving', unit: 'sq_ft', price: 0.22, sort: 1, description: '', code: '' }, { id: 'PI2', name: 'Striping', unit: 'ln_ft', price: 0.45, sort: 2, description: '', code: '' },
    { id: 'PI3', name: 'Light pole', unit: 'each', price: 650, sort: 3, description: '', code: '' }, { id: 'PI4', name: 'Saw cut and patch', unit: 'each', price: 175, sort: 4, description: '', code: '' },
    { id: 'PI5', name: 'Remove or relocate', unit: 'each', price: 350, sort: 5, description: '', code: '' }];
  D.measure_types = [{ id: 'MT1', name: 'Paved area', kind: 'area', color: '#2563EB', price_item_id: 'PI1', states: [], sort: 1 },
    { id: 'MT2', name: 'Striping', kind: 'length', color: '#EAB308', price_item_id: 'PI2', states: [], sort: 2 },
    { id: 'MT3', name: 'Light pole', kind: 'count', color: '#2563EB', price_item_id: 'PI3', sort: 3, states: [{ key: 'count', name: 'Counted', short: '', color: '#2563EB', base: true, addons: [] },
      { key: 'moved', name: 'Remove or relocate', short: 'moved', color: '#DC2626', base: false, addons: ['PI5', 'PI4'] }] }];
  D.measurements = [];
  D.proposals = [{ id: 'PR1', company_id: 'C1', status: 'draft', items: { custom: [], mockups: [] }, updated_at: new Date().toISOString(), version: 1 }];
  D.invoices[0].pictures = [{ url: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#9ab"/><text x="20" y="40">map</text></svg>'), title: 'Front lot map' }];
  R.measure_seed = () => 0;
  R.proposal_price_list = () => ({ rate_partner: 85, rate_standard: 125, site_default_hours: 20, funnel_default_hours: 18, lock_min: 1, lock_max: 24, items: {} });
  R.proposal_quote = () => ({ lines: [], setup: { gross: 0, disc: 0, net: 0 }, month: { gross: 0, disc: 0, net: 0 }, week: { gross: 0, disc: 0, net: 0 }, light: { setup: 'none', month: 'none' }, comm: { lead: 'other', is_closer: false }, phases: [], hosting: { units: 0, covered: 0, paid: 0 }, rate: 125, plan: { setup: 0, month: 0, week: 0 }, commission: {}, margin: {} });
  const acct = R.current_account; R.current_account = () => ({ ...acct(), is_gelp: true });
};
// bids mode: Bids on (with measuring), a scorecard, three bids (one overridden and waiting in Review, one won)
const bidsSeed = () => {
  const D = window.__DB, R = window.__RPC;
  D.account_settings[0].settings.features.bids = true;
  const now = new Date(), later = (d) => new Date(Date.now() + d * 86400000).toISOString();
  const metrics = [{ key: 'value', kind: 'value', label: 'Job size', rank: 1, good: 50000, poor: 5000 }, { key: 'margin', kind: 'margin', label: 'Expected margin', rank: 1, good: 30, poor: 10 },
    { key: 'distance', kind: 'distance', label: 'Distance from the shop', rank: 2, good: 25, poor: 100 }, { key: 'crew', kind: 'crew', label: 'Crew free', rank: 2 },
    { key: 'q_repeat', kind: 'yesno', label: 'Worked for them before?', rank: 3, yes_good: true }];
  let set = { metrics, go_at: 70, maybe_at: 45, override_review: true, email_on: true, upload_on: true, upload_token: 'a'.repeat(64), email_address: 'bids+demo@bids.gelpstrategies.com', email_ready: true,
    can_edit: true, set_up: true, base_address: '1 Main St, Biloxi, MS', base_lat: 30.396, base_lng: -88.885, platform_owner: true, email_domain: 'bids.gelpstrategies.com', email_style: 'plus' };
  const parts = [{ key: 'value', points: 4.6, value: 68000 }, { key: 'margin', points: 4.6, value: 28 }, { key: 'distance', points: 5, value: 4.2 }, { key: 'crew', points: 5, value: 'yes' }, { key: 'q_repeat', points: 5, value: 'yes' }];
  D.bids = [
    { id: 'B1', title: 'Edgewater Mall lot reseal', client_name: 'Edgewater Mall', company_id: null, status: 'reviewing', source: 'email', due_at: later(18), score: 92.5, result: 'go', score_parts: parts,
      answers: { crew: 'yes', q_repeat: 'yes' }, est_value: 68000, est_margin: 28, site_address: '2600 Beach Blvd, Biloxi, MS', site_lat: 30.39, site_lng: -88.95, distance_mi: 4.2, owner_id: 'U1',
      from_email: 'gc@builder.com', from_name: 'Gary', email_subject: 'RFP: Mall reseal', email_body: 'See the attached plans.', price_lines: [], history: [{ at: now.toISOString(), by: 'U1', what: 'status', from: 'new', to: 'reviewing' }], created_at: now.toISOString() },
    { id: 'B2', title: 'Hattiesburg clinic lot', client_name: 'Forrest Health', status: 'new', source: 'upload', due_at: later(3), score: 30.3, result: 'no_go', override_result: 'go', override_note: 'GM asked for us', override_by: 'U2',
      review_state: 'pending', score_parts: [], answers: {}, price_lines: [], history: [], owner_id: 'U2', created_at: now.toISOString() },
    { id: 'B3', title: 'School striping', client_name: 'Gulfport Schools', company_id: 'C1', status: 'won', source: 'manual', submitted_amount: 23500, score: 71, result: 'go', score_parts: [], answers: {},
      price_lines: [{ code: '', name: 'Striping', desc: '820 ft', qty: 820, price: 0.45 }], history: [], owner_id: 'U1', created_at: now.toISOString() }];
  D.bid_files = [{ id: 'BF1', bid_id: 'B1', path: 'T1/B1/x-plans.pdf', name: 'plans.pdf', size: 204800, source: 'email', created_at: now.toISOString() }];
  R.bid_settings_get = () => set;
  R.bid_settings_save = (a) => { set = { ...set, ...a.p }; return set; };
  R.bid_review_list = () => D.bids.filter((b) => b.review_state === 'pending').map((b) => ({ id: b.id, title: b.title, client: b.client_name, score: b.score, result: b.result, override: b.override_result, note: b.override_note, by: 'Worker Wes', at: now.toISOString(), due_at: b.due_at }));
  R.bid_override = (a) => { const b = D.bids.find((x) => x.id === a.p_id); Object.assign(b, { override_result: a.p_result, override_note: a.p_note, review_state: null }); return { ok: true, review: null }; };
  R.bid_override_decide = (a) => { D.bids.find((x) => x.id === a.p_id).review_state = a.p_ok ? 'approved' : 'returned'; return { ok: true }; };
  R.bid_converted = (a) => { const b = D.bids.find((x) => x.id === a.p_id); b[a.p_kind + '_id'] = a.p_ref; return { ok: true }; };
  R.bid_upload_link_new = () => 'b'.repeat(64); R.bid_intake_domain_set = () => set;
  R.bid_upload_info = () => ({ name: 'Essential Services', intro: 'Send us your RFP.' });
};
// portal mode: the Client portal card, its settings and the client's own portal page (/portal/)
const portalSeed = () => {
  const D = window.__DB, R = window.__RPC, now = new Date(), at = (d, h = 10) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  D.account_settings[0].settings.features.portal = true;
  D.chat_threads.push({ id: 'CH1', visitor_name: 'Pam Smith (Gulf Mgmt Co)', visitor_email: 'pam@gulf.test', source: 'other', source_ref: 'portal', status: 'open', unread_staff: true,
    last_message_at: now.toISOString(), company_id: 'C2', kind: 'chat' });
  D.chat_messages = [{ id: 'CM1', thread_id: 'CH1', sender: 'visitor', body: 'When is the next pickup?', created_at: now.toISOString() }];
  let users = [{ id: 'PU1', name: 'Pam Smith', email: 'pam@gulf.test', is_admin: true, joined: true, last_seen_at: now.toISOString() },
    { id: 'PU2', name: 'Bob Jones', email: 'bob@gulf.test', is_admin: false, joined: false, by_client: true }];
  let set = { sections: { schedule: true, estimates: true, invoices: true, files: true, messages: true, approvals: true }, files_default: 'hidden', welcome: 'Thanks for choosing us. Text the office any time.', can_edit: true, on: true };
  R.portal_admin_get = (a) => ({ settings: set, users: a.p_company === 'C2' ? users : [], parent_portal: a.p_company === 'C1' ? { id: 'C2', name: 'Gulf Mgmt Co' } : null });
  R.portal_admin_invite = (a) => { users.push({ id: 'PU' + (users.length + 1), name: a.p_name, email: a.p_email, is_admin: !users.some((u) => u.is_admin), joined: false }); return 'PU' + users.length; };
  R.portal_admin_set = (a) => { users.find((u) => u.id === a.p_id).is_admin = a.p_admin; return { ok: true }; };
  R.portal_admin_remove = (a) => { users = users.filter((u) => u.id !== a.p_id); return { ok: true }; };
  R.portal_vis_list = () => ({ files_default: set.files_default,
    jobs: [{ id: 'J1', title: 'Nightly valet', at: at(1, 19), location: 'Oak Apartments', shown: true, note: 'Gate code is on file' }, { id: 'J2', title: 'Pickup', at: at(0), location: 'Oak Apartments', shown: false }],
    invoices: [{ id: 'I1', title: 'Invoice 1001', at: '2026-10-01', location: 'Oak Apartments', shown: true, status: 'partial' }], estimates: [],
    files: [{ id: 'A1', title: 'Service agreement', at: at(-5), location: 'Gulf Mgmt Co', share: 'shared', shown: true }, { id: 'A2', title: 'Pricing sheet', at: at(-5), location: 'Gulf Mgmt Co', share: null, shown: false }],
    photos: [{ id: 'E2', path: 'T1/jobs/a.jpg', title: 'Nightly valet', at: at(-1), location: 'Oak Apartments', share: null, shown: false }] });
  R.portal_vis_set = () => ({ ok: true });
  R.portal_settings_get = () => set;
  R.portal_settings_save = (a) => { set = { ...set, ...a.p }; return set; };
  // the client's side
  const brand = { name: 'Essential Services', color: '#2A6B4F', phone: '228-555-0100', email: 'office@es.com' };
  R.portal_brand = () => brand; R.brand_for_host = () => null;
  R.portal_me = () => ({ crm: false, portals: [{ id: 'PU1', org: 'Gulf Mgmt Co', account: 'Essential Services', is_admin: true, brand }, { id: 'PU9', org: 'Pine Plaza', account: 'Other Lawn Co', is_admin: false, brand }] });
  const preview = new URLSearchParams(location.search).get('preview');
  R.portal_home = () => ({ org: 'Gulf Mgmt Co', account: 'Essential Services', brand, locations: [{ id: 'C1', name: 'Oak Apartments' }], welcome: set.welcome, preview: !!preview, is_admin: !preview,
    levels: { schedule: 1, estimates: 2, invoices: 2, files: 1, messages: 2, approvals: 2 }, me: preview ? null : { name: 'Pam Smith', email: 'pam@gulf.test' },
    counts: { upcoming: 2, next_visit: at(1, 19), open_invoices: 1, balance: 257, estimates: 1, approvals: 1 } });
  R.portal_schedule = () => [{ id: 'J9', title: 'Pressure wash', start: at(-6), end: at(-6, 12), status: 'left', location: 'Oak Apartments' },
    { id: 'J1', number: 1, title: 'Nightly valet', service: 'Valet trash', start: at(1, 19), end: at(1, 21), status: 'scheduled', location: 'Oak Apartments', note: 'Please leave the side gate open' },
    { id: 'J2', number: 2, title: 'Bulk pickup', start: at(4), status: 'accepted', location: 'Gulf Mgmt Co' }];
  R.portal_docs = (a) => (a.p_kind === 'invoices'
    ? [{ id: 'I1', number: '1001', status: 'partial', issue_date: '2026-10-01', due_date: '2026-10-15', total: 357, balance: 257, location: 'Oak Apartments', overdue: true, can_pay: true },
       { id: 'I2', number: '1002', status: 'paid', issue_date: '2026-10-20', total: 350, balance: 0, location: 'Gulf Mgmt Co', can_pay: false }]
    : [{ id: 'P1', title: 'Estimate', version: 2, status: 'sent', sent_at: at(-2), expires_at: at(20), location: 'Oak Apartments', can_accept: true }]);
  R.portal_doc = (a) => { if (a.p_kind === 'invoice') { const d = R.doc_view({ p_token: 'tok1'.padEnd(64, 'x') }); delete d.token; delete d.autopay; return { ...d, link: preview ? null : '/doc/?t=' + 'tok1'.padEnd(64, 'x') }; }
    return { kind: 'proposal', title: 'Estimate', number: 2, status: 'sent', issue_date: '2026-10-28', customer: { name: 'Pam Smith', org: 'Gulf Mgmt Co' }, brand,
      view: { quote: { lines: [{ title: 'Weekly valet trash', sub: '5 nights a week', setup: 0, mo: 900 }, { title: 'Startup bins', setup: 450 }], setup: { net: 450 }, month: { net: 900 } }, note: 'Starts Nov 1' },
      link: preview ? null : '/proposal/view/?t=x' }; };
  R.portal_files = () => ({ files: [{ id: 'A1', title: 'Service agreement', kind: 'document', url: 'https://example.com/a.pdf', location: 'Gulf Mgmt Co', at: at(-5) }],
    photos: [{ id: 'E2', path: 'T1/jobs/a.jpg', job: 'Nightly valet', at: at(-1), location: 'Oak Apartments' }, { id: 'E3', path: 'T1/jobs/b.jpg', job: 'Pressure wash', at: at(-6), location: 'Oak Apartments' }] });
  let msgs = [{ id: 'M1', from: 'me', name: 'Pam', body: 'When is the next pickup?', at: at(-1) }, { id: 'M2', from: 'team', name: 'Admin', body: 'Tuesday morning!', at: at(-1, 11) },
    { id: 'M3', from: 'client', name: 'Bob', body: 'Thanks', at: at(-1, 12) }];
  R.portal_messages = () => ({ can_send: !preview, messages: msgs });
  R.portal_send = (a) => { msgs = [...msgs, { id: 'M' + (msgs.length + 1), from: 'me', name: 'Pam', body: a.p_body, at: new Date().toISOString() }]; return { ok: true }; };
  let aps = [{ id: 'AP1', kind: 'change_order', title: 'Add two dumpsters', summary: 'Two more 20 yard dumpsters for move out week', amount: 450, status: 'pending', location: 'Oak Apartments', at: at(-1), can_decide: !preview },
    { id: 'AP2', kind: 'change_order', title: 'Extra night', amount: 120, status: 'approved', decided_name: 'Pam Smith', decided_at: at(-3), location: 'Oak Apartments', at: at(-4) }];
  R.portal_approvals_list = () => aps;
  R.portal_approval_decide = (a) => { aps = aps.map((x) => (x.id === a.p_id ? { ...x, status: a.p_ok ? 'approved' : 'declined', can_decide: false, decided_at: new Date().toISOString(), decided_name: 'Pam Smith' } : x)); return { ok: true }; };
  let team = [{ id: 'PU1', name: 'Pam Smith', email: 'pam@gulf.test', is_admin: true, joined: true, me: true, perms: {} },
    { id: 'PU2', name: 'Bob Jones', email: 'bob@gulf.test', is_admin: false, joined: false, perms: { schedule: 1, estimates: 2, invoices: 1, files: 1, messages: 2, approvals: 0 } }];
  R.portal_team = () => team;
  R.portal_team_set = (a) => { const u = team.find((x) => x.id === a.p_user); Object.assign(u, { is_admin: a.p_admin, perms: a.p_perms }); window.__SET = a; return { ok: true }; };
  R.portal_team_invite = (a) => { team = [...team, { id: 'PU7', name: a.p_name, email: a.p_email, is_admin: a.p_admin, joined: false, perms: {} }]; return 'PU7'; };
  R.portal_team_remove = (a) => { team = team.filter((x) => x.id !== a.p_user); return { ok: true }; };
};
// esign mode: E-sign on, a draft, one waiting on the second signer, one completed, a template; /sign/ against a stand-in function
const esignSeed = () => {
  const D = window.__DB, R = window.__RPC, now = new Date().toISOString(), T = 'T1';
  D.account_settings[0].settings.features.esign = true;
  window.__SIGNED_URL = 'http://localhost:8099/__esign_test.pdf';
  const pages = [{ w: 612, h: 792 }, { w: 612, h: 792 }];
  D.esign_templates = [{ id: 'TP1', name: 'Service agreement', description: 'Our standard one', file_path: 'T1/t/x-agreement.pdf', file_name: 'agreement.pdf', pages,
    roles: [{ key: 'client', label: 'Client', order: 1 }, { key: 'rep', label: 'Company rep', order: 2 }], ordered: false, message: 'Please sign',
    fields: [{ id: 'tf1', signer: 'client', type: 'signature', page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.05, required: true }, { id: 'tf2', signer: 'rep', type: 'signature', page: 2, x: 0.55, y: 0.8, w: 0.3, h: 0.05, required: true }],
    owner_id: 'U1', updated_at: now }];
  D.esign_envelopes = [
    { id: 'E1', title: 'Lease for Oak', status: 'draft', source: 'upload', file_path: 'T1/u/x-lease.pdf', file_name: 'lease.pdf', pages, fields: [], ordered: false, owner_id: 'U1', created_at: now, message: 'Please sign' },
    { id: 'E2', title: 'Pressure wash contract', status: 'partly_signed', source: 'template', template_id: 'TP1', company_id: 'C1', person_id: 'P1', file_path: 'T1/t/x-agreement.pdf', file_name: 'agreement.pdf', pages,
      fields: D.esign_templates[0].fields, ordered: true, owner_id: 'U1', created_at: now, sent_at: now, expires_at: new Date(Date.now() + 9e8).toISOString(), original_sha256: 'a'.repeat(64), message: 'Thanks!' },
    { id: 'E3', title: 'Signed estimate', status: 'completed', source: 'upload', file_path: 'T1/u/x-est.pdf', file_name: 'estimate.pdf', pages, fields: [], ordered: false, owner_id: 'U1', created_at: now, sent_at: now,
      completed_at: now, original_sha256: 'b'.repeat(64), final_sha256: 'c'.repeat(64), final_path: 'T1/E3/signed-estimate.pdf' }];
  D.esign_signers = [
    { id: 'S1', envelope_id: 'E2', key: 'client', role_label: 'Client', name: 'Pam Smith', email: 'pam@oak.test', sign_order: 1, status: 'signed', viewed_at: now, consent_at: now, otp_verified_at: now, signed_at: now, sign_ip: '203.0.113.5', sign_device: 'iPhone', sign_browser: 'Safari 17' },
    { id: 'S2', envelope_id: 'E2', key: 'rep', role_label: 'Company rep', name: 'Admin Al', email: 'admin@test.local', sign_order: 2, status: 'sent', reminders: 1 },
    { id: 'S3', envelope_id: 'E3', key: 's1', name: 'Gary', email: 'gary@x.test', sign_order: 1, status: 'signed', signed_at: now }];
  D.esign_events = [{ id: 1, envelope_id: 'E2', kind: 'sent', name: 'Admin Al', email: 'admin@test.local', at: now, detail: {} },
    { id: 2, envelope_id: 'E2', kind: 'viewed', name: 'Pam Smith', email: 'pam@oak.test', ip: '203.0.113.5', device: 'iPhone', browser: 'Safari 17', at: now, detail: {} },
    { id: 3, envelope_id: 'E2', kind: 'signed', name: 'Pam Smith', email: 'pam@oak.test', ip: '203.0.113.5', device: 'iPhone', browser: 'Safari 17', at: now, detail: {} }];
  D.people[0].personal_email = 'pam@oak.test';
  let set = { default_message: 'Please review and sign this document.', expires_days: 30, can_edit: true, on: true };
  R.esign_settings_get = () => set;
  R.esign_settings_save = (a) => { set = { ...set, ...a.p }; return set; };
  R.esign_envelope_create = (a) => {
    const id = 'EN' + (D.esign_envelopes.length + 1); const tp = D.esign_templates.find((t) => t.id === a.p.template_id);
    D.esign_envelopes.push({ id, title: a.p.title || tp?.name || 'Document', status: 'draft', source: tp ? 'template' : 'upload', template_id: tp?.id || null, file_path: tp?.file_path || a.p.file_path,
      file_name: tp?.file_name || a.p.file_name, pages: tp?.pages || a.p.pages, fields: tp ? tp.fields : [], ordered: false, owner_id: 'U1', created_at: new Date().toISOString(), message: a.p.message || set.default_message,
      company_id: a.p.company_id || null });
    (a.p.signers || []).forEach((x, i) => D.esign_signers.push({ id: id + 'S' + i, envelope_id: id, key: x.key || 's' + (i + 1), name: x.name, email: x.email, sign_order: i + 1, status: 'waiting' }));
    return id;
  };
  R.esign_envelope_update = (a) => { const e = D.esign_envelopes.find((x) => x.id === a.p_id); Object.assign(e, { title: a.p.title, message: a.p.message, ordered: a.p.ordered, fields: a.p.fields, company_id: a.p.company_id });
    D.esign_signers = D.esign_signers.filter((x) => x.envelope_id !== e.id).concat(a.p.signers.map((x, i) => ({ id: e.id + 'S' + i, envelope_id: e.id, key: x.key, name: x.name, email: x.email, sign_order: x.order, status: 'waiting' })));
    return { ok: true }; };
  R.esign_envelope_delete = (a) => { D.esign_envelopes.find((x) => x.id === a.p_id).archived_at = new Date().toISOString(); return { ok: true }; };
  R.esign_template_save = (a) => { let t = D.esign_templates.find((x) => x.id === a.p.id);
    if (!t) { t = { id: 'TP' + (D.esign_templates.length + 1), file_path: a.p.file_path, file_name: a.p.file_name, pages: a.p.pages, owner_id: 'U1' }; D.esign_templates.push(t); }
    Object.assign(t, { name: a.p.name || t.name, roles: a.p.roles || t.roles, fields: a.p.fields || t.fields || [], ordered: !!a.p.ordered, message: a.p.message }); return t.id; };
  R.esign_template_archive = (a) => { D.esign_templates.find((x) => x.id === a.p_id).archived_at = new Date().toISOString(); return { ok: true }; };
  R.esign_void = (a) => { Object.assign(D.esign_envelopes.find((x) => x.id === a.p_id), { status: 'voided', void_reason: a.p_reason, voided_at: new Date().toISOString() }); return { ok: true }; };
  R.esign_verify = (a) => (a.p_sha ? [{ match: 'signed', title: 'Signed estimate', status: 'completed', completed_at: new Date().toISOString(), from: 'Essential Services', signers: [{ name: 'Gary' }] }] : []);
  window.__FN = { 'esign-email': (b) => { if (b.action === 'send') { const e = D.esign_envelopes.find((x) => x.id === b.id); e.status = 'sent'; e.sent_at = new Date().toISOString(); return { ok: true, emailed: 1, failed: [] }; }
    return { ok: true, emailed: 1 }; } };
};
// the stand-in for the esign-sign edge function and the test PDF
let ESIGN_PDF = null; const ESIGN_CALLS = [];
const esignRoutes = async (page) => {
  await page.route('**/__esign_test.pdf', (r) => r.fulfill({ contentType: 'application/pdf', headers: { 'access-control-allow-origin': '*' }, body: ESIGN_PDF }));
  await page.route('**/functions/v1/esign-sign', async (r) => {
    const b = JSON.parse(r.request().postData() || '{}'); ESIGN_CALLS.push(b);
    const brand = { name: 'Essential Services', color: '#2A6B4F', logo: null };
    const reply = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(d) });
    if (b.action === 'view') {
      if (b.t === 'c'.repeat(64)) return reply({ state: 'completed', title: 'Signed estimate', signer: { name: 'Gary', email: 'gary@x.test' }, final_url: 'http://localhost:8099/__esign_test.pdf', final_sha256: 'c'.repeat(64), mail: { brand, account: 'Essential Services' } });
      return reply({ state: 'open', envelope_id: 'E2', title: 'Pressure wash contract', message: 'Thanks!', url: 'http://localhost:8099/__esign_test.pdf', pages: [{ w: 612, h: 792 }, { w: 612, h: 792 }],
        fields: [{ id: 'f1', signer: 'rep', type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.3, h: 0.06, required: true }, { id: 'f2', signer: 'rep', type: 'initials', page: 1, x: 0.8, y: 0.9, w: 0.1, h: 0.04, required: true },
          { id: 'f3', signer: 'rep', type: 'text', page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.04, required: true, label: 'Unit number' }, { id: 'f4', signer: 'rep', type: 'checkbox', page: 1, x: 0.1, y: 0.3, w: 0.04, h: 0.03, required: true, label: 'I read it' },
          { id: 'f5', signer: 'rep', type: 'date', page: 1, x: 0.5, y: 0.75, w: 0.2, h: 0.03, required: true }, { id: 'f6', signer: 'rep', type: 'name', page: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.03, required: true }],
        signer: { name: 'Admin Al', email: 'admin@test.local', consent_at: null }, others: [{ name: 'Pam Smith', signed: true }], mail: { brand, account: 'Essential Services', from_name: 'Get Coast Customers', sender: { name: 'Admin Al' } } });
    }
    if (b.action === 'consent') return reply({ ok: true });
    if (b.action === 'code') return reply({ ok: true, to: 'a***@test.local', minutes: 10 });
    if (b.action === 'check') return reply(b.code === '123456' ? { ok: true, session: 's'.repeat(64) } : { ok: false, error: 'That code doesn\'t match. Try again.', tries_left: 4 });
    if (b.action === 'submit') return reply({ ok: true, all_signed: true, finished: true });
    if (b.action === 'decline') return reply({ ok: true });
    return reply({ error: 'Unknown action' }, 400);
  });
};
// calendars mode: Calendars on, two booking calendars, hours, a day off, appointments this week, and the public /book/ page
const phoneSeed = () => {
  const D = window.__DB, R = window.__RPC;
  D.account_settings[0].settings.features.phone = true;
  D.phone_lines = [{ id: 'L1', tenant_id: 'T1', name: 'Main line', kind: 'group', number: '+12285550100', members: ['U1', 'U2'], ring_secs: 25, record: true, voicemail: true, greeting: null, active: true, created_at: '2026-11-16T10:00:00Z' }];
  D.phone_calls = [
    { id: 'PC1', tenant_id: 'T1', line_id: 'L1', direction: 'in', other_number: '+12285550101', status: 'done', started_at: '2026-11-16T15:00:00Z', seconds: 125, user_id: 'U1', person_id: 'P1', company_id: null, recording_path: 'T1/PC1-call.mp3', voicemail_path: null, notes: null, dismissed_at: null },
    { id: 'PC2', tenant_id: 'T1', line_id: 'L1', direction: 'in', other_number: '+16015550123', status: 'voicemail', started_at: '2026-11-16T16:00:00Z', seconds: 0, user_id: null, person_id: null, company_id: null, recording_path: null, voicemail_path: 'T1/PC2-voicemail.mp3', notes: null, dismissed_at: null }];
  R.phone_me = () => ({ user_id: 'U1', tenant_id: 'T1', internal: true, on: true, admin: true, platform: true, can_buy: true });
  R.phone_usage = () => ({ me: { calls_in: 3, calls_out: 2, minutes: 14 }, company: { lines: 1, limit: 1500, minutes: 1400, calls_in: 20, calls_out: 9, missed: 2 }, people: [{ user_id: 'U1', name: 'Admin', calls_in: 3, calls_out: 2, minutes: 14 }] });
  R.phone_review = () => [{ month: '2026-11-01', level: 90, minutes: 1400, limit: 1500, at: '2026-11-16T16:00:00Z' }];
  R.phone_review_clear = () => null;
  R.phone_who = (a) => String(a.p_number).endsWith('0101') ? { person_id: 'P1', person: 'Pat Person', company: 'Acme' } : null;
  R.phone_out_start = (a) => ({ call_id: 'PC9', from: '+12285550100', to: '+1' + String(a.p_to).replace(/\D/g, '').slice(-10) });
  R.phone_out_ccid = () => null; R.phone_out_end = () => null; R.phone_line_save = () => null; R.phone_call_file = () => null; R.phone_call_note = () => null;
  R.timeline = () => [{ id: 'E1', kind: 'call', title: 'Call from (228) 555-0101', data: { call_id: 'PC1', line: 'Main line', seconds: 125, user: 'Admin', recorded: true }, at: '2026-11-16T15:00:00Z', by: 'Admin' }];
  window.__FN = { ...(window.__FN || {}), phone: (b) => b.kind === 'token' ? { token: 'jwt' } : b.kind === 'search' ? { numbers: [{ number: '+12285550111', place: 'Biloxi, MS' }] } : b.kind === 'status' ? { ready: true, balance: { balance: '10.00' } } : { ok: true } };
};
const FAKE_RTC = `export class TelnyxRTC { constructor(o) { this.h = {}; this.o = o; window.__RTC = this; }
  on(e, f) { this.h[e] = f; return this; } connect() { setTimeout(() => this.h['telnyx.ready'] && this.h['telnyx.ready'](), 50); }
  _call(st, dir, opts) { const rtc = this; const c = { state: st, direction: dir, options: opts, telnyxIDs: { telnyxCallControlId: 'cc-1' },
      fire() { rtc.h['telnyx.notification']({ type: 'callUpdate', call: c }); },
      hangup() { c.state = 'hangup'; c.fire(); }, answer() { c.state = 'active'; c.fire(); }, muteAudio() { window.__MUTED = true; }, unmuteAudio() {}, hold() { c.state = 'held'; c.fire(); }, unhold() { c.state = 'active'; c.fire(); }, dtmf(d) { (window.__DTMF ||= []).push(d); } };
    return c; }
  newCall(o) { const c = this._call('trying', 'outbound', o); window.__OUT = o; setTimeout(() => { c.state = 'active'; c.fire(); }, 100); return c; }
  ring() { const c = this._call('ringing', 'inbound', { remoteCallerNumber: '+12285550101', remoteCallerName: 'Main line' }); c.fire(); return c; } }`;
const calendarsSeed = () => {
  const D = window.__DB, R = window.__RPC;
  D.account_settings[0].settings.features.calendars = true;
  // 112: custom fields for booking answers, and a possible duplicate to compare
  D.account_settings[0].settings.features.custom_fields = true;
  D.custom_fields = [{ id: 'CF1', entity: 'people', key: 'intake', label: 'Intake done', type: 'checkbox', options: [], archived_at: null, sort: 0 }];
  D.people.push({ id: 'P9', first_name: 'Pam', last_name: 'Smith', personal_cell: '2285550199', personal_email: 'pam@x.test', custom: { gate: '9999' }, divisions: [], created_at: '2026-11-16T10:00:00Z' });
  D.people[0].personal_cell = '2285550101'; D.people[0].created_at = '2026-10-01T10:00:00Z';
  // 113: brand kit swatches and off-brand flags
  D.brand_kits = [{ tenant_id: 'T1', colors: [{ name: 'Navy', hex: '#1A2A52' }, { name: 'Teal', hex: '#12B5AC' }], fonts: [] }];
  D.brand_flags = [{ id: 'BF1', kind: 'calendar', ref: 'CA2', name: 'Free estimate', off: { colors: ['#ff0000'] }, status: 'open', created_at: '2026-11-16T10:00:00Z' }];
  R.brand_check = (a) => ({ off: { colors: a.p_colors.filter((c) => !['#1a2a52', '#12b5ac'].includes(c.toLowerCase())) } });
  R.brand_flag_ok = (a) => { D.brand_flags.find((f) => f.id === a.p_id).status = 'ok'; return null; };
  D.review_items.push({ id: 'RV1', kind: 'possible_duplicate', entity: 'people', entity_id: 'P9', related_id: 'P1', reason: 'Booking answers differ', status: 'open', created_at: '2026-11-16T10:00:00Z' });
  const at = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  const acct = R.current_account; R.current_account = () => ({ ...acct(), slug: 'demo' });
  D.calendars = [
    { id: 'CA1', name: 'Consult', slug: 'consult', description: 'A quick call', color: '#2563EB', kind: 'one', user_ids: ['U1'], duration_min: 30, durations: [60], slot_min: 30, buffer_before: 0, buffer_after: 15,
      notice_min: 120, ahead_days: 60, daily_max: null, location_kind: 'phone', location_text: null, questions: [{ key: 'what', label: 'What for?', kind: 'long', options: [], required: true }],
      ask_company: true, confirm_text: 'Thanks!', redirect_url: null, time_zone: 'America/Chicago', allow_cancel: true, allow_reschedule: true, cutoff_hours: 4, reminders: [1440, 60], active: true, archived_at: null },
    { id: 'CA2', name: 'Free estimate', slug: 'free-estimate', description: '', color: '#2A6B4F', kind: 'round_robin', user_ids: ['U1', 'U2'], duration_min: 60, durations: [], slot_min: 30, buffer_before: 0, buffer_after: 0,
      notice_min: 240, ahead_days: 45, daily_max: 3, location_kind: 'customer', location_text: null, questions: [], ask_company: false, confirm_text: null, redirect_url: null, time_zone: 'America/Chicago',
      allow_cancel: true, allow_reschedule: true, cutoff_hours: 4, reminders: [1440], active: true, archived_at: null }];
  D.cal_hours = [{ tenant_id: 'T1', user_id: 'U1', weekly: { 1: [['09:00', '12:00'], ['13:00', '17:00']], 2: [['09:00', '17:00']] }, time_zone: 'America/Chicago' }];
  D.cal_overrides = [{ id: 'OV1', tenant_id: 'T1', user_id: 'U1', day: at(9, 12).slice(0, 10), ranges: [], note: 'Vacation' }];
  D.appointments = [
    { id: 'AP1', tenant_id: 'T1', calendar_id: 'CA1', user_id: 'U1', person_id: 'P1', company_id: 'C1', starts_at: at(0, 10), ends_at: at(0, 10, 30), status: 'booked', title: 'Consult with Pam Smith',
      name: 'Pam Smith', email: 'pam@oak.test', phone: '228-555-0101', company_name: 'Oak Apartments', answers: [{ key: 'what', label: 'What for?', value: 'Gate code question' }], location: 'Phone call to 228-555-0101',
      source: 'booking', history: [{ at: at(-1, 9), what: 'booked', by: 'customer' }], divisions: [] },
    { id: 'AP2', tenant_id: 'T1', calendar_id: 'CA2', user_id: 'U2', person_id: null, company_id: 'C1', starts_at: at(0, 10, 15), ends_at: at(0, 11, 15), status: 'confirmed', title: 'Free estimate with Bob',
      name: 'Bob Jones', email: 'bob@x.test', answers: [], location: '1 Beach Blvd', source: 'booking', history: [], divisions: [] },
    { id: 'AP3', tenant_id: 'T1', calendar_id: null, user_id: 'U1', person_id: 'P1', company_id: null, starts_at: at(1, 14), ends_at: at(1, 15), status: 'booked', title: 'Walkthrough', name: 'Pam Smith',
      answers: [], source: 'manual', history: [], divisions: [] }];
  R.appointment_mail = () => [{ kind: 'confirm', to: 'pam@oak.test', status: 'sent', at: at(-1, 9) }, { kind: 'notice', to: 'admin@test.local', status: 'sent', at: at(-1, 9) }];
  R.appointment_status = (a) => { D.appointments.find((x) => x.id === a.p_id).status = a.p_status; return null; };
  let busyOnce = true;
  R.appointment_save = (a) => {
    if (!a.p.force && busyOnce && !a.p_id) { busyOnce = false; throw new Error('BUSY: Admin Al already has something then. Book it anyway?'); }
    if (a.p_id) { Object.assign(D.appointments.find((x) => x.id === a.p_id), { starts_at: a.p.starts_at, ends_at: a.p.ends_at, user_id: a.p.user_id, status: 'rescheduled' }); return a.p_id; }
    const id = 'AP' + (D.appointments.length + 1); D.appointments.push({ id, tenant_id: 'T1', calendar_id: a.p.calendar_id, user_id: a.p.user_id, person_id: a.p.person_id, starts_at: a.p.starts_at, ends_at: a.p.ends_at,
      status: 'booked', title: a.p.title || a.p.name || 'Appointment', name: a.p.name, answers: [], history: [], divisions: [], source: 'manual' }); return id;
  };
  R.calendar_save = (a) => { const id = a.p_id || 'CA' + (D.calendars.length + 1); const c = D.calendars.find((x) => x.id === id); if (c) Object.assign(c, a.p, { id }); else D.calendars.push({ ...a.p, id, archived_at: null }); return id; };
  R.calendar_archive = (a) => { D.calendars.find((x) => x.id === a.p_id).archived_at = new Date().toISOString(); return null; };
  R.cal_hours_save = (a) => { const h = D.cal_hours.find((x) => x.user_id === a.p_user); if (h) Object.assign(h, { weekly: a.p_weekly, time_zone: a.p_tz }); else D.cal_hours.push({ user_id: a.p_user, weekly: a.p_weekly, time_zone: a.p_tz }); return null; };
  R.cal_override_save = (a) => { D.cal_overrides.push({ id: 'OV' + (D.cal_overrides.length + 1), user_id: a.p_user, day: a.p_day, ranges: a.p_ranges, note: a.p_note }); return 'OVx'; };
  R.cal_override_remove = (a) => { D.cal_overrides = D.cal_overrides.filter((x) => x.id !== a.p_id); return null; };
  // 109: the person's own hours (everywhere) plus this account's
  D.user_hours = [];
  R.hours_get = (a) => { const h = D.cal_hours.find((x) => x.user_id === a.p_user); return { user: h ? { weekly: h.weekly, time_zone: h.time_zone } : null, account: null, home: true, home_name: 'Demo', can_user: true, can_account: true,
    days: D.cal_overrides.filter((x) => x.user_id === a.p_user).map((o) => ({ ...o, scope: 'user' })) }; };
  R.hours_save = (a) => R.cal_hours_save(a);
  R.hours_day_save = (a) => R.cal_override_save(a);
  R.hours_day_remove = (a) => R.cal_override_remove(a);
  R.hours_use_default = () => null;
  // the public page
  const brand = { name: 'Essential Services', color: '#2A6B4F', phone: '228-555-0100' };
  R.book_info = (a) => (a.p_cal === 'consult' ? { name: 'Consult', description: 'A quick call about your property.', color: '#2563EB', kind: 'pick', duration: 30, lengths: [30, 60], time_zone: 'America/Chicago',
    ahead_days: 60, location_kind: 'phone', location: null, ask_company: true, team: [{ id: 'U1', name: 'Admin A.' }, { id: 'U2', name: 'Worker W.' }], with: null, brand,
    questions: [{ key: 'what', label: 'What for?', kind: 'long', options: [], required: true }, { key: 'heard', label: 'How did you hear about us?', kind: 'choice', options: ['Google', 'A friend'], required: false }] } : null);
  const open = (from, to) => { const out = []; for (let d = 1; d < 40; d++) for (const [h, m] of [[9, 0], [9, 30], [14, 0]]) { const x = new Date(at(d, h, m)); if (x.getDay() % 6 && x >= new Date(from) && x < new Date(to)) out.push(x.toISOString()); } return out; };
  R.book_slots = (a) => open(a.p_from, a.p_to);
  R.book_make = (a) => { if (!a.p.answers?.what) throw new Error('Please answer: What for?'); window.__BOOKED = a; return { ok: true, token: 'c'.repeat(64), starts_at: a.p_start, ends_at: a.p_start, location: 'Phone call to ' + a.p.phone, with: 'Admin A.', confirm_text: 'Thanks! See you then.' }; };
  let mg = { name: 'Pam Smith', title: 'Consult', status: 'booked', starts_at: at(3, 9), ends_at: at(3, 9, 30), location: 'Phone call', with: 'Admin A.', color: '#2563EB', time_zone: 'America/Chicago',
    can_cancel: true, can_reschedule: true, cutoff_hours: 4, ahead_days: 60, brand };
  R.book_manage = (a) => (a.p_token === 'c'.repeat(64) ? mg : null);
  R.book_manage_slots = (a) => open(a.p_from, a.p_to);
  R.book_reschedule = (a) => { mg = { ...mg, starts_at: a.p_start, status: 'rescheduled' }; window.__MOVED = a; return { ok: true, starts_at: a.p_start, ends_at: a.p_start, with: 'Admin A.' }; };
  R.book_cancel = (a) => { window.__CANCELLED = a; mg = { ...mg, status: 'cancelled' }; return { ok: true, status: 'cancelled' }; };
};
// social mode: two connected accounts (one needs reconnecting), posts across the month, media to pick from
const socialSeed = () => {
  const D = window.__DB, R = window.__RPC;
  const at = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  D.social_accounts = [{ id: 'SA1', network: 'facebook', external_id: 'pg1', name: 'Essential Services', status: 'ok', picture_url: null },
    { id: 'SA2', network: 'instagram', external_id: 'ig1', name: 'Essential Services', handle: 'essentialms', status: 'ok' },
    { id: 'SA3', network: 'facebook', external_id: 'pg2', name: 'Old Page', status: 'reconnect', status_note: 'Token expired' }];
  const img = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#2A6B4F"/></svg>');
  const POSTS = [
    { id: 'SP1', body: 'Fall cleanup special this week! #biloxi', media: [{ url: img, kind: 'image' }], account_ids: ['SA1', 'SA2'], scheduled_at: at(1, 10), status: 'scheduled', by: 'Admin Al', mine: true, targets: [] },
    { id: 'SP2', body: 'Before and after on Oak Apartments', media: [{ url: img, kind: 'image' }], account_ids: ['SA1', 'SA2'], scheduled_at: at(-1, 9), status: 'partial', by: 'Admin Al', mine: true,
      targets: [{ account_id: 'SA1', status: 'posted', permalink: 'https://facebook.com/x' }, { account_id: 'SA2', status: 'failed', error: 'Instagram only takes JPEG pictures' }] },
    { id: 'SP3', body: 'Can we post the crew photo?', media: [], account_ids: ['SA1'], scheduled_at: at(2, 14), status: 'pending', by: 'Worker Wes', mine: false, targets: [] },
    { id: 'SP4', body: 'Idea: holiday hours post', media: [], account_ids: [], scheduled_at: null, status: 'draft', by: 'Admin Al', mine: true, targets: [] }];
  R.social_settings = () => ({ require_approval: false, default_time: '10:00', can_post: true, can_manage: true, can_connect: true });
  R.social_posts_list = () => POSTS;
  R.social_post_save = (a) => { window.__SAVED = a.p; return 'SPX'; };
  R.social_batch_save = (a) => { window.__BATCH = a.p; return { batch_id: 'B', count: a.p.posts.length }; };
  R.social_post_approve = () => null; R.social_post_retry = () => null; R.social_post_unschedule = () => null; R.social_post_delete = () => null;
  R.social_settings_save = (a) => { window.__SSET = a.p; return null; }; R.social_account_remove = () => null;
  R.media_library = () => [{ id: 'M1', url: img + '#1', title: 'crew.jpg', mime: 'image/jpeg', kind: 'photo' }, { id: 'M2', url: img + '#2', title: 'truck.jpg', mime: 'image/jpeg', kind: 'photo' },
    { id: 'M3', url: '/x/a.pdf', title: 'menu.pdf', mime: 'application/pdf', kind: 'file' }];
  window.__FN = { 'social-connect': () => ({ error: 'Facebook and Instagram aren\'t set up on the platform yet.' }) };
  // pipeline: one pipeline, two organizations in Lead, org types to pick from
  D.pipelines = [{ id: 'PL1', name: 'Sales', sort: 0, is_default: true, archived_at: null }];
  D.pipeline_stages = [{ id: 'ST1', name: 'Lead', sort: 0, kind: 'open', system_key: 'lead', pipeline_id: 'PL1', archived_at: null },
    { id: 'ST2', name: 'Closed Won', sort: 9, kind: 'won', system_key: 'won', pipeline_id: 'PL1', archived_at: null }];
  D.companies[0].pipeline_stage_id = 'ST1'; D.companies[1].pipeline_stage_id = 'ST1'; D.companies[0].archived_at = null; D.companies[1].archived_at = null;
  D.lookup_values = [{ list_name: 'org_type', label: 'Clinic', active: true, sort_order: 1 }, { list_name: 'org_type', label: 'Vendor', active: true, sort_order: 2 }, { list_name: 'org_type', label: 'Referral Partner', active: true, sort_order: 3 }];
  R.account_settings_save = (a) => { window.__ASET = a.p; return { ...(D.account_settings[0].settings), ...a.p }; };
};
(async () => {
  if (mode === 'esign') {
    const { PDFDocument, StandardFonts } = require(`${NPM_G}/pdf-lib`);
    const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const t of ['Page one: the agreement', 'Page two: sign below']) doc.addPage([612, 792]).drawText(t, { x: 60, y: 720, size: 22, font });
    ESIGN_PDF = Buffer.from(await doc.save());
  }
  const browser = await chromium.launch();
  const errors = [];
  for (const [label, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const page = await browser.newPage({ viewport: vp });
    page.on('pageerror', (e) => { if (process.env.DBG) console.log('PAGEERR', e.message, e.stack); errors.push(`[${label}] page error: ${e.message}`); });
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`[${label}] console: ${m.text()}`); });
    await page.route('https://cdn.jsdelivr.net/**', (r) => { const u = r.request().url();
      if (u.includes('supabase-js')) return r.fulfill({ contentType: 'application/javascript', body: FAKE });
      const m = u.match(/pdfjs-dist@[^/]+\/build\/(pdf(?:\.worker)?\.min\.mjs)$/);
      return r.fulfill({ contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: m ? pdfjsFile(m[1]) : '' }); });
    await page.addInitScript(seed(seedMode));
    if (mode === 'members') { await page.addInitScript(membersSeed); page.on('dialog', (d) => d.accept()); }
    if (mode === 'plans') { await page.addInitScript(plansSeed); page.on('dialog', (d) => d.accept()); }
    if (mode === 'crews') await page.addInitScript(crewsSeed);
    if (mode === 'today') { await page.addInitScript(todaySeed); page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Vendors in Biloxi' : undefined)); }
    if (mode === 'bids') await page.addInitScript(bidsSeed);
    if (mode === 'esign') { await page.addInitScript(esignSeed); await esignRoutes(page); page.on('dialog', (d) => d.accept()); }
    if (mode === 'social') { await page.addInitScript(socialSeed); page.on('dialog', (d) => d.accept()); }
    if (mode === 'phone') { await page.addInitScript(phoneSeed); page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Sales line' : undefined));
      await page.route('https://esm.sh/**', (r) => r.fulfill({ contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: FAKE_RTC })); }
    if (mode === 'calendars') { await page.addInitScript(calendarsSeed); page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Running late' : undefined)); }
    if (mode === 'portal') { await page.addInitScript(portalSeed); page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Too much' : undefined)); }
    if (mode === 'measure' || mode === 'bids') {
      await page.addInitScript(measureSeed); page.on('dialog', (d) => d.accept());
      await page.route('https://unpkg.com/**', (r) => r.fulfill({ contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: r.request().url().endsWith('.css') ? '' : FAKE_LEAFLET }));
      await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ lat: '30.3935', lon: '-88.8890' }]) }));
    }
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.touroffer{display:none!important}'; document.head.appendChild(s); }));
    await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (ok) => ok({ coords: { latitude: 30.4, longitude: -89, accuracy: 10 } }); });
    const views = mode === 'phone' ? ['phoneset', 'phonelog', 'phoneusage', 'review', 'people/P1', 'dashboard', 'tools', 'settings'] : mode === 'today' ? ['myday', 'routes', 'routes/R1', 'orgs', 'org/C1', 'people/P1', 'whatsnew', 'settings'] : mode === 'plans' ? ['packages', 'accounts', 'org/C1', 'tools'] : mode === 'social' ? ['social', 'socialaccounts', 'socialbatch', 'tools', 'settings', 'roles'] : mode === 'esign' ? ['esign', 'esigndoc/E2', 'esigndoc/E3', 'esignedit/E1', 'esigntpl/TP1', 'esignsetup', 'settings', 'roles', 'org/C1', 'tools'] : mode === 'calendars' ? ['calendar', 'calsetup', 'calset/CA1', 'calset/new', 'calhours', 'myday', 'org/C1', 'people/P1', 'tools', 'automation/new', 'roles', 'settings'] : mode === 'portal' ? ['org/C2', 'org/C1', 'portalsetup', 'settings', 'inbox', 'tools'] : mode === 'bids' ? ['bids', 'bid/B1', 'bid/B2', 'bid/B3', 'bidsetup', 'review', 'sales', 'tools', 'roles'] : mode === 'measure' ? ['measuresetup', 'org/C1', 'invoice/I3', 'settings', 'tools'] : mode === 'crews' ? ['dispatch', 'job/J1', 'job/J2', 'jobs', 'crews', 'schedules', 'review', 'myday', 'settings', 'time'] : mode === 'members' ? ['team', 'departments', 'roles', 'dashboard', 'dispatch', 'myday', 'tools'] : mode === 'docs' ? ['invoices', 'invoice/I1', 'invoice/I2', 'invoice/I3', 'invoice/new', 'docsetup', 'products', 'review', 'org/C1', 'reports', 'tools'] : mode === 'grow' ? ['automations', 'automation/A1', 'automation/new', 'links', 'webhooks', 'templates', 'media', 'brandkit', 'reports', 'departments', 'chatsetup', 'contactlist', 'people/P1', 'org/C1', 'tools']
      : mode === 'on'
      ? ['dashboard', 'jobs', 'job/J1', 'job/J2', 'dispatch', 'schedules', 'time', 'pay', 'roles', 'accounting', 'review', 'settings', 'add', 'org/C1', 'org/C2', 'myday', 'people/P1', 'team', 'tools']
      : ['dashboard', 'orgs', 'org/C1', 'add', 'myday', 'settings', 'review', 'team', 'tools', 'people/P1'];
    for (const v of views) {
      await page.goto('http://localhost:8099/#' + v); await page.waitForTimeout(700);
      const bad = await page.$eval('#toast', (t) => (!t.hidden && t.classList.contains('bad') ? t.textContent : '')).catch(() => '');
      if (bad) errors.push(`[${label}] ${v}: error toast "${bad.trim()}"`);
      const h1 = await page.$eval('#view h1', (h) => h.textContent).catch(() => '(no h1)');
      if (label === 'desktop' && !['dashboard', 'today', ''].includes(v.split('/')[0])) {
        const tab = await page.$eval('.cabinet .folder.on', (b) => b.dataset.nav).catch(() => '');
        if (tab === 'dashboard') errors.push(`[${label}] ${v}: lights the Dashboard tab`);
      }
      if (label === 'phone') console.log(`${v.padEnd(12)} → ${h1.trim().slice(0, 50)}`);
      if (label === 'desktop' || ['job/J1', 'review', 'dispatch', 'add', 'pay', 'myday'].includes(v)) await page.screenshot({ path: `/tmp/shots-${mode}-${label}-${v.replace('/', '_')}.png`, fullPage: v === 'settings' });
    }
    // Tools menu (desktop): only drawer names show; hovering Admin flies out its items
    if (mode === 'on' && label === 'desktop') {
      await page.goto('http://localhost:8099/#dashboard'); await page.waitForTimeout(600);
      await page.hover('.ddwrap:has([data-nav="tools"].folder) > .folder'); await page.waitForTimeout(200);
      const shownBefore = await page.$$eval('.ddwrap:has([data-nav="tools"].folder) .ddsubmenu', (ms) => ms.filter((m) => getComputedStyle(m).display !== 'none').length);
      const heads = await page.$$eval('.ddwrap:has([data-nav="tools"].folder) .ddsubhead', (hs) => hs.map((h) => h.textContent.replace('›', '').trim()));
      await page.hover('.ddsub:has(.ddsubhead:text-is("Admin›")) > .ddsubhead').catch(() => page.hover('.ddsub:last-child > .ddsubhead'));
      await page.waitForTimeout(200);
      const adminItems = await page.$$eval('.ddsub', (ss) => { const a = ss.find((s) => s.querySelector('.ddsubhead').textContent.startsWith('Admin')); const m = a && a.querySelector('.ddsubmenu');
        return m && getComputedStyle(m).display !== 'none' ? [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) : []; });
      // Admin › Team flies out its items
      const adminSub = page.locator('.ddsub', { has: page.locator(':scope > .ddsubhead', { hasText: /^Admin/ }) }).first();
      await adminSub.locator(':scope > .ddsubmenu > .ddsub > .ddsubhead', { hasText: /^Team/ }).hover(); await page.waitForTimeout(200);
      const teamItems = await adminSub.locator(':scope > .ddsubmenu > .ddsub').first().locator(':scope > .ddsubmenu button').allTextContents();
      const teamShown = await adminSub.locator(':scope > .ddsubmenu > .ddsub').first().locator(':scope > .ddsubmenu').isVisible();
      console.log('admin › team:', teamShown, teamItems.join(', '));
      if (!teamShown || !teamItems.includes('Roles')) errors.push('[desktop] Admin › Team did not fly out Roles');
      await page.screenshot({ path: '/tmp/shots-on-desktop-toolsmenu.png' });
      console.log('tools drawers:', heads.join(', '), '| flyouts open before hover:', shownBefore, '| admin flyout:', adminItems.join(', '));
      if (shownBefore !== 0) errors.push('[desktop] tools menu: a flyout was open before hovering a drawer');
      if (!adminItems.includes('Team')) errors.push('[desktop] tools menu: hovering Admin did not show Team');
    }
    if (mode === 'today' && label === 'phone') {
      // What's new banner on the first visit after a release
      await page.goto('http://localhost:8099/#myday'); await page.reload(); await page.waitForTimeout(900);
      const wn = await page.$eval('#wnBanner', (b) => b.textContent).catch(() => '');
      if (!/Quick filters/.test(wn)) errors.push("[phone] What's new banner missing");
      if (/Routes \(Beta\), ready/.test(wn) === false) errors.push("[phone] admin should see the Routes item");
      await page.click('[data-wnok]'); await page.waitForTimeout(300);
      // note with an @mention and the Notify list
      await page.goto('http://localhost:8099/#org/C1'); await page.waitForTimeout(800);
      await page.click('#tlNote'); await page.keyboard.type('Call them @Wor'); await page.waitForTimeout(300);
      const ml = await page.$eval('#tlMention', (m) => (m.hidden ? '' : m.textContent)).catch(() => '');
      if (!/Worker Wes/.test(ml)) errors.push('[phone] @ list did not offer Worker Wes');
      await page.keyboard.press('Enter'); await page.keyboard.type('back tomorrow');
      await page.click('#tlAdd'); await page.waitForTimeout(500);
      const note = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'timeline_note').map((x) => x[2]).pop());
      console.log('note sent:', JSON.stringify(note));
      if (!note || !(note.p_notify || []).includes('U2') || !/@Worker Wes back tomorrow/.test(note.p_body)) errors.push('[phone] note did not notify Worker Wes');
      // quick filters: apply the shared one, save a new one
      await page.goto('http://localhost:8099/#orgs'); await page.waitForTimeout(700);
      await page.click('[data-qf="Q1"]'); await page.waitForTimeout(500);
      const on = await page.$eval('[data-qf="Q1"]', (b) => b.classList.contains('on'));
      if (!on) errors.push('[phone] quick filter did not turn on');
      await page.screenshot({ path: '/tmp/shots-today-phone-quickfilter.png' });
      await page.click('[data-ft="Client"]'); await page.waitForTimeout(300); await page.click('#qAdd'); await page.waitForTimeout(500);
      const saved = await page.evaluate(() => window.__DB.shortcuts.map((x) => x.name));
      if (!saved.includes('Vendors in Biloxi')) errors.push('[phone] quick filter not saved: ' + saved);
      // routes in My Day: far warning and a location report, then can't finish
      await page.goto('http://localhost:8099/#myday'); await page.waitForTimeout(800);
      await page.click('[data-tap="arrived"][data-rs="X1"]'); await page.waitForTimeout(500);
      await page.fill('#lmWhy', 'Gate moved'); await page.click('[name="lmScope"][value="permanent"]'); await page.click('#lmSend'); await page.waitForTimeout(400);
      const rep = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'route_location_report').map((x) => x[2]).pop());
      if (rep?.p_scope !== 'permanent') errors.push('[phone] location report not sent');
      await page.click('[data-inc="X1"]'); await page.waitForTimeout(300); await page.fill('#icWhy', 'Locked out');
      await page.setInputFiles('#icFiles', { name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('x') }); await page.click('#icOk'); await page.waitForTimeout(500);
      const inc = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'route_stop_incomplete').map((x) => x[2]).pop());
      if (!inc || inc.p_media.length !== 1) errors.push('[phone] incomplete not saved with photo');
      await page.screenshot({ path: '/tmp/shots-today-phone-myday-route.png', fullPage: true });
      // dispatcher board: push and email customers, approve a report, split
      await page.goto('http://localhost:8099/#routes/R1'); await page.waitForTimeout(800);
      await page.click('#rbPush'); await page.waitForTimeout(500); await page.click('#pnSend'); await page.waitForTimeout(500);
      const sent = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'route_notify_customers').map((x) => x[2]).pop());
      if (!sent || !sent.p_companies.includes('C1')) errors.push('[phone] push did not email customers');
      await page.click('[data-exok="EX1"]'); await page.waitForTimeout(400);
      await page.click('#rbSplit'); await page.waitForTimeout(300); await page.selectOption('[data-sp="X1"]', 'U2'); await page.click('#spSave'); await page.waitForTimeout(400);
      const split = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'route_run_action' && x[2].p_action === 'split').map((x) => x[2]).pop());
      if (split?.p?.assign?.X1 !== 'U2') errors.push('[phone] split not sent');
      await page.click('#rtEdit'); await page.waitForTimeout(400); await page.selectOption('#reRep', 'custom'); await page.fill('#reEvery', '2'); await page.click('#reSave'); await page.waitForTimeout(400);
      const rr = await page.evaluate(() => window.__DB.routes[0]);
      if (rr.repeat !== 'custom' || rr.every_weeks !== 2) errors.push('[phone] route edit not saved');
      await page.screenshot({ path: '/tmp/shots-today-phone-route-board.png', fullPage: true });
      // drag the second stop above the first
      { await page.$eval('#rtStopList', (l) => l.scrollIntoView({ block: 'center' })); await page.waitForTimeout(200);
        const g2 = await page.$('[data-sid="RS2"] .rtgrip'), g1 = await page.$('[data-sid="RS1"] .rtgrip');
        const b2 = await g2.boundingBox(), b1 = await g1.boundingBox();
        await page.mouse.move(b2.x + 5, b2.y + 5); await page.mouse.down();
        await page.mouse.move(b1.x + 5, b1.y - 4, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(600);
        const ord = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'route_stops_order').map((x) => x[2]).pop());
        if (ord?.p_ids?.join() !== 'RS2,RS1') errors.push('[phone] drag reorder not saved: ' + JSON.stringify(ord)); }
      // the customer picker finds people too; picking one files them as the customer
      await page.fill('#stOrg [data-q]', 'Pam'); await page.waitForTimeout(700);
      const hits = await page.$$eval('#stOrg [data-pe]', (b) => b.map((x) => x.textContent));
      if (!hits.some((h) => /Pam Smith/.test(h))) errors.push('[phone] customer picker did not find the person: ' + hits);
      else { await page.click('#stOrg [data-pe]'); await page.waitForTimeout(400); await page.fill('#stReq', 'Front porch'); await page.click('#stAdd'); await page.waitForTimeout(500);
        const st = await page.evaluate(() => window.__DB.route_stops.map((x) => x.request));
        if (!st.includes('Front porch')) errors.push('[phone] stop for a person not added'); }
      // connected calendars on my profile
      await page.goto('http://localhost:8099/#teamdir/U1'); await page.waitForTimeout(900);
      const cf = await page.$eval('#calFeeds', (b) => b.textContent).catch(() => '');
      if (!/Work Google/.test(cf) || !/Last synced 4 min ago/.test(cf)) errors.push('[phone] connected calendars card missing: ' + cf.slice(0, 120));
      await page.evaluate(() => { window.__FN = { ...(window.__FN || {}), 'ms-graph': (b) => (b.kind === 'start' ? { url: '#ms-signin' } : { ok: true }) }; });
      await page.click('[data-msgo]'); await page.waitForTimeout(400);
      const ms = await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'fn' && x[1] === 'ms-graph').pop());
      if (ms?.[2]?.kind !== 'start' || !/#teamdir\/U1$/.test(ms?.[2]?.return_to || '')) errors.push('[phone] Connect Microsoft did not start sign-in: ' + JSON.stringify(ms));
      await page.goto('http://localhost:8099/#teamdir/U1'); await page.waitForTimeout(900);
      await page.click('#calFeeds summary'); await page.fill('#cfLabel', 'Personal'); await page.fill('#cfUrl', 'webcal://p01-caldav.icloud.com/published/2/abc'); await page.click('#cfAdd'); await page.waitForTimeout(500);
      const added = await page.evaluate(() => ({ rpc: window.__LOG.filter((x) => x[1] === 'my_cal_feed_add').pop(), fn: window.__LOG.filter((x) => x[0] === 'fn' && x[1] === 'cal-sync').pop() }));
      if (!added.rpc || added.fn?.[2]?.feed_id !== 'CF2') errors.push('[phone] connecting a calendar did not save and sync: ' + JSON.stringify(added));
      // My availability: hours summary and my video link
      const ma = await page.$eval('#myAvail', (b) => b.textContent).catch(() => '');
      if (!/My availability/.test(ma) || !/Mon/.test(ma)) errors.push('[phone] My availability card missing: ' + ma.slice(0, 120));
      await page.fill('#maLink', 'https://zoom.us/j/123'); await page.click('#maSave'); await page.waitForTimeout(400);
      const mls = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'my_meeting_save').pop());
      if (mls?.[2]?.p_link !== 'https://zoom.us/j/123' || mls?.[2]?.p_mode !== 'fixed') errors.push('[phone] video link not saved: ' + JSON.stringify(mls));
      await page.screenshot({ path: '/tmp/shots-today-phone-calfeeds.png', fullPage: true });
      // gear menu: how notifications reach me
      await page.click('#gearBtn'); await page.waitForTimeout(400); await page.selectOption('[data-nvia]', 'both'); await page.waitForTimeout(300);
      const via = await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'my_notify_via_set').map((x) => x[2]).pop());
      if (via?.p_via !== 'both') errors.push('[phone] notify method not saved');
    }
    if (mode === 'grow' && label === 'phone') {
      await page.goto('http://localhost:8099/#automation/A1'); await page.waitForTimeout(600);
      await page.selectOption('[data-addsel=""]', 'if'); await page.waitForTimeout(300);
      await page.selectOption('[data-addsel="3.then"]', 'add_tag'); await page.waitForTimeout(300);
      await page.click('[data-up="1"]'); await page.waitForTimeout(200);
      await page.click('#aSave'); await page.waitForTimeout(400);
      const saved = await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === 'automation_save').map((x) => x[2]).pop());
      console.log('saved steps:', JSON.stringify(saved?.p?.steps?.map((s) => s.type + (s.then ? '[' + s.then.map((t) => t.type) + ']' : ''))));
      await page.screenshot({ path: '/tmp/shots-grow-auto-edit.png', fullPage: true });
      await page.goto('http://localhost:8099/#templates'); await page.waitForTimeout(500); await page.click('[data-t="TP1"]'); await page.waitForTimeout(300);
      await page.goto('http://localhost:8099/#links'); await page.waitForTimeout(500); await page.click('#qNew'); await page.waitForTimeout(300);
      await page.goto('http://localhost:8099/#chatsetup'); await page.waitForTimeout(500); await page.click('[data-w="CW1"]'); await page.waitForTimeout(300); await page.click('#wPool [data-u="U2"]'); await page.waitForTimeout(300);
      await page.screenshot({ path: '/tmp/shots-grow-chatsetup.png', fullPage: true });
      await page.goto('http://localhost:8099/#contactlist'); await page.waitForTimeout(500); await page.fill('#clQ', 'Pam'); await page.click('#clGo'); await page.waitForTimeout(500);
      await page.screenshot({ path: '/tmp/shots-grow-contactlist.png', fullPage: true });
      await page.goto('http://localhost:8099/#webhooks'); await page.waitForTimeout(500); await page.click('[data-ed="H1"]'); await page.waitForTimeout(300);
      await page.goto('http://localhost:8099/#reports'); await page.waitForTimeout(800);
      await page.screenshot({ path: '/tmp/shots-grow-reports.png', fullPage: true });
    }
    if (mode === 'docs') {
      // new invoice by hand: pick the organization, fill a line, save
      await page.goto('http://localhost:8099/#invoice/new'); await page.waitForTimeout(600);
      await page.fill('#iOrgQ', 'Oak'); await page.waitForTimeout(700); await page.click('[data-co="C1"]'); await page.waitForTimeout(500);
      await page.fill('#iLines [data-ln="0"] [data-k="name"]', 'Pressure washing'); await page.fill('#iLines [data-ln="0"] [data-k="price"]', '125');
      await page.click('#iAdd'); await page.fill('#iLines [data-ln="1"] [data-k="name"]', 'Trip charge'); await page.fill('#iLines [data-ln="1"] [data-k="price"]', '25');
      await page.waitForTimeout(300);
      const tot = await page.$eval('#iTot', (e) => e.textContent.replace(/\s+/g, ' ').trim());
      if (label === 'phone') console.log('live totals:', tot);
      // a saved product at retail, lowered: a reason is asked for, the customer preview shows the crossed out retail and the savings
      await page.click('#iProd'); await page.waitForTimeout(300); await page.click('[data-pp="PR1"]'); await page.waitForTimeout(300);
      await page.fill('#iLines [data-ln="2"] [data-k="price"]', '1750'); await page.waitForTimeout(300);
      if (!(await page.isVisible('#iLines [data-ln="2"] [data-k="reason"]'))) errors.push(`[${label}] no reason box after lowering a price`);
      await page.click('#iSave'); await page.waitForTimeout(400);
      if (await page.evaluate(() => window.__DB.invoices.some((i) => i.lines?.[0]?.name === 'Pressure washing'))) errors.push(`[${label}] saved without a reason for the lower price`);
      await page.fill('#iLines [data-ln="2"] [data-k="reason"]', 'Booked the dashboard too'); await page.waitForTimeout(300);
      const prev = await page.$eval('#iPrev', (e) => e.textContent);
      if (!/\$2,500\.00/.test(prev) || !/You saved/.test(prev) || /Booked the dashboard/.test(prev)) errors.push(`[${label}] preview savings wrong: ${prev.slice(0, 200)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-override.png', fullPage: true });
      await page.uncheck('#iSav'); await page.waitForTimeout(300);
      if (/You saved/.test(await page.$eval('#iPrev', (e) => e.textContent))) errors.push(`[${label}] savings still shown after turning it off`);
      await page.check('#iSav');
      await page.click('#iSave'); await page.waitForTimeout(600);
      const saved = await page.evaluate(() => window.__DB.invoices.find((i) => i.lines?.[0]?.name === 'Pressure washing'));
      if (!saved) errors.push(`[${label}] new invoice not saved`);
      else if (!(saved.lines[2]?.retail === 2500 && saved.lines[2]?.reason && saved.lines[2]?.product_id === 'PR1')) errors.push(`[${label}] product line not kept: ${JSON.stringify(saved.lines[2])}`);
      // a fresh new invoice starts with no organization picked
      await page.goto('http://localhost:8099/#invoices'); await page.waitForTimeout(500); await page.click('#iNew'); await page.waitForTimeout(600);
      if (!(await page.$('#iOrgQ'))) errors.push(`[${label}] new invoice started with an organization already picked`);
      // Quick Add an individual customer right from the invoice search
      await page.evaluate(() => { window.__RPC.quick_entry = (a) => { window.__QE = a.p; window.__DB.companies.push({ id: 'CQ1', name: a.p.company.name, org_types: a.p.company.org_types, city: '' }); return 'CQ1'; }; });
      await page.fill('#iOrgQ', 'Jane Roe'); await page.waitForTimeout(700);
      await page.click('#iOrgAdd'); await page.waitForTimeout(200);
      await page.check('[name=qaKind][value=ind]'); await page.fill('#qa_email', 'jane@roe.test'); await page.click('#qaGo'); await page.waitForTimeout(700);
      const qe = await page.evaluate(() => window.__QE);
      if (!qe || qe.company.name !== 'Jane Roe' || qe.company.org_types[0] !== 'Individual' || !qe.contacts[0]?.is_billing) errors.push(`[${label}] quick add individual wrong: ${JSON.stringify(qe)}`);
      if ((await page.$('#iOrgQ')) || !(await page.$eval('#bEmail', (e) => e.value).catch(() => '')).includes('jane@roe.test')) errors.push(`[${label}] quick-added customer not picked on the invoice`);
      // products screen: add one
      await page.goto('http://localhost:8099/#products'); await page.waitForTimeout(600);
      await page.click('#prNew'); await page.fill('#prName', 'Hosting and care'); await page.fill('#prPrice', '75'); await page.fill('#prCost', '30'); await page.fill('#prSetup', '150'); await page.fill('#prSetupCost', '40'); await page.selectOption('#prFreq', 'custom');
      if (!(await page.$eval('#prM', (e) => e.textContent).catch(() => '')).includes('60%')) errors.push(`[${label}] product margin not shown live`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-product-edit.png' });
      await page.fill('#prEvery', '10'); await page.click('#prSave'); await page.waitForTimeout(500);
      if (!(await page.evaluate(() => window.__DB.products.some((p) => p.name === 'Hosting and care' && p.custom_every === 10)))) errors.push(`[${label}] product not added`);
      if (!(await page.evaluate(() => (window.__DB.product_costs || []).some((c) => Number(c.cost) === 30 && Number(c.setup_cost) === 40)))) errors.push(`[${label}] product cost not saved`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-products.png', fullPage: true });
      // link an existing contact to an organization, then unlink from the person's page
      await page.goto('http://localhost:8099/#org/C2'); await page.waitForTimeout(800);
      await page.click('#linkPerson'); await page.fill('#lkQ', 'Pam Smith'); await page.waitForTimeout(600);
      await page.click('[data-lk="P1"]'); await page.fill('#lkTitle', 'Owner'); await page.check('#lkDm'); await page.click('#lkGo'); await page.waitForTimeout(700);
      if (!(await page.evaluate(() => window.__DB.company_people.some((l) => l.company_id === 'C2' && l.person_id === 'P1' && l.title === 'Owner' && l.is_decision_maker)))) errors.push(`[${label}] contact not linked`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-link.png', fullPage: true });
      await page.goto('http://localhost:8099/#people/P1'); await page.waitForTimeout(800);
      const ul = await page.$$('[data-unlink]');
      if (ul.length < 2) errors.push(`[${label}] person page should show 2 links with Unlink, got ${ul.length}`);
      page.once('dialog', (dg) => dg.accept()); await page.click('[data-unlink][data-where="Gulf Mgmt Co"]'); await page.waitForTimeout(600);
      if (await page.evaluate(() => window.__DB.company_people.some((l) => l.company_id === 'C2' && l.person_id === 'P1'))) errors.push(`[${label}] contact not unlinked`);
      await page.click('#linkOrg'); await page.fill('#lkQ', 'Gulf'); await page.waitForTimeout(600);
      if (!(await page.$('[data-lk="C2"]'))) errors.push(`[${label}] org search from person page found nothing`);
      // repeat an invoice: monthly, drafts to Review, autopay, 12 in all; then stop it
      await page.goto('http://localhost:8099/#invoice/I1'); await page.waitForTimeout(700);
      await page.click('#repEdit'); await page.waitForTimeout(300);
      await page.selectOption('#rFreq', 'custom'); await page.fill('#rEvery', '10'); await page.check('input[name="rSend"][value="0"]');
      await page.selectOption('#rEnd', 'count'); await page.fill('#rCount', '12');
      if (await page.isEnabled('#rAuto')) await page.check('#rAuto');
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-repeat.png' });
      await page.click('#rGo'); await page.waitForTimeout(700);
      const ser = await page.evaluate(() => (window.__SER || {}).I1);
      if (!ser || ser.frequency !== 'custom' || ser.custom_every !== 10 || ser.auto_send !== false || ser.end_count !== 12) errors.push(`[${label}] repeat not saved: ${JSON.stringify(ser)}`);
      const rep = await page.$eval('#iRepBody', (e) => e.textContent).catch(() => '');
      if (!/Repeats every 10 days/.test(rep)) errors.push(`[${label}] repeat card wrong: ${rep.slice(0, 160)}`);
      page.once('dialog', (dg) => dg.accept()); await page.click('#repStop'); await page.waitForTimeout(600);
      if ((await page.evaluate(() => window.__SER.I1.status)) !== 'ended') errors.push(`[${label}] series not stopped`);
      // Review shows the held draft and the failed autopay
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(900);
      const rv = await page.$eval('#view', (e) => e.textContent).catch(() => '');
      if (!/Autopay that didn't go through/.test(rv) || !/Repeating invoices to check and send/.test(rv) || !/Payments to approve/.test(rv)) errors.push(`[${label}] review missing series items`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-review.png', fullPage: true });
      // reminders and late fees settings save
      await page.goto('http://localhost:8099/#docsetup'); await page.waitForTimeout(800);
      await page.check('#sLate'); await page.fill('#sLateAmt', '25'); await page.click('#sSave'); await page.waitForTimeout(500);
      const col = await page.evaluate(() => window.__COLLECT);
      if (!col || col.late_fees_enabled !== true || col.late_fee_amount !== 25) errors.push(`[${label}] late fee settings not saved: ${JSON.stringify(col)}`);
      // record a payment and open the email dialog on an open invoice
      await page.goto('http://localhost:8099/#invoice/I1'); await page.waitForTimeout(700);
      await page.click('#iPay'); await page.waitForTimeout(300); await page.fill('#pAmt', '50'); await page.click('#pGo'); await page.waitForTimeout(500);
      await page.goto('http://localhost:8099/#invoice/I1'); await page.waitForTimeout(700);
      await page.click('#iSend'); await page.waitForTimeout(400);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-send.png' });
      // pick recipients: the billing contact is pre-checked, add the other contact and a typed address
      const boxes = await page.$$('#sList [data-to]');
      if (boxes.length < 1) errors.push(`[${label}] invoice email: expected contact checkboxes, got ${boxes.length}`);
      for (const bx of boxes) if (!(await bx.isChecked())) await bx.check();
      await page.fill('#sTo', 'ap@oak.test, Boss@Oak.test'); await page.evaluate(() => { window.__FN = { ...(window.__FN || {}), 'invoice-email': (b) => (window.__SENT = b, { ok: true }) }; });
      await page.click('#sGo'); await page.waitForTimeout(500);
      const sent = await page.evaluate(() => window.__SENT);
      if (!sent || !Array.isArray(sent.to) || sent.to.length !== boxes.length + 2 || !sent.to.includes('boss@oak.test')) errors.push(`[${label}] invoice email recipients wrong: ${JSON.stringify(sent)}`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      // Review: approve the waiting cash payment
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(900);
      if (!(await page.$('[data-rp="IP2"] [data-ok="1"]'))) { await page.screenshot({ path: `/tmp/shots-docs-${label}-review-missing.png`, fullPage: true }); console.log('url', page.url(), await page.$eval('#view', (e) => e.innerText.slice(0, 300)).catch(() => '')); }
      await page.click('[data-rp="IP2"] [data-ok="1"]', { timeout: 5000 }); await page.waitForTimeout(400);
      // bill approved jobs from the list
      await page.goto('http://localhost:8099/#invoices'); await page.waitForTimeout(600);
      if (await page.$('#iJobs')) { await page.click('#iJobs'); await page.waitForTimeout(500); if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-docs-jobs.png' }); }
      // the customer's page and its print view
      for (const t of ['tok1', 'tok2']) {
        await page.goto('http://localhost:8099/doc/?t=' + t.padEnd(64, 'x')); await page.waitForTimeout(900);
        const h = await page.$eval('.doc-title', (e) => e.textContent).catch(() => '(no doc)');
        if (h !== 'Invoice') errors.push(`[${label}] doc page ${t}: ${h}`);
        if (t === 'tok1' && !/charged automatically to Visa ending 4242/.test(await page.$eval('#root', (e) => e.textContent))) errors.push(`[${label}] doc page autopay note missing`);
        if (t === 'tok1' && !(await page.$('#card'))) errors.push(`[${label}] doc page has no update card button`);
        await page.screenshot({ path: `/tmp/shots-docs-${label}-public-${t}.png`, fullPage: true });
        if (t === 'tok1' && label === 'desktop') { await page.emulateMedia({ media: 'print' }); await page.screenshot({ path: '/tmp/shots-docs-print.png', fullPage: true }); await page.emulateMedia({ media: 'screen' }); }
      }
      const log = await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]));
      if (label === 'phone') console.log('rpcs called:', [...new Set(log)].join(', '));
    }
    if (mode === 'docs' && label === 'desktop') {
      // dashboard: every widget, in mixed widths
      await page.evaluate(() => { localStorage.setItem('dashLayout_T1', JSON.stringify({ v: ['tiles', 'inv_open', 'inv_paid', 'escalations', 'inv_overdue', 'my_todos', 'new_leads', 'jobs_today', 'revenue_month', 'unbilled', 'review_waiting', 'margin_division', 'pipeline'] })); });
      await page.goto('http://localhost:8099/#dashboard'); await page.reload(); await page.waitForTimeout(1500);
      const wids = await page.$$eval('.dgrid .dw', (xs) => xs.map((x) => x.dataset.wid + ':' + Math.round(x.getBoundingClientRect().width)));
      console.log('widgets:', wids.join(' '));
      if (!wids.some((w) => w.startsWith('inv_overdue')) || !wids.some((w) => w.startsWith('inv_open'))) errors.push(`[${label}] invoice widgets missing: ${wids}`);
      await page.screenshot({ path: '/tmp/shots-dash-widgets.png', fullPage: true });
      await page.click('#dashCust'); await page.waitForTimeout(400);
      await page.selectOption('[data-sz="inv_overdue"]', 'full'); await page.click('#dashDlg [data-x]'); await page.waitForTimeout(900);
      const w2 = await page.$eval('[data-wid="inv_overdue"]', (x) => Math.round(x.getBoundingClientRect().width));
      const w1 = await page.$eval('[data-wid="tiles"]', (x) => Math.round(x.getBoundingClientRect().width));
      if (Math.abs(w2 - w1) > 4) errors.push(`[${label}] resizing a widget didn't stick (${w2} vs ${w1})`);
      // arrange: drag Overdue invoices to the top, make it a third, hide New this week
      await page.click('#dashArr'); await page.waitForTimeout(300);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-dash-arrange.png' });
      const g = await page.$('[data-wid="inv_overdue"] .dwgrip'), tgt = await page.$('[data-wid="tiles"]');
      const gb = await g.boundingBox(), tb = await tgt.boundingBox();
      await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await page.mouse.down();
      await page.mouse.move(tb.x + 20, tb.y + 10, { steps: 8 }); await page.mouse.move(tb.x + 10, tb.y + 5, { steps: 4 }); await page.mouse.up();
      await page.click('[data-wid="inv_overdue"] [data-dsz="third"]');
      await page.click('[data-wid="new_leads"] .dwhide');
      await page.click('#dashArr'); await page.waitForTimeout(1200);
      const after = await page.$$eval('.dgrid .dw', (xs) => xs.map((x) => x.dataset.wid + ':' + x.className.replace('dw dw-', '')));
      console.log('arranged:', after.join(' '));
      if (!after[0]?.startsWith('inv_overdue:third') || after.some((x) => x.startsWith('new_leads'))) errors.push(`[${label}] arrange didn't save: ${after}`);
      await page.evaluate(() => { localStorage.removeItem('dashLayout_T1'); localStorage.removeItem('dashSizes_T1'); });
      // search shows where each screen lives
      await page.goto('http://localhost:8099/#dashboard'); await page.waitForTimeout(600);
      await page.keyboard.press('Control+k'); await page.fill('#gsQ', 'invoic'); await page.waitForTimeout(700);
      const res = await page.$$eval('#gsRes .gsitem, #gsRes button', (xs) => xs.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
      console.log('search:', res.join(' | '));
      if (!res.some((r) => /Invoices Sales › Invoices/.test(r)) || !res.some((r) => /Invoices and payments Tools › Admin › Sales › Invoices and payments/.test(r))) errors.push(`[${label}] search doesn't show screen paths: ${res.join(' | ')}`);
      await page.screenshot({ path: '/tmp/shots-search-paths.png' });
      await page.keyboard.press('Escape');
    }
    if (mode === 'plans') {
      const txt = () => page.$eval('body', (b) => b.innerText);
      // agency: make a package, put the client account on it, make a CRM client from an organization
      await page.goto('http://localhost:8099/#packages'); await page.waitForTimeout(600);
      await page.click('#pkNew'); await page.fill('#pkName', 'Service Pro'); await page.fill('#pkPrice', '60'); await page.selectOption('#pkPer', 'user');
      for (const k of ['jobs', 'dispatch', 'bids']) await page.check(`[data-pkf="${k}"]`);
      await page.click('#pkSave'); await page.waitForTimeout(500);
      const pk = await page.evaluate(() => window.__DB.packages[0]);
      if (!pk || pk.name !== 'Service Pro' || !pk.features.includes('dispatch') || pk.price_per !== 'user') errors.push(`[${label}] package not saved right: ${JSON.stringify(pk)}`);
      await page.goto('http://localhost:8099/#accounts'); await page.waitForTimeout(700);
      await page.click('[data-plan="T1"]'); await page.waitForTimeout(600);
      await page.selectOption('#pePkg', pk.id); await page.click('#peFeatWrap summary'); await page.uncheck('[data-pef="dispatch"]'); await page.check('[data-pef="calendars"]');
      const shows = await page.$eval('#peLabel', (e) => e.textContent);
      if (!/Service Pro \+ Calendars − Dispatch and GPS check-in/.test(shows)) errors.push(`[${label}] plan label: ${shows}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-plans-editor.png' });
      await page.click('[data-bm="bypass"]'); await page.click('#peSave'); await page.waitForTimeout(700);
      const pl = await page.evaluate(() => window.__DB.account_plans.find((x) => x.tenant_id === 'T1'));
      if (!pl || pl.billing_mode !== 'bypass' || pl.allowed.includes('dispatch') || !pl.allowed.includes('calendars')) errors.push(`[${label}] plan not saved right: ${JSON.stringify(pl)}`);
      if (!/Service Pro \+ Calendars − Dispatch and GPS check-in/.test(await txt())) errors.push(`[${label}] accounts row doesn't show the plan`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-plans-accounts.png', fullPage: true });
      await page.goto('http://localhost:8099/#org/C2'); await page.waitForTimeout(800);
      // not a client yet: the option lives in the page's More menu
      await page.evaluate(() => (document.querySelector('#ccMake') || document.querySelector('#ccMakeMore'))?.click()); await page.waitForTimeout(600);
      await page.fill('#peEmail', 'owner@gulf.test'); await page.selectOption('#pePkg', pk.id); await page.click('[data-bm="invoice"]');
      await page.click('#peSave'); await page.waitForTimeout(900);
      const made = await page.evaluate(() => window.__made);
      const pl9 = await page.evaluate(() => window.__DB.account_plans.find((x) => x.tenant_id === 'T9'));
      if (!made || made.p_owner_email !== 'owner@gulf.test' || made.p_agency !== 'T0') errors.push(`[${label}] create account call wrong: ${JSON.stringify(made)}`);
      if (!pl9 || pl9.company_id !== 'C2' || pl9.package_id !== pk.id) errors.push(`[${label}] new account plan wrong: ${JSON.stringify(pl9)}`);
      const sent = await page.evaluate(() => window.__LOG.some((x) => x[0] === 'fn' || (x[1] === 'invite-email')));
      await page.goto('http://localhost:8099/#chat'); await page.waitForTimeout(900);
      const chatTxt = await txt();
      if (!/Whole team: GELP/.test(chatTxt) || !/Julie Olivari \(GELP\)/.test(chatTxt) || !/Julie: Team hello/.test(chatTxt)) errors.push(`[${label}] chat doesn't label other accounts' rooms`);
      await page.waitForTimeout(400); await page.goto('http://localhost:8099/#chat'); await page.waitForTimeout(900);
      const grp = await page.$eval('#tcList', (e) => e.textContent).catch(() => '');
      if (!/Other accounts/.test(grp) || !/Customer chats waiting/.test(grp) || !(await page.$('#tcList [data-acctsec="TG"] [data-room="RD1"]'))) errors.push(`[${label}] other accounts not grouped: ${grp.slice(0, 200)}`);
      await page.click('#tcList [data-room="RD1"]'); await page.waitForTimeout(500);
      if (!(await page.$('#tcOpenIn')) && label === 'desktop') errors.push(`[${label}] no Open in GELP button`);
      // Support tab: search help, then start an urgent chat with the search text
      await page.click('[data-tosupport]'); await page.waitForTimeout(500);
      await page.fill('#spQ', 'zzqq nothing matches'); await page.waitForTimeout(900);
      if (!(await page.$eval('#spBody', (e) => e.value).catch(() => '')).includes('zzqq')) errors.push(`[${label}] support chat not prefilled with the search`);
      await page.check('[name=spPr][value=urgent]'); await page.click('#spSend'); await page.waitForTimeout(600);
      const so = (await page.evaluate(() => window.__LOG.filter((x) => x[1] === 'support_open').pop()))?.[2];
      if (!so || so.p_priority !== 'urgent' || !/zzqq/.test(so.p_body)) errors.push(`[${label}] support request wrong: ${JSON.stringify(so)}`);
      if (!/Your requests/.test(await txt())) errors.push(`[${label}] support request not listed`);
      await page.click('[data-toteam]'); await page.waitForTimeout(500);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-chat-across.png' });
      // client scenes
      for (const sc of ['setup', 'locked', 'staff', 'grace', 'limited']) {
        await page.evaluate((x) => localStorage.setItem('scene', x), sc);
        await page.goto('http://localhost:8099/#dashboard'); await page.reload(); await page.waitForTimeout(900);
        const t = await txt(), hasShell = !!(await page.$('.cabinet'));
        if (sc === 'setup' && (!/Pay now/.test(t) || hasShell || !(await page.$('a[href*="tk1"]')))) errors.push(`[${label}] setup gate wrong`);
        if (sc === 'locked') {
          if (!/Update billing/.test(t) || !/Export data/.test(t) || hasShell) errors.push(`[${label}] locked gate wrong`);
          await page.click('#bgExport'); await page.waitForTimeout(500);
          if (!(await page.evaluate(() => window.__LOG.some((x) => x[1] === 'account_export')))) errors.push(`[${label}] export not called`);
        }
        if (sc === 'staff' && (!/paused for billing/.test(t) || /Export data|Update billing/.test(t) || !/Owner Olive/.test(t))) errors.push(`[${label}] staff lock wrong`);
        if (sc === 'grace' && (!hasShell || !(await page.$('.billwarn')) || !/3 days late/.test(t))) errors.push(`[${label}] grace banner wrong`);
        if (sc === 'limited') {
          await page.goto('http://localhost:8099/#settings'); await page.waitForTimeout(800);
          const feats = await page.$$eval('[data-feat]', (xs) => xs.map((x) => x.dataset.feat));
          if (feats.join() !== 'sales,inbox' || !/in your plan/.test(await txt())) errors.push(`[${label}] client feature list not limited: ${feats}`);
        }
        if (label === 'desktop') { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `/tmp/shots-plans-${sc}.png` }); }
      }
      await page.evaluate(() => localStorage.setItem('scene', 'agency'));
    }
    if (mode === 'members') {
      const rpcs = () => page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]));
      // the client's admin: the member card has the badge, admin switch and remove
      await page.goto('http://localhost:8099/#team'); await page.waitForTimeout(700);
      const badge = await page.$eval('[data-m="U3"] .badge', (b) => b.textContent).catch(() => '');
      if (badge !== 'from GELP') errors.push(`[${label}] member badge missing (${badge})`);
      if (!(await page.$('[data-m="U3"] .rolepick select'))) errors.push(`[${label}] member role picker missing`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-members-team.png', fullPage: true });
      await page.click('[data-m="U3"] [data-madmin]'); await page.waitForTimeout(400);
      await page.goto('http://localhost:8099/#team'); await page.waitForTimeout(600);
      await page.click('[data-m="U3"] [data-mrm]'); await page.waitForTimeout(500);
      const r1 = await rpcs();
      if (!r1.includes('account_member_set') || !r1.includes('account_member_remove')) errors.push(`[${label}] client member actions not called`);
      if (await page.$('#acctSwitch')) errors.push(`[${label}] switcher shown with one account`);
      // Julie switched in as a member: banner and the switcher with both accounts
      await page.evaluate(() => localStorage.setItem('scene', 'julie'));
      await page.goto('http://localhost:8099/#dashboard'); await page.reload(); await page.waitForTimeout(800);
      if (await page.$('#acctHome')) errors.push(`[${label}] account banner still shown`);
      if (!(await page.$('#acctSwitch.away'))) errors.push(`[${label}] switcher not marked as away`);
      const opts = await page.$$eval('#acctSwitch option', (o) => o.map((x) => x.textContent)).catch(() => []);
      if (opts.length !== 2) errors.push(`[${label}] switcher options: ${opts.join(', ')}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-members-julie.png' });
      await page.goto('http://localhost:8099/#team'); await page.waitForTimeout(700);
      // the agency side: add her from Accounts and from Platform
      await page.evaluate(() => localStorage.setItem('scene', 'agency'));
      await page.goto('http://localhost:8099/#accounts'); await page.reload(); await page.waitForTimeout(500);
      for (const v of ['accounts', 'platform']) {
        await page.goto('http://localhost:8099/#' + v); await page.waitForTimeout(800);
        if (!(await page.$('[data-memadd="T1"]'))) { errors.push(`[${label}] ${v}: no add button. ${await page.$eval('#view', (e) => e.innerText.slice(0, 200)).catch(() => '')}`); continue; }
        await page.click('[data-memadd="T1"]'); await page.waitForTimeout(500);
        if (label === 'desktop') await page.screenshot({ path: `/tmp/shots-members-${v}.png`, fullPage: true });
        await page.check('[data-membox="T1"] [data-amadmin]'); await page.click('[data-membox="T1"] [data-amgo]'); await page.waitForTimeout(500);
        const bad = await page.$eval('#toast', (t) => (!t.hidden && t.classList.contains('bad') ? t.textContent : '')).catch(() => '');
        if (bad) errors.push(`[${label}] ${v} add: error toast "${bad.trim()}"`);
      }
      const add = await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === 'account_member_add').map((x) => x[2]));
      if (add.length !== 2 || add[0].p_user !== 'U3' || !add[0].p_is_admin) errors.push(`[${label}] add calls: ${JSON.stringify(add)}`);
      await page.evaluate(() => localStorage.removeItem('scene'));
      if (label === 'phone') console.log('member rpcs:', [...new Set((await rpcs()).filter((x) => /member|account/.test(x)))].join(', '));
    }
    if (mode === 'crews') {
      const rpcLog = (n) => page.evaluate((n) => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === n).map((x) => x[2]), n);
      // dispatch: send a saved crew with the card menu, then drag a crew chip onto a card
      await page.goto('http://localhost:8099/#dispatch'); await page.waitForTimeout(700);
      const crewTxt = await page.$eval('[data-j="J1"] .dcrew', (e) => e.textContent).catch(() => '');
      if (!/Wes's crew: Worker, Joe/.test(crewTxt)) errors.push(`[${label}] dispatch crew names: ${crewTxt}`);
      await page.selectOption('[data-mv="J2"]', 'crew:CR1'); await page.waitForTimeout(600);
      if (label === 'desktop') {
        await page.dragAndDrop('[data-crewdrag="CR2"]', '[data-j="J2"]'); await page.waitForTimeout(600);
        await page.screenshot({ path: '/tmp/shots-crews-dispatch-after.png', fullPage: true });
      }
      const sets = await rpcLog('job_crew_set');
      if (!sets.some((x) => x.p_job === 'J2' && x.p_crew === 'CR1')) errors.push(`[${label}] crew menu didn't send the crew: ${JSON.stringify(sets)}`);
      if (label === 'desktop' && !sets.some((x) => x.p_job === 'J2' && x.p_crew === 'CR2')) errors.push(`[${label}] crew drag didn't send the crew: ${JSON.stringify(sets)}`);
      // the job: foreman step, then answer the missed clock-in
      await page.goto('http://localhost:8099/#job/J1'); await page.waitForTimeout(700);
      if (await page.$('#jStep')) { await page.click('#jStep'); await page.waitForTimeout(600); }
      await page.click('[data-cf="CF1"] [data-here="1"]'); await page.waitForTimeout(200);
      await page.fill('[data-cf="CF1"] [data-hrs]', '6'); await page.fill('[data-cf="CF1"] [data-note]', 'Phone died');
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-crews-answer.png', fullPage: true });
      await page.click('[data-cf="CF1"] [data-save]'); await page.waitForTimeout(600);
      const ans = await rpcLog('crew_missed_answer');
      if (!ans.length || ans[0].p_hours !== 6 || !ans[0].p_here) errors.push(`[${label}] missed clock-in answer: ${JSON.stringify(ans)}`);
      // the crew card: add someone, make them foreman
      await page.goto('http://localhost:8099/#job/J1'); await page.waitForTimeout(700);
      await page.selectOption('#crAdd', 'U3'); await page.click('#crAddGo'); await page.waitForTimeout(600);
      // Review: the swap OK and the foreman-added hours with their note
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(900);
      if (!(await page.$('[data-rv="W5"] [data-tfix]'))) errors.push(`[${label}] no fix button on foreman-added hours`);
      await page.click('[data-cf="CF2"] [data-seen]'); await page.waitForTimeout(500);
      if (!(await rpcLog('crew_flag_seen')).length) errors.push(`[${label}] swap OK not sent`);
      // saved crews: edit and save; crew settings save
      await page.goto('http://localhost:8099/#crews'); await page.waitForTimeout(600);
      await page.click('[data-crew="CR1"]'); await page.waitForTimeout(300); await page.click('#crDlg [data-m="U2"]'); await page.click('#ceGo'); await page.waitForTimeout(500);
      const cs = await rpcLog('crew_save'); if (!cs.length || !cs[0].p_members.includes('U2')) errors.push(`[${label}] crew save: ${JSON.stringify(cs)}`);
      await page.goto('http://localhost:8099/#settings'); await page.waitForTimeout(700);
      await page.click('#crSave'); await page.waitForTimeout(400);
      const st = await rpcLog('account_settings_save'); const cr = st.map((x) => x.p.crews).filter(Boolean).pop();
      if (!cr || cr.mode !== 'standing' || cr.by_service?.Striping?.clock !== 'foreman') errors.push(`[${label}] crew settings: ${JSON.stringify(cr)}`);
      if (label === 'phone') console.log('crew rpcs:', [...new Set((await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]))).filter((x) => /crew/.test(x)))].join(', '));
    }
    if (mode === 'measure') {
      const box = async () => page.$eval('#mMap', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const tap = async (fx, fy) => { const b = await box(); await page.mouse.click(b.x + b.w * fx, b.y + b.h * fy); await page.waitForTimeout(120); };
      // from the location page: an area with a cutout, a line, two poles with one tapped again to "moved"
      await page.goto('http://localhost:8099/#org/C1'); await page.waitForTimeout(900);
      await page.click('#omNew'); await page.waitForTimeout(900);
      await page.click('[data-tool="MT1"]');
      for (const [x, y] of [[0.15, 0.15], [0.85, 0.15], [0.85, 0.7], [0.15, 0.7]]) await tap(x, y);
      await page.click('#mDone'); await page.waitForTimeout(200);
      await page.click('[data-tool="cutout"]');
      for (const [x, y] of [[0.4, 0.3], [0.6, 0.3], [0.6, 0.5]]) await tap(x, y);
      await tap(0.4, 0.3);   // the first point closes it
      await page.click('[data-tool="MT2"]'); await tap(0.1, 0.85); await tap(0.9, 0.85); await page.click('#mDone');
      await page.click('[data-tool="MT3"]'); await tap(0.25, 0.6); await tap(0.75, 0.6); await page.waitForTimeout(200);
      await tap(0.75, 0.6);  // tap it again: remove or relocate
      const sum = await page.$eval('#mSum', (e) => e.textContent);
      if (label === 'phone') console.log('measured:', sum);
      if (!/sq ft paved area/.test(sum) || !/ft striping/.test(sum) || !/2 light poles, 1 moved/.test(sum)) errors.push(`[${label}] measure totals: ${sum}`);
      await page.fill('#mName', 'Front lot');
      await page.screenshot({ path: `/tmp/shots-measure-${label}-map.png` });
      await page.click('#mPrice'); await page.waitForTimeout(1200);
      await page.screenshot({ path: `/tmp/shots-measure-${label}-price.png` });
      const m = await page.evaluate(() => window.__DB.measurements[0]);
      if (!m || m.shapes.features.length !== 4 || m.shapes.features[0].geometry.coordinates.length !== 2 || !m.picture_url) errors.push(`[${label}] measurement saved: ${JSON.stringify(m)?.slice(0, 300)}`);
      const priceTxt = await page.$eval('.mprice', (e) => e.innerText).catch(() => '');
      if (!/Saw cut and patch/.test(priceTxt) || !/Light pole/.test(priceTxt)) errors.push(`[${label}] price panel: ${priceTxt.slice(0, 300)}`);
      if (label === 'desktop') { const b64 = await page.evaluate(async () => { const f = window.__UPLOADS?.slice(-1)[0]; if (!f) return ''; const r = new FileReader(); return new Promise((ok) => { r.onload = () => ok(r.result.split(',')[1]); r.readAsDataURL(f); }); });
        if (b64) fs.writeFileSync('/tmp/shots-measure-picture.png', Buffer.from(b64, 'base64')); else errors.push('no map picture uploaded'); }
      await page.click('[data-go="newinv"]'); await page.waitForTimeout(900);
      const inv = await page.evaluate(() => window.__DB.invoices.find((i) => i.pictures?.length && i.id !== 'I1'));
      if (!inv || inv.lines.length !== 5 || !/^Front lot/.test(inv.lines[0].desc)) errors.push(`[${label}] invoice from measure: ${JSON.stringify(inv)?.slice(0, 300)}`);
      if (label === 'phone') console.log('invoice lines:', inv?.lines.map((l) => `${l.name} ${l.qty} x ${l.price}`).join(' | '));
      await page.screenshot({ path: `/tmp/shots-measure-${label}-invoice.png`, fullPage: true });
      // reopen it from the location page and push it into the proposal draft
      await page.goto('http://localhost:8099/#org/C1'); await page.waitForTimeout(900);
      await page.click(`[data-om="${m.id}"]`); await page.waitForTimeout(900);
      await page.click('#mPrice'); await page.waitForTimeout(900);
      await page.click('[data-go="prop:PR1"]'); await page.waitForTimeout(900);
      const pr = await page.evaluate(() => window.__DB.proposals[0].items);
      if (pr.custom.length !== 5 || !pr.mockups[0]?.measure) errors.push(`[${label}] proposal push: ${JSON.stringify(pr).slice(0, 300)}`);
      // inside the invoice editor: Measure and price, count one pole, add the lines, save
      await page.goto('http://localhost:8099/#invoice/I3'); await page.waitForTimeout(900);
      await page.click('#iMeasure'); await page.waitForTimeout(900);
      await page.click('[data-tool="MT3"]'); await tap(0.5, 0.5);
      await page.click('#mPrice'); await page.waitForTimeout(900);
      await page.click('[data-go="back"]'); await page.waitForTimeout(500);
      await page.click('#iSave'); await page.waitForTimeout(600);
      const i3 = await page.evaluate(() => window.__DB.invoices.find((i) => i.id === 'I3'));
      if (i3.lines.length !== 1 || i3.lines[0].name !== 'Light pole' || i3.pictures?.length !== 1) errors.push(`[${label}] invoice editor push: ${JSON.stringify(i3).slice(0, 300)}`);
      const used = await page.evaluate(() => window.__DB.measurements.map((x) => (x.used_on || []).map((u) => u.kind)));
      if (label === 'phone') console.log('used on:', JSON.stringify(used));
      await page.screenshot({ path: `/tmp/shots-measure-${label}-i3.png`, fullPage: true });
      // the customer's page shows the map
      await page.goto('http://localhost:8099/doc/?t=' + 'tok1'.padEnd(64, 'x')); await page.waitForTimeout(900);
      if (!(await page.$('.doc-pics img'))) errors.push(`[${label}] doc page has no map picture`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-measure-doc.png', fullPage: true });
      // setup: change a price, add a tap to Light pole, save
      await page.goto('http://localhost:8099/#measuresetup'); await page.waitForTimeout(800);
      await page.fill('[data-pi="PI1"] [data-pk="price"]', '0.25'); await page.click('#pbSave'); await page.waitForTimeout(500);
      if ((await page.evaluate(() => window.__DB.price_items[0].price)) !== 0.25) errors.push(`[${label}] price book save`);
      await page.click('[data-type="MT3"] [data-stadd]'); await page.waitForTimeout(200);
      await page.click('[data-type="MT3"] [data-tsave]'); await page.waitForTimeout(500);
      const st = await page.evaluate(() => window.__DB.measure_types[2].states);
      if (st.length !== 3) errors.push(`[${label}] tap added: ${JSON.stringify(st)}`);
      await page.screenshot({ path: `/tmp/shots-measure-${label}-setup.png`, fullPage: true });
    }
    if (mode === 'bids') {
      const rpcLog = (n) => page.evaluate((n) => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === n).map((x) => x[2]), n);
      // the Sales tab has a Bids divider
      await page.goto('http://localhost:8099/#bids'); await page.waitForTimeout(700);
      if (!(await page.$('.divider[data-nav="bids"]')) && label === 'desktop') errors.push(`[${label}] no Bids divider`);
      // scorecard setup: add a yes or no question, rank job size 2, save
      await page.goto('http://localhost:8099/#bidsetup'); await page.waitForTimeout(700);
      await page.click('#mYes'); await page.waitForTimeout(200);
      await page.fill('[data-m="6"] [data-mk="label"]', 'Bonded job?');
      await page.selectOption('[data-m="0"] [data-mk="rank"]', '2');
      await page.click('[data-m="4"] [data-mk="on"]');   // turn on Time to prepare
      await page.click('#sSave'); await page.waitForTimeout(600);
      const ss = (await rpcLog('bid_settings_save')).pop();
      if (!ss || ss.p.metrics.length !== 7 || ss.p.metrics[0].rank !== 2 || ss.p.metrics.pop().label !== 'Bonded job?' || ss.p.base_lat == null) errors.push(`[${label}] scorecard save: ${JSON.stringify(ss)?.slice(0, 400)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-bids-setup-saved.png', fullPage: true });
      // add a bid with an upload
      await page.goto('http://localhost:8099/#bids'); await page.waitForTimeout(700);
      await page.click('#bNew'); await page.waitForTimeout(300);
      await page.fill('#nbT', 'Casino garage sealcoat'); await page.fill('#nbC', 'Beau Rivage');
      await page.setInputFiles('#nbF', { name: 'rfp.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
      await page.click('#nbGo'); await page.waitForTimeout(900);
      const nb = await page.evaluate(() => { const b = window.__DB.bids.find((x) => x.title === 'Casino garage sealcoat'); return b && { b, f: window.__DB.bid_files.filter((f) => f.bid_id === b.id) }; });
      if (!nb || nb.b.source !== 'upload' || nb.f.length !== 1 || !nb.f[0].path.startsWith('T1/' + nb.b.id + '/')) errors.push(`[${label}] new bid with upload: ${JSON.stringify(nb)?.slice(0, 300)}`);
      if (!/bid\//.test(page.url())) errors.push(`[${label}] didn't open the new bid: ${page.url()}`);
      // score it: answer the crew question; fill details and save (looks the address up once)
      await page.goto('http://localhost:8099/#bid/B1'); await page.waitForTimeout(800);
      await page.selectOption('[data-ans="crew"]', 'tight'); await page.waitForTimeout(600);
      if ((await page.evaluate(() => window.__DB.bids[0].answers.crew)) !== 'tight') errors.push(`[${label}] crew answer not saved`);
      await page.fill('#bAddr', '100 Beach Blvd, Biloxi, MS'); await page.fill('#bVal', '70,000'); await page.click('#bSave'); await page.waitForTimeout(800);
      const b1 = await page.evaluate(() => window.__DB.bids[0]);
      if (b1.est_value !== 70000 || b1.site_lat == null) errors.push(`[${label}] bid save: ${JSON.stringify(b1).slice(0, 300)}`);
      // override it: a note is required
      await page.click('#bid-override-summary, details summary').catch(() => {}); await page.waitForTimeout(200);
      await page.selectOption('#oRes', 'no_go'); await page.click('#oGo'); await page.waitForTimeout(300);
      if ((await rpcLog('bid_override')).length) errors.push(`[${label}] override went without a note`);
      await page.fill('#oNote', 'Crew is booked solid'); await page.click('#oGo'); await page.waitForTimeout(700);
      const ov = (await rpcLog('bid_override')).pop();
      if (!ov || ov.p_result !== 'no_go' || ov.p_note !== 'Crew is booked solid') errors.push(`[${label}] override: ${JSON.stringify(ov)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-bids-bid-after.png', fullPage: true });
      // measure and price from the bid
      await page.goto('http://localhost:8099/#bid/B1'); await page.waitForTimeout(800);
      await page.click('#bMeasure'); await page.waitForTimeout(900);
      const mb = await page.$eval('#mMap', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await page.click('[data-tool="MT3"]'); await page.mouse.click(mb.x + mb.w / 2, mb.y + mb.h / 2); await page.waitForTimeout(200);
      await page.click('#mPrice'); await page.waitForTimeout(900);
      await page.click('[data-go="back"]'); await page.waitForTimeout(800);
      const pl = await page.evaluate(() => window.__DB.bids[0]);
      if (!pl.measurement_id || pl.price_lines.length !== 1 || pl.price_lines[0].name !== 'Light pole') errors.push(`[${label}] measure on bid: ${JSON.stringify(pl.price_lines)}`);
      // the won bid becomes an invoice with its priced lines
      await page.goto('http://localhost:8099/#bid/B3'); await page.waitForTimeout(800);
      await page.click('[data-conv="invoice"]'); await page.waitForTimeout(900);
      const conv = (await rpcLog('bid_converted')).pop();
      const inv = await page.evaluate((id) => window.__DB.invoices.find((i) => i.id === id), conv?.p_ref);
      if (!conv || conv.p_kind !== 'invoice' || !inv || inv.lines[0].name !== 'Striping' || inv.company_id !== 'C1') errors.push(`[${label}] won to invoice: ${JSON.stringify(conv)} ${JSON.stringify(inv)?.slice(0, 200)}`);
      // Review: approve the waiting override
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(900);
      await page.click('[data-rb="B2"] [data-ok="1"]', { timeout: 5000 }); await page.waitForTimeout(500);
      if ((await rpcLog('bid_override_decide')).pop()?.p_ok !== true) errors.push(`[${label}] review approve not sent`);
      // the public upload page
      await page.route('**/functions/v1/bid-intake**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, files: 1 }) }));
      await page.goto('http://localhost:8099/bid/?t=' + 'a'.repeat(64)); await page.waitForTimeout(900);
      await page.fill('#title', 'Church lot'); await page.fill('#name', 'Pat'); await page.fill('#email', 'pat@church.org');
      await page.setInputFiles('#files', { name: 'plans.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-bids-public.png', fullPage: true });
      await page.click('#go'); await page.waitForTimeout(700);
      const done = await page.$eval('#root', (e) => e.innerText);
      if (!/Got it/.test(done)) errors.push(`[${label}] public upload: ${done.slice(0, 200)}`);
      if (label === 'phone') await page.screenshot({ path: '/tmp/shots-bids-public-done.png' });
      if (label === 'phone') console.log('bid rpcs:', [...new Set((await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]))).filter((x) => /bid/.test(x)))].join(', '));
    }
    if (mode === 'esign') try {
      const shot = (n, full = true) => page.screenshot({ path: `/tmp/shots-esign-${label}-${n}.png`, fullPage: full });
      const rpcLog = (n) => page.evaluate((n) => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === n).map((x) => x[2]), n);
      const fnLog = () => page.evaluate(() => window.__LOG.filter((x) => x[0] === 'fn').map((x) => [x[1], x[2]]));
      const toastBad = async (where) => { const bad = await page.$eval('#toast', (t) => (!t.hidden && /bad/.test(t.className) ? t.textContent : '')).catch(() => ''); if (bad) errors.push(`[${label}] ${where}: error toast "${bad.trim()}"`); };
      // Tools has a Documents drawer with E-sign, and search finds it
      await page.goto('http://localhost:8099/#tools'); await page.waitForTimeout(700);
      if (!(await page.$('#view [data-nav="esign"]'))) errors.push(`[${label}] no E-sign in Tools`);
      if (!(await page.$('#view [data-nav="esignsetup"]'))) errors.push(`[${label}] no E-sign setup in Tools, Admin`);
      // the feature switch and the role area are listed
      await page.goto('http://localhost:8099/#settings'); await page.waitForTimeout(700);
      if (!/E-sign/.test(await page.$eval('#view', (e) => e.innerText))) errors.push(`[${label}] E-sign switch missing in Settings`);
      // the list: filters and tabs
      await page.goto('http://localhost:8099/#esign'); await page.waitForTimeout(800);
      await page.click('[data-f="all"]'); await page.waitForTimeout(300);
      const rows = await page.$$eval('[data-env]', (b) => b.length);
      if (rows !== 3) errors.push(`[${label}] list shows ${rows} documents, expected 3`);
      await page.click('[data-f="completed"]'); await page.waitForTimeout(300);
      if ((await page.$$eval('[data-env]', (b) => b.length)) !== 1) errors.push(`[${label}] completed filter`);
      await page.click('[data-tab="tpl"]'); await page.waitForTimeout(300); await shot('templates');
      if (!(await page.$('[data-tpl="TP1"]'))) errors.push(`[${label}] template not listed`);
      await page.click('[data-tab="docs"]'); await page.waitForTimeout(300);
      // new from upload: real pdf.js reads the pages, then the editor
      await page.click('#esNew'); await page.waitForTimeout(300);
      await page.setInputFiles('#esF', { name: 'roof-contract.pdf', mimeType: 'application/pdf', buffer: ESIGN_PDF });
      await page.click('#esGo'); await page.waitForTimeout(1500); await toastBad('upload');
      const made = (await rpcLog('esign_envelope_create')).pop();
      if (!made || made.p.pages?.length !== 2 || !made.p.file_path?.startsWith('T1/u/') || made.p.title !== 'roof contract') errors.push(`[${label}] create from upload: ${JSON.stringify(made)?.slice(0, 300)}`);
      if (!/esignedit\//.test(page.url())) errors.push(`[${label}] didn't open the editor: ${page.url()}`);
      await page.waitForSelector('.pdfpage canvas', { timeout: 8000 }).catch(() => errors.push(`[${label}] editor: no pages drawn`));
      const drawn = await page.$eval('.pdfpage canvas', (c) => c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 !== 3 && v < 200)).catch(() => false);
      if (!drawn) errors.push(`[${label}] editor: the page canvas is blank`);
      // signer, then a signature placed by tapping, a text field dragged on, move and resize
      await page.fill('[data-who="s1"] [data-pk="name"]', 'Pam Smith'); await page.fill('[data-who="s1"] [data-pk="email"]', 'pam@oak.test');
      await page.click('[data-type="signature"]');
      const ov = await page.$eval('.pdfpage[data-page="1"] .pdfov', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height }; });
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 100)), ov.y);
      let r1 = await page.$eval('.pdfpage[data-page="1"] .pdfov', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await page.mouse.click(r1.x + r1.w * 0.5, r1.y + r1.h * 0.5); await page.waitForTimeout(300);
      if ((await page.$$('.esf')).length !== 1) errors.push(`[${label}] tap to place: no field`);
      if (label === 'desktop') await page.dragAndDrop('[data-type="text"]', '.pdfpage[data-page="1"] .pdfov', { targetPosition: { x: Math.round(r1.w * 0.3), y: Math.round(r1.h * 0.2) } }).catch((e) => errors.push(`[${label}] drag on: ${e.message}`));
      else {   // phones place by tapping (no drag and drop from the palette on touch screens)
        await page.click('[data-type="text"]');
        await page.$eval('.pdfpage[data-page="1"]', (e) => e.scrollIntoView());
        r1 = await page.$eval('.pdfpage[data-page="1"] .pdfov', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        await page.mouse.click(r1.x + r1.w * 0.3, r1.y + r1.h * 0.2);
      }
      await page.waitForTimeout(300);
      if ((await page.$$('.esf')).length !== 2) errors.push(`[${label}] drag to place: ${(await page.$$('.esf')).length} fields`);
      r1 = await page.$eval('.pdfpage[data-page="1"] .pdfov', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const sig = await page.$eval('.esf', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, rx: r.right - 4, ry: r.bottom - 4 }; });
      await page.mouse.move(sig.x, sig.y); await page.mouse.down(); await page.mouse.move(sig.x - 40, sig.y + 60, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(200);
      const sig2 = await page.$eval('.esf', (e) => { const r = e.getBoundingClientRect(); return { rx: r.right - 4, ry: r.bottom - 4 }; });
      await page.mouse.move(sig2.rx, sig2.ry); await page.mouse.down(); await page.mouse.move(sig2.rx + 50, sig2.ry + 20, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(200);
      await page.click('.esf:nth-child(2)').catch(() => {}); await page.waitForTimeout(200);
      if (await page.$('#edFL')) { await page.fill('#edFL', 'Unit number'); await page.click('#edFR'); }
      if (label === 'desktop') await shot('editor');
      await page.click('#edSave'); await page.waitForTimeout(600); await toastBad('editor save');
      const up = (await rpcLog('esign_envelope_update')).pop();
      const fs1 = up?.p?.fields || [];
      const sigF = fs1.find((f) => f.type === 'signature'), txtF = fs1.find((f) => f.type === 'text');
      if (!up || fs1.length !== 2 || up.p.signers[0]?.email !== 'pam@oak.test' || !sigF || !(sigF.y > 0.5) || !(sigF.w > 0.3) || txtF?.label !== 'Unit number' || txtF?.required !== true || txtF?.page !== 1)
        errors.push(`[${label}] editor save: ${JSON.stringify(up)?.slice(0, 500)}`);
      await page.click('#edSend'); await page.waitForTimeout(900); await toastBad('send');
      const sent = (await fnLog()).filter(([n, b]) => n === 'esign-email' && b.action === 'send').pop();
      if (!sent || !/esigndoc\//.test(page.url())) errors.push(`[${label}] send: ${JSON.stringify(sent)} ${page.url()}`);
      // template editor: add a role, put initials on page 2 for it, save
      await page.goto('http://localhost:8099/#esigntpl/TP1'); await page.waitForTimeout(800);
      await page.waitForSelector('.pdfpage[data-page="2"] .esf', { timeout: 8000 }).catch(() => errors.push(`[${label}] template fields not shown`));
      await page.click('#edAddWho'); await page.waitForTimeout(200); await page.fill('[data-who="r1"] [data-pk="label"]', 'Witness');
      await page.click('[data-type="initials"]');
      await page.$eval('.pdfpage[data-page="2"]', (e) => e.scrollIntoView());
      const r2 = await page.$eval('.pdfpage[data-page="2"] .pdfov', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await page.mouse.click(r2.x + r2.w * 0.8, r2.y + r2.h * 0.5); await page.waitForTimeout(300);
      await page.click('#edSave'); await page.waitForTimeout(600); await toastBad('template save');
      const ts = (await rpcLog('esign_template_save')).pop();
      if (!ts || ts.p.roles.length !== 3 || ts.p.roles[2].label !== 'Witness' || !ts.p.fields.some((f) => f.signer === 'r1' && f.type === 'initials' && f.page === 2)) errors.push(`[${label}] template save: ${JSON.stringify(ts)?.slice(0, 400)}`);
      if (label === 'desktop') await shot('template');
      // send from template: fill the people in, send now
      await page.goto('http://localhost:8099/#esign'); await page.waitForTimeout(700);
      await page.click('#esFromTpl'); await page.waitForTimeout(400);
      await page.selectOption('#etC', 'C1'); await page.waitForTimeout(400);
      await page.fill('[data-role="client"] [data-k="name"]', 'Pam Smith'); await page.fill('[data-role="client"] [data-k="email"]', 'pam@oak.test');
      await page.selectOption('[data-role="rep"] [data-pick]', 'u:U1'); await page.waitForTimeout(100);
      await page.fill('[data-role="r1"] [data-k="name"]', 'Wes Witness'); await page.fill('[data-role="r1"] [data-k="email"]', 'wes@test.local');
      if (label === 'desktop') await shot('from-template', false);
      await page.click('#etSend'); await page.waitForTimeout(900); await toastBad('send from template');
      const ft = (await rpcLog('esign_envelope_create')).pop();
      if (!ft || ft.p.template_id !== 'TP1' || ft.p.company_id !== 'C1' || ft.p.signers.find((x) => x.key === 'rep')?.email !== 'admin@test.local') errors.push(`[${label}] from template: ${JSON.stringify(ft)?.slice(0, 300)} toast=${await page.$eval('#toast', (t) => t.textContent).catch(() => '')} dlg=${await page.$eval('#esTpl', (d) => d.open + ' ' + d.innerText.slice(0, 300)).catch((e) => e.message)}`);
      if ((await fnLog()).filter(([n, b]) => n === 'esign-email' && b.action === 'send').length < 2) errors.push(`[${label}] from template: not sent`);
      // envelope detail: signers, event log, remind, download, void
      await page.goto('http://localhost:8099/#esigndoc/E2'); await page.waitForTimeout(800);
      const det = await page.$eval('#view', (e) => e.innerText);
      if (!/Pam Smith/.test(det) || !/203\.0\.113\.5/.test(det) || !/Opened/.test(det) || !/a{64}/.test(det)) errors.push(`[${label}] detail missing signer, log or fingerprint`);
      if (!(await page.$('[data-rem="S2"]'))) errors.push(`[${label}] no Remind button: ${det.slice(0, 600).replace(/\n/g, ' | ')}`);
      else { await page.click('[data-rem="S2"]'); await page.waitForTimeout(500); await toastBad('remind'); }
      if (!(await fnLog()).some(([n, b]) => b.action === 'remind' && b.signer === 'S2')) errors.push(`[${label}] remind not sent`);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), page.click('#dOrig')]);
      if (!dl) errors.push(`[${label}] original download didn't start`);
      await page.goto('http://localhost:8099/#esigndoc/E2'); await page.waitForTimeout(700);
      await page.click('#dVoid'); await page.waitForTimeout(300); await page.click('#vGo'); await page.waitForTimeout(200);
      if ((await rpcLog('esign_void')).length) errors.push(`[${label}] void went without a reason`);
      await page.fill('#vR', 'Wrong price'); await page.click('#vGo'); await page.waitForTimeout(600);
      if ((await rpcLog('esign_void')).pop()?.p_reason !== 'Wrong price') errors.push(`[${label}] void not sent`);
      if (label === 'desktop') await shot('detail-voided');
      await page.goto('http://localhost:8099/#esigndoc/E3'); await page.waitForTimeout(700);
      if (!(await page.$('#dFinal'))) errors.push(`[${label}] no signed PDF download on a completed one`);
      // setup
      await page.goto('http://localhost:8099/#esignsetup'); await page.waitForTimeout(600);
      if (!/wet, ink signature/.test(await page.$eval('#view', (e) => e.innerText))) errors.push(`[${label}] setup is missing the wills and trusts note`);
      await page.fill('#sE', '14'); await page.click('#sSave'); await page.waitForTimeout(400); await toastBad('setup save');
      if ((await rpcLog('esign_settings_save')).pop()?.p?.expires_days !== 14) errors.push(`[${label}] setup not saved`);
      // the signing page
      ESIGN_CALLS.length = 0;
      await page.goto('http://localhost:8099/sign/?t=' + 'a'.repeat(64)); await page.waitForTimeout(1200);
      await page.waitForSelector('.ff', { timeout: 8000 }).catch(() => errors.push(`[${label}] sign page: no fields`));
      if (await page.$('[data-tx="f3"]:not([disabled])')) errors.push(`[${label}] sign page: fields open before the code`);
      if (label === 'desktop') await shot('sign-start');
      await page.click('#agree'); await page.click('#agreeGo'); await page.waitForTimeout(500);
      await page.fill('#code', '000000'); await page.waitForTimeout(500);
      if (!/doesn't match/.test(await page.$eval('#serr', (e) => e.textContent))) errors.push(`[${label}] sign page: wrong code not shown`);
      await page.fill('#code', '123456'); await page.waitForTimeout(600);
      if (!(await page.$('[data-tx="f3"]:not([disabled])'))) errors.push(`[${label}] sign page: fields still locked after the code`);
      await page.fill('[data-tx="f3"]', '12B'); await page.check('[data-cb="f4"]');
      await page.click('[data-pad="signature"]'); await page.waitForTimeout(300);
      const pc = await page.$eval('#pc', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await page.mouse.move(pc.x + 30, pc.y + 100); await page.mouse.down(); for (let i = 1; i <= 12; i++) await page.mouse.move(pc.x + 30 + i * 25, pc.y + 100 + Math.sin(i) * 40); await page.mouse.up();
      if (label === 'desktop') await shot('sign-pad', false);
      await page.click('#pOk'); await page.waitForTimeout(300);
      await page.click('[data-pad="initials"]'); await page.waitForTimeout(300); await page.click('#padDlg [data-m="type"]'); await page.click('#pOk'); await page.waitForTimeout(300);
      if (await page.$eval('#finish', (b) => b.disabled)) errors.push(`[${label}] sign page: Finish still off with everything filled`);
      if (label === 'desktop') await shot('sign-filled');
      await page.click('#finish'); await page.waitForTimeout(700);
      const sub = ESIGN_CALLS.find((c) => c.action === 'submit');
      if (!sub || !/^data:image\/png;base64,/.test(sub.signature || '') || !/^data:image\/png;base64,/.test(sub.initials || '') || sub.vals?.f3 !== '12B' || sub.vals?.f4 !== true || sub.session !== 's'.repeat(64) || sub.kind !== 'drawn')
        errors.push(`[${label}] sign submit: ${JSON.stringify(sub && { ...sub, signature: sub.signature?.slice(0, 30), initials: sub.initials?.slice(0, 30) })}`);
      if (!/Done\. You signed/.test(await page.$eval('#root', (e) => e.innerText))) errors.push(`[${label}] sign page: no done message`);
      if (ESIGN_CALLS.map((c) => c.action).join(',') !== 'view,consent,code,check,check,submit') errors.push(`[${label}] sign page calls: ${ESIGN_CALLS.map((c) => c.action)}`);
      if (label === 'phone') await shot('sign-done', false);
      // decline
      await page.goto('http://localhost:8099/sign/?t=' + 'a'.repeat(64)); await page.waitForTimeout(900);
      await page.click('#dec'); await page.click('#dGo'); await page.waitForTimeout(200);
      if (ESIGN_CALLS.some((c) => c.action === 'decline')) errors.push(`[${label}] decline went without a reason`);
      await page.fill('#dr', 'Wrong unit'); await page.click('#dGo'); await page.waitForTimeout(500);
      if (ESIGN_CALLS.filter((c) => c.action === 'decline').pop()?.reason !== 'Wrong unit') errors.push(`[${label}] decline not sent`);
      // a completed one offers the signed copy
      await page.goto('http://localhost:8099/sign/?t=' + 'c'.repeat(64)); await page.waitForTimeout(800);
      if (!(await page.$('#dlFinal'))) errors.push(`[${label}] completed sign page has no download`);
      // the public check
      await page.goto('http://localhost:8099/sign/?verify=1'); await page.waitForTimeout(700);
      await page.setInputFiles('#vf', { name: 'signed.pdf', mimeType: 'application/pdf', buffer: ESIGN_PDF }); await page.waitForTimeout(800);
      if (!/real signed copy/.test(await page.$eval('#vr', (e) => e.innerText))) errors.push(`[${label}] verify page: ${await page.$eval('#vr', (e) => e.innerText)}`);
      const vr = (await rpcLog('esign_verify')).pop();
      if (!/^[a-f0-9]{64}$/.test(vr?.p_sha || '')) errors.push(`[${label}] verify hash: ${JSON.stringify(vr)}`);
      if (label === 'desktop') await shot('verify');
    } catch (x) { errors.push(`[${label}] esign run stopped: ${x.message.split('\n')[0]} at ${page.url()}`); await page.screenshot({ path: `/tmp/shots-esign-${label}-stopped.png`, fullPage: true }); }
    if (mode === 'portal') {
      const shot = (n, full = true) => page.screenshot({ path: `/tmp/shots-portal-${label}-${n}.png`, fullPage: full });
      const toastBad = async (where) => { const bad = await page.$eval('#toast', (t) => (!t.hidden && /bad/.test(t.className) ? t.textContent : '')).catch(() => ''); if (bad) errors.push(`[${label}] ${where}: error toast "${bad.trim()}"`); };
      // the CRM card: invite, email again, make admin, choose what they see
      await page.goto('http://localhost:8099/#org/C2'); await page.waitForTimeout(900);
      if (!(await page.$('#orgPortal [data-pu="PU1"]'))) errors.push(`[${label}] portal card missing`);
      await page.fill('#pvName', 'Dana Lee'); await page.fill('#pvEmail', 'dana@gulf.test'); await page.click('#pvInv'); await page.waitForTimeout(600); await toastBad('invite');
      if (!(await page.$('#orgPortal [data-pu="PU3"]'))) errors.push(`[${label}] invited person not listed`);
      await page.click('#orgPortal [data-pu="PU2"] [data-again]'); await page.waitForTimeout(400);
      await page.click('#orgPortal [data-pu="PU2"] [data-adm]'); await page.waitForTimeout(500); await toastBad('make admin');
      await page.$eval('#orgPortal', (e) => e.scrollIntoView()); await shot('card', false);
      await page.click('#pvVis'); await page.waitForTimeout(600);
      await page.click('#portalVis input[type=checkbox][data-id="J2"]'); await page.waitForTimeout(300);
      await page.selectOption('#portalVis select[data-id="A2"]', 'shared'); await page.waitForTimeout(300);
      await page.fill('#portalVis [data-note="J1"]', 'Please leave the side gate open'); await page.press('#portalVis [data-note="J1"]', 'Tab'); await page.waitForTimeout(300);
      await page.screenshot({ path: `/tmp/shots-portal-${label}-vis.png` }); await toastBad('visibility');
      await page.click('#portalVis [data-x]'); await page.waitForTimeout(200);
      await page.click('#orgPortal [data-pu="PU3"] [data-rm]'); await page.waitForTimeout(500); await toastBad('remove');
      if (await page.$('#orgPortal [data-pu="PU3"]')) errors.push(`[${label}] removed person still listed`);
      // settings
      await page.goto('http://localhost:8099/#portalsetup'); await page.waitForTimeout(700);
      await page.click('[data-sec="approvals"]'); await page.check('input[name=pfd][value=shared]'); await page.click('#pSave'); await page.waitForTimeout(500); await toastBad('portal settings');
      await shot('setup');
      await page.goto('http://localhost:8099/#inbox/CH1'); await page.waitForTimeout(900);
      if (!/Client portal/.test(await page.$eval('#view', (e) => e.innerText).catch(() => ''))) errors.push(`[${label}] inbox doesn't say Client portal`);
      // the client's portal
      for (const [hash, check] of [['', 'Hi, Pam'], ['#schedule', 'side gate'], ['#estimates', 'Waiting on you'], ['#invoices', 'Past due'], ['#invoice/I1', 'Pay $257.00'], ['#estimate/P1', 'Review, accept and sign'],
        ['#files', 'Service agreement'], ['#messages', 'Tuesday morning'], ['#approvals', 'Add two dumpsters'], ['#team', 'Bob Jones']]) {
        await page.goto('http://localhost:8099/portal/' + hash); await page.waitForTimeout(800);
        const txt = await page.$eval('#app', (e) => e.innerText).catch(() => '');
        if (!txt.includes(check)) errors.push(`[${label}] portal ${hash || 'home'}: missing "${check}" (got ${txt.slice(0, 160).replace(/\n/g, ' ')})`);
        await toastBad('portal ' + hash);
        await shot('client-' + (hash.replace(/[#/]/g, '') || 'home'));
      }
      await page.goto('http://localhost:8099/portal/#messages'); await page.waitForTimeout(700);
      await page.fill('#mT', 'Can you come Friday?'); await page.click('#mf button'); await page.waitForTimeout(700);
      if (!/Can you come Friday/.test(await page.$eval('#msgs', (e) => e.innerText))) errors.push(`[${label}] message not sent`);
      await page.goto('http://localhost:8099/portal/#approvals'); await page.waitForTimeout(700);
      await page.click('[data-ap="AP1"] [data-ok="1"]'); await page.waitForTimeout(700); await toastBad('approve');
      await page.goto('http://localhost:8099/portal/#team'); await page.waitForTimeout(700);
      await page.selectOption('[data-u="PU2"] [data-a="invoices"]', '2'); await page.click('[data-u="PU2"] [data-save]'); await page.waitForTimeout(500); await toastBad('team save');
      if ((await page.evaluate(() => window.__SET?.p_perms?.invoices)) !== 2) errors.push(`[${label}] team levels not saved`);
      await page.fill('#iE', 'erin@gulf.test'); await page.fill('#iN', 'Erin'); await page.click('#inv button'); await page.waitForTimeout(700); await toastBad('team invite');
      if (!(await page.$('[data-u="PU7"]'))) errors.push(`[${label}] client invite not listed`);
      await page.click('#me'); await page.waitForTimeout(200); await shot('client-menu', false);
      await page.click('#mMfa'); await page.waitForTimeout(500); await shot('client-mfa', false);
      await page.keyboard.press('Escape');
      // the CRM preview
      await page.goto('http://localhost:8099/portal/?preview=C2#invoice/I1'); await page.waitForTimeout(800);
      const pv = await page.$eval('#app', (e) => e.innerText);
      if (!/Preview: this is what this client sees/.test(pv) || /Pay \$257/.test(pv)) errors.push(`[${label}] preview: banner or pay button wrong`);
      await page.goto('http://localhost:8099/portal/?preview=C2#messages'); await page.waitForTimeout(700); await shot('preview-messages');
      if (await page.$('#mf')) errors.push(`[${label}] preview can send`);
      if (label === 'phone') console.log('portal rpcs:', [...new Set((await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]))).filter((x) => /portal/.test(x)))].join(', '));
    }
    if (mode === 'social') {
      const toastBad = async (what) => { const bad = await page.$eval('#toast', (t) => (!t.hidden && t.classList.contains('bad') ? t.textContent : '')).catch(() => ''); if (bad) errors.push(`[${label}] ${what}: error toast "${bad.trim()}"`); };
      const shot = (n, full = true) => page.screenshot({ path: `/tmp/shots-social-${label}-${n}.png`, fullPage: full });
      await page.goto('http://localhost:8099/#social'); await page.waitForTimeout(800);
      const chips = await page.$$eval('.schip', (x) => x.length);
      if (chips < 3) errors.push(`[${label}] month shows ${chips} posts`);
      await shot('month');
      await page.click('[data-mode="list"]'); await page.waitForTimeout(500); await shot('list');
      const lt = await page.$eval('#spBody', (e) => e.innerText);
      if (!/Needs approval/.test(lt) || !/Didn't go out/.test(lt) || !/JPEG/.test(lt)) errors.push(`[${label}] list groups: ${lt.slice(0, 200)}`);
      // approve the pending one
      await page.click('[data-post="SP3"]'); await page.waitForTimeout(400); await page.click('#spApprove'); await page.waitForTimeout(400); await toastBad('approve');
      // a new post with two pictures from the library, scheduled
      await page.click('[data-mode="month"]'); await page.waitForTimeout(400);
      await page.click('#spNew'); await page.waitForTimeout(400);
      await page.fill('#spText', 'New truck is here #local');
      await page.click('#spLib'); await page.waitForTimeout(400);
      const pickN = await page.$$eval('#spPg label', (x) => x.length);
      if (pickN !== 2) errors.push(`[${label}] picker should list 2 pictures, shows ${pickN}`);
      await page.check('#spPg input[value="M1"]'); await page.check('#spPg input[value="M2"]'); await page.click('#spPadd'); await page.waitForTimeout(300);
      await page.click('#spDlg summary'); await page.waitForTimeout(200);
      await shot('composer', false);
      await page.click('#spGo'); await page.waitForTimeout(500); await toastBad('schedule');
      const sv = await page.evaluate(() => window.__SAVED);
      if (!sv || sv.mode !== 'schedule' || sv.media.length !== 2 || !sv.account_ids.includes('SA1') || !sv.account_ids.includes('SA2') || sv.account_ids.includes('SA3') || !sv.scheduled_at) errors.push(`[${label}] saved post: ${JSON.stringify(sv)}`);
      // Instagram without a picture warns
      await page.click('#spNew'); await page.waitForTimeout(300); await page.fill('#spText', 'text only');
      const warn = await page.$eval('#spWarn', (e) => e.innerText);
      if (!/Instagram needs/.test(warn)) errors.push(`[${label}] no Instagram warning: ${warn}`);
      await page.click('#spDlg [data-x]');
      // duplicate a posted one keeps its media
      await page.click('[data-post="SP2"]'); await page.waitForTimeout(300); await page.click('#spDup'); await page.waitForTimeout(300);
      if ((await page.$$eval('#spMedia .mi', (x) => x.length)) !== 1 || (await page.$eval('#spText', (e) => e.value)) !== 'Before and after on Oak Apartments') errors.push(`[${label}] duplicate lost content`);
      await page.click('#spDlg [data-x]');
      // batch from a pasted sheet
      await page.goto('http://localhost:8099/#socialbatch'); await page.waitForTimeout(600);
      await page.click('[data-tab="sheet"]');
      const y = new Date().getFullYear() + 1;
      await page.fill('#sbPaste', `date,time,text,media,accounts,link\n${y}-01-05,9:30 am,"Hello, world",https://cdn.test/a.jpg,all,\n1/6/${y},14:00,Facebook only,,facebook,https://x.com\n${y}-01-07,10:00,"needs a pic",,instagram,`);
      await page.click('#sbRead'); await page.waitForTimeout(400);
      const bad = await page.$$eval('.sbatch tr.bad', (x) => x.length);
      if (bad !== 1) errors.push(`[${label}] batch should flag 1 row, flagged ${bad}`);
      await shot('batch');
      await page.click('.sbatch tr.bad [data-rmr]'); await page.waitForTimeout(300);
      await page.click('#sbGo'); await page.waitForTimeout(600); await toastBad('batch');
      const bt = await page.evaluate(() => window.__BATCH);
      if (!bt || bt.posts.length !== 2 || bt.posts[0].account_ids.length !== 2 || bt.posts[1].account_ids.join() !== 'SA1' || new Date(bt.posts[0].scheduled_at).getHours() !== 9 || new Date(bt.posts[1].scheduled_at).getHours() !== 14) errors.push(`[${label}] batch payload: ${JSON.stringify(bt).slice(0, 300)}`);
      // batch from media, weekdays
      await page.goto('http://localhost:8099/#socialbatch'); await page.waitForTimeout(600);
      await page.click('#sbPick'); await page.waitForTimeout(300); await page.check('#spPg input[value="M1"]'); await page.check('#spPg input[value="M2"]'); await page.click('#spPadd');
      await page.fill('#sbCap', 'Tip #{n}'); await page.selectOption('#sbEvery', 'wk'); await page.click('#sbLay'); await page.waitForTimeout(300);
      const rowsN = await page.$$eval('.sbatch tbody tr', (x) => x.length);
      if (rowsN !== 2) errors.push(`[${label}] media batch rows ${rowsN}`);
      // accounts: connect explains it isn't set up yet, settings save
      await page.goto('http://localhost:8099/#socialaccounts'); await page.waitForTimeout(600); await shot('accounts');
      await page.click('#saMeta'); await page.waitForTimeout(400);
      const tt = await page.$eval('#toast', (t) => t.textContent).catch(() => '');
      if (!/set up/.test(tt)) errors.push(`[${label}] connect message: ${tt}`);
      await page.check('#saAppr'); await page.click('#saSave'); await page.waitForTimeout(300);
      if (!(await page.evaluate(() => window.__SSET?.require_approval))) errors.push(`[${label}] settings not saved`);
      await page.goto('http://localhost:8099/#socialaccounts/connected-2'); await page.waitForTimeout(500);
      const ct = await page.$eval('#toast', (t) => t.textContent).catch(() => '');
      if (!/Connected 2 accounts/.test(ct)) errors.push(`[${label}] connected toast: ${ct}`);
      await page.goto('http://localhost:8099/#tools'); await page.waitForTimeout(500);
      if (!(await page.$eval('#view', (v) => /Social planner/.test(v.innerText)))) errors.push(`[${label}] Social planner missing from Tools`);
      // pipeline: take one out; settings: only clinics start in Lead
      await page.goto('http://localhost:8099/#pipeline'); await page.waitForTimeout(700);
      const before = await page.$$eval('#board .deal', (x) => x.length);
      await page.selectOption('[data-move="C2"]', 'none'); await page.waitForTimeout(500); await toastBad('take out of pipeline');
      const after = await page.$$eval('#board .deal', (x) => x.length);
      const upd = await page.evaluate(() => window.__DB.companies.find((c) => c.id === 'C2').pipeline_stage_id);
      if (before !== 2 || after !== 1 || upd !== null) errors.push(`[${label}] take out of pipeline: ${before} -> ${after}, stage ${upd}`);
      await page.goto('http://localhost:8099/#settings'); await page.waitForTimeout(700);
      await page.uncheck('[data-ptype="Vendor"]'); await page.click('#ptSave'); await page.waitForTimeout(400); await toastBad('pipeline types');
      const pt = await page.evaluate(() => window.__ASET?.pipeline_types);
      if (JSON.stringify(pt) !== '["Clinic"]') errors.push(`[${label}] pipeline types saved: ${JSON.stringify(pt)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-pipeline-settings.png' });
    }
    if (mode === 'phone') {
      const rpcLog = (n) => page.evaluate((n) => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === n).map((x) => x[2]), n);
      const fnLog = () => page.evaluate(() => window.__LOG.filter((x) => x[0] === 'fn' && x[1] === 'phone').map((x) => x[2].kind));
      const toastBad = async (what) => { const bad = await page.$eval('#toast', (t) => (!t.hidden && t.classList.contains('bad') ? t.textContent : '')).catch(() => ''); if (bad) errors.push(`[${label}] ${what}: error toast "${bad.trim()}"`); };
      await page.goto('http://localhost:8099/#phonelog'); await page.waitForTimeout(900);
      if (!(await page.$('#phFab'))) errors.push(`[${label}] no phone button for someone on a line`);
      if (!(await fnLog()).includes('token')) errors.push(`[${label}] no browser phone login asked for`);
      // place a call from the dial pad
      await page.click('#phFab'); await page.waitForTimeout(200);
      for (const k of '2285550101') await page.click(`#phPanel [data-k="${k}"]`);
      await page.waitForTimeout(500);
      const who = await page.$eval('#phWho', (e) => e.textContent).catch(() => '');
      if (!who.includes('Pat Person')) errors.push(`[${label}] dial pad didn't show who: "${who}"`);
      await page.click('#phGo'); await page.waitForTimeout(400);
      const out = await page.evaluate(() => window.__OUT);
      if (out?.destinationNumber !== '+12285550101' || out?.callerNumber !== '+12285550100') errors.push(`[${label}] outbound call numbers ${JSON.stringify(out)}`);
      if (!(await page.$('#phEnd'))) errors.push(`[${label}] no hang up button on a call`);
      await page.click('#phMute'); await page.click('#phKeys'); await page.click('#phDtmf [data-d="5"]');
      if (!(await page.evaluate(() => window.__MUTED && (window.__DTMF || []).includes('5')))) errors.push(`[${label}] mute or keypad didn't reach the call`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-phone-oncall.png' });
      await page.waitForTimeout(1100); await page.click('#phEnd'); await page.waitForTimeout(400);
      const ends = await rpcLog('phone_out_end');
      if (!ends.length || !(ends[0].p_answered_secs >= 1)) errors.push(`[${label}] outbound end not reported: ${JSON.stringify(ends)}`);
      if (!(await rpcLog('phone_out_ccid')).some((x) => x.p_ccid === 'cc-1')) errors.push(`[${label}] call id not saved`);
      // an incoming call rings, shows who, and answers
      await page.evaluate(() => window.__RTC.ring()); await page.waitForTimeout(400);
      const inc = await page.$eval('#phPanel', (e) => e.textContent).catch(() => '');
      if (!inc.includes('Incoming call') || !inc.includes('Pat Person')) errors.push(`[${label}] incoming panel: ${inc.slice(0, 120)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-phone-incoming.png' });
      await page.click('#phAns'); await page.waitForTimeout(200);
      if (!(await page.$('#phEnd'))) errors.push(`[${label}] answered call has no hang up`);
      await page.click('#phEnd'); await page.waitForTimeout(300);
      // tel: links dial through the CRM phone
      await page.goto('http://localhost:8099/#people/P1'); await page.waitForTimeout(900);
      const tel = await page.$('a[href^="tel:"]');
      if (tel) { await tel.click(); await page.waitForTimeout(300); if (!(await page.$eval('#phNum', (e) => e.value).catch(() => ''))) errors.push(`[${label}] tel link didn't fill the dial pad`); await page.click('#phClose').catch(() => {}); }
      if (!(await page.$('[data-tlcall="PC1"] [data-tlplay="call"]'))) errors.push(`[${label}] call on the timeline has no play button`);
      // file an unknown call
      await page.goto('http://localhost:8099/#phonelog'); await page.waitForTimeout(700);
      await page.click('[data-ls="unfiled"]'); await page.waitForTimeout(500);
      await page.click('[data-call="PC2"] [data-file]'); await page.fill('[data-call="PC2"] [data-fq]', 'Pa'); await page.waitForTimeout(600);
      const pick = await page.$('[data-call="PC2"] [data-fp], [data-call="PC2"] [data-fco]');
      if (pick) { await pick.click(); await page.waitForTimeout(300); } else errors.push(`[${label}] file search found nothing`);
      if (!(await rpcLog('phone_call_file')).length) errors.push(`[${label}] filing didn't save`);
      await page.click('[data-ls="all"]'); await page.waitForTimeout(400);
      await page.click('[data-call="PC2"] [data-play]'); await page.waitForTimeout(200);
      if (!(await page.$('[data-call="PC2"] audio'))) errors.push(`[${label}] voicemail didn't play`);
      await page.fill('[data-call="PC1"] [data-cnote]', 'Wants a quote'); await page.press('[data-call="PC1"] [data-cnote]', 'Tab'); await page.waitForTimeout(300);
      if (!(await rpcLog('phone_call_note')).some((x) => x.p_notes === 'Wants a quote')) errors.push(`[${label}] call note didn't save`);
      // lines: save who rings, and buy a number
      await page.goto('http://localhost:8099/#phoneset'); await page.waitForTimeout(700);
      await page.fill('form[data-line="L1"] [name="ring_secs"]', '30'); await page.click('form[data-line="L1"] button.btn.small:not([data-release])'); await page.waitForTimeout(400); await toastBad('save line');
      const sv = await rpcLog('phone_line_save');
      if (!sv.length || sv[0].p.ring_secs !== 30 || sv[0].p.members.length !== 2) errors.push(`[${label}] line save: ${JSON.stringify(sv)}`);
      await page.fill('#pnArea', '228'); await page.click('#pnFind'); await page.waitForTimeout(400);
      await page.click('[data-buy="+12285550111"]'); await page.waitForTimeout(400);
      const fns = await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'fn' && x[1] === 'phone' && x[2].kind === 'buy').map((x) => x[2]));
      if (fns[0]?.number !== '+12285550111' || fns[0]?.name !== 'Sales line') errors.push(`[${label}] buy: ${JSON.stringify(fns)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-phone-lines.png', fullPage: true });
      // usage colors and Review
      await page.goto('http://localhost:8099/#phoneusage'); await page.waitForTimeout(600);
      if (!(await page.$('.phbar .ph-orange'))) errors.push(`[${label}] 93% isn't orange`);
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(700);
      if (!(await page.$('#phoneRev [data-pclr]'))) errors.push(`[${label}] usage alert not in Review`);
      await page.goto('http://localhost:8099/#tools'); await page.waitForTimeout(500);
      for (const n of ['phonelog', 'phoneusage', 'phoneset']) if (!(await page.$(`[data-nav="${n}"].drawitem`))) errors.push(`[${label}] Tools has no ${n}`);
    }
    if (mode === 'calendars') {
      const rpcLog = (n) => page.evaluate((n) => window.__LOG.filter((x) => x[0] === 'rpc' && x[1] === n).map((x) => x[2]), n);
      const toastBad = async (what) => { const bad = await page.$eval('#toast', (t) => (!t.hidden && t.classList.contains('bad') ? t.textContent : '')).catch(() => ''); if (bad) errors.push(`[${label}] ${what}: error toast "${bad.trim()}"`); };
      const shot = (n, full = true) => page.screenshot({ path: `/tmp/shots-calendars-${label}-${n}.png`, fullPage: full });
      // Calendar: day, week and month; the two overlapping appointments sit side by side
      await page.goto('http://localhost:8099/#calendar'); await page.waitForTimeout(700);
      for (const m of ['day', 'week', 'month']) {
        await page.click(`[data-mode="${m}"]`); await page.waitForTimeout(500);
        const n = await page.$$eval('[data-appt]', (x) => x.length);
        if (n < 2) errors.push(`[${label}] ${m} view shows ${n} appointments`);
        await shot('view-' + m, m !== 'month');
      }
      await page.click('[data-mode="week"]'); await page.waitForTimeout(500);
      const lanes = await page.$$eval('.appt[data-appt="AP1"], .appt[data-appt="AP2"]', (x) => x.map((e) => e.style.width));
      if (lanes.length !== 2 || !lanes.every((w) => w.includes('50%'))) errors.push(`[${label}] overlapping appointments not side by side: ${lanes}`);
      // open one: details, mark confirmed
      await page.click('.appt[data-appt="AP1"]'); await page.waitForTimeout(600);
      const det = await page.$eval('#apptDlg', (d) => d.innerText).catch(() => '');
      if (!/Gate code question/.test(det) || !/Confirmation to pam@oak.test/.test(det)) errors.push(`[${label}] appointment details: ${det.slice(0, 200)}`);
      if (label === 'desktop') await page.screenshot({ path: '/tmp/shots-calendars-detail.png' });
      await page.click('#apptDlg [data-st="confirmed"]'); await page.waitForTimeout(500); await toastBad('confirm');
      // reschedule from the dialog
      await page.click('.appt[data-appt="AP3"]').catch(() => {}); await page.waitForTimeout(500);
      if (await page.$('#apptDlg[open] #apMove')) { await page.click('#apMove'); await page.click('#apMoveGo'); await page.waitForTimeout(500); }
      // cancel one (a prompt asks for a reason)
      await page.click('.appt[data-appt="AP2"]'); await page.waitForTimeout(500); await page.click('#apCancel'); await page.waitForTimeout(500);
      const st = await rpcLog('appointment_status');
      if (!st.some((x) => x.p_id === 'AP1' && x.p_status === 'confirmed') || !st.some((x) => x.p_id === 'AP2' && x.p_status === 'cancelled' && x.p_reason === 'Running late')) errors.push(`[${label}] status changes: ${JSON.stringify(st)}`);
      // click an empty time to add one; the first save says busy, the confirm books it anyway
      await page.goto('http://localhost:8099/#calendar'); await page.waitForTimeout(700);
      await page.click('.calcol', { position: { x: 20, y: 60 * 3 + 10 } }); await page.waitForTimeout(500);
      await page.fill('#anQ', 'Walk-in Wanda'); await page.fill('#anE', 'wanda@x.test'); await page.selectOption('#anCal', 'CA1');
      await page.click('#anGo'); await page.waitForTimeout(700); await toastBad('add appointment');
      const saves = await rpcLog('appointment_save');
      if (saves.length < 2 || !saves[saves.length - 1].p.force || saves[saves.length - 1].p.name !== 'Walk-in Wanda' || saves[saves.length - 1].p.calendar_id !== 'CA1') errors.push(`[${label}] add by clicking a time: ${JSON.stringify(saves).slice(0, 300)}`);
      // setup: edit a calendar, add a choice question, round robin with two people, a reminder, save
      await page.goto('http://localhost:8099/#calset/CA1'); await page.waitForTimeout(700);
      await page.selectOption('#ceKind', 'round_robin'); await page.waitForTimeout(300);
      await page.check('[data-cu="U2"]');
      await page.click('#ceQAdd'); await page.waitForTimeout(200);
      await page.fill('[data-q="1"] [data-qk="label"]', 'How did you hear about us?'); await page.selectOption('[data-q="1"] [data-qk="kind"]', 'choice');
      await page.fill('[data-q="1"] [data-qk="options"]', 'Google, A friend');
      await page.check('[data-rem="120"]'); await page.fill('#ceBA', '10');
      await page.evaluate(() => { window.__RPC.cal_busy_preview = () => [{ day: '2030-01-07', open: 10, shown: 7 }, { day: '2030-01-08', open: 8, shown: 6 }]; });
      await page.check('#ceLB'); await page.fill('#ceLBPct', '40'); await page.waitForTimeout(400);
      if (!/13 of 18 open times show/.test(await page.$eval('#ceLBPrev', (e) => e.textContent).catch(() => ''))) errors.push(`[${label}] look busy preview missing`);
      if (label === 'desktop') await shot('editor');
      await page.click('#ceSave'); await page.waitForTimeout(600); await toastBad('calendar save');
      const cs = (await rpcLog('calendar_save')).pop();
      if (!cs || cs.p.kind !== 'round_robin' || cs.p.user_ids.length !== 2 || cs.p.questions[1]?.options?.length !== 2 || !cs.p.reminders.includes(120) || cs.p.buffer_after !== 10 || cs.p.look_busy_pct !== 40) errors.push(`[${label}] calendar save: ${JSON.stringify(cs)?.slice(0, 400)}`);
      // brand swatches under the calendar color; saving checks the color against the brand kit
      await page.goto('http://localhost:8099/#calset/CA1'); await page.waitForTimeout(900);
      await page.click('#ceColor + .bswatch [data-hex="#12B5AC"]'); await page.waitForTimeout(100);
      if ((await page.$eval('#ceColor', (e) => e.value)) !== '#12b5ac') errors.push(`[${label}] brand swatch didn't set the color`);
      await page.click('#ceSave'); await page.waitForTimeout(600);
      const bc = (await rpcLog('brand_check')).pop();
      if (!bc || bc.p_kind !== 'calendar' || bc.p_colors[0] !== '#12b5ac') errors.push(`[${label}] brand check not sent: ${JSON.stringify(bc)}`);
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(800);
      if (!/Off-brand picks/.test(await page.$eval('#brandRev', (e) => e.textContent).catch(() => ''))) errors.push(`[${label}] off-brand flag not in Review`);
      // a question saves its answer on the contact (pick a checkbox field: the question becomes Yes/No)
      await page.goto('http://localhost:8099/#calset/CA1'); await page.waitForTimeout(700);
      await page.selectOption('[data-q="0"] [data-qk="field"]', 'people:intake'); await page.waitForTimeout(200);
      if ((await page.$eval('[data-q="0"] [data-qk="options"]', (e) => e.value)) !== 'Yes, No') errors.push(`[${label}] picking a checkbox field didn't make it Yes/No`);
      await page.click('#ceSave'); await page.waitForTimeout(600);
      const cs2 = (await rpcLog('calendar_save')).pop();
      if (cs2?.p?.questions?.[0]?.field !== 'people:intake') errors.push(`[${label}] question field not saved: ${JSON.stringify(cs2?.p?.questions?.[0])}`);
      // Review: compare side by side, keep the older record but take the newer cell number
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(800);
      await page.click('[data-item="RV1"] [data-cmp]'); await page.waitForTimeout(600);
      const rowsTxt = await page.$eval('#mergeDlg tbody', (e) => e.textContent).catch(() => '');
      if (!/Cell/.test(rowsTxt) || /First name/.test(rowsTxt)) errors.push(`[${label}] compare should show only differences: ${rowsTxt.slice(0, 160)}`);
      await page.check('#mergeDlg input[name="mp_personal_cell"][value="b"]');
      await page.click('#mpGo'); await page.waitForTimeout(500);
      const mp = (await rpcLog('merge_pick')).pop();
      if (!mp || mp.p_keep !== 'P1' || mp.p_drop !== 'P9' || !mp.p_take.includes('personal_cell') || mp.p_take.includes('custom.gate')) errors.push(`[${label}] merge picks wrong: ${JSON.stringify(mp)}`);
      if (label === 'desktop') await shot('merge');
      await page.goto('http://localhost:8099/#calsetup'); await page.waitForTimeout(600);
      await page.click('[data-emb="CA1"]'); await page.waitForTimeout(300);
      const code = await page.$eval('#emPop', (e) => e.value);
      if (!/book\/embed\.js" data-account="demo" data-calendar="consult" data-mode="popup"/.test(code)) errors.push(`[${label}] embed code: ${code}`);
      await page.keyboard.press('Escape');
      // hours: add a Saturday range, save; add a day off
      await page.goto('http://localhost:8099/#calhours'); await page.waitForTimeout(600);
      await page.click('[data-add="6"]'); await page.waitForTimeout(200);
      await page.click('#hSaveU'); await page.waitForTimeout(500); await toastBad('hours save');
      const hs = (await rpcLog('hours_save')).pop();
      if (!hs || hs.p_scope !== 'user' || hs.p_weekly['6']?.length !== 1 || hs.p_weekly['1']?.length !== 2) errors.push(`[${label}] hours save: ${JSON.stringify(hs)}`);
      await page.goto('http://localhost:8099/#calhours'); await page.waitForTimeout(600);
      const dd = new Date(Date.now() + 5 * 86400000); const ds = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      await page.fill('#oDay', ds); await page.fill('#oNote', 'Dentist'); await page.selectOption('#oScope', 'account'); await page.click('#oSave'); await page.waitForTimeout(500);
      const os = (await rpcLog('hours_day_save')).pop();
      if (!os || os.p_day !== ds || os.p_ranges.length !== 0 || os.p_scope !== 'account') errors.push(`[${label}] day off: ${JSON.stringify(os)}`);
      if (label === 'desktop') await shot('hours');
      // My Day and the contact pages show appointments
      await page.goto('http://localhost:8099/#myday'); await page.waitForTimeout(700);
      if (!(await page.$('#mdCal [data-appt]'))) errors.push(`[${label}] My Day has no appointments`);
      await page.goto('http://localhost:8099/#people/P1'); await page.waitForTimeout(700);
      if (!(await page.$('#pAppts [data-appt]'))) errors.push(`[${label}] person page has no appointments`);
      // automations can start on a booking, for one calendar
      await page.goto('http://localhost:8099/#automation/new'); await page.waitForTimeout(600);
      await page.selectOption('#tgKind', 'appointment_booked'); await page.waitForTimeout(200);
      await page.selectOption('#tgCal', 'CA2'); await page.fill('#aName', 'Estimate booked'); await page.click('#aSave'); await page.waitForTimeout(500);
      const au = (await rpcLog('automation_save')).pop();
      if (!au || au.p.trigger.kind !== 'appointment_booked' || au.p.trigger.calendar_id !== 'CA2') errors.push(`[${label}] automation trigger: ${JSON.stringify(au?.p?.trigger)}`);
      if (label === 'phone') console.log('calendar rpcs:', [...new Set((await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]))).filter((x) => /cal|appointment|automation/.test(x)))].join(', '));
      // the public booking page: pick a person, a length, a day and a time, answer, book
      await page.goto('http://localhost:8099/book/?a=demo&c=consult'); await page.waitForTimeout(1000);
      await page.click('[data-u="U2"]'); await page.waitForTimeout(500); await page.click('[data-l="60"]'); await page.waitForTimeout(700);
      if (!(await page.$('[data-t]'))) { await page.click('#nx'); await page.waitForTimeout(700); }
      await shot('book-pick', false);
      await page.click('[data-t]'); await page.waitForTimeout(300);
      await page.fill('#n', 'Pat Doe'); await page.fill('#e', 'pat@example.com'); await page.fill('#p', '228-555-0199'); await page.fill('#co', 'Pat Co');
      await page.click('#go'); await page.waitForTimeout(400);
      const e1 = await page.$eval('#err', (e) => e.textContent).catch(() => '');
      if (!/What for/.test(e1)) errors.push(`[${label}] required question not checked: ${e1}`);
      await page.fill('[data-q="what"]', 'Roof leak'); await page.selectOption('[data-q="heard"]', 'Google');
      await shot('book-form', false);
      await page.click('#go'); await page.waitForTimeout(700);
      const okTxt = await page.$eval('#root', (e) => e.innerText);
      const bk = await page.evaluate(() => window.__BOOKED);
      if (!/You're booked/.test(okTxt) || !bk || bk.p_user !== 'U2' || bk.p_duration !== 60 || bk.p.answers.heard !== 'Google' || bk.p.website !== '' || !bk.p.tz) errors.push(`[${label}] booking: ${okTxt.slice(0, 120)} ${JSON.stringify(bk)?.slice(0, 300)}`);
      await shot('book-done', false);
      // the manage link: reschedule, then cancel
      await page.goto('http://localhost:8099/book/?m=' + 'c'.repeat(64)); await page.waitForTimeout(900);
      await page.click('#rs'); await page.waitForTimeout(700);
      if (!(await page.$('#box [data-t]'))) { await page.click('#nx'); await page.waitForTimeout(700); }
      await page.click('#box [data-t]'); await page.waitForTimeout(700);
      if (!(await page.evaluate(() => window.__MOVED))) errors.push(`[${label}] reschedule not sent`);
      await page.click('#cx'); await page.waitForTimeout(300); await page.fill('#why', 'Fixed it'); await page.click('#cxGo'); await page.waitForTimeout(600);
      const cx = await page.evaluate(() => window.__CANCELLED);
      if (!cx || cx.p_reason !== 'Fixed it' || !/cancelled/i.test(await page.$eval('#root', (e) => e.innerText))) errors.push(`[${label}] cancel: ${JSON.stringify(cx)}`);
      await shot('manage-cancelled', false);
      // unknown links say so
      await page.goto('http://localhost:8099/book/?a=demo&c=nope'); await page.waitForTimeout(700);
      if (!/isn't taking bookings/.test(await page.$eval('#root', (e) => e.innerText))) errors.push(`[${label}] unknown calendar message`);
    }
    if (mode === 'on' && label === 'phone') {
      // a few clicks: pay tabs, Quick Add job tab, a step, a review decision, customize dashboard, role editor
      await page.goto('http://localhost:8099/#pay'); await page.waitForTimeout(500);
      for (const t of ['rates', 'periods', 'templates', 'batches']) { await page.click(`[data-pt="${t}"]`); await page.waitForTimeout(400, { force: true }); }
      await page.click('[data-b="B1"]'); await page.waitForTimeout(400, { force: true });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), page.click('#exGo')]);
      if (dl) { const p = await dl.path(); console.log('export:', fs.readFileSync(p, 'utf8').split('\r\n').join(' | ')); } else errors.push('no export download');
      await page.goto('http://localhost:8099/#add'); await page.waitForTimeout(500);
      await page.click('[data-qt="job"]'); await page.waitForTimeout(300); await page.fill('#qjT', 'Test job', { force: true });
      await page.screenshot({ path: `/tmp/shots-on-phone-add-job.png` });
      await page.goto('http://localhost:8099/#job/J1'); await page.waitForTimeout(500);
      await page.click('#jStep'); await page.waitForTimeout(600, { force: true });
      await page.goto('http://localhost:8099/#review'); await page.waitForTimeout(600);
      await page.click('[data-rv="W1"] [data-d="approve"]'); await page.waitForTimeout(500, { force: true });
      await page.goto('http://localhost:8099/#roles'); await page.waitForTimeout(500);
      await page.click('[data-pre="manager"]'); await page.waitForTimeout(300, { force: true });
      await page.screenshot({ path: `/tmp/shots-on-phone-roles-edit.png`, fullPage: true });
      await page.goto('http://localhost:8099/#dashboard'); await page.waitForTimeout(500); await page.click('#dashCust'); await page.waitForTimeout(300, { force: true });
      await page.screenshot({ path: `/tmp/shots-on-phone-dash-custom.png` });
      const log = await page.evaluate(() => window.__LOG.filter((x) => x[0] === 'rpc').map((x) => x[1]));
      console.log('rpcs called:', [...new Set(log)].join(', '));
    }
    await page.close();
  }
  await browser.close();
  console.log(errors.length ? 'PROBLEMS:\n' + [...new Set(errors)].join('\n') : 'no errors');
})();
