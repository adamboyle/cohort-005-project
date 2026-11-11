import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { endEnrollment } from "~/lib/enrollment.server";
import { formatPrice } from "~/lib/utils";

// ─── The Refund Window ───
// See GLOSSARY.md. Eligibility is checked when the learner raises a Refund
// Request. Support sees the same facts when deciding, but isn't bound by them.

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

type Purchase = typeof purchases.$inferSelect;

// The window is counted in whole days, not hours — someone who buys at 23:00
// should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAt: string): string {
  const deadline = new Date(purchasedAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc, ${purchases.id} desc`)
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function findRefundRequest(purchaseId: number, status: RefundRequestStatus) {
  return db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, status)
      )
    )
    .get();
}

function hasClaimedSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

export type RefundFacts = {
  daysSincePurchase: number;
  lastDayInWindow: string;
  withinWindow: boolean;
  secondsWatched: number;
  completedLessons: number;
  totalLessons: number;
};

/** How far into the course the learner is, measured against the Refund Window. */
export function getRefundFacts(
  userId: number,
  courseId: number,
  purchase: Pick<Purchase, "createdAt">,
  now: Date = new Date()
): RefundFacts {
  const purchasedDay = calendarDay(new Date(purchase.createdAt));
  const lastDayInWindow = lastDayOfWindow(purchase.createdAt);
  const today = calendarDay(now);

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSincePurchase = Math.round(
    (Date.parse(today) - Date.parse(purchasedDay)) / msPerDay
  );

  const lessonIds = getLessonIdsForCourse(courseId);
  let secondsWatched = 0;
  let completedLessons = 0;

  if (lessonIds.length > 0) {
    secondsWatched = db
      .select({
        furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
      })
      .from(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, userId),
          inArray(videoWatchEvents.lessonId, lessonIds)
        )
      )
      .groupBy(videoWatchEvents.lessonId)
      .all()
      .reduce((total, row) => total + row.furthest, 0);

    completedLessons =
      db
        .select({ count: sql<number>`count(*)` })
        .from(lessonProgress)
        .where(
          and(
            eq(lessonProgress.userId, userId),
            eq(lessonProgress.status, LessonProgressStatus.Completed),
            inArray(lessonProgress.lessonId, lessonIds)
          )
        )
        .get()?.count ?? 0;
  }

  return {
    daysSincePurchase,
    lastDayInWindow,
    withinWindow: today >= purchasedDay && today <= lastDayInWindow,
    secondsWatched,
    completedLessons,
    totalLessons: lessonIds.length,
  };
}

export type RefundEligibility =
  | { eligible: true; purchase: Purchase; lastDayInWindow: string }
  | { eligible: false; reason: string };

/** Whether the learner may raise a Refund Request on their latest purchase. */
export function checkRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) {
    return { eligible: false, reason: "You have not bought this course." };
  }

  if (findRefundRequest(purchase.id, RefundRequestStatus.Open)) {
    return {
      eligible: false,
      reason: "You already have an open refund request on this purchase.",
    };
  }

  if (findRefundRequest(purchase.id, RefundRequestStatus.Approved)) {
    return {
      eligible: false,
      reason: "This purchase has already been refunded.",
    };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  if (hasClaimedSeat(purchase.id)) {
    return {
      eligible: false,
      reason: "A claimed team seat cannot be refunded.",
    };
  }

  const facts = getRefundFacts(userId, courseId, purchase, now);

  if (!facts.withinWindow) {
    return {
      eligible: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
    };
  }

  if (
    facts.totalLessons > 0 &&
    facts.completedLessons / facts.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    return {
      eligible: false,
      reason: "You have completed too much of this course to request a refund.",
    };
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched too much of this course to request a refund.",
    };
  }

  return { eligible: true, purchase, lastDayInWindow: facts.lastDayInWindow };
}

/** Thrown when a Refund Request or Refund can't move to the state asked for. */
export class RefundError extends Error {}

export function raiseRefundRequest(
  userId: number,
  courseId: number,
  reason: string,
  now: Date = new Date()
) {
  const eligibility = checkRefundEligibility(userId, courseId, now);

  if (!eligibility.eligible) {
    throw new RefundError(eligibility.reason);
  }

  const refundRequest = db
    .insert(refundRequests)
    .values({
      purchaseId: eligibility.purchase.id,
      status: RefundRequestStatus.Open,
      reason,
      requestedAt: now.toISOString(),
    })
    .returning()
    .get();

  return { refundRequest, purchase: eligibility.purchase };
}

// ─── Deciding a Refund Request ───
// Open → Approved | Declined. Only an Open Refund Request can be decided.

export const MIN_DECLINE_NOTE_LENGTH = 10;

function getRequestWithPurchase(refundRequestId: number) {
  return db
    .select({ request: refundRequests, purchase: purchases })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();
}

function decide(
  refundRequestId: number,
  supportUserId: number,
  status: RefundRequestStatus.Approved | RefundRequestStatus.Declined,
  note: string | null,
  now: Date
) {
  const found = getRequestWithPurchase(refundRequestId);
  if (!found) {
    throw new RefundError("Refund request not found.");
  }

  // Guarded on the status as well, so two people deciding at once can't both
  // succeed.
  const decided = db
    .update(refundRequests)
    .set({
      status,
      decisionNote: note,
      decidedAt: now.toISOString(),
      decidedByUserId: supportUserId,
    })
    .where(
      and(
        eq(refundRequests.id, refundRequestId),
        eq(refundRequests.status, RefundRequestStatus.Open)
      )
    )
    .returning()
    .get();

  if (!decided) {
    throw new RefundError("This refund request has already been decided.");
  }

  return { refundRequest: decided, purchase: found.purchase };
}

function cleanNote(note: string | null | undefined) {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Approves the request: a Pending Refund for the full amount paid, the
 * learner's access ends now, and unclaimed team seats on the purchase are
 * voided. Progress is kept — see ADR-0001.
 */
export function approveRefundRequest(
  refundRequestId: number,
  supportUserId: number,
  note?: string | null,
  now: Date = new Date()
) {
  return db.transaction(() => {
    const { refundRequest, purchase } = decide(
      refundRequestId,
      supportUserId,
      RefundRequestStatus.Approved,
      cleanNote(note),
      now
    );

    const refund = db
      .insert(refunds)
      .values({
        refundRequestId: refundRequest.id,
        status: RefundStatus.Pending,
        amount: purchase.amountPaid,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();

    endEnrollment(purchase.userId, purchase.courseId, now.toISOString());

    const voidedSeats = db
      .update(coupons)
      .set({ voidedAt: now.toISOString() })
      .where(
        and(
          eq(coupons.purchaseId, purchase.id),
          isNull(coupons.redeemedAt),
          isNull(coupons.voidedAt)
        )
      )
      .returning({ id: coupons.id })
      .all().length;

    return { refundRequest, refund, purchase, voidedSeats };
  });
}

/** Declines the request. Support must tell the learner why. */
export function declineRefundRequest(
  refundRequestId: number,
  supportUserId: number,
  note: string,
  now: Date = new Date()
) {
  const cleaned = cleanNote(note);
  if (!cleaned || cleaned.length < MIN_DECLINE_NOTE_LENGTH) {
    throw new RefundError(
      `Tell the learner why, in at least ${MIN_DECLINE_NOTE_LENGTH} characters.`
    );
  }

  return decide(
    refundRequestId,
    supportUserId,
    RefundRequestStatus.Declined,
    cleaned,
    now
  );
}

// ─── The Refund ───
// Pending → Issued | Failed, and Failed → Issued on a retry. Issued is final.

const REFUND_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  [RefundStatus.Pending]: [RefundStatus.Issued, RefundStatus.Failed],
  [RefundStatus.Failed]: [RefundStatus.Issued],
  [RefundStatus.Issued]: [],
};

function moveRefund(
  refundId: number,
  supportUserId: number,
  to: RefundStatus.Issued | RefundStatus.Failed,
  failureNote: string | null,
  now: Date
) {
  const refund = db.select().from(refunds).where(eq(refunds.id, refundId)).get();

  if (!refund) {
    throw new RefundError("Refund not found.");
  }

  if (!REFUND_TRANSITIONS[refund.status].includes(to)) {
    throw new RefundError(
      refund.status === RefundStatus.Issued
        ? "This refund has already been issued."
        : "This refund is already marked as failed."
    );
  }

  const moved = db
    .update(refunds)
    .set({
      status: to,
      // A retry that succeeds clears the old failure note.
      failureNote,
      statusChangedAt: now.toISOString(),
      statusChangedByUserId: supportUserId,
    })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, refund.status)))
    .returning()
    .get();

  if (!moved) {
    throw new RefundError("This refund changed while you were looking at it.");
  }

  return moved;
}

export function markRefundIssued(
  refundId: number,
  supportUserId: number,
  now: Date = new Date()
) {
  return moveRefund(refundId, supportUserId, RefundStatus.Issued, null, now);
}

export function markRefundFailed(
  refundId: number,
  supportUserId: number,
  note?: string | null,
  now: Date = new Date()
) {
  return moveRefund(
    refundId,
    supportUserId,
    RefundStatus.Failed,
    cleanNote(note),
    now
  );
}

// ─── Read views ───

/** What Support works through on the refunds screen. */
export function getSupportQueues(now: Date = new Date()) {
  const openRequests = db
    .select({
      id: refundRequests.id,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(refundRequests.requestedAt, refundRequests.id)
    .all()
    .map((row) => ({
      ...row,
      facts: getRefundFacts(
        row.learnerId,
        row.courseId,
        { createdAt: row.purchasedAt },
        now
      ),
    }));

  const refundsAwaitingConfirmation = db
    .select({
      id: refunds.id,
      status: refunds.status,
      amount: refunds.amount,
      failureNote: refunds.failureNote,
      approvedAt: refunds.createdAt,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(inArray(refunds.status, [RefundStatus.Pending, RefundStatus.Failed]))
    .orderBy(refunds.createdAt, refunds.id)
    .all();

  return { openRequests, refundsAwaitingConfirmation };
}

/** The learner's latest Refund Request on each purchase, newest first. */
export function getLearnerRefundRequests(userId: number) {
  const rows = db
    .select({
      id: refundRequests.id,
      purchaseId: refundRequests.purchaseId,
      status: refundRequests.status,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      decisionNote: refundRequests.decisionNote,
      decidedAt: refundRequests.decidedAt,
      amountPaid: purchases.amountPaid,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      refundStatus: refunds.status,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(refundRequests.requestedAt), desc(refundRequests.id))
    .all();

  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.purchaseId)) return false;
    seen.add(row.purchaseId);
    return true;
  });
}

// ─── Emails ───
// There is no mail transport wired up yet, so built messages go to the
// server log.

export type LearnerEmail = { to: string; subject: string; body: string };

export function buildLearnerEmail(input: {
  kind: "requested" | "approved" | "declined" | "issued";
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
  note?: string | null;
}): LearnerEmail {
  const { kind, courseTitle, amount, note } = input;
  const subjects = {
    requested: `Refund requested — ${courseTitle}`,
    approved: `Refund approved — ${courseTitle}`,
    declined: `Refund request declined — ${courseTitle}`,
    issued: `Refund sent — ${courseTitle}`,
  };
  const lines = {
    requested: [
      `We have your refund request for "${courseTitle}".`,
      `The refund is for ${formatPrice(amount)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
    ],
    approved: [
      `We have approved your refund request for "${courseTitle}".`,
      `We are sending back ${formatPrice(amount)}, the amount you paid, and will email you once it is on its way.`,
      "Your access to the course has ended. If you buy it again, your progress will be waiting for you.",
    ],
    declined: [
      `We have declined your refund request for "${courseTitle}".`,
      "",
      `Our reason: ${note ?? ""}`,
      "",
      "You still have the course. If something changes, you can raise a new refund request from the course page.",
    ],
    issued: [
      `Your refund of ${formatPrice(amount)} for "${courseTitle}" has been sent.`,
      "It can take a few days to show up, depending on your bank.",
    ],
  };
  const extra =
    kind === "approved" && note ? ["", `A note from our team: ${note}`] : [];

  return {
    to: input.learnerEmail,
    subject: subjects[kind],
    body: [
      `Hi ${input.learnerName},`,
      "",
      ...lines[kind],
      ...extra,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function logEmail(email: LearnerEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
