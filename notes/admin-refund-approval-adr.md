# admin-refund-approval-adr: my work vs Matt's

Lesson: Writing an ADR. My work is a grilling session (glossary + 2 ADRs, design only). Matt's solution is commit `5bbfdea` on `live-run-through`.

| Topic | Yours | Matt's |
|---|---|---|
| **Keeping Progress** | ADR 0001: **hide, don't delete** | **Same.** His ADR 0001 also names watch history, quiz attempts, comments and rating. |
| **When access ends** | ADR 0002: when the Refund is **Issued** | **Opposite:** at **approval**. He rejected "at Issued" because a Failed Refund would leave the buyer with both the course and an approved Refund Request, and it ties the course to money movement. |
| **Team purchases** | Seats **stop working at Issued** | ADR 0003: **all-or-nothing**, and Unclaimed Seats **freeze while a request is Open**, so no one can claim a Seat mid-request. **Missed** the freeze. |
| **Which Purchase a refund belongs to** | **Not covered** | ADR 0004: a learner can hold the course through an Individual Purchase **and** a Claimed Seat, so approval mustn't remove their place. The old code also refunded the **newest** Purchase, which was a bug. **Missed.** |
| **Roles** | **Admin**, **Team Manager**, Learner, Instructor | **Platform Admin**, **Team Admin**. Same fix for "admin means two things", different names. |
| **Other terms** | Progress, Refund Eligibility, Decided Refund Request | Purchase, Individual Purchase, Team Licence, Unclaimed and Claimed Seat |
| **Code** | **Design only** | Built the `/admin/refunds` screen, refund logic with tests, and a migration |

## What to take from it

- **Matched:** the core decision, keeping Progress rather than deleting it, and spotting that "admin" was overloaded.
- **Different but defensible:** when access ends. You put the Learner's money first; Matt kept access separate from money movement and avoided a Learner holding both the course and an approved Refund.
- **Missed:** both gaps are edge cases about *Purchases*. One is Seats being claimed between the request and the decision. The other is a learner who holds the same course two ways. Next time, push on "what else grants this course?" and on any "takes the latest one" detail in the code.
