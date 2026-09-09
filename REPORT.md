# Design write-up

## 1. Architecture

One process, five boundaries. The value is in where the lines are drawn, not in the number of services.

```
agent/discover ──┐                          ┌── artifact/compile ──▶ capabilities/*.json
   (LLM here,    │                          │
    only here)   ▼                          │
              GuardedSurface ────────────────┘        replay/executor ──▶ ReplayResult
              (policy + lease choke point)                  (no LLM, by invariant)
                     │
              Surface (the seam)
                     │
              surface/web/* ── Playwright ── the legacy app
```

**The seam is `Surface`** (`src/surface/types.ts`): `observe → Observation`, `act(Action)`, `resolve(TargetDescriptor)`. Above it nothing knows what a browser is. The rule I enforced to keep that honest: *nothing above the seam may name a CSS selector, an XPath, or a coordinate.* A capability refers to controls only by role + accessible name + structural context.

**Perception is accessibility-shaped, not DOM-shaped.** An injected script computes a role and an accessible name for every control, then hands up a flat node list. The name cascade is ARIA-first but its sixth rule is the one that matters here: for a form control with no label, take the text of the preceding `<td>` in the same row. That is how a 2003 intranet app labels its fields, and it is why `txtMemberId` is perceived as `"Member ID"` rather than as a de-camel-cased identifier. Cells carry table geometry (`table`, `row`, `col`) because in these apps **the grid is the data model**.

**Trade-offs I took:**

- *Text-first, screenshot on demand.* A frameset page is tens of thousands of tokens of nested tables; a semantic node list is ~60 lines. Pixels are also the least replayable way to identify a control. A screenshot tool exists for when layout carries meaning. Cost: a purely visual control (a canvas widget) would need the screenshot path, which the model must choose to use.
- *Single process.* The brief explicitly does not reward queue-building. The seams that would matter for splitting it are real, though: `LeaseStore` is the one interface that has to become a row in Postgres with a compare-and-set on `epoch` before the executor and the console can run as separate services.
- *Groq `gpt-oss-120b` for discovery.* Discovery is bounded and well-scaffolded — pre-parsed observation, fixed tool schema, capped loop — so a mid-tier model suffices, and cost is paid once per capability per app version across thousands of app instances. `LlmProvider` is four lines wide; an Anthropic implementation is also included and selected by `CUA_LLM`.

**The model never sees a parameter value.** It is told the capability takes a `memberId` and instructed to type the literal `{{memberId}}`; substitution happens in the instant before the keystroke. Three things fall out: the transcript contains no customer data or credentials, the recorded step is *already* parameterized (no fragile "find the literal, guess it was a variable" pass), and a password can be typed into a login form the model discovered without the model ever holding the password.

**Recording is mechanical, not model-reported.** Steps are built from what the surface actually did — the node actually resolved, the tier it resolved at, the state that actually changed. I do not ask the model to summarize its own run, because that is exactly what models get subtly wrong, and here it would be baked into a production automation.

## 2. Artifact schema

`src/artifact/schema.ts`. It is a **contract**, not a macro. A calling agent must be able to read it and know what the capability does, what typed arguments it needs, what it returns, what legitimate business answers it can come back with, and whether it is safe to run unattended. The step list is an implementation detail of that contract.

Four properties I designed for:

**It contains no code and no selectors.** Every assertion is a small declarative predicate (`textPresent`, `elementPresent`, `uriMatches`, `all`/`any`/`not`) evaluated against an `Observation`. So an artifact stays reviewable in a pull request, diffable, portable across surfaces, and structurally incapable of becoming an arbitrary-execution vector.

**It contains no data.** Typed values are bound to declared parameters. Anything left over is scanned, and a literal that looks sensitive is refused at compile time rather than stored.

**Business outcomes are first-class.** `outcomes[]` declares codes like `MEMBER_NOT_FOUND` with the condition that detects them — alongside the success condition, not buried in error handling.

**Data classification is on the contract**, per parameter and per output: `public | identifier | financial | pii | secret`. That single field decides what may appear in a log, a screenshot, or the artifact. Declaring it once beats guessing at forty log sites.

Targeting deserves its own note. A `TargetDescriptor` stores role, accessible name, frame path, enclosing section, neighbouring text, ordinal, *and* framework ids — all of them, ranked. Resolution walks them in order and reports which tier fired. Storing several weak signals and knowing which one you used beats storing one strong signal and finding out it rotted.

Two decisions I would defend hardest:

- **`labeledValue` with an optional `row`.** `{label: "Current Balance", row: "Savings"}` reads a grid by column header × row anchor. Without it, adjacency silently returns the *neighbouring column's* value on a header-per-column table — a wrong answer that looks like a right one. Both table shapes occur on the same screen in this app.
- **`secret-store` parameters.** Credentials are declared by env key, never by value, and are rejected outright if a caller tries to pass one. A compromised calling agent cannot inject a credential, and the tool schema does not even advertise that one exists.

Tenant reuse is `CapabilityOverlay`: a thin per-tenant patch (base URL, a renamed button, a skipped step) merged onto a shared base and re-validated. See §4.

## 3. Determinism & error handling

**Determinism** comes from four places: replay never calls a model (an invariant stated in the executor's header — no SDK is imported, and `verify` re-runs it N times to prove stability); targets resolve through a fixed 7-tier cascade; waits are DOM-quiescence-based rather than `networkidle` (which hangs on long-polling enterprise apps); and every step asserts a checkpoint instead of assuming its click worked.

**The resolution cascade** ranks strategies by how tightly each couples to something a vendor can change *without changing what the screen means*:

| Tier | Signal | Breaks when |
|---|---|---|
| 1–2 | role + accessible name (+ section) | the UI's meaning changes — a human operator also has to relearn it |
| 3–4 | normalized / substring name | — survives casing, padding, punctuation |
| 5 | neighbouring text | the row label changes |
| 6 | framework id (`ctl00$...`) | someone reorders a panel |
| 7 | ordinal position | anything moves |

First tier yielding **exactly one** match wins. Ambiguity is reported from the *earliest* tier that matched, because "two `View` buttons in Accounts" is what a human fixing the artifact needs to see. Replay records the tier used and compares it to the tier recorded: a step that used to resolve on name and now resolves on ordinal still passes, but `driftDetected` fires — the early warning while it still works.

**The ordering per step IS the error taxonomy:**

```
observe → declared OUTCOMES → declared RECOVERIES → guard → act → checkpoint (bounded retries) → onFailure
```

*Outcomes first*, because "no such member" is an **answer**. Check the checkpoint first and you report it as `checkpoint_failed: expected "Account Summary" not found`, and the calling agent has to string-match an error to learn whether the member exists. That ordering is the single decision that keeps `business_outcome` a real status.

*Recoveries second*, because an interstitial covering the page makes every assertion below it noise. Recoveries are bounded by `maxPerRun` — a recovery without a budget is an unbounded agent, and this is the only self-directed behaviour anywhere in replay.

*Guard third*: a precondition failure means the flow diverged **earlier**, which points the investigation at the right step.

**Assertions are retried; actions are never retried.** You cannot distinguish "the click was lost" from "the click worked and the confirmation is slow" by looking at the screen, so the safe reading of an ambiguous state is the one that does not act again. `click Post Transaction` is not idempotent. The one exception is authored, not inferred: a `Recovery` with `retryStep`, written by a human against a specific interstitial. **And even then** — live testing caught that clearing an interstitial often lands you exactly where the interrupted action was going, because the server already accepted it. So before repeating the action, replay re-checks the step's checkpoint. That bug would have double-submitted a transaction.

The **result contract** has four terminal statuses, not two: `success` (typed outputs), `business_outcome` (branch on `code`; exit 0), `escalated` (carries an intervention id), `failed` (a 12-class taxonomy where each class implies a different operator response, plus a `RETRYABLE` map so callers do not have to encode that themselves). `BUILT_IN_CONDITIONS` is a small exported table that upgrades a generic "we are lost" into `session_expired` / `permission_denied` / `surface_error` when the page says why — a safety net for undeclared conditions, never a substitute for declared outcomes, which always win.

Evidence: `events.jsonl` per run, redacted, sequenced, every event tagged with **who held the session lease**, plus masked screenshots and semantic snapshots at failures.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `Surface` + `TargetDescriptor`. A capability names controls in a vocabulary — role, accessible name, enclosing section — that a desktop accessibility API already speaks: UIA's `ControlType`/`Name`/ancestor chain and macOS AX's `AXRole`/`AXTitle` map onto the same 19-role union, which is small *on purpose*. A `DesktopSurface` implements `observe`/`act`/`resolve` over UIAutomation; the artifact schema, the executor, the predicate language, the policy gate and the escalation broker are untouched. `framePath` generalizes to a window/pane chain; `SurfaceLocation.uri` becomes an `app://` pseudo-URI. What genuinely does not port is anything that leaked a web assumption — which is why the seam forbids selectors and coordinates outright.

A legacy web app is not a different surface at all: it is the case I built against. Framesets, no test ids, no ARIA, ASP.NET ids, label-by-adjacent-cell, and grids-as-data are all handled today.

**Multi-tenant.** Hundreds of tenants running the same vendor product must not mean hundreds of independent recordings — you would have N unrelated flows that are nominally "the same capability", and no way to tell a tenant customization from a regression.

So: **one base capability per vendor product** (`app: {vendor, product, versionRange}`, `tenantId: null`), plus a thin `CapabilityOverlay` per tenant carrying only the deltas — a different base URL, a renamed button, an extra confirmation step some institutions enable, a skipped step. Overlays merge field-by-field into the target descriptor (change `name`, keep `section`) and the result is re-validated against the schema, so a bad override fails loudly instead of silently degrading a shared capability. An overlay is small enough to review in a PR.

**Drift detection falls out of the locator design for free.** Every replay reports the tier that resolved each step. A tenant whose steps consistently resolve one or two tiers weaker than recorded is drifting — the capability still passes, but it is now leaning on "the third button" instead of "the button labelled Search". Aggregated across tenants, that is a ranked worklist of which artifacts to re-record next, *before* anything breaks. `verify` adds a flakiness signal on top, and `stability` is persisted onto the artifact.

The scaling story I deliberately did **not** build: queues, workers, a tenant registry. The brief says designing so you *could* is valuable and prematurely building it is not. I agree.

## 5. Escalation & handoff

**Detecting stuck** is three distinct signals, not one: the discovery loop escalates when N consecutive actions produce no observable state change; the policy gate escalates when a risky action needs a human decision; replay escalates when a step's `onFailure` is `escalate`, when a recovery budget is exhausted, or when a target is ambiguous.

**Control transfer is a lease, not a pause flag** (`src/escalation/lease.ts`). This is the part I would push back on if someone called it over-engineered. A paused executor that is mid-`await` can still fire an action into a session a human is now driving — you get a click landing in the middle of someone's typing. So:

- exactly one holder, `automation` or `human`;
- every action passes `assertHolds()`, and `GuardedSurface` is the only route to the surface, so there is no path that skips it;
- **each transfer bumps an epoch**, and an in-flight action that captured epoch *N* and completes after a transfer to *N+1* is rejected rather than applied. A pause flag cannot give you that;
- every transition is recorded, so the evidence answers "who was in control when this member record was opened?" — in a regulated back office that audit line is the deliverable.

**The handoff sequence** (`broker.escalate`): capture evidence *first*, while automation still holds the lease — once a human starts clicking, the state that caused the escalation is gone; persist the intervention request with context an operator can act on; cede the lease; expose the session and attach the human-action recorder; wait; stop recording; hand back. On timeout the request is abandoned and the lease returns, because an unattended escalation must not hang a production run forever.

Live testing caught a real bug here: the executor *and* the broker both transferred the lease, so the broker's evidence capture ran after control had already left automation and failed with a lease violation. Two owners of a single-holder lease is not a race, it is a bug. The broker owns it now.

**Human actions are recorded, never replayed.** A page-side recorder reports clicks, inputs and navigations — and reports the *shape* of typed values (`"6 digits"`), never the values, computed in the page so the value never crosses the boundary.

**What I mocked, deliberately:** the operator console is a bare HTTP page — a list, a detail view with the masked screenshot and semantic snapshot, and Resume/Skip/Approve/Abort. It is not a co-browsing product. But the handoff *mechanism* is real: when headless, the console proxies actions into the same live page, so control transfer works without a visible window and is exercisable in CI.

## 6. Safety

**The allowlist is enforced at a choke point, not by convention.** `GuardedSurface` wraps the `Surface` and is the only one anything else is handed; discovery, replay and recovery all funnel through it. A guardrail you have to remember to invoke is one that eventually is not invoked. Every decision is logged — allow *and* deny — because an allowlist you cannot audit is not a control. A capability may **narrow** its own origins but never widen them (intersection, not union).

**Risky actions.** Classification is by *accessible name* (`post `, `transfer`, `confirm`, `authorize`, `delete`, …) because that is what a human reads before clicking and it survives markup changes. But the **artifact's own `risk` declaration is authoritative and is checked before the action is attempted**, because the dangerous case is a button labelled "OK" that posts a wire transfer. Heuristic as safety net; reviewed declaration as the control. During discovery a risky action is blocked and escalated; at replay an unapproved capability is blocked. An operator's approval is a **one-action** grant, revoked immediately after — a session-wide flag would mean one click authorises every risky action for the rest of the run.

**The approval gate carries the accountability.** A capability is always born `draft`, never promoted because the run that produced it went well. Read-only capabilities gate on demonstrated stability; capabilities with irreversible steps gate on human sign-off. Learning a new outcome resets to `draft`, because it changed the contract.

**Redaction is layered, and the layers cover each other's blind spots.** Classification-driven (the schema says `financial`, so it is `[REDACTED]` in logs but returned to the caller); pattern-driven (SSN, card, token, password); and **value-driven** — resolved secrets are registered with the redactor so a credential the *application itself* echoes back into its page text still gets scrubbed. Money is deliberately never redacted: a balance is the legitimate return value, and a redactor that eats it turns every successful run into a useless one.

**Limits and honest gaps.** Budgets on steps and duration — and the duration budget excludes model latency, because it exists to stop runaway automation hammering a bank system, not to time-box thinking. Screenshots mask sensitive *fields*, but a screenshot of a member record still contains that member's data; masking is field-level, not classification-level, and closing that properly means classifying regions, not elements. Identifier "tokenization" is a display convenience, not a security control. The allowlist is origin/path-based and would not stop a same-origin action the agent was never meant to take — the risky-name classifier is the backstop there, and it is a heuristic.

## 7. Cuts

**What I left out, and why.**

- *The second (irreversible) capability.* I ran discovery against the sub-account flow specifically to record a capability with a risky step. The guardrail behaved exactly right — blocked `Post New Sub-Account`, escalated with full context, accepted the operator's approval — but the free-tier model repeatedly lost the thread on the longer multi-field form. Rather than ship a flaky artifact or quietly hand-write one and imply it was discovered, I exercised the risky path through the production replay engine with a hand-authored fixture and **said so** in `evidence/INDEX.md`. The engine, gate, lease and broker are the real ones; only the artifact's provenance differs.
- *Desktop surface, multi-tenant plumbing, code generation.* Designed at the seam (§4), not built. The brief is explicit that building the infrastructure is not rewarded.
- *Assisted LLM fallback on replay failure.* Tempting and deliberately skipped — it puts a model back in the production path, which is the one thing this system exists to remove. If I added it, it would be bounded to a single step, policy-checked, and recorded as evidence, and I would still default it off.
- *A real operator console.* Bare by design; the mechanism is what I wanted to be real.

**What I would build next, in order.**

1. **Cross-tenant validation.** Stand up a second Meridian variant (renamed buttons, different base URL) and prove one base capability + one overlay drives both. The code path exists and is unit-tested; it has not been demonstrated end to end, and that is the highest-value gap.
2. **Region-level screenshot masking**, driven by the same sensitivity classification the logs already use.
3. **Drift telemetry aggregated across tenants** — turning the per-run tier signal into a ranked "re-record these next" worklist, which is the thing that makes record-once/replay-many survive contact with 20 apps × hundreds of tenants.
4. **A step-level `guard` on every step**, not just where synthesized. Cheap insurance against silent divergence.

**Bugs found by running it, not by reading it.** Worth listing because each one changed the design, and each was caught only because the system was driven against a live app: recovery re-submitting a non-idempotent action; two owners of the single-holder lease; the stuck-detector firing falsely because the digest hashed only a text prefix (a frameset's nav frame dominates it) and ignored field values (so filling a form looked like no progress); the compiler baking a member-specific account number into a success condition; a checkpoint capturing the operator's username; and the discovery result writing raw parameter values — including the password — into evidence, which the redactor could not catch because a credential under a field called `value` looks like any other string. That last one is now a structural fix at the boundary plus a regression test, not a smarter regex.
