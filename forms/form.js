/* GELP lead form. Add to any page where the form should appear:
   <script src="https://app.gelpstrategies.com/forms/form.js" data-form="FORM KEY" async></script>
   Options:
     data-fields="name,email,phone,organization,message"   which standard fields to show (name is always required,
                                                            plus an email or a phone)
     data-extra="child_age:Child's age,zip:ZIP code"       extra questions (key:label), saved with the lead
     data-title="Request a screening"  data-button="Send"  data-success="Thanks! We'll be in touch."
     data-color="#1A2A52"  data-target="#css-selector"     (put the form inside an element instead of after the script)
   Leads land in the Lead stage of the account that owns the form. If GELP has turned on sharing for the form,
   the fine print names every company that receives the information and the visitor must tick the box to agree.
   Custom-built pages can post their own form with: GELPForm.submit(formKey, { name, email, phone, ... }, agreed). */
(function () {
  var SB = 'https://stfnpzqymjlxpainmgoo.supabase.co', KEY = 'sb_publishable_4T9hanZ9uv4Q2ih59QwMjA_0nJv-P3m';
  function rpc(n, a) {
    return fetch(SB + '/rest/v1/rpc/' + n, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(a) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && (j.message || j.error)) || 'Something went wrong'); return j; }); });
  }
  window.GELPForm = window.GELPForm || {
    config: function (key) { return rpc('form_config', { p_key: key }); },
    submit: function (key, data, agreed) { return rpc('form_submit', { p_key: key, p_data: data, p_consent: !!agreed, p_page: location.href }); },
  };
  var me = document.currentScript;
  if (!me || !me.dataset.form) return;
  var cfg = me.dataset, FORM = cfg.form, COLOR = cfg.color || '#1A2A52';
  var LABELS = { name: 'Your name', email: 'Email', phone: 'Phone', organization: 'Organization', message: 'How can we help?' };
  var fields = (cfg.fields || 'name,email,phone,message').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return LABELS[x]; });
  if (fields.indexOf('name') < 0) fields.unshift('name');
  var extra = (cfg.extra || '').split(',').map(function (x) { var i = x.indexOf(':'); return i > 0 ? [x.slice(0, i).trim().replace(/[^a-zA-Z0-9_]/g, '_'), x.slice(i + 1).trim()] : null; }).filter(Boolean);
  var host = document.createElement('div');
  var target = cfg.target && document.querySelector(cfg.target);
  if (target) target.appendChild(host); else me.parentNode.insertBefore(host, me.nextSibling);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var css = '<style>:host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}'
    + 'form{display:grid;gap:10px;max-width:560px;color:#1A2A52}h3{margin:0 0 4px;font-size:20px}'
    + 'label{display:grid;gap:4px;font-size:14px;font-weight:600}input,textarea{font:inherit;font-size:16px;font-weight:400;padding:10px 12px;border:1px solid #C9D2E3;border-radius:8px;width:100%;color:#1A2A52;background:#fff}'
    + 'textarea{min-height:96px;resize:vertical}.fine{font-size:12px;line-height:1.45;color:#5B6B8A;margin:0}.agree{display:flex;gap:8px;align-items:flex-start;font-weight:600;font-size:13px}.agree input{width:18px;height:18px;margin:2px 0 0;flex:none}'
    + 'button{font:inherit;font-weight:700;font-size:16px;padding:12px 18px;border:0;border-radius:8px;color:#fff;background:' + esc(COLOR) + ';cursor:pointer}button[disabled]{opacity:.6}'
    + '.err{color:#B4532A;font-size:14px;margin:0}.ok{padding:16px;border-radius:8px;background:#EEF8F1;color:#1E5C3F;font-size:16px}</style>';
  function draw(c) {
    root.innerHTML = css + '<form novalidate>' + (cfg.title ? '<h3>' + esc(cfg.title) + '</h3>' : '')
      + fields.map(function (k) {
        return '<label>' + esc(LABELS[k]) + (k === 'message' ? '<textarea name="' + k + '"></textarea>'
          : '<input name="' + k + '" type="' + (k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text') + '" autocomplete="' + (k === 'name' ? 'name' : k === 'email' ? 'email' : k === 'phone' ? 'tel' : k === 'organization' ? 'organization' : 'off') + '"' + (k === 'name' ? ' required' : '') + '>') + '</label>';
      }).join('')
      + extra.map(function (x) { return '<label>' + esc(x[1]) + '<input name="' + esc(x[0]) + '" type="text"></label>'; }).join('')
      + (c.consent_label ? '<label class="agree"><input type="checkbox" name="__agree"> <span>' + esc(c.consent_label) + '</span></label>' : '')
      + '<p class="fine">' + esc(c.fine_print) + '</p><p class="err" hidden></p><button type="submit">' + esc(cfg.button || 'Send') + '</button></form>';
    var form = root.querySelector('form'), err = root.querySelector('.err'), btn = root.querySelector('button');
    form.onsubmit = function (e) {
      e.preventDefault(); err.hidden = true;
      var data = {}; [].forEach.call(form.querySelectorAll('input,textarea'), function (el) { if (el.name && el.name !== '__agree' && el.value.trim()) data[el.name] = el.value.trim(); });
      var agreed = c.consent_label ? form.querySelector('[name="__agree"]').checked : false;
      var fail = function (m) { err.textContent = m; err.hidden = false; };
      if (!data.name) return fail('Add your name.');
      if (!data.email && !data.phone) return fail('Add an email or phone number so we can reach you.');
      if (c.consent_label && !agreed) return fail('Please tick the box to agree to how your information is shared.');
      btn.disabled = true;
      window.GELPForm.submit(FORM, data, agreed).then(function () {
        root.innerHTML = css + '<div class="ok">' + esc(cfg.success || 'Thank you! We received your information and will be in touch soon.') + '</div>';
      }, function (x) { btn.disabled = false; fail(x.message); });
    };
  }
  window.GELPForm.config(FORM).then(function (c) {
    if (!c) { root.innerHTML = css + '<p class="fine">This form is not available right now.</p>'; return; }
    draw(c);
  }, function () { root.innerHTML = css + '<p class="fine">This form could not load. Please refresh the page.</p>'; });
})();
