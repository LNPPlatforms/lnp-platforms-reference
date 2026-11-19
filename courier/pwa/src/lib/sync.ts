import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from './db';

/** Errors worth retrying later (connection, serialization, resource problems); everything else is final. */
const isTransient = (code?: string) => !!code && /^(08|40|53|57)/.test(code);

export function createSync(supabase: SupabaseClient, onChange?: (pending: number) => void) {
  let running = false;

  const pendingCount = () => db.queue.where('synced').equals(0).count();

  /** Upload photos, then submit drop records in one batch. Safe to call as often as you like. */
  async function run(): Promise<void> {
    if (running || !navigator.onLine) return;
    running = true;
    try {
      const rows = await db.queue.where('synced').equals(0).limit(25).toArray();

      // 1) photos -> private bucket (path rules are enforced by storage RLS)
      for (const r of rows) {
        if (r.uploaded || !r.blob || !r.photo_path) continue;
        const { error } = await supabase.storage
          .from('drop-photos')
          .upload(r.photo_path, r.blob, { contentType: 'image/jpeg', upsert: false });
        const alreadyThere = !!error && /exist|duplicate|409/i.test(`${error.message} ${(error as any).statusCode ?? ''}`);
        if (error && !alreadyThere) {   // retry next run; "already exists" means a previous attempt landed
          await db.queue.update(r.client_drop_id, { last_error: error.message, attempts: r.attempts + 1 });
          continue;
        }
        await db.queue.update(r.client_drop_id, { uploaded: 1 });
        r.uploaded = 1;
      }

      // 2) records
      const ready = rows.filter((r) => r.uploaded === 1);
      if (!ready.length) return;
      const payload = ready.map((r) => ({
        client_drop_id: r.client_drop_id, address_id: r.address_id, outcome: r.outcome,
        skip_reason: r.skip_reason, lat: r.lat, lng: r.lng, accuracy_m: r.accuracy_m,
        captured_at: r.captured_at, clock_offset_ms: r.clock_offset_ms, device_id: r.device_id,
        photo_key: r.photo_path ?? null,
      }));
      const { data, error } = await supabase.rpc('dh_submit_drops', { p_drops: payload });
      if (error) throw error;

      for (const res of data as Array<{ client_drop_id: string; error?: string; code?: string; status?: string }>) {
        if (res.error && res.error === 'invalid_drop' && isTransient(res.code)) {
          const row = await db.queue.get(res.client_drop_id);
          await db.queue.update(res.client_drop_id, { attempts: (row?.attempts ?? 0) + 1, last_error: res.code });
          continue;
        }
        // Accepted, duplicate-of-mine, or permanently refused: the server has answered.
        // Refusals stay in the queue (synced = 1, last_error set) so the UI can show "needs attention".
        await db.queue.update(res.client_drop_id, {
          synced: 1, blob: undefined, last_error: res.error ? (res.code ? `${res.error}:${res.code}` : res.error) : undefined,
        });
      }
    } catch (e) {
      // network or auth failure: leave everything queued
      console.warn('dh sync failed, will retry', e);
    } finally {
      running = false;
      onChange?.(await pendingCount());
    }
  }

  /** Sync on reconnect, on returning to the foreground, and every minute. iOS has no Background Sync. */
  function start(): () => void {
    void navigator.storage?.persist?.();
    const onVisible = () => { if (!document.hidden) void run(); };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(run, 60_000);
    void run();
    return () => {
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }

  return { run, start, pendingCount };
}
