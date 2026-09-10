import type { JobStatus } from "./enums.js";

/**
 * Job state machine - pure, shared by API, web and (later) the native app.
 * `new` jobs are created by the dispatcher or synced from the online store.
 *
 * Store unhappy paths are first-class statuses, not just failure reasons:
 *   no_answer        customer did not answer (door/phone) - requeue, return or fail
 *   location_changed customer moved the drop-off - rider updates address and continues
 *   returned         package is back at the store (terminal)
 */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  new: ["assigned", "cancelled"],
  assigned: ["accepted", "new", "no_answer", "location_changed", "failed", "cancelled"],
  accepted: ["picked_up", "assigned", "no_answer", "location_changed", "failed", "cancelled"],
  picked_up: ["in_transit", "delivering", "no_answer", "location_changed", "failed", "cancelled"],
  in_transit: ["delivering", "delivered", "no_answer", "location_changed", "failed", "cancelled"],
  delivering: ["delivered", "in_transit", "no_answer", "location_changed", "failed", "cancelled"],
  delivered: [],
  no_answer: ["new", "returned", "failed", "cancelled"],
  location_changed: ["in_transit", "delivering", "no_answer", "failed", "cancelled"],
  failed: ["new", "returned"],
  returned: [],
  cancelled: [],
};

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["delivered", "cancelled", "returned"];

/**
 * Statuses in which the rider is actively working a job (owns the package or
 * is in the middle of resolving it). Used for on_job, current-job lookups and
 * room membership. Note `no_answer`/`location_changed` count: the package is
 * still with the rider until the job resolves to a terminal status.
 */
export const ACTIVE_JOB_STATUSES: JobStatus[] = [
  "assigned",
  "accepted",
  "picked_up",
  "in_transit",
  "delivering",
  "location_changed",
  "no_answer",
];

/** A return job is modelled as a new job of type `return` linked to the original. */
export const RETURNABLE_STATUSES: JobStatus[] = ["delivered", "failed"];

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false;
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitions(from: JobStatus): JobStatus[] {
  return [...(JOB_TRANSITIONS[from] ?? [])];
}

/**
 * Primary actor allowed to perform a transition TO the given status.
 * (The API may widen this per-role, e.g. dispatchers can requeue failed jobs.)
 */
export const TRANSITION_PRIMARY_ACTOR: Record<JobStatus, "rider" | "dispatcher" | "system"> = {
  new: "dispatcher",
  assigned: "dispatcher",
  accepted: "rider",
  picked_up: "rider",
  in_transit: "rider",
  delivering: "rider",
  delivered: "rider",
  no_answer: "rider",
  location_changed: "rider",
  failed: "rider",
  returned: "rider",
  cancelled: "dispatcher",
};
