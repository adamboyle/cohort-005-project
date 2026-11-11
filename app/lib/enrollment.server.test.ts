import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { enroll, endEnrollment, isEnrolled } from "./enrollment.server";

describe("enrollment", () => {
  let base: ReturnType<typeof seedBaseData>;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("enrolls a learner who has never taken the course", () => {
    expect(isEnrolled(base.user.id, base.course.id)).toBe(false);
    enroll(base.user.id, base.course.id);
    expect(isEnrolled(base.user.id, base.course.id)).toBe(true);
  });

  it("stops counting a learner as enrolled once their enrollment ends", () => {
    enroll(base.user.id, base.course.id);
    endEnrollment(base.user.id, base.course.id);
    expect(isEnrolled(base.user.id, base.course.id)).toBe(false);
  });

  it("reopens the same enrollment when a learner comes back", () => {
    const first = enroll(base.user.id, base.course.id);
    endEnrollment(base.user.id, base.course.id);

    const second = enroll(base.user.id, base.course.id);

    expect(second.id).toBe(first.id);
    expect(second.enrolledAt).toBe(first.enrolledAt);
    expect(isEnrolled(base.user.id, base.course.id)).toBe(true);
  });

  it("refuses to enroll a learner twice", () => {
    enroll(base.user.id, base.course.id);
    expect(() => enroll(base.user.id, base.course.id)).toThrow(
      /already enrolled/
    );
  });

  it("keeps another learner's enrollment when one ends", () => {
    const other = testDb
      .insert(schema.users)
      .values({
        name: "Other",
        email: "other@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
    enroll(base.user.id, base.course.id);
    enroll(other.id, base.course.id);

    endEnrollment(base.user.id, base.course.id);

    expect(isEnrolled(other.id, base.course.id)).toBe(true);
  });
});
