/* GELP chat widget. Add to any page:
   <script src="https://app.gelpstrategies.com/chat/widget.js" data-account="gelp" async></script>
   Optional: data-widget="support" (which chat widget, for assignment), data-source="proposal|invoice|website", data-ref="proposal token or invoice number", data-color="#1A2A52".
   Conversations land in the CRM Inbox for that account. "Agent online" whenever someone on the account has the CRM open.
   The widget's settings (Chat assignment) decide what visitors can pick: live chat, leave a message, or both.
   A message is the same conversation in the Inbox, it just skips the "nobody picked up" ping and the visitor gets a thank you.
   Pages that switch between businesses (the directory) add data-manual and call GelpChat.mount({ account, source, ref, color, label, open })
   and GelpChat.unmount(). */
(function () {
  if (window.GelpChat) return;
  var SB = 'https://stfnpzqymjlxpainmgoo.supabase.co', KEY = 'sb_publishable_4T9hanZ9uv4Q2ih59QwMjA_0nJv-P3m';
  var me = document.currentScript || document.querySelector('script[src*="chat/widget.js"]');
  var current = null;
  window.GelpChat = {
    mount: function (c) { if (current) current.destroy(); current = init(c || {}); return current; },
    unmount: function () { if (current) current.destroy(); current = null; }
  };
  if (me && me.dataset && me.dataset.manual == null) window.GelpChat.mount(me.dataset);

  function init(cfg) {
  var timers = [];
  var WIDGET = (cfg.widget || '').toLowerCase(), ACCOUNT = (cfg.account || 'gelp').toLowerCase(), SOURCE = cfg.source || 'website', REF = cfg.ref || '', COLOR = cfg.color || '#1A2A52', GOLD = '#C9A04A';
  var STORE = 'gelpchat:' + ACCOUNT + (SOURCE === 'directory' && REF ? ':' + REF : '');
  var LABEL = cfg.label || 'Chat with us';
  var state = { offer: null, thanks: '', pick: null, mode: 'live', wait: null, open: !!cfg.open, free: false, online: false, name: cfg.name || 'GELP Strategies', thread: null, key: null, msgs: [], seen: 0, busy: false, err: '' };
  try { var saved = JSON.parse(localStorage.getItem(STORE) || 'null'); if (saved && saved.thread) { state.thread = saved.thread; state.key = saved.key; state.seen = saved.seen || 0; state.mode = saved.mode || 'live'; } } catch (e) {}
  function save() { try { localStorage.setItem(STORE, JSON.stringify({ thread: state.thread, key: state.key, seen: state.seen, mode: state.mode })); } catch (e) {} }
  function post(path, body) {
    return fetch(SB + path, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && (j.message || j.error)) || 'Something went wrong'); return j; }); });
  }
  var rpc = function (n, a) { return post('/rest/v1/rpc/' + n, a); };
  var notify = function () { post('/functions/v1/chat-email', { kind: 'visitor', thread: state.thread, key: state.key }).catch(function () {}); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var time = function (s) { try { return new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };

  var host = document.createElement('div'); host.id = 'gelp-chat';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.fab{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:13px 18px;background:' + COLOR + ';color:#fff;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 10px 30px rgba(16,30,60,.35)}' +
    '.dot{width:9px;height:9px;border-radius:50%;background:#9AA5B8;box-shadow:0 0 0 2px rgba(255,255,255,.35)}.dot.on{background:#3FBF7F}' +
    '.badge{background:' + GOLD + ';color:' + COLOR + ';border-radius:999px;font-size:12px;padding:1px 7px}' +
    '.panel{position:absolute;right:0;bottom:62px;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 100px);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(16,30,60,.35);display:flex;flex-direction:column;overflow:hidden;border:1px solid #DCE2EC}' +
    '.hd{background:' + COLOR + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.hd b{font-size:16px;display:block}.hd small{font-size:13px;opacity:.9;display:flex;align-items:center;gap:6px;margin-top:3px}' +
    '.x{background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 2px}' +
    '.note{background:#FBF0D3;color:#6E4E00;font-size:13px;padding:10px 14px;line-height:1.4}' +
    '.body{flex:1;overflow:auto;padding:12px 14px;background:#F6F8FB;display:flex;flex-direction:column;gap:8px}' +
    '.m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}.m small{display:block;font-size:11px;opacity:.7;margin-top:3px}' +
    '.m.v{align-self:flex-end;background:' + COLOR + ';color:#fff;border-bottom-right-radius:4px}.m.s{align-self:flex-start;background:#fff;border:1px solid #DCE2EC;color:#1A2A52;border-bottom-left-radius:4px}' +
    '.form{padding:12px 14px;display:flex;flex-direction:column;gap:8px;border-top:1px solid #DCE2EC;background:#fff}' +
    'input,textarea{font-size:15px;padding:9px 11px;border:1px solid #DCE2EC;border-radius:9px;width:100%;color:#1A2A52;background:#fff}textarea{resize:none;min-height:64px}' +
    '.row{display:flex;gap:8px;align-items:flex-end}.row textarea{min-height:44px;height:44px}' +
    '.send{border:0;border-radius:9px;padding:11px 16px;background:' + GOLD + ';color:' + COLOR + ';font-weight:800;font-size:14px;cursor:pointer;white-space:nowrap}.send:disabled{opacity:.5}' +
    '.note.ok{background:#E3F4EA;color:#1F5E3A}' +
    '.choice{display:block;width:100%;text-align:left;border:1px solid #DCE2EC;border-radius:12px;padding:14px;background:#fff;cursor:pointer;color:#1A2A52}.choice:hover{border-color:' + COLOR + '}' +
    '.choice b{display:flex;align-items:center;gap:8px;font-size:15px}.choice span.s{display:block;font-size:13px;color:#5B6B8A;margin-top:4px}.choice:disabled{opacity:.55;cursor:default}.choice:disabled:hover{border-color:#DCE2EC}' +
    '.back{background:none;border:0;color:#5B6B8A;font-size:13px;cursor:pointer;padding:0;align-self:flex-start}.back:hover{color:' + COLOR + '}' +
    '.err{color:#B4412C;font-size:13px}.intro{color:#5B6B8A;font-size:14px;line-height:1.45}' +
    '.by{display:block;text-align:center;font-size:11px;color:#8A96AD;padding:6px 0 8px;background:#fff;text-decoration:none}.by:hover{color:' + COLOR + ';text-decoration:underline}' +
    '@media (max-width:480px){.panel{position:fixed;left:8px;right:8px;bottom:80px;width:auto;height:calc(100vh - 110px)}}' +
    '</style><div id="w"></div>';
  document.body.appendChild(host);
  var w = root.getElementById ? root.getElementById('w') : root.querySelector('#w');

  function unread() { return state.msgs.filter(function (m) { return m.from === 'staff'; }).length - state.seen; }
  function render() {
    var status = state.online ? 'Agent online' : 'Agent offline';
    var html = '';
    if (state.open) {
      html += '<div class="panel" role="dialog" aria-label="Chat with ' + esc(state.name) + '"><div class="hd"><div><b>' + esc(state.name) + '</b><small><span class="dot' + (state.online ? ' on' : '') + '"></span>' + status + '</small></div><button class="x" id="x" aria-label="Close chat">&times;</button></div>';
      var mode = curMode(), choosing = !state.thread && state.offer === 'both' && !state.pick;
      if (state.thread && mode === 'message') html += '<div class="note ok">' + esc(state.thanks || 'Thanks! We got your message and we\'ll get back to you by email soon.') + '</div>';
      else if (mode === 'message' || choosing || state.offer === null) {}
      else if (state.wait && state.wait.waiting && !state.wait.picked_up) html += '<div class="note">' + esc(state.wait.waiting_text) + '</div>';
      else if (!state.online || (state.wait && state.wait.nobody && !state.wait.picked_up)) html += '<div class="note">' + esc(state.wait && state.wait.offline_text || 'We\'re away right now. Leave a message and we\'ll respond as soon as someone\'s back, right here and by email.') + '</div>';
      if (!state.thread && state.offer === null) {
        html += '<div class="body"></div>';
      } else if (choosing) {
        html += '<div class="body"><p class="intro">How would you like to reach us?</p>' +
          '<button class="choice" id="cl"' + (state.online ? '' : ' disabled') + '><b><span class="dot' + (state.online ? ' on' : '') + '"></span>Live chat</b><span class="s">' + (state.online ? 'Talk with someone right now' : 'Nobody\'s online right now') + '</span></button>' +
          '<button class="choice" id="cm"><b>Leave a message</b><span class="s">We\'ll get back to you by email</span></button></div>';
      } else if (!state.thread) {
        var back = state.offer === 'both' ? '<button class="back" id="bk">&larr; Back</button>' : '';
        html += '<div class="body">' + back + '<p class="intro">' + (mode === 'message' ? 'Leave us a message and we\'ll get back to you by email.' : state.online ? 'Hi! Send us a message and someone on our team will answer here in a moment.' : 'Send us a message and we\'ll get back to you.') + '</p></div>' +
          '<div class="form"><input id="nm" placeholder="Your name" autocomplete="name"><input id="em" type="email" placeholder="Email, so we can reply" autocomplete="email">' +
          '<textarea id="tx" placeholder="' + (mode === 'message' ? 'Your message' : 'How can we help?') + '"' + (mode === 'message' ? ' style="min-height:110px"' : '') + '></textarea><div class="err" id="er">' + esc(state.err) + '</div><button class="send" id="go">' + (mode === 'message' ? 'Send message' : 'Send') + '</button></div>';
      } else {
        html += '<div class="body" id="bd">' + state.msgs.map(function (m) {
          return '<div class="m ' + (m.from === 'visitor' ? 'v' : 's') + '">' + esc(m.body) + '<small>' + (m.from === 'staff' && m.name ? esc(m.name) + ' · ' : '') + time(m.at) + '</small></div>';
        }).join('') + '</div><div class="form"><div class="err" id="er">' + esc(state.err) + '</div><div class="row"><textarea id="tx" placeholder="Type a message" aria-label="Message"></textarea><button class="send" id="go">Send</button></div></div>';
      }
      if (state.free) html += '<a class="by" href="https://gelpstrategies.com/?ref=chat" target="_blank" rel="noopener">Free live chat by GELP. Get one for your website</a>';
      html += '</div>';
    }
    var n = unread();
    html += '<button class="fab" id="fab" aria-label="' + (state.open ? 'Close chat' : esc(LABEL)) + '"><span class="dot' + (state.online ? ' on' : '') + '"></span>' + (state.open ? 'Close' : esc(LABEL)) + (n > 0 && !state.open ? ' <span class="badge">' + n + '</span>' : '') + '</button>';
    var keep = w.querySelector && w.querySelector('#tx'), draft = keep ? keep.value : '', focused = keep && (root.activeElement === keep);
    var nm = w.querySelector && w.querySelector('#nm'), em = w.querySelector && w.querySelector('#em');
    var nmv = nm ? nm.value : '', emv = em ? em.value : '';
    w.innerHTML = html;
    var q = function (id) { return w.querySelector('#' + id); };
    if (q('tx')) { q('tx').value = draft; if (focused) q('tx').focus(); }
    if (q('nm')) { q('nm').value = nmv; q('em').value = emv; }
    var bd = q('bd'); if (bd) bd.scrollTop = bd.scrollHeight;
    q('fab').onclick = function () { state.open = !state.open; if (state.open) { markSeen(); fetchMsgs(); } render(); if (state.open && q('tx')) q(state.thread ? 'tx' : 'nm').focus(); };
    if (q('x')) q('x').onclick = function () { state.open = false; render(); };
    if (q('go')) q('go').onclick = send;
    var choose = function (m) { state.pick = m; state.err = ''; render(); if (q('nm')) q('nm').focus(); };
    if (q('cl')) q('cl').onclick = function () { choose('live'); };
    if (q('cm')) q('cm').onclick = function () { choose('message'); };
    if (q('bk')) q('bk').onclick = function () { state.pick = null; state.err = ''; render(); };
    if (q('tx')) q('tx').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && state.thread) { e.preventDefault(); send(); } };
  }
  // live or message: a started conversation keeps its mode; a new one follows the visitor's pick and the widget's setting.
  // Picking live while nobody's online (offer "live" only) is saved as a message, since there's nobody to chat with.
  function curMode() {
    if (state.thread) return state.mode;
    if (state.offer === 'message' || state.pick === 'message') return 'message';
    return 'live';
  }
  function markSeen() { state.seen = state.msgs.filter(function (m) { return m.from === 'staff'; }).length; save(); }
  function send() {
    var q = function (id) { return w.querySelector('#' + id); };
    var body = (q('tx').value || '').trim(); if (!body || state.busy) return;
    state.busy = true; state.err = ''; q('go').disabled = true;
    var p = state.thread ? rpc('chat_send', { p_thread: state.thread, p_key: state.key, p_body: body })
      : rpc('chat_start', { p_tenant: ACCOUNT, p_name: q('nm').value, p_email: q('em').value, p_body: body, p_source: SOURCE, p_ref: REF, p_page: location.href.split('#')[0] + (SOURCE === 'proposal' && REF ? '#' + REF : SOURCE === 'directory' && REF ? '#l=' + REF : '') })
        .then(function (r) {
          var m = curMode() === 'live' && !r.online ? 'message' : curMode();
          state.thread = r.thread; state.key = r.key; state.mode = m; save();
          if (m === 'message') rpc('chat_set_mode', { p_thread: r.thread, p_key: r.key, p_mode: 'message' }).catch(function () {});
          if (WIDGET) rpc('chat_widget_attach', { p_thread: r.thread, p_key: r.key, p_widget: WIDGET }).catch(function () {}); return r; });
    p.then(function (r) { state.online = !!r.online; q('tx').value = ''; notify(); return fetchMsgs(); })
      .catch(function (e) { state.err = e.message; })
      .then(function () { state.busy = false; render(); });
  }
  function fetchMsgs() {
    if (!state.thread) return Promise.resolve();
    return rpc('chat_fetch', { p_thread: state.thread, p_key: state.key }).then(function (r) {
      if (!r) { state.thread = null; state.key = null; state.msgs = []; save(); render(); return; }
      var before = JSON.stringify(state.msgs); state.msgs = r.messages || []; state.online = !!r.online;
      if (state.open) markSeen();
      // waiting for pickup? (older accounts without assignment just skip this)
      rpc('chat_wait_state', { p_thread: state.thread, p_key: state.key }).then(function (ws) {
        var b2 = JSON.stringify(state.wait); state.wait = ws || null; if (b2 !== JSON.stringify(state.wait)) render();
      }).catch(function () {});
      if (before !== JSON.stringify(state.msgs)) render();
    }).catch(function () {});
  }
  function status() { return rpc('chat_status', { p_tenant: ACCOUNT }).then(function (r) { if (r) { state.name = cfg.name || r.name || state.name; if (state.free !== !!r.free) { state.free = !!r.free; render(); } if (state.online !== !!r.online) { state.online = !!r.online; render(); } } }).catch(function () {}); }
  function config() {
    return rpc('chat_widget_config', { p_tenant: ACCOUNT, p_widget: WIDGET || null })
      .then(function (r) { state.offer = r && /^(both|live|message)$/.test(r.offer) ? r.offer : 'both'; state.thanks = (r && r.message_thanks) || ''; })
      .catch(function () { state.offer = 'live'; })   // older database without the setting: plain live chat like before
      .then(render);
  }
  render(); config(); status(); fetchMsgs();
  timers.push(setInterval(function () { if (!document.hidden) { if (state.thread) fetchMsgs(); else status(); } }, 4000));
  timers.push(setInterval(function () { if (!document.hidden && state.thread) status(); }, 30000));
  return {
    open: function () { state.open = true; markSeen(); fetchMsgs(); render(); },
    destroy: function () { timers.forEach(clearInterval); if (host.parentNode) host.parentNode.removeChild(host); }
  };
  }
})();
