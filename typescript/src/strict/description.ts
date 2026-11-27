/**
 * The description strict mode writes: the user's own notes, byte for byte,
 * plus one delimited block listing what was done in Hevy.
 *
 * Contract item 3: "preserve existing user notes" and "no misleading
 * estimated HR/calories in descriptions". The block therefore carries only
 * facts recorded in Hevy (exercises, set types, reps, weights, durations,
 * distances). The activity's real heart rate and calories are the watch's own
 * and stay in Garmin's fields, untouched.
 *
 * The block is found again by its markers, so a resync replaces exactly the
 * previous block and nothing the user wrote around it.
 */
import type { StrictIntent, StrictSetIntent } from "./intent";

export const BLOCK_START = "[hevy2garmin]";
export const BLOCK_END = "[/hevy2garmin]";
/** Garmin truncates long descriptions; refuse rather than cut the user's text. */
export const MAX_DESCRIPTION_CHARS = 4000;

const TYPE_MARK: Record<StrictSetIntent["type"], string> = { normal: "", warmup: "W ", failure: "F ", dropset: "D " };

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function formatSet(s: StrictSetIntent): string {
  const parts: string[] = [];
  if (s.reps != null) parts.push(`${fmtNumber(s.reps)} reps`);
  if (s.weightKg != null) parts.push(s.weightKg === 0 ? "0 kg" : `${fmtNumber(s.weightKg)} kg`);
  else if (s.reps != null) parts.push("bodyweight");
  if (s.durationS != null) parts.push(`${fmtNumber(s.durationS)} s`);
  if (s.distanceM != null) parts.push(`${fmtNumber(s.distanceM)} m`);
  return `${TYPE_MARK[s.type]}${parts.join(" · ") || "no values"}`;
}

/** The block: Hevy facts only, no estimates. */
export function strictDescriptionBlock(intent: StrictIntent): string {
  const lines = [BLOCK_START, `Hevy: ${intent.title}`];
  for (const ex of intent.exercises) {
    if (!ex.sets.length) continue;
    lines.push(`${ex.title}: ${ex.sets.map(formatSet).join(", ")}`);
  }
  lines.push("W = warm-up, F = failure, D = drop set", BLOCK_END);
  return lines.join("\n");
}

/**
 * The existing description with the block inserted or replaced. Returns null
 * when the result would exceed the limit, so the caller skips the update
 * instead of truncating what the user wrote.
 */
export function mergeDescription(existing: string | null, block: string): string | null {
  const base = existing ?? "";
  const start = base.indexOf(BLOCK_START);
  const end = start >= 0 ? base.indexOf(BLOCK_END, start) : -1;
  let next: string;
  if (start >= 0 && end > start) {
    next = base.slice(0, start) + block + base.slice(end + BLOCK_END.length);
  } else {
    next = base.trim() ? `${base.replace(/\s+$/, "")}\n\n${block}` : block;
  }
  return next.length > MAX_DESCRIPTION_CHARS ? null : next;
}

/** The user's own text, i.e. everything outside the block. For tests and audits. */
export function userNotesOf(description: string | null): string {
  const base = description ?? "";
  const start = base.indexOf(BLOCK_START);
  const end = start >= 0 ? base.indexOf(BLOCK_END, start) : -1;
  if (start < 0 || end < start) return base;
  return base.slice(0, start) + base.slice(end + BLOCK_END.length);
}
