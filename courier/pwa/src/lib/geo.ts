/**
 * Best GPS fix within a short window. Browsers give no "mock location" flag, so the server
 * relies on accuracy, distance-to-door, travel speed and photo checks instead.
 * Foreground only: a PWA cannot track location in the background.
 */
export function bestFix(maxWaitMs = 6000, goodEnoughM = 15): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    let best: GeolocationPosition | null = null;
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      if (best) resolve(best); else reject(err ?? new Error('no GPS fix'));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (p.coords.accuracy <= goodEnoughM) finish();
      },
      (e) => finish(new Error(e.message)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs },
    );
    const timer = setTimeout(() => finish(), maxWaitMs);
  });
}
