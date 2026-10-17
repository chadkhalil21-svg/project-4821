// What an operator has actually been given.
//
// THE DEFECT THIS CLOSES. Dispatch has always written a real travel to `rides` with the
// matched operator on it — but the operator app never read it. It ran a timer that invented a
// request every few seconds from a scripted list (SIM_REQUESTS), so an operator on duty saw
// journeys that did not exist while the traveler who really booked one waited for somebody who
// was never told. Two halves of the same company, neither aware of the other.
//
// It could not have read them anyway: until 19 Aug 2026 the Firestore rule on `rides` matched
// the traveler only, so a real assignment was unreadable to the person assigned to it.
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  limit,
} from 'firebase/firestore';
import { fareFromTotal } from '../data';
import { PAYMENT_SERVER_URL } from '../config';
import { type OperatorStatus } from './rideStatusWrite';
import { auth, db } from '../firebase';
import { t } from '../i18n';

export type AssignedTravel = {
  rideId: string;
  /** Whose travel it is. Needed so the operator can write into their message thread — the
   *  security rule lets each side write only as themselves and read only threads they are on,
   *  so the counterparty's uid has to travel with the assignment. */
  travelerUid: string;
  /** Empty when the traveler has not set a name. Never substituted with an invented one. */
  travelerName: string;
  bookedForAnother?: boolean;
  minor?: boolean;
  teen?: boolean;
  guardianName?: string | null;
  pinRequired?: boolean;
  tripNo: string;
  dep: string;
  dest: string;
  travelClass: string;
  cabinPreferences?: {
    climate: 'Cool' | 'Moderate' | 'Warm';
    music: 'None' | 'Traveler Choice';
    quiet: boolean;
    charging: boolean;
    luggage: boolean;
  };
  costCents: number;
  /** Authoritative Travel Fare before Platform Fee/pass-throughs. */
  travelCostCents: number;
  status: string;
  releasedAt?: number | null;
  createdAt: number;
  /** When the status last changed. Distinguishes a journey underway from one that never
   *  closed — see ACTIVE_RESTORE_MAX_MS in OperatorContext. */
  statusAt: number;
  /** Raised by route monitoring when this vehicle has stopped for longer than a long light.
   *  Written only by the server; answered through POST /travel/check-in. */
  monitor?: {
    state?: string;
    question?: string;
    note?: string;
    askedOperatorAt?: number;
    operatorReply?: string;
  } | null;
};

/**
 * What the operator keeps, from what the traveler paid.
 *
 * `costCents` on a ride record is the ALL-IN price — the fare plus the platform fee. The
 * operator's 99% is of the fare alone, so the fee comes off first. Taking 1% off the
 * total instead would quote an operator 99% of American Rider's fee as well as of their own
 * fare.
 */
// SUBTRACTING A FLAT $1.50 IS ONLY RIGHT BELOW $30. Above that the platform fee is 5% of the
// fare, so taking $1.50 off the total overstates the fare — and therefore overstates what the
// operator is told they earned, on precisely the largest travels.
export const travelFareCents = (costCents: number) =>
  Math.round(fareFromTotal(costCents / 100) * 100);
export const operatorShareCents = (costCents: number) => {
  const fare = travelFareCents(costCents);
  return fare - Math.floor(fare * 0.01);
};

/**
 * Watch for travel dispatched to the signed-in operator.
 *
 * Queries on `operatorId` alone and filters status in memory. Two equality filters would work
 * through index merging, but this keeps the query independent of index configuration — a
 * dispatch that silently returns nothing because an index is missing is exactly the class of
 * failure this file exists to remove.
 *
 * Returns an unsubscribe function. Never throws: a listener that cannot attach reports an
 * empty inbox, which shows the operator "nothing yet" rather than a scripted journey.
 */
export function watchAssignedTravel(
  onChange: (travels: AssignedTravel[]) => void,
  onError?: (reason: string) => void,
): () => void {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    onChange([]);
    onError?.(t('traveler.errNotSignedIn'));
    return () => {};
  }
  try {
    // Historic completed/cancelled Travels belong to paginated history, not the
    // real-time assignment inbox. Fetch only active work, with an explicit ceiling.
    // A saturated inbox is an operational exception, never silently truncated.
    const MAX_ACTIVE_INBOX = 100;
    const q = query(collection(db, 'rides'),
      where('operatorId', '==', uid),
      where('status', 'in', ['assigned', 'accepted', 'arrived', 'onboard']),
      limit(MAX_ACTIVE_INBOX + 1));
    return onSnapshot(
      q,
      (snap) => {
        if (snap.docs.length > MAX_ACTIVE_INBOX) {
          onChange([]);
          onError?.(t('traveler.errReadTravel'));
          return;
        }
        const open = snap.docs
          .map((d) => {
            const x = d.data() as Record<string, unknown>;
            return {
              rideId: d.id,
              travelerUid: String(x.travelerUid ?? ''),
              travelerName: String(x.travelerName ?? ''),
              bookedForAnother: (x.party as any)?.bookedForAnother === true,
              teen: (x.party as any)?.teen === true,
              guardianName: typeof (x.party as any)?.guardianName === 'string' ? (x.party as any).guardianName : null,
              pinRequired: (x.party as any)?.pinRequired === true,
              tripNo: String(x.tripNo ?? ''),
              dep: String(x.dep ?? ''),
              dest: String(x.dest ?? ''),
              travelClass: String(x.travelClass ?? 'Standard'),
              cabinPreferences: x.cabinPreferences && typeof x.cabinPreferences === 'object'
                ? {
                    climate: ['Cool', 'Moderate', 'Warm'].includes(String((x.cabinPreferences as any).climate))
                      ? (String((x.cabinPreferences as any).climate) as 'Cool' | 'Moderate' | 'Warm')
                      : 'Moderate',
                    music: ['None', 'Traveler Choice'].includes(String((x.cabinPreferences as any).music))
                      ? (String((x.cabinPreferences as any).music) as 'None' | 'Traveler Choice')
                      : 'None',
                    quiet: (x.cabinPreferences as any).quiet !== false,
                    charging: (x.cabinPreferences as any).charging === true,
                    luggage: (x.cabinPreferences as any).luggage === true,
                  }
                : undefined,
              costCents: Number(x.costCents ?? 0),
              travelCostCents: Number(x.travelCostCents ?? 0),
              status: String(x.status ?? ''),
              releasedAt: Number(x.releasedAt) || null,
              createdAt: Number(x.createdAt ?? 0),
              statusAt: Number(x.statusAt ?? 0),
              monitor: (x.monitor as AssignedTravel['monitor']) ?? null,
            };
          })
          // EVERY travel dispatched to this operator, not just the unanswered ones. The
          // caller decides: 'assigned' is a request to answer, and accepted/arrived/onboard
          // is a journey underway — which the operator app currently keeps only in local
          // state, so it is lost if the app restarts mid-travel.
          .sort((a, b) => b.createdAt - a.createdAt);
        onChange(open);
      },
      // NOT SWALLOWED. The first version of this reported an empty inbox on any failure, so a
      // denied query and a quiet night looked identical — an operator would sit on
      // "Matching you with nearby travelers" while travels were being dispatched to them.
      // That is the same shape as the firebase-admin outage that hid for weeks because the
      // failure was reported honestly at every step except the one that mattered.
      (e) => {
        onChange([]);
        onError?.(e?.message || t('traveler.errReadTravel'));
      },
    );
  } catch (e) {
    onChange([]);
    onError?.(e instanceof Error ? e.message : t('traveler.errReadTravel'));
    return () => {};
  }
}

/**
 * Move a travel along. The rule permits an operator these statuses and nothing else — not the
 * fare, not the traveler, not who it belongs to.
 *
 * Returns whether the write landed, and never throws. The caller decides what to tell the
 * operator; it must not claim a travel was accepted if the database refused.
 */
async function setStatus(rideId: string, status: OperatorStatus): Promise<boolean> {
  if (!rideId) return false;
  try {
    const token = await auth.currentUser?.getIdToken().catch(() => null);
    if (!token) return false;
    const res = await fetch(`${PAYMENT_SERVER_URL}/travel/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rideId, status }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      console.error(`[inbox] server refused travel ${rideId} -> ${status}:`, d?.code || d?.error || res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[inbox] could not request travel ${rideId} -> ${status}:`, (e as Error)?.message);
    return false;
  }
}

/**
 * Accept the travel offered to this operator — through the server, never a direct write.
 *
 * firestore.rules refuses 'accepted' from a phone. POST /travel/accept re-checks, at the moment
 * of acceptance, everything that made the operator eligible when the travel was offered: the
 * insurance disclosure version, approval, documents, insurance, screening, the account and
 * Stripe payouts. A refusal comes back with a code, and the travel goes to somebody else.
 * Never throws; an unreachable server is a refusal, not an acceptance.
 */
export async function acceptTravel(
  rideId: string,
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  if (!rideId) return { ok: false, error: 'No travel' };
  try {
    const token = await auth.currentUser?.getIdToken().catch(() => null);
    const res = await fetch(`${PAYMENT_SERVER_URL}/travel/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ rideId }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: d?.error || `Server error ${res.status}`, code: d?.code };
    return { ok: true };
  } catch {
    return { ok: false, error: t('traveler.errReachDispatch') };
  }
}
export const declineTravel = (rideId: string) => setStatus(rideId, 'declined');
export const markArrived = (rideId: string) => setStatus(rideId, 'arrived');
export async function markOnboard(rideId: string, teenPickupCode?: string): Promise<boolean> {
  if (!rideId) return false;
  if (teenPickupCode) {
    try {
      const token = await auth.currentUser?.getIdToken().catch(() => null);
      const res = await fetch(`${PAYMENT_SERVER_URL}/travel/teen-pickup/verify`, { method:'POST', headers:{'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{})}, body:JSON.stringify({rideId,pin:teenPickupCode}) });
      if (!res.ok) return false;
    } catch { return false; }
  }
  return setStatus(rideId, 'onboard');
}
export const markCompleted = (rideId: string) => setStatus(rideId, 'completed');
