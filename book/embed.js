/* Booking calendar for any website. Paste where it should show:
     <script src="https://app.lnpplatforms.com/book/embed.js" data-account="ACCOUNT" data-calendar="CALENDAR" async></script>
   Options:
     data-mode="popup"           a button that opens the calendar in a window (default: the calendar shows on the page)
     data-button="Book a time"   the button's words (popup only)
     data-color="#1A2A52"        the button's color (popup only; the calendar itself uses the account's brand color)
     data-target="#css-selector" put it inside an element instead of right after the script
   The copy-ready code is on each calendar in the CRM (Tools, Calendars, Booking calendars, Embed code).
   Window.LNPBook.open(account, calendar) opens the popup from your own button too. */
(function () {
  var me = document.currentScript;
  var ORIGIN = me && me.src ? new URL(me.src).origin : location.origin;
  function url(a, c) { return ORIGIN + '/book/?a=' + encodeURIComponent(a) + '&c=' + encodeURIComponent(c) + '&embed=1'; }
  function frame(a, c) {
    var f = document.createElement('iframe');
    f.src = url(a, c); f.title = 'Book a time'; f.loading = 'lazy'; f.allow = 'clipboard-write';
    f.style.cssText = 'width:100%;border:0;min-height:560px;display:block;background:transparent';
    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN || !e.data || e.data.type !== 'lnp-book-height' || e.source !== f.contentWindow) return;
      f.style.height = Math.max(420, Math.ceil(e.data.h) + 4) + 'px'; f.style.minHeight = '0';
    });
    return f;
  }
  function open(a, c) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(16,30,60,.55);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 10px';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:min(880px,100%);background:#F3F5F9;border-radius:14px;padding:34px 8px 8px;box-shadow:0 30px 80px rgba(0,0,0,.35)';
    var x = document.createElement('button');
    x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '✕';
    x.style.cssText = 'position:absolute;top:6px;right:8px;border:0;background:none;font-size:20px;cursor:pointer;padding:4px 8px;color:#1A2A52';
    var shut = function () { ov.remove(); document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') shut(); };
    x.onclick = shut; ov.onclick = function (e) { if (e.target === ov) shut(); };
    document.addEventListener('keydown', key);
    box.appendChild(x); box.appendChild(frame(a, c)); ov.appendChild(box); document.body.appendChild(ov);
  }
  window.LNPBook = window.LNPBook || { open: open };
  if (!me || !me.dataset.account || !me.dataset.calendar) return;
  var d = me.dataset, host = document.createElement('div');
  var target = d.target && document.querySelector(d.target);
  if (target) target.appendChild(host); else me.parentNode.insertBefore(host, me.nextSibling);
  if (d.mode === 'popup') {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = d.button || 'Book a time';
    var color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : '#1A2A52';
    b.style.cssText = 'font:inherit;font-weight:700;font-size:16px;padding:12px 22px;border:0;border-radius:8px;color:#fff;background:' + color + ';cursor:pointer';
    b.onclick = function () { open(d.account, d.calendar); };
    host.appendChild(b);
  } else host.appendChild(frame(d.account, d.calendar));
})();
