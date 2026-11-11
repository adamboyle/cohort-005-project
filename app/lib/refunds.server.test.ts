import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { enroll, isEnrolled } from "./enrollment.server";
import {
  approveRefundRequest,
  checkRefundEligibility,
  declineRefundRequest,
  getLearnerRefundRequests,
  getRefundFacts,
  getSupportQueues,
  markRefundFailed,
  markRefundIssued,
  raiseRefundRequest,
  RefundError,
} from "./refunds.server";

const PURCHASED_AT = new Date(2026, 10, 1, 23, 0); // 1 Nov 2026, 23:00 local
const daysAfterPurchase = (days: number) =>
  new Date(2026, 10, 1 + days, 12, 0);

let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

function buy(userId = base.user.id, amountPaid = 7900) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid,
      createdAt: PURCHASED_AT.toISOString(),
    })
    .returning()
    .get();
  enroll(userId, base.course.id);
  return purchase;
}

function completeLessons(count: number) {
  for (const lessonId of lessonIds.slice(0, count)) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
  }
}

function watch(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("refund eligibility", () => {
  it("is eligible on the fourteenth calendar day after purchase", () => {
    buy();
    const result = checkRefundEligibility(
      base.user.id,
      base.course.id,
      daysAfterPurchase(14)
    );
    expect(result.eligible).toBe(true);
  });

  it("closes the Refund Window on the fifteenth day", () => {
    buy();
    const result = checkRefundEligibility(
      base.user.id,
      base.course.id,
      daysAfterPurchase(15)
    );
    expect(result).toEqual({
      eligible: false,
      reason: "The 14-day window has closed.",
    });
  });

  it("refuses a learner who has completed half the lessons", () => {
    buy();
    completeLessons(2);
    const result = checkRefundEligibility(
      base.user.id,
      base.course.id,
      daysAfterPurchase(1)
    );
    expect(result).toEqual({
      eligible: false,
      reason: "You have completed too much of this course to request a refund.",
    });
  });

  it("allows a learner who has completed under half the lessons", () => {
    buy();
    completeLessons(1);
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(1))
        .eligible
    ).toBe(true);
  });

  it("refuses a learner who has watched two hours", () => {
    buy();
    watch(lessonIds[0], 3600);
    watch(lessonIds[1], 3600);
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(1))
    ).toEqual({
      eligible: false,
      reason: "You have watched too much of this course to request a refund.",
    });
  });

  it("refuses a learner who hasn't bought the course", () => {
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(1))
    ).toEqual({ eligible: false, reason: "You have not bought this course." });
  });

  it("refuses a second Refund Request while one is open", () => {
    buy();
    raiseRefundRequest(
      base.user.id,
      base.course.id,
      "Not what I expected.",
      daysAfterPurchase(1)
    );
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(2))
    ).toEqual({
      eligible: false,
      reason: "You already have an open refund request on this purchase.",
    });
  });

  it("refuses a purchase with a claimed team seat", () => {
    const purchase = buy();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: base.instructor.id,
        redeemedAt: PURCHASED_AT.toISOString(),
      })
      .run();
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(1))
    ).toEqual({
      eligible: false,
      reason: "A claimed team seat cannot be refunded.",
    });
  });
});

describe("raising a Refund Request", () => {
  it("leaves the learner enrolled while it is open", () => {
    buy();
    raiseRefundRequest(
      base.user.id,
      base.course.id,
      "Not what I expected.",
      daysAfterPurchase(1)
    );
    expect(isEnrolled(base.user.id, base.course.id)).toBe(true);
  });

  it("refuses when the learner is not eligible", () => {
    buy();
    expect(() =>
      raiseRefundRequest(
        base.user.id,
        base.course.id,
        "Not what I expected.",
        daysAfterPurchase(20)
      )
    ).toThrow("The 14-day window has closed.");
  });
});

function createSupport() {
  return testDb
    .insert(schema.users)
    .values({
      name: "Support Admin",
      email: "admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
}

function openRequest() {
  buy();
  return raiseRefundRequest(
    base.user.id,
    base.course.id,
    "Bought the wrong course.",
    daysAfterPurchase(1)
  ).refundRequest;
}

describe("deciding a Refund Request", () => {
  let support: ReturnType<typeof createSupport>;

  beforeEach(() => {
    support = createSupport();
  });

  it("approving creates a Pending Refund for the full amount paid", () => {
    const request = openRequest();

    approveRefundRequest(request.id, support.id);

    const queues = getSupportQueues();
    expect(queues.openRequests).toEqual([]);
    expect(queues.refundsAwaitingConfirmation).toMatchObject([
      {
        status: schema.RefundStatus.Pending,
        amount: 7900,
        learnerName: "Test User",
      },
    ]);
  });

  it("lists Open Refund Requests with how far the learner has got", () => {
    const request = openRequest();
    completeLessons(1);
    watch(lessonIds[0], 600);

    expect(getSupportQueues().openRequests).toMatchObject([
      {
        id: request.id,
        learnerName: "Test User",
        amountPaid: 7900,
        reason: "Bought the wrong course.",
        facts: { completedLessons: 1, totalLessons: 4, secondsWatched: 600 },
      },
    ]);
  });

  it("approving ends the learner's access straight away", () => {
    const request = openRequest();
    approveRefundRequest(request.id, support.id);
    expect(isEnrolled(base.user.id, base.course.id)).toBe(false);
  });

  it("approving keeps the learner's progress for if they buy again", () => {
    const request = openRequest();
    completeLessons(1);
    approveRefundRequest(request.id, support.id);

    buy();

    expect(isEnrolled(base.user.id, base.course.id)).toBe(true);
    expect(
      getRefundFacts(base.user.id, base.course.id, {
        createdAt: PURCHASED_AT.toISOString(),
      }).completedLessons
    ).toBe(1);
  });

  it("approving voids the purchase's unclaimed team seats", () => {
    const request = openRequest();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values(
        ["SEAT-A", "SEAT-B"].map((code) => ({
          teamId: team.id,
          courseId: base.course.id,
          code,
          purchaseId: request.purchaseId,
        }))
      )
      .run();

    const outcome = approveRefundRequest(request.id, support.id);

    expect(outcome.voidedSeats).toBe(2);
  });

  it("refuses another Refund Request once the purchase is refunded", () => {
    const request = openRequest();
    approveRefundRequest(request.id, support.id);
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(2))
    ).toEqual({
      eligible: false,
      reason: "This purchase has already been refunded.",
    });
  });

  it("declining needs a note and leaves the learner enrolled", () => {
    const request = openRequest();

    expect(() => declineRefundRequest(request.id, support.id, "  ")).toThrow(
      RefundError
    );

    declineRefundRequest(
      request.id,
      support.id,
      "You have finished the course already."
    );

    expect(isEnrolled(base.user.id, base.course.id)).toBe(true);
    expect(getLearnerRefundRequests(base.user.id)).toMatchObject([
      {
        status: schema.RefundRequestStatus.Declined,
        decisionNote: "You have finished the course already.",
        refundStatus: null,
      },
    ]);
  });

  it("lets the learner raise a new Refund Request after a decline", () => {
    const request = openRequest();
    declineRefundRequest(request.id, support.id, "Please tell us more first.");
    expect(
      checkRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(2))
        .eligible
    ).toBe(true);
  });

  it("refuses to decide a Refund Request twice", () => {
    const request = openRequest();
    approveRefundRequest(request.id, support.id);

    expect(() => approveRefundRequest(request.id, support.id)).toThrow(
      "This refund request has already been decided."
    );
    expect(() =>
      declineRefundRequest(request.id, support.id, "Changed my mind here.")
    ).toThrow("This refund request has already been decided.");
  });
});

describe("the Refund lifecycle", () => {
  let support: ReturnType<typeof createSupport>;
  let refundId: number;

  beforeEach(() => {
    support = createSupport();
    const request = openRequest();
    refundId = approveRefundRequest(request.id, support.id).refund.id;
  });

  const learnerRefundStatus = () =>
    getLearnerRefundRequests(base.user.id)[0].refundStatus;

  it("goes from Pending to Issued and leaves the queue", () => {
    markRefundIssued(refundId, support.id);
    expect(learnerRefundStatus()).toBe(schema.RefundStatus.Issued);
    expect(getSupportQueues().refundsAwaitingConfirmation).toEqual([]);
  });

  it("goes from Pending to Failed and stays in the queue with its note", () => {
    markRefundFailed(refundId, support.id, "Card expired.");
    expect(learnerRefundStatus()).toBe(schema.RefundStatus.Failed);
    expect(getSupportQueues().refundsAwaitingConfirmation).toMatchObject([
      { status: schema.RefundStatus.Failed, failureNote: "Card expired." },
    ]);
  });

  it("keeps the Refund Request approved when the Refund fails", () => {
    markRefundFailed(refundId, support.id);
    expect(getLearnerRefundRequests(base.user.id)[0].status).toBe(
      schema.RefundRequestStatus.Approved
    );
  });

  it("can be retried from Failed to Issued", () => {
    markRefundFailed(refundId, support.id);
    markRefundIssued(refundId, support.id);
    expect(learnerRefundStatus()).toBe(schema.RefundStatus.Issued);
  });

  it("can't fail twice in a row", () => {
    markRefundFailed(refundId, support.id);
    expect(() => markRefundFailed(refundId, support.id)).toThrow(
      "This refund is already marked as failed."
    );
  });

  it("is final once issued", () => {
    markRefundIssued(refundId, support.id);
    expect(() => markRefundIssued(refundId, support.id)).toThrow(
      "This refund has already been issued."
    );
    expect(() => markRefundFailed(refundId, support.id)).toThrow(
      "This refund has already been issued."
    );
  });
});
