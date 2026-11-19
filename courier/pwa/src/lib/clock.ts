/**
 * Phones can have wrong clocks, and offline drops can't ask the server for the time.
 * While online, measure (server time - device time) and store it; every queued drop carries
 * the offset in force when it was captured and the server corrects captured_at with it.
 */
const KEY = 'dh_clock_offset_ms';

export function getClockOffsetMs(): number {
  try { return Number(localStorage.getItem(KEY) ?? 0) || 0; } catch { return 0; }
}

/** Call on app start, on reconnect, and about every 10 minutes while online. */
export async function refreshClockOffset(supabaseUrl: string, anonKey: string): Promise<void> {
  try {
    const t0 = Date.now();
    const res = await fetch(`${supabaseUrl}/rest/v1/`, { method: 'HEAD', headers: { apikey: anonKey } });
    const t1 = Date.now();
    const date = res.headers.get('Date');
    if (!date) return;
    const serverNow = new Date(date).getTime();           // 1-second resolution is plenty here
    const offset = serverNow - (t0 + t1) / 2;
    localStorage.setItem(KEY, String(Math.round(offset)));
  } catch { /* offline: keep the last known offset */ }
}
