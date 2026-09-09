# Evidence

Every run writes `events.jsonl` (a redacted, sequenced log where each event records **who held the session lease** at that moment), `result.json` (the structured result contract), and `captures/` (masked screenshots + semantic snapshots taken at failures and escalations).

All nine runs below are real, against the live `apps/meridian` target. Nothing here is hand-written.

| # | Run | Status | What it demonstrates |
|---|-----|--------|----------------------|
| 01 | `01-discovery-success` | `success` | **The LLM-driven discovery run.** 5 steps, 9 model calls, `groq/openai/gpt-oss-120b`. Produced `capabilities/meridian.member.savings-balance@1.0.0.json`. |
| 02 | `02-replay-risky-action-approved` | `success` | A step declared **risky** in the artifact, replayed **unapproved** → blocked → escalated → operator approved → action performed. Lease transitions recorded. |
| 03 | `03-replay-success` | `success` | Deterministic replay, no model. Typed outputs: `balance: 4812.55` as a **number**, not `"$4,812.55"`. |
| 04 | `04-replay-different-member` | `success` | Same artifact, **a member it was never recorded against** (`100517` → `132.4`). This is the proof that the recording generalized rather than memorized. |
| 05 | `05-replay-business-outcome-not-found` | `business_outcome` | `MEMBER_NOT_FOUND`. **Exit code 0** — a legitimate answer, not a crash. |
| 06 | `06-replay-business-outcome-restricted` | `business_outcome` | `MEMBER_RESTRICTED` — a permission denial reported as an expected outcome the caller can branch on. |
| 07 | `07-replay-invalid-input` | `failed / invalid_input` | Caller passed a 5-digit id. Rejected against the declared `pattern` **before the browser was opened** — 1 log line, no session cost. |
| 08 | `08-replay-injected-server-error` | `failed / surface_error` | Injected HTTP 500 mid-flow. Classified `surface_error` (retryable) rather than a generic checkpoint failure, with a masked screenshot at the point of failure. |
| 09 | `09-escalation-human-takeover` | `escalated` | Checkpoint failed → evidence captured → lease ceded to `human` → operator drove the **same live session** → handed back → run resumed and reported. |

## Things worth opening

**Redaction is real, not decorative.** In `03/result.json` the caller's account number is returned but the persisted log shows `[REDACTED:accountNumber]` — the value is classified `financial` in the artifact, so it reaches the caller and never the log. In `01/events.jsonl` the model's *own reasoning text* is redacted the same way.

**No credentials anywhere.** `grep -r 'Passw0rd\|demo.operator' evidence capabilities` returns nothing. The model was never given the password: it typed the literal placeholder `{{operatorPassword}}`, and the value was substituted in the instant before the keystroke.

**Who was in control.** `09/events.jsonl` carries a `controller` field on every event, flipping `automation → human → automation` across the handoff, plus `control.transfer` events with lease epochs.

## Reproducing

`03`–`08` need no API key — replay never calls a model:

```bash
npm run app                       # terminal 1
npm run cua -- replay meridian.member.savings-balance --input memberId=100482
```

Reproducing `01` needs `GROQ_API_KEY` or `ANTHROPIC_API_KEY`. See the README.

## One caveat, stated plainly

Runs `02` and `09` use `scripts/smoke-replay.ts`, a hand-authored capability fixture, rather than the LLM-discovered artifact. The discovered read-only capability has no irreversible step to block and no step configured to escalate, so it cannot exercise those two paths. The engine, guardrail, lease and broker exercised are exactly the production ones — only the artifact differs. I would rather say that than imply the discovered capability demonstrated something it did not.
