# PWA courier modules

Dependencies: `dexie`, `@supabase/supabase-js` (you likely already have the latter).

```ts
import { createSync, courierApi, refreshClockOffset, startCamera, holdScreenAwake, captureDrop } from './lib';

const sync = createSync(supabase, (pending) => setBadge(pending));
const stopSync = sync.start();                       // online / foreground / 60s timer
await refreshClockOffset(SUPABASE_URL, ANON_KEY);    // on start, on reconnect, every ~10 min

const api = courierApi(supabase);
const { data: doors } = await api.zoneAddresses(zoneId);   // rows include tenant_id = owner account

const stream = await startCamera(videoEl);
const release = holdScreenAwake();
await captureDrop(videoEl, {
  address_id: d.address_id, zone_id: d.zone_id, owner_tenant_id: d.tenant_id, label: d.line1,
});
sync.run();
```

Notes
- Foreground only: PWAs cannot track location in the background; GPS is read at capture time.
- iOS has no Background Sync, so the queue drains when the app is open. Show the pending count prominently.
- Rows the server permanently refuses stay in the queue with `synced = 1` and `last_error` set; surface them as "needs attention".
- Test on real iPhones and Androids: location permission prompts and storage eviction behave differently in installed PWAs.
