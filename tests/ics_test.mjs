// node tests/ics_test.mjs : the iCal reader behind connected calendars (supabase/functions/cal-sync/ics.js)
import { busyFromIcs, zoned } from '../supabase/functions/cal-sync/ics.js';
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('✗', m); } else console.log('✓', m); };
const iso = (d) => d.toISOString().slice(0, 16);
const wrap = (body, extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${extra}${body}END:VCALENDAR\r\n`;
const from = Date.UTC(2026, 10, 16), to = Date.UTC(2027, 0, 15);   // Nov 16 2026 to Jan 15 2027

// time zones: 9 AM Chicago in November (CST, UTC-6) is 15:00Z; in July (CDT) it's 14:00Z
ok(iso(new Date(zoned(2026, 11, 20, 9, 0, 0, 'America/Chicago'))) === '2026-11-20T15:00', 'CST conversion');
ok(iso(new Date(zoned(2026, 7, 20, 9, 0, 0, 'America/Chicago'))) === '2026-07-20T14:00', 'CDT conversion');

let r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:a1\r\nDTSTART;TZID=America/Chicago:20261120T090000\r\nDTEND;TZID=America/Chicago:20261120T103000\r\nSUMMARY:Dentist\\, then lunch\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 1 && iso(r[0].start) === '2026-11-20T15:00' && iso(r[0].end) === '2026-11-20T16:30' && r[0].title === 'Dentist, then lunch', 'one event with TZID');

r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:a2\r\nDTSTART:20261121T180000Z\r\nDURATION:PT45M\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 1 && iso(r[0].end) === '2026-11-21T18:45', 'UTC start with DURATION');

r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:a3\r\nDTSTART;VALUE=DATE:20261126\r\nDTEND;VALUE=DATE:20261128\r\nSUMMARY:Thanksgiving\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 1 && r[0].allDay && iso(r[0].start) === '2026-11-26T06:00' && iso(r[0].end) === '2026-11-28T06:00', 'two-day all-day event in calendar time');

r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:a4\r\nDTSTART:20261122T150000Z\r\nDTEND:20261122T160000Z\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a5\r\nDTSTART:20261122T150000Z\r\nDTEND:20261122T160000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 0, 'free and cancelled events skipped');

// weekly Mon/Wed 8-9 AM Chicago, from Nov 2, skip Nov 18, Nov 23 moved to 10 AM
r = busyFromIcs(wrap(`BEGIN:VEVENT\r\nUID:w1\r\nDTSTART;TZID=America/Chicago:20261102T080000\r\nDTEND;TZID=America/Chicago:20261102T090000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261202T235959Z\r\nEXDATE;TZID=America/Chicago:20261118T080000\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:w1\r\nRECURRENCE-ID;TZID=America/Chicago:20261123T080000\r\nDTSTART;TZID=America/Chicago:20261123T100000\r\nDTEND;TZID=America/Chicago:20261123T110000\r\nSUMMARY:Standup moved\r\nEND:VEVENT\r\n`), from, to);
ok(r.map((x) => iso(x.start)).join() === '2026-11-16T14:00,2026-11-23T16:00,2026-11-25T14:00,2026-11-30T14:00,2026-12-02T14:00', 'weekly with EXDATE, a moved date and UNTIL: ' + r.map((x) => iso(x.start)).join());

// monthly 2nd Tuesday, 3 times; daily x5 every other day; 31st monthly; Outlook Windows zone; folded line
r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:m1\r\nDTSTART;TZID=Central Standard Time:20261110T130000\r\nDTEND;TZID=Central Standard Time:20261110T140000\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3\r\nEND:VEVENT\r\n'), from, to);
ok(r.map((x) => iso(x.start)).join() === '2026-12-08T19:00,2027-01-12T19:00', 'monthly 2nd Tuesday, COUNT counts from the first, Windows zone name');
r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:d1\r\nDTSTART:20261116T120000Z\r\nDTEND:20261116T130000Z\r\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=5\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 5 && iso(r[4].start) === '2026-11-24T12:00', 'every other day x5');
r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:e1\r\nDTSTART;TZID=America/Chicago:20261031T170000\r\nDTEND;TZID=America/Chicago:20261031T180000\r\nRRULE:FREQ=MONTHLY\r\nEND:VEVENT\r\n'), from, to);
ok(r.map((x) => iso(x.start)).join() === '2026-12-31T23:00', 'monthly on the 31st skips short months');
r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:f1\r\nDTSTART:20261201T150000Z\r\nDTEND:20261201T160000Z\r\nSUMMARY:A very long\r\n  title folded\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 1 && r[0].title === 'A very long title folded', 'folded line and an alarm inside the event');
r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:o1\r\nDTSTART:20250101T150000Z\r\nDTEND:20250101T160000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:y1\r\nDTSTART;VALUE=DATE:20201214\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Birthday\r\nEND:VEVENT\r\n'), from, to);
ok(r.length === 1 && r[0].title === 'Birthday' && iso(r[0].start) === '2026-12-14T06:00', 'old events left out, yearly all-day repeats');
// floating times use the calendar's own zone
r = busyFromIcs(wrap('BEGIN:VEVENT\r\nUID:fl\r\nDTSTART:20261201T090000\r\nDTEND:20261201T100000\r\nEND:VEVENT\r\n', 'X-WR-TIMEZONE:America/New_York\r\n'), from, to);
ok(iso(r[0].start) === '2026-12-01T14:00', 'floating time in the calendar zone');
console.log(bad ? `${bad} FAILED` : 'all passed'); process.exit(bad ? 1 : 0);
