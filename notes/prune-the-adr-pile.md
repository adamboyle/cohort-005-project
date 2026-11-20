# prune-the-adr-pile: my work vs Matt's

Mine: `my/prune-the-adr-pile` (2bd6116). Matt's: `cf2dbbc` on `live-run-through`.

| Topic | Yours | Matt's |
| --- | --- | --- |
| 0001–0006, 0009 (pass the 3-part test) | **Kept** | **Kept**. Same |
| 0007 lucide-react | **Deleted** | **Deleted**. Same |
| 0011 Prettier | **Deleted** | **Deleted**. Same |
| 0010 refund emails to server log | **Deleted**, no Postmark ADR | **Deleted**, no Postmark ADR. Same |
| 0008 ip-api lookup | **Deprecated**: kept the old ADR with a `status: deprecated` header and a note | **Deleted**, then wrote a **new ADR 0012** for the decision now in the code. Different |
| The decision the code actually makes now (full price when the country is unknown) | Only a **one-line note** inside the deprecated 0008 | **ADR 0012**, with ip-api as a tried-and-dropped Considered Option. Missing on my side |
| Why ip-api was dropped | **Inferred**: "no page should wait on a network call" | **Stated**: pages **stalled at peak**, plus plain HTTP and 45 requests a minute. Same idea, Matt's is more concrete |
| Consequence of the new decision | **Not recorded** | A Student who qualifies for a discount but isn't behind Cloudflare **pays full price**. Missing on my side |
| 0009 wording | **Unchanged** ("learner", "Staff") | **Updated to glossary terms**: Student, and "Platform Admins and the owning Instructor" instead of Staff. Missing on my side |
| Renumbering | **None**, gaps kept | **None**, gaps kept, new ADR takes 0012. Same |

## What to take from it

**What matched.** All seven keeps and all three plain deletes were the same, as was the call not to renumber. Applying the three-part test gave the same answers.

**Different but defensible: 0008.** We both wanted to keep the ip-api history. I kept it by deprecating the old ADR. Matt deleted it and moved that history into a new ADR as a Considered Option ("we did this, and dropped it"). His way is better: a reader looking for "why do we charge full price?" finds an ADR that records the current decision. A deprecated ADR records the opposite decision and makes them read it backwards. Deprecate when an ADR is replaced by nothing. When the code made a new decision, write that decision up and fold the old one in as a rejected option.

**What I missed.**
- The new decision itself. Charging full price when the country is unknown passes the three-part test on its own. It overcharges exactly the people PPP is for, so someone will try to "fix" it. It deserved its own ADR, not a footnote.
- Glossary drift in the ADRs I kept. "Keep unchanged" was too quick: 0009 still said "learner" and "Staff", which the glossary lists under _Avoid_. Matt checked the code (`getAccess`: admins plus the owning Instructor) and wrote the precise terms. When pruning, also check that the ADRs you keep use the glossary's words.
