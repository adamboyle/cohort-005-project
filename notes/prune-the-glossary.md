# prune-the-glossary: my work vs Matt's

Lesson: prune a deliberately bloated glossary. My work is a grilling session that edited only `GLOSSARY.md`. Matt's solution is commit `c196393` on `live-run-through`.

| Topic | Yours | Matt's |
|---|---|---|
| **Code and UI terms** (Button, Loader, Slug, cwd, columns…) | **Removed all 9** | **Same.** Removed all of them. |
| **Watch Limit** | **Dropped the number**, said the Learner is never offered a Refund past it | **Same idea:** no number, "past which a Student can no longer get a Refund" |
| **Watched** | **Kept**, moved to Refunds | **Kept**, moved to the Enrollment section |
| **What we call the person** | **Learner**, avoid Student | **Opposite:** **Student**, avoid Learner. It matches the code (`UserRole.Student`). |
| **What we call their access** | **Place**, avoid Enrollment | **Opposite:** **Enrollment**, avoid "Place on a course". It matches the code (`enrollments` table). |
| **Lapsed** | A Learner on the roster with **no Place** | Lost their Enrollment **but still has progress**. That's why they still show up on the roster. |
| **Code and ADRs** | **Untouched.** Flagged the mismatch for later. | **Renamed to match:** code comments, tests and ADRs 0002 and 0004 now say Student and Enrollment. |
| **Seat** | Reworded "place" to "**spot**" to avoid clashing with Place | Kept "one place". No clash, because Place isn't a term in his glossary. |

## What to take from it

- **Matched:** the actual pruning. You removed exactly the right terms, and you also caught that Watch Limit's number had drifted from the code.
- **Different but defensible:** the names. "Learner" and "Place" are arguably nicer words. Matt's reason for his choice: **pick the words the code already uses**, then make every other document agree. That way the glossary, the code, the tests and the ADRs all speak one language.
- **Missed:** following through. You chose names that disagree with the code and left the code, tests and ADRs as they were, so the drift moved instead of disappearing. Next time, when choosing between two names, ask "which one does the code use?" first. If the glossary wins anyway, rename the code in the same piece of work.
