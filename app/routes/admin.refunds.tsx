import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AlertTriangle, ReceiptText } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import {
  courses,
  purchases,
  refundRequests,
  refunds,
  RefundStatus,
  UserRole,
  users,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  buildLearnerEmail,
  declineRefundRequest,
  getSupportQueues,
  logEmail,
  markRefundFailed,
  markRefundIssued,
  MIN_DECLINE_NOTE_LENGTH,
  REFUND_COMPLETION_LIMIT,
  REFUND_WATCH_LIMIT_SECONDS,
  RefundError,
  type RefundFacts,
} from "~/lib/refunds.server";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    note: z
      .string()
      .trim()
      .min(
        MIN_DECLINE_NOTE_LENGTH,
        `Tell the learner why, in at least ${MIN_DECLINE_NOTE_LENGTH} characters.`
      )
      .max(1000),
  }),
  z.object({
    intent: z.literal("mark-issued"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-failed"),
    refundId: z.coerce.number().int(),
    note: z.string().trim().max(1000).optional(),
  }),
]);

async function requireSupport(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can review refunds.", { status: 403 });
  }

  return currentUser;
}

function getLearnerAndCourse(purchaseId: number) {
  return db
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      amount: purchases.amountPaid,
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.id, purchaseId))
    .get()!;
}

function getPurchaseIdForRefund(refundId: number) {
  return db
    .select({ purchaseId: refundRequests.purchaseId })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .where(eq(refunds.id, refundId))
    .get()!.purchaseId;
}

export function meta() {
  return [{ title: "Refunds — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireSupport(request);
  return getSupportQueues();
}

export async function action({ request }: Route.ActionArgs) {
  const support = await requireSupport(request);
  const parsed = parseFormData(await request.formData(), refundActionSchema);

  if (!parsed.success) {
    const message = Object.values(parsed.errors)[0] ?? "Invalid request.";
    return data({ error: String(message) }, { status: 400 });
  }

  try {
    switch (parsed.data.intent) {
      case "approve": {
        const { purchase, voidedSeats } = approveRefundRequest(
          parsed.data.refundRequestId,
          support.id,
          parsed.data.note
        );
        logEmail(
          buildLearnerEmail({
            kind: "approved",
            ...getLearnerAndCourse(purchase.id),
            note: parsed.data.note,
          })
        );
        return {
          message:
            voidedSeats > 0
              ? `Approved. ${voidedSeats} unclaimed seat${voidedSeats === 1 ? "" : "s"} voided.`
              : "Approved. The refund is now pending.",
        };
      }
      case "decline": {
        const { purchase } = declineRefundRequest(
          parsed.data.refundRequestId,
          support.id,
          parsed.data.note
        );
        logEmail(
          buildLearnerEmail({
            kind: "declined",
            ...getLearnerAndCourse(purchase.id),
            note: parsed.data.note,
          })
        );
        return { message: "Declined. The learner keeps the course." };
      }
      case "mark-issued": {
        markRefundIssued(parsed.data.refundId, support.id);
        logEmail(
          buildLearnerEmail({
            kind: "issued",
            ...getLearnerAndCourse(getPurchaseIdForRefund(parsed.data.refundId)),
          })
        );
        return { message: "Marked as issued." };
      }
      case "mark-failed": {
        markRefundFailed(parsed.data.refundId, support.id, parsed.data.note);
        return { message: "Marked as failed. Try again when you can." };
      }
    }
  } catch (error) {
    if (error instanceof RefundError) {
      return data({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

type ActionResult = { message?: string; error?: string };

function useActionToast(fetcher: ReturnType<typeof useFetcher<ActionResult>>) {
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) toast.error(fetcher.data.error);
    else if (fetcher.data.message) toast.success(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { openRequests, refundsAwaitingConfirmation } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Decide open refund requests, then confirm when the money has gone
          back.
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">
          Open refund requests{" "}
          <span className="text-muted-foreground">({openRequests.length})</span>
        </h2>
        {openRequests.length === 0 ? (
          <EmptyQueue text="No refund requests are waiting on a decision." />
        ) : (
          <div className="space-y-4">
            {openRequests.map((request) => (
              <OpenRequestCard key={request.id} request={request} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Refunds to confirm{" "}
          <span className="text-muted-foreground">
            ({refundsAwaitingConfirmation.length})
          </span>
        </h2>
        {refundsAwaitingConfirmation.length === 0 ? (
          <EmptyQueue text="Every approved refund has been issued." />
        ) : (
          <div className="space-y-4">
            {refundsAwaitingConfirmation.map((refund) => (
              <RefundCard key={refund.id} refund={refund} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyQueue({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
        <ReceiptText className="size-5" />
        {text}
      </CardContent>
    </Card>
  );
}

type OpenRequest = Route.ComponentProps["loaderData"]["openRequests"][number];

function OpenRequestCard({ request }: { request: OpenRequest }) {
  const fetcher = useFetcher<ActionResult>();
  const [note, setNote] = useState("");
  useActionToast(fetcher);
  const busy = fetcher.state !== "idle";
  const canDecline = note.trim().length >= MIN_DECLINE_NOTE_LENGTH;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">
              {request.learnerName}{" "}
              <span className="font-normal text-muted-foreground">
                · {request.learnerEmail}
              </span>
            </p>
            <Link
              to={`/courses/${request.courseSlug}`}
              className="text-sm hover:underline"
            >
              {request.courseTitle}
            </Link>
          </div>
          <p className="text-lg font-semibold">
            {formatPrice(request.amountPaid)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <blockquote className="border-l-2 pl-3 text-sm">
          {request.reason}
        </blockquote>
        <FactsRow facts={request.facts} requestedAt={request.requestedAt} />

        <fetcher.Form method="post" className="space-y-3">
          <input type="hidden" name="refundRequestId" value={request.id} />
          <Textarea
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note to the learner — required to decline, optional to approve"
            rows={2}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="intent" value="approve" disabled={busy}>
              Approve refund
            </Button>
            <Button
              type="submit"
              name="intent"
              value="decline"
              variant="outline"
              disabled={busy || !canDecline}
              title={
                canDecline
                  ? undefined
                  : "Write a note so the learner knows why"
              }
            >
              Decline
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Approving ends the learner's access now. Their progress is kept in
            case they buy again.
          </p>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

function FactsRow({
  facts,
  requestedAt,
}: {
  facts: RefundFacts;
  requestedAt: string;
}) {
  const hours = facts.secondsWatched / 3600;
  const completion =
    facts.totalLessons > 0 ? facts.completedLessons / facts.totalLessons : 0;
  const overWatch = facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS;
  const overCompletion = completion >= REFUND_COMPLETION_LIMIT;

  return (
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      <Fact
        label="Since purchase"
        value={`${facts.daysSincePurchase} day${facts.daysSincePurchase === 1 ? "" : "s"}`}
        warn={!facts.withinWindow}
      />
      <Fact
        label="Watched"
        value={`${hours.toFixed(1)} h`}
        warn={overWatch}
      />
      <Fact
        label="Lessons complete"
        value={`${facts.completedLessons} of ${facts.totalLessons} (${Math.round(completion * 100)}%)`}
        warn={overCompletion}
      />
      <Fact
        label="Requested"
        value={new Date(requestedAt).toLocaleDateString()}
      />
    </dl>
  );
}

function Fact({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          warn ? "font-medium text-amber-700 dark:text-amber-400" : "font-medium"
        }
      >
        {value}
        {warn && <span className="sr-only"> (past the Refund Window limit)</span>}
      </dd>
    </div>
  );
}

type AwaitingRefund =
  Route.ComponentProps["loaderData"]["refundsAwaitingConfirmation"][number];

function RefundCard({ refund }: { refund: AwaitingRefund }) {
  const fetcher = useFetcher<ActionResult>();
  const [note, setNote] = useState("");
  useActionToast(fetcher);
  const busy = fetcher.state !== "idle";
  const failed = refund.status === RefundStatus.Failed;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">
              {refund.learnerName}{" "}
              <span className="font-normal text-muted-foreground">
                · {refund.learnerEmail}
              </span>
            </p>
            <p className="text-sm">{refund.courseTitle}</p>
            <p className="text-xs text-muted-foreground">
              Approved {new Date(refund.approvedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">{formatPrice(refund.amount)}</p>
            <span
              className={
                failed
                  ? "rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
                  : "rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
              }
            >
              {failed ? "Failed" : "Pending"}
            </span>
          </div>
        </div>
        {failed && refund.failureNote && (
          <p className="rounded-md bg-muted p-2 text-sm">
            <span className="font-medium">Why it failed: </span>
            {refund.failureNote}
          </p>
        )}
        <fetcher.Form method="post" className="space-y-3">
          <input type="hidden" name="refundId" value={refund.id} />
          {!failed && (
            <Textarea
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why it failed (optional, only used if you mark it failed)"
              rows={2}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              name="intent"
              value="mark-issued"
              disabled={busy}
            >
              {failed ? "Retry succeeded — mark issued" : "Mark issued"}
            </Button>
            {!failed && (
              <Button
                type="submit"
                name="intent"
                value="mark-failed"
                variant="outline"
                disabled={busy}
              >
                Mark failed
              </Button>
            )}
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can review refunds.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
