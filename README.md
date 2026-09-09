# Computer-Use Automation System

An LLM works out how to complete a task inside a legacy UI that has no API. The successful run is recorded as a typed, versioned **capability**. That capability then replays deterministically, with **no model in the decision loop**, and returns typed data to the calling agent.

```
goal ──▶ discovery (LLM drives a real UI) ──▶ capability artifact ──▶ deterministic replay ──▶ typed outputs
                     │                                                        │
                     └──────────── human escalation ◀───────────────────────┘
```

The design write-up is in **[REPORT.md](REPORT.md)**. Run evidence is in **[evidence/INDEX.md](evidence/INDEX.md)**.

---

## Six decisions worth looking at

Each is one click away, and each is argued in REPORT.md.

**1. "No such member" is an answer, not an error.** Declared business outcomes are checked *before* step checkpoints, so a lookup for a nonexistent member returns `MEMBER_NOT_FOUND` with exit code 0 — not `checkpoint_failed: expected element not found`, which would force the calling agent to string-match an error message to find out whether the member exists. That ordering is the single most consequential decision in the engine. → [`replay/executor.ts`](src/replay/executor.ts) header, [REPORT §3](REPORT.md#3-determinism--error-handling)

**2. The locator tells you it's dying before it dies.** A descriptor stores seven ranked signals (role + accessible name → section → neighbouring text → framework id → ordinal position). Replay records *which tier actually fired* and compares it to the tier recorded. A step that used to resolve on name and now resolves on position still passes — and raises `driftDetected`. Drift detection falls out of the locator design rather than being a separate system. → [`surface/web/resolve.ts`](src/surface/web/resolve.ts)

**3. We never ship a detector we haven't watched fire.** You cannot learn an app's failure screens from one happy-path run. `cua learn-outcome` runs the flow with inputs that *should* fail and derives the detector from what the app actually rendered — after first running the happy path to establish a baseline, so page chrome present on every screen can never become a detector. → [`cli.ts`](src/cli.ts), `pickDistinctivePhrase`

**4. The model never sees a parameter value.** It is told the capability takes a `memberId` and instructed to type the literal `{{memberId}}`; substitution happens in the instant before the keystroke. So the transcript holds no customer data or credentials, the recorded step is *already* parameterized, and a password can be typed into a login form the model discovered without the model ever holding it. → [`agent/discover.ts`](src/agent/discover.ts) header

**5. Control transfer is a fenced lease, not a pause flag.** Every transfer bumps an epoch; an in-flight automation action that completes *after* a human took over is rejected rather than applied. A pause flag cannot give you that, and the failure it prevents is a click landing in the middle of an operator's typing. → [`escalation/lease.ts`](src/escalation/lease.ts)

**6. Assertions get retried. Actions never do.** You cannot tell "the click was lost" from "the click worked and confirmation is slow" by looking at the screen, so the safe reading is the one that does not act twice. Live testing then caught the sharper version: clearing an interstitial often lands you where the interrupted action was already going, because the server accepted it — so replay re-checks the checkpoint before repeating. That bug would have double-posted a transaction. → [REPORT §3](REPORT.md#3-determinism--error-handling)

If you only open two files, make them [`src/artifact/schema.ts`](src/artifact/schema.ts) (the contract) and [`src/replay/executor.ts`](src/replay/executor.ts) (the taxonomy).

---

## The target

`apps/meridian` is a deliberately hostile stand-in for a bank back-office app: a real `<frameset>`, table-based layout, ASP.NET-style ids (`ctl00$MainContent$txtMemberId`), **no test ids, no ARIA, no `<label for>`** — form fields are labelled only by the adjacent `<td>`. It also injects runtime faults on demand (interstitials, session expiry, HTTP 500, latency), which is what makes the error-path evidence reproducible rather than anecdotal.

All member data is synthetic. No real credentials or PII.

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
```

Replay needs **no API key**. Discovery needs one:

```bash
cp .env.example .env      # then add ONE of:
#   GROQ_API_KEY=...      (used for the committed evidence; free tier works)
#   ANTHROPIC_API_KEY=... (set CUA_LLM=anthropic to force it)
```

## Demo path

**Terminal 1 — the legacy app:**

```bash
npm run app
# Meridian Core listening on http://127.0.0.1:8099/meridian
```

**Terminal 2 — discover, then replay:**

```bash
export MERIDIAN_USER=demo.operator MERIDIAN_PASSWORD='Passw0rd!demo'

# 1. The model drives the real UI and records what worked.
npm run cua -- discover \
  --goal "Sign on as the operator, look up member {{memberId}}, then report the account number, current balance and status of that member's Savings account." \
  --target http://127.0.0.1:8099/meridian/login \
  --id meridian.member.savings-balance \
  --param memberId=100482 \
  --secret operatorId=MERIDIAN_USER --secret operatorPassword=MERIDIAN_PASSWORD

# 2. Replay it. No model. Note the DIFFERENT member — the recording generalized.
npm run cua -- replay meridian.member.savings-balance --input memberId=100482
npm run cua -- replay meridian.member.savings-balance --input memberId=100517
```

```
success (3 outputs, 5 steps, 526ms)
  savingsAccountNumber: "SAV-0100517-01"
  savingsCurrentBalance: 132.4          ← a number, not "$132.40"
  savingsStatus: "Active"
```

**The interesting cases:**

```bash
# A legitimate business answer, NOT an error. Exit code 0.
npm run cua -- replay meridian.member.savings-balance --input memberId=999999
#   business_outcome MEMBER_NOT_FOUND: No member exists with the supplied id.

# A permission denial, also an expected outcome.
npm run cua -- replay meridian.member.savings-balance --input memberId=100999
#   business_outcome MEMBER_RESTRICTED

# A caller bug. Rejected before the browser opens.
npm run cua -- replay meridian.member.savings-balance --input memberId=12345
#   failed [invalid_input] ... does not match required pattern /\d{6}/

# Inject a server error mid-flow -> classified surface_error, not "checkpoint failed".
curl -s -XPOST -H 'content-type: application/json' -H 'x-fault-session: *' \
     -d '{"error500":true,"afterRequests":3}' http://127.0.0.1:8099/meridian/_faults
npm run cua -- replay meridian.member.savings-balance --input memberId=100482
```

## Human-in-the-loop

A blocked run cedes the **same live browser session** to a person, records what they do, and takes it back.

```bash
npm run cua -- replay meridian.member.savings-balance --input memberId=100482 --console --headed
# operator console: http://127.0.0.1:7788
```

The console shows why the run stopped, a masked screenshot, the semantic snapshot, and Resume / Skip / Approve / Abort. When headless, it also **proxies actions into the same page**, so control transfer is real without a visible window.

For non-interactive runs (CI, the committed evidence), `CUA_AUTO_RESOLVE_ESCALATIONS=approve|resume|skip|abort` auto-answers. It is a test affordance and is recorded as such in the intervention record.

```bash
CUA_AUTO_RESOLVE_ESCALATIONS=approve npx tsx scripts/smoke-replay.ts memberId=100482 risky=1
#   automation -> human (risky_action_blocked) -> human -> automation (approve)
```

## Everything else

```bash
npm run cua -- catalog list          # what a calling agent sees: typed args, returns, outcomes
npm run cua -- catalog export        # tool definitions an agent framework can load
npm run cua -- approve <id>          # human sign-off; gates unattended risky replay
npm run cua -- verify <id> --input memberId=100482 --runs 5   # flakiness signal
npm run cua -- learn-outcome <id> --input memberId=999999 \
    --code MEMBER_NOT_FOUND --description "..."               # see below

npm test          # 165 tests
npm run typecheck
```

### `learn-outcome` is worth a look

You cannot know an app's failure screens from one happy-path run. `learn-outcome` runs the flow with inputs that *should* fail, and derives the detector from what the application actually rendered — after first running the happy path to establish a baseline, so app chrome present on every screen can never become a detector.

The rule it enforces: **we never ship a detector we have not watched fire, and never one we have also watched fire on the happy path.** Learning an outcome bumps the version and resets `status` to `draft`, because it changed the contract.

## Layout

```
apps/meridian/          the hostile legacy target + fault injection
src/surface/            THE SEAM: perceive/act, surface-independent
  types.ts              Surface, Observation, UiNode, TargetDescriptor
  web/                  the only Playwright-aware code in the repo
    accessible-name.ts  role + accessible-name cascade (runs in the page)
    perceive.ts         semantic snapshot incl. table geometry
    resolve.ts          descriptor -> element, 7-tier cascade  ← load-bearing
  guarded.ts            the policy/lease choke point
src/artifact/           schema.ts (the contract)  compile.ts (run -> artifact)
src/replay/             executor.ts (no model, by invariant)  conditions  extract
src/policy/             allowlist, risk classification, redaction
src/escalation/         lease.ts (control transfer)  broker  operator console
src/agent/              the discovery loop; the only place a model is called
capabilities/           the artifacts, as reviewable JSON
evidence/               nine real runs
```

## Honest notes

- The discovery run is genuinely non-deterministic. The committed artifact came from a run that succeeded in 5 steps; earlier attempts got stuck and escalated, which the evidence for the stuck-detector reflects. Every bug that caused a *false* stuck detection was fixed rather than papered over — see REPORT §7.
- The free-tier model rate-limits at 8k tokens/minute, so discovery backs off and can take a few minutes. Replay is unaffected and runs in ~500ms.
- `scripts/smoke-replay.ts` is a hand-authored fixture used to exercise the risky-action and escalation paths, which the discovered read-only capability cannot. It is not part of the demo path; see `evidence/INDEX.md`.
