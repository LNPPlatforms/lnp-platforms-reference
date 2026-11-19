import { db, QueuedDrop } from './db';
import { bestFix } from './geo';
import { getClockOffsetMs } from './clock';

/** Everything the capture screen needs to know about a door; comes from dh_zone_addresses(). */
export interface DoorTarget {
  address_id: string;
  zone_id: string;
  owner_tenant_id: string;   // the "tenant_id" column returned by dh_zone_addresses
  label: string;             // e.g. "12 Oak St"
}

/** Live camera only (no gallery picker) - the single biggest anti-fraud lever in a PWA. */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');   // required for iOS standalone PWAs
  await video.play();
  return stream;
}

/** Keep the screen on during a shift; the lock is released whenever the page is hidden, so re-take it. */
export function holdScreenAwake(): () => void {
  let lock: { release: () => Promise<void> } | null = null;
  const take = async () => {
    try { lock = await (navigator as any).wakeLock?.request('screen'); } catch { lock = null; }
  };
  const onVis = () => { if (!document.hidden) void take(); };
  document.addEventListener('visibilitychange', onVis);
  void take();
  return () => { document.removeEventListener('visibilitychange', onVis); void lock?.release(); };
}

function deviceId(): string {
  try {
    let id = localStorage.getItem('dh_device_id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('dh_device_id', id); }
    return id;
  } catch { return 'unknown'; }
}

export interface CaptureOptions {
  outcome?: 'hung' | 'skipped';
  skipReason?: string;          // required when outcome = 'skipped' (e.g. "No Soliciting sign")
  takePhoto?: boolean;          // default true; a skip may omit the photo
}

/**
 * GPS fix + photo with an on-image stamp (address, time, coordinates, accuracy), saved to the
 * offline queue. Canvas capture strips EXIF, so the stamp and the queued metadata are the evidence.
 * Returns immediately after queuing; call sync.run() afterwards.
 */
export async function captureDrop(
  video: HTMLVideoElement, door: DoorTarget, opts: CaptureOptions = {},
): Promise<QueuedDrop> {
  const outcome = opts.outcome ?? 'hung';
  const takePhoto = opts.takePhoto ?? true;
  if (outcome === 'skipped' && !opts.skipReason) throw new Error('skip reason required');

  const fix = await bestFix();
  const capturedAt = new Date();
  const id = crypto.randomUUID();
  let blob: Blob | undefined;

  if (takePhoto) {
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const stamp = `${door.label} | ${capturedAt.toLocaleString()} | ` +
      `${fix.coords.latitude.toFixed(5)}, ${fix.coords.longitude.toFixed(5)} ±${Math.round(fix.coords.accuracy)}m`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, canvas.height - 36, canvas.width, 36);
    ctx.fillStyle = '#fff';
    ctx.font = '16px sans-serif';
    ctx.fillText(stamp, 8, canvas.height - 12);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('photo failed'))), 'image/jpeg', 0.7));
  }

  const row: QueuedDrop = {
    client_drop_id: id,
    address_id: door.address_id,
    zone_id: door.zone_id,
    owner_tenant_id: door.owner_tenant_id,
    outcome,
    skip_reason: opts.skipReason,
    lat: fix.coords.latitude,
    lng: fix.coords.longitude,
    accuracy_m: fix.coords.accuracy,
    captured_at: capturedAt.toISOString(),
    clock_offset_ms: getClockOffsetMs(),
    device_id: deviceId(),
    // must match the server and storage policy: t/<owner tenant>/<zone>/<client_drop_id>.jpg
    photo_path: blob ? `t/${door.owner_tenant_id}/${door.zone_id}/${id}.jpg` : undefined,
    blob,
    uploaded: blob ? 0 : 1,
    synced: 0,
    attempts: 0,
  };
  await db.queue.add(row);
  navigator.vibrate?.(50);
  return row;
}
