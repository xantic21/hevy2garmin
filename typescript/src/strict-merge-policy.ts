/** Conservative pure policy for the quarantined strict-merge lane.
 * This module is a building block, not a live synchronization entry point.
 * The caller must enforce a durable exclusive binding and verified backup
 * before granting a write capability. No upload or delete is ever exposed.
 */
import { findMergeMatch, type CandidateActivity, type MergeMatch, type TimedWorkout } from "./merge-match";
import { toUtcDate } from "./match";
import type { GarminGateway } from "./sync/gateway";

export type StrictMatchDecision =
  | { status: "matched"; match: MergeMatch }
  | { status: "pending" | "needs_review"; reason: string };

function explicitInstant(value: string | null | undefined): number {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value) : NaN;
}

/** Never guess a timezone or choose the highest score among multiple matches. */
export function selectStrictMergeMatch(
  workout: TimedWorkout,
  activities: CandidateActivity[],
  now = new Date(),
): StrictMatchDecision {
  const start = explicitInstant(workout.start_time || workout.startTime);
  const end = explicitInstant(workout.end_time || workout.endTime);
  const clock = now.getTime();
  if (![start, end, clock].every(Number.isFinite) || end <= start || end > clock) {
    return { status: "needs_review", reason: "invalid or unfinished Hevy interval" };
  }
  if (!Array.isArray(activities)) {
    return { status: "needs_review", reason: "invalid Garmin activity listing" };
  }
  const eligible: MergeMatch[] = [];
  for (const activity of activities) {
    if (!activity || activity.activityType?.typeKey !== "strength_training") continue;
    const manufacturer = String(activity.manufacturer ?? "").trim().toUpperCase();
    if (manufacturer === "DEVELOPMENT") continue;
    const gmt = activity.startTimeGMT;
    if (!gmt || !toUtcDate(gmt) || !Number.isFinite(activity.duration) ||
        (activity.duration ?? 0) <= 0 || !Number.isSafeInteger(activity.activityId) ||
        activity.activityId <= 0) {
      // A malformed native candidate cannot be safely ruled out. Fail closed.
      return { status: "needs_review", reason: "unusable native strength activity" };
    }
    const match = findMergeMatch(workout, [activity], {
      activityTypes: ["strength_training"], overlapThreshold: 0.7,
      maxDriftMinutes: 20, now,
    });
    if (!match) continue;
    if (manufacturer !== "GARMIN") {
      return { status: "needs_review", reason: "native Garmin provenance not established" };
    }
    eligible.push(match);
  }
  if (eligible.length === 0) return { status: "pending", reason: "no qualifying original activity" };
  if (eligible.length !== 1) return { status: "needs_review", reason: "ambiguous activity candidates" };
  return { status: "matched", match: eligible[0] };
}

/** A narrow capability: caller must already hold the durable exclusive claim
 * and verified immutable backup for this exact activity. Only set read/write
 * is exposed, not raw client access, rename, delete, upload or description.
 */
export interface StrictSetCapability {
  readonly activityId: number;
  readSets(): Promise<Record<string, unknown>>;
  writeSets(payload: unknown): Promise<void>;
}
export function restrictToOriginalSets(
  gateway: Pick<GarminGateway, "exerciseSets" | "putExerciseSets">,
  activityId: number,
): StrictSetCapability {
  if (!Number.isSafeInteger(activityId) || activityId <= 0) throw new Error("Invalid original activity ID");
  return Object.freeze({
    activityId,
    readSets: () => gateway.exerciseSets(activityId),
    writeSets: (payload: unknown) => gateway.putExerciseSets(activityId, payload),
  });
}
