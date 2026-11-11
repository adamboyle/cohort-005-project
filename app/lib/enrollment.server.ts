import { and, eq, isNull } from "drizzle-orm";
import { db } from "~/db";
import { enrollments } from "~/db/schema";

// An enrollment ends when an Approved Refund Request takes the course away.
// The row is kept and reopened if the learner comes back — see ADR-0001.

/** Only enrollments that haven't ended give access. */
export const isActiveEnrollment = () => isNull(enrollments.endedAt);

function findEnrollment(userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export function findActiveEnrollment(userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        isActiveEnrollment()
      )
    )
    .get();
}

export function isEnrolled(userId: number, courseId: number) {
  return !!findActiveEnrollment(userId, courseId);
}

/** Enrolls the learner, reopening an ended enrollment if they had one. */
export function enroll(userId: number, courseId: number) {
  const existing = findEnrollment(userId, courseId);

  if (!existing) {
    return db
      .insert(enrollments)
      .values({ userId, courseId })
      .returning()
      .get();
  }

  if (existing.endedAt === null) {
    throw new Error("User is already enrolled in this course");
  }

  return db
    .update(enrollments)
    .set({ endedAt: null })
    .where(eq(enrollments.id, existing.id))
    .returning()
    .get();
}

export function endEnrollment(
  userId: number,
  courseId: number,
  endedAt = new Date().toISOString()
) {
  db.update(enrollments)
    .set({ endedAt })
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
        isActiveEnrollment()
      )
    )
    .run();
}
