import Dexie, { Table } from 'dexie';

/** One door's outcome waiting to be uploaded. Lives in IndexedDB until the server confirms it. */
export interface QueuedDrop {
  client_drop_id: string;          // idempotency key; also the photo file name
  address_id: string;
  zone_id: string;
  owner_tenant_id: string;         // the CAMPAIGN OWNER's tenant (not the courier's); from dh_zone_addresses
  outcome: 'hung' | 'skipped';
  skip_reason?: string;
  lat: number;
  lng: number;
  accuracy_m: number;
  captured_at: string;             // device clock, ISO
  clock_offset_ms: number;         // serverNow - deviceNow when last online; server corrects with it
  device_id: string;
  photo_path?: string;             // t/<owner_tenant>/<zone>/<client_drop_id>.jpg
  blob?: Blob;                     // removed once uploaded
  uploaded: 0 | 1;
  synced: 0 | 1;                   // 1 = the server has answered (accepted OR permanently refused)
  last_error?: string;
  attempts: number;
}

class DropDB extends Dexie {
  queue!: Table<QueuedDrop, string>;
  constructor() {
    super('dh_drops');
    this.version(1).stores({ queue: 'client_drop_id, synced, zone_id' });
  }
}
export const db = new DropDB();
