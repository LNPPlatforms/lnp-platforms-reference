// ics.js: reads an iCal (.ics) feed into busy times. Plain JavaScript with no packages, so it runs in the edge
// function (Deno) and in the tests (Node). Handles what Google, Outlook and Apple calendars send:
//   one-off and all-day events, time zones (IANA and Outlook's Windows names), repeating events (daily, weekly on
//   days, monthly by date or "2nd Tuesday", yearly; INTERVAL, COUNT, UNTIL), skipped dates (EXDATE), moved or
//   changed single dates (RECURRENCE-ID), cancelled events, and events marked "free" (TRANSP:TRANSPARENT), which are
//   left out because they don't block time.

const WIN_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney',
};
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function tzName(tz, fallback) {
  if (!tz) return fallback;
  const t = String(tz).replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, '');   // "/mozilla.org/20050126_1/America/Chicago"
  const name = WIN_TZ[t] || t;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return name; } catch { return fallback; }
}

// minutes east of UTC for a zone at a moment
function offsetMin(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}
// wall-clock time in a zone -> UTC milliseconds (a time skipped by daylight saving moves forward an hour, like calendars do)
export function zoned(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === 'UTC') return guess;
  let ms = guess - offsetMin(tz, guess) * 60000;
  const o2 = offsetMin(tz, ms);
  ms = guess - o2 * 60000;
  return ms;
}

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
function parseLine(line) {
  const c = line.indexOf(':'); if (c < 0) return null;
  const head = line.slice(0, c), value = line.slice(c + 1);
  const parts = head.split(';'), name = parts[0].toUpperCase(), params = {};
  for (const p of parts.slice(1)) { const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1); }
  return { name, params, value };
}

// a date or date-time value -> { ms, allDay, wall: [y,mo,d,h,mi,s], tz }
function parseTime(value, params, defTz) {
  const v = String(value).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (!m[4] || (params.VALUE || '').toUpperCase() === 'DATE') {
    const tz = defTz; return { ms: zoned(y, mo, d, 0, 0, 0, tz), allDay: true, wall: [y, mo, d, 0, 0, 0], tz };
  }
  const h = +m[4], mi = +m[5], s = +(m[6] || 0);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, wall: [y, mo, d, h, mi, s], tz: 'UTC' };
  const tz = tzName(params.TZID, defTz);
  return { ms: zoned(y, mo, d, h, mi, s, tz), allDay: false, wall: [y, mo, d, h, mi, s], tz };
}
function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// the calendar days a repeating event lands on, in its own wall-clock time
function* occurrences(rule, start, untilMs, hardEnd) {
  const r = Object.fromEntries(String(rule).split(';').filter(Boolean).map((kv) => { const [k, ...v] = kv.split('='); return [k.toUpperCase(), v.join('=')]; }));
  const freq = (r.FREQ || '').toUpperCase(), interval = Math.max(1, +(r.INTERVAL || 1));
  const count = r.COUNT ? +r.COUNT : Infinity;
  let until = untilMs;
  if (r.UNTIL) { const u = parseTime(r.UNTIL, {}, start.tz === 'UTC' ? 'UTC' : start.tz); if (u) until = Math.min(until, u.allDay ? u.ms + 86399000 : u.ms); }
  const byday = (r.BYDAY || '').split(',').filter(Boolean).map((x) => { const mm = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return mm ? { n: mm[1] ? +mm[1] : 0, wd: DAYS.indexOf(mm[2]) } : null; }).filter((x) => x && x.wd >= 0);
  const bymd = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const bymonth = (r.BYMONTH || '').split(',').filter(Boolean).map(Number);
  const [sy, smo, sd, h, mi, s] = start.wall;
  const day0 = Date.UTC(sy, smo - 1, sd);
  const DAY = 86400000;
  let emitted = 0;
  const at = (dayMs) => { const t = new Date(dayMs); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() }; };
  const out = function* (cands) {
    for (const dms of cands.sort((a, b) => a - b)) {
      if (dms < day0) continue;
      const c = at(dms);
      if (bymonth.length && !bymonth.includes(c.mo)) continue;
      const ms = start.allDay ? zoned(c.y, c.mo, c.d, 0, 0, 0, start.tz) : zoned(c.y, c.mo, c.d, h, mi, s, start.tz);
      if (ms > until) return 'stop';
      emitted++;
      yield ms;
      if (emitted >= count) return 'stop';
    }
  };
  const monthDays = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const nthWeekday = (y, mo, n, wd) => {
    const len = monthDays(y, mo), days = [];
    for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd) days.push(d);
    const d = n > 0 ? days[n - 1] : days[days.length + n];
    return d ? Date.UTC(y, mo - 1, d) : null;
  };
  for (let i = 0; i < 5000; i++) {
    let cands = [];
    if (freq === 'DAILY') {
      const dms = day0 + i * interval * DAY; const c = at(dms);
      if (dms > hardEnd + DAY) return;
      if (!byday.length || byday.some((b) => b.wd === c.wd)) cands = [dms];
    } else if (freq === 'WEEKLY') {
      const sw = day0 - at(day0).wd * DAY + i * interval * 7 * DAY;     // the Sunday of that week
      const wds = byday.length ? byday.map((b) => b.wd) : [at(day0).wd];
      cands = wds.map((wd) => sw + wd * DAY);
    } else if (freq === 'MONTHLY') {
      const tot = (smo - 1) + i * interval, y = sy + Math.floor(tot / 12), mo = (tot % 12) + 1, len = monthDays(y, mo);
      if (byday.length) cands = byday.flatMap((b) => b.n ? [nthWeekday(y, mo, b.n, b.wd)] : Array.from({ length: 5 }, (_, k) => nthWeekday(y, mo, k + 1, b.wd))).filter(Boolean);
      else cands = (bymd.length ? bymd : [sd]).map((d) => (d < 0 ? len + d + 1 : d)).filter((d) => d >= 1 && d <= len).map((d) => Date.UTC(y, mo - 1, d));
    } else if (freq === 'YEARLY') {
      const y = sy + i * interval, mos = bymonth.length ? bymonth : [smo];
      cands = mos.flatMap((mo) => byday.length ? byday.map((b) => nthWeekday(y, mo, b.n || 1, b.wd)) : [sd <= monthDays(y, mo) ? Date.UTC(y, mo - 1, sd) : null]).filter(Boolean);
    } else { return; }
    if (cands.length && cands[0] > hardEnd + 2 * DAY && freq !== 'WEEKLY') return;
    if (freq === 'WEEKLY' && day0 - at(day0).wd * DAY + i * interval * 7 * DAY > hardEnd + 7 * DAY) return;
    const r2 = yield* out(cands);
    if (r2 === 'stop') return;
  }
}

// ics text -> busy blocks overlapping [fromMs, toMs): [{ uid, start, end, title, allDay }]
export function busyFromIcs(text, fromMs, toMs, defaultTz = 'America/Chicago') {
  const lines = unfold(text);
  let calTz = defaultTz;
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    const l = parseLine(raw); if (!l) continue;
    if (l.name === 'X-WR-TIMEZONE' && !cur) calTz = tzName(l.value, defaultTz);
    if (l.name === 'BEGIN') { if (l.value.toUpperCase() === 'VEVENT' && !cur) { cur = { exdates: [] }; depth = 0; } else if (cur) depth++; continue; }
    if (l.name === 'END') { if (cur && depth > 0) { depth--; continue; } if (cur && l.value.toUpperCase() === 'VEVENT') { events.push(cur); cur = null; } continue; }
    if (!cur || depth > 0) continue;
    if (l.name === 'EXDATE') { for (const v of l.value.split(',')) cur.exdates.push({ v, p: l.params }); continue; }
    if (!(l.name in cur)) cur[l.name] = l;
  }
  const out = [];
  const moved = new Map();   // uid -> set of recurrence-id times that were changed or cancelled
  for (const e of events) {
    if (e['RECURRENCE-ID']) {
      const rid = parseTime(e['RECURRENCE-ID'].value, e['RECURRENCE-ID'].params, calTz);
      const uid = e.UID?.value || '';
      if (rid) { if (!moved.has(uid)) moved.set(uid, new Set()); moved.get(uid).add(rid.ms); }
    }
  }
  for (const e of events) {
    if (!e.DTSTART) continue;
    const status = (e.STATUS?.value || '').toUpperCase(), transp = (e.TRANSP?.value || '').toUpperCase();
    if (status === 'CANCELLED' || transp === 'TRANSPARENT') continue;
    const st = parseTime(e.DTSTART.value, e.DTSTART.params, calTz); if (!st) continue;
    let len;
    if (e.DTEND) { const en = parseTime(e.DTEND.value, e.DTEND.params, calTz); len = en ? en.ms - st.ms : null; }
    if (len == null && e.DURATION) len = parseDuration(e.DURATION.value);
    if (len == null || len <= 0) len = st.allDay ? 86400000 : 0;
    if (len <= 0) continue;                         // a zero-length reminder blocks nothing
    const uid = e.UID?.value || `${e.DTSTART.value}-${e.SUMMARY?.value || ''}`;
    const title = (e.SUMMARY?.value || '').replace(/\\([,;\\nN])/g, (_, c) => (c === 'n' || c === 'N' ? ' ' : c)).slice(0, 200);
    const push = (ms) => { if (ms < toMs && ms + len > fromMs) out.push({ uid, start: new Date(ms), end: new Date(ms + len), title, allDay: st.allDay }); };
    if (e.RRULE && !e['RECURRENCE-ID']) {
      const skip = new Set(e.exdates.map((x) => parseTime(x.v, x.p, calTz)?.ms).filter((x) => x != null));
      const changed = moved.get(uid) || new Set();
      for (const ms of occurrences(e.RRULE.value, st, Infinity, toMs)) {
        if (ms >= toMs) break;
        if (skip.has(ms) || changed.has(ms)) continue;
        push(ms);
      }
    } else {
      push(st.ms);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
