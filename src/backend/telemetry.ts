// Where the vehicle is, while it is carrying somebody.
//
// WHY THIS EXISTS. Route monitoring (backend/monitor.js) can only notice a car that has
// stopped if something is telling it where the car is. Nothing was: the app read the phone's
// position for the map, for pricing and for the emergency screen, and never once wrote it to
// the travel. The platform knew a journey was underway and had no idea whether it was moving.
//
// WHAT IS COLLECTED, AND WHEN IT STOPS. Position, only while a travel this operator accepted
// is underway, and only until it ends. Not when they are on duty and empty, not when the app
// is open with no travel, never for a traveler. The operator's own screen says so.
//
// `stillSince` is sent as well as the position because the phone sees a fix every fifteen
// seconds and the server's sweep sees one a minute. The server does not take it on trust —
// see monitor.js, which keeps its own anchor and can only ever shorten the stationary period,
// so no phone can make itself look stuck.
import * as Location from 'expo-location';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { MOVEMENT_RADIUS_MI, shouldPublishTripPosition } from '../tripPositionPolicy';

/** Movement below this is GPS drift at a standstill, not a car going anywhere. */
const STILL_RADIUS_MI = MOVEMENT_RADIUS_MI;

/** Sample locally every 15 seconds; publish less often without losing stop detection. */
const SAMPLE_EVERY_MS = 15_000;

function distanceMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Report this vehicle's position to the travel until the returned function is called.
 *
 * Never throws and never asks for a permission it has not got: if location is refused the
 * reporting simply does not start, and monitoring sees a travel it has no position for —
 * which it treats as "no information", not as "stopped". A refused permission must not be
 * able to open a support case about an operator.
 */
export function reportPosition(rideId: string): () => void {
  if (!rideId) return () => {};
  let stop = false;
  let sub: Location.LocationSubscription | null = null;
  let last: { lat: number; lng: number } | null = null;
  let stillSince = Date.now();
  let sentAt = 0;

  (async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || stop) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: SAMPLE_EVERY_MS, distanceInterval: 10 },
        (pos) => {
          if (stop) return;
          const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          const now = Date.now();
          const moved = !last || distanceMiles(last, here) > STILL_RADIUS_MI;
          if (moved) {
            stillSince = now;
            last = here;
          }
          // Local GPS remains automatic. Moving updates are capped at 30 seconds;
          // stationary freshness at 60 seconds. Do not silence an initial fix.
          if (!shouldPublishTripPosition({
            elapsedMs: now - sentAt, moved, hasPublished: sentAt > 0,
          })) return;
          sentAt = now;
          updateDoc(doc(db, 'rides', rideId), {
            opLat: here.lat,
            opLng: here.lng,
            opAt: now,
            stillSince,
          }).catch(() => {
            /* one lost fix is nothing; the next is fifteen seconds away */
          });
        },
      );
      if (stop) {
        sub.remove();
        sub = null;
      }
    } catch {
      /* no position available on this device — see above */
    }
  })();

  return () => {
    stop = true;
    sub?.remove();
    sub = null;
  };
}
