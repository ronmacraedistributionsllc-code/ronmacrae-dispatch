import { describe, expect, it } from "vitest";
import {
  canTransition,
  allowedTransitions,
  toCustomerStatus,
  TERMINAL_JOB_STATUSES,
  JOB_STATUSES,
  RIDER_STAGES,
  RIDER_STAGE_LABELS,
  CUSTOMER_JOB_STATUSES,
} from "../src/index.js";

describe("job state machine", () => {
  it("allows the full happy path", () => {
    const path = [
      "new",
      "assigned",
      "accepted",
      "picked_up",
      "in_transit",
      "delivering",
      "delivered",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("rejects backwards jumps", () => {
    expect(canTransition("delivered", "new")).toBe(false);
    expect(canTransition("new", "delivered")).toBe(false);
    expect(canTransition("cancelled", "assigned")).toBe(false);
  });

  it("allows failure from any in-field state and requeue from failed", () => {
    for (const from of ["picked_up", "in_transit", "delivering", "assigned", "accepted"] as const) {
      expect(canTransition(from, "failed")).toBe(true);
    }
    expect(canTransition("failed", "new")).toBe(true);
    expect(allowedTransitions("delivered")).toHaveLength(0);
    expect(TERMINAL_JOB_STATUSES).toEqual(["delivered", "cancelled", "returned"]);
  });

  it("never allows a self transition", () => {
    for (const s of ["new", "assigned", "delivered", "no_answer", "location_changed"] as const) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("models the store unhappy paths as distinct statuses", () => {
    // customer not answering / changed location: requeue, return or fail out
    for (const from of ["assigned", "accepted", "picked_up", "in_transit", "delivering"] as const) {
      expect(canTransition(from, "no_answer")).toBe(true);
      expect(canTransition(from, "location_changed")).toBe(true);
    }
    expect(canTransition("no_answer", "new")).toBe(true); // requeue a delivery attempt
    expect(canTransition("no_answer", "returned")).toBe(true); // rider brings it back
    expect(canTransition("failed", "returned")).toBe(true);
    expect(canTransition("location_changed", "in_transit")).toBe(true); // continue to the new spot
    expect(canTransition("location_changed", "delivering")).toBe(true);
    // returned is terminal; a fresh delivery job is created instead
    expect(allowedTransitions("returned")).toHaveLength(0);
    expect(canTransition("new", "no_answer")).toBe(false); // never skipped to a door outcome
    expect(canTransition("new", "location_changed")).toBe(false);
  });
});

describe("rider stages", () => {
  it("are sub-progress markers, never status transitions", () => {
    for (const stage of RIDER_STAGES) {
      // a stage is never a JobStatus: the state machine must not know about it
      expect(JOB_STATUSES).not.toContain(stage as (typeof JOB_STATUSES)[number]);
    }
    expect(RIDER_STAGE_LABELS.at_pickup).toBe("At pickup");
  });
});

describe("customer status projection", () => {
  it("maps internal statuses to customer-friendly ones", () => {
    expect(toCustomerStatus("new")).toBe("confirmed");
    expect(toCustomerStatus("assigned")).toBe("assigned");
    expect(toCustomerStatus("picked_up")).toBe("picked_up");
    expect(toCustomerStatus("in_transit")).toBe("out_for_delivery");
    expect(toCustomerStatus("delivering")).toBe("out_for_delivery");
    expect(toCustomerStatus("delivered")).toBe("delivered");
    // the store unhappy paths are surfaced distinctly to the customer
    expect(toCustomerStatus("no_answer")).toBe("no_answer");
    expect(toCustomerStatus("location_changed")).toBe("location_changed");
    expect(toCustomerStatus("failed")).toBe("failed");
    expect(toCustomerStatus("returned")).toBe("returned");
    expect(toCustomerStatus("cancelled")).toBe("cancelled");
  });

  it("every customer status is reachable from some internal status", () => {
    const projected = new Set(JOB_STATUSES.map(toCustomerStatus));
    for (const s of CUSTOMER_JOB_STATUSES) expect(projected.has(s)).toBe(true);
  });
});
