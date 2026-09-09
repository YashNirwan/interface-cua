/**
 * The capability artifact: what a discovery run produces and what deterministic
 * replay consumes.
 *
 * Design intent (defended in REPORT.md §2):
 *
 * 1. It is a *contract*, not a macro. A calling agent must be able to read this
 *    file and know what the capability does, what typed arguments it needs,
 *    what it returns, what legitimate business answers it can come back with,
 *    and whether it is safe to run unattended. The step list is an
 *    implementation detail of that contract.
 *
 * 2. It contains no code and no selectors. Every condition is expressed in a
 *    small declarative predicate language evaluated against an Observation, so
 *    the artifact stays reviewable by a human, diffable in git, portable across
 *    surfaces, and impossible to turn into an arbitrary-execution vector.
 *
 * 3. It never contains data. Values typed during discovery are either bound to
 *    declared parameters or, if they look sensitive, promoted into required
 *    parameters. Nothing regulated is ever serialized here.
 *
 * 4. Business outcomes are first-class. "No such member" is a documented return
 *    value of the capability, declared alongside the success condition — not an
 *    exception the caller has to string-match.
 */

import { z } from 'zod';
import { UI_ROLES } from '../surface/types.js';

export const SCHEMA_VERSION = 'cua.capability/v1' as const;

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export const zRole = z.enum(UI_ROLES);

export const zTargetDescriptor = z.object({
  role: zRole,
  /** Accessible name. May contain {{param}} when nameMatch is 'template'. */
  name: z.string(),
  nameMatch: z.enum(['exact', 'normalized', 'contains', 'template']).default('exact'),
  /** Frame/window chain, outermost first. [] for a top-level document. */
  framePath: z.array(z.string()).default([]),
  /** Enclosing legend/heading/caption/dialog title. Primary disambiguator. */
  section: z.string().optional(),
  /** Index among otherwise-identical matches. Positional; only consulted last. */
  ordinal: z.number().int().min(0).optional(),
  /** Neighbouring text — the real label in table-layout legacy apps. */
  textNear: z.array(z.string()).optional(),
  /** Framework-generated identifiers. Lowest-priority tier; may rot freely. */
  hint: z.record(z.string()).optional(),
  /** Why this control, in the recorder's words. For human reviewers. */
  note: z.string().optional(),
});
export type TargetDescriptorSpec = z.infer<typeof zTargetDescriptor>;

// ---------------------------------------------------------------------------
// Predicate language
// ---------------------------------------------------------------------------

/**
 * Conditions are evaluated against a single Observation. Strings may contain
 * {{param}} placeholders, which are substituted with the *invocation's* inputs
 * before evaluation — that is what lets one recorded checkpoint ("Member 100482
 * — Profile") assert correctly for any member id.
 */
export type Condition =
  | { textPresent: string }
  | { textAbsent: string }
  | { textMatches: string }
  | { elementPresent: TargetDescriptorSpec }
  | { elementAbsent: TargetDescriptorSpec }
  | { uriMatches: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

// Typed with an `unknown` input so the recursive union's *input* type (where
// defaulted fields like nameMatch are optional) is not required to match the
// *output* type (where they are filled in). Without this the declaration is
// variance-broken and zod cannot type a self-referential schema with defaults.
export const zCondition: z.ZodType<Condition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z.object({ textPresent: z.string() }).strict(),
    z.object({ textAbsent: z.string() }).strict(),
    z.object({ textMatches: z.string() }).strict(),
    z.object({ elementPresent: zTargetDescriptor }).strict(),
    z.object({ elementAbsent: zTargetDescriptor }).strict(),
    z.object({ uriMatches: z.string() }).strict(),
    z.object({ all: z.array(zCondition) }).strict(),
    z.object({ any: z.array(zCondition) }).strict(),
    z.object({ not: zCondition }).strict(),
  ]),
);

// ---------------------------------------------------------------------------
// Typed I/O
// ---------------------------------------------------------------------------

export const zValueType = z.enum(['string', 'number', 'money', 'date', 'boolean', 'enum']);
export type ValueType = z.infer<typeof zValueType>;

/**
 * Data classification. This is the hook the whole redaction story hangs off:
 * it decides what may appear in a log line, a screenshot, or an artifact, and
 * it is declared on the *contract* rather than guessed at each log site.
 *
 *   public     - safe to log and persist (a product name, a status)
 *   identifier - log only in tokenized form (a member id)
 *   financial  - regulated; never logged raw, returned to the caller only
 *   pii        - regulated; never logged raw, returned to the caller only
 *   secret     - never leaves the secret store; never returned, never logged
 */
export const zSensitivity = z.enum(['public', 'identifier', 'financial', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof zSensitivity>;

export const zParamSpec = z.object({
  type: zValueType,
  description: z.string(),
  required: z.boolean().default(true),
  /** Validated before the browser is even opened. Cheap, and blocks injection. */
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  sensitivity: zSensitivity.default('public'),
  /**
   * 'caller'       - the invoking agent supplies it
   * 'secret-store' - resolved at replay from the operator's secret store by
   *                  `secretKey`. Credentials take this path so that a login
   *                  step can be recorded without the artifact ever containing,
   *                  or the caller ever seeing, a password.
   */
  source: z.enum(['caller', 'secret-store']).default('caller'),
  secretKey: z.string().optional(),
  /** Only permitted for public/identifier params — enforced in refine below. */
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof zParamSpec>;

/** Where an output value is read from. */
export const zExtractionSource = z.union([
  /** The accessible name or value of one control. */
  z.object({ element: zTargetDescriptor }).strict(),
  /**
   * The value sitting next to a label. This is the single most durable
   * extraction primitive in legacy enterprise UIs, where data lives in
   * `<td>Balance:</td><td>$4,812.55</td>` with no ids, no classes, and no
   * semantic markup of any kind.
   */
  z
    .object({
      labeledValue: z.object({
        label: z.string(),
        within: zTargetDescriptor.optional(),
        /**
         * Column mode. When set, `label` is read as a COLUMN HEADER and `row`
         * identifies the row by the text of one of its cells — "the Current
         * Balance of the Savings row". Without this, a grid can only be read
         * by adjacency, which silently returns the neighbouring column's value
         * on a header-per-column table. Both layouts are common in the same
         * application, often on the same screen.
         */
        row: z.string().optional(),
      }),
    })
    .strict(),
  /** Regex with exactly one capture group, run over the observation's text. */
  z.object({ textPattern: z.string() }).strict(),
]);
export type ExtractionSource = z.infer<typeof zExtractionSource>;

export const zExtraction = z.object({
  name: z.string(),
  type: zValueType,
  description: z.string(),
  from: zExtractionSource,
  required: z.boolean().default(true),
  sensitivity: zSensitivity.default('public'),
  /** Optional post-parse assertion, e.g. money must be non-negative. */
  expect: z.enum(['non-empty', 'non-negative', 'any']).default('non-empty'),
});
export type Extraction = z.infer<typeof zExtraction>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Risk classification is on the *step*, decided at record time and re-checked at
 * replay against the live policy. 'risky' means the action is not obviously
 * reversible from the UI: posting a transaction, submitting an application,
 * deleting a record. We refuse to run those unattended unless a human has
 * explicitly approved the artifact (see `status`), which makes the approval
 * gate the thing that carries the accountability, not the model.
 */
export const zRisk = z.enum(['safe', 'risky']);

export const zStepAction = z.union([
  z.object({ type: z.literal('navigate'), uri: z.string() }).strict(),
  z.object({ type: z.literal('click'), target: zTargetDescriptor }).strict(),
  z
    .object({
      type: z.literal('type'),
      target: zTargetDescriptor,
      /** Template string; {{param}} placeholders bound per invocation. */
      text: z.string(),
      submit: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal('select'), target: zTargetDescriptor, value: z.string() }).strict(),
  z.object({ type: z.literal('press'), key: z.string() }).strict(),
  z.object({ type: z.literal('wait'), ms: z.number().optional(), forText: z.string().optional() }).strict(),
]);
export type StepAction = z.infer<typeof zStepAction>;

export const zStep = z.object({
  id: z.string(),
  /** Plain-language intent. This is what a reviewer reads; keep it honest. */
  intent: z.string(),
  action: zStepAction,
  /** Must hold before the step runs. Catches "we are not where we think we are". */
  guard: zCondition.optional(),
  /**
   * Must hold after the step runs. A step without a checkpoint is a step that
   * assumes its click worked, which is the classic way replay silently drifts
   * three screens off course and then reports a confusing failure.
   */
  checkpoint: zCondition.optional(),
  risk: zRisk.default('safe'),
  timeoutMs: z.number().int().positive().default(10_000),
  /** Retries only for the *resolution + checkpoint* of this step, never a blind re-click. */
  retries: z.number().int().min(0).max(5).default(2),
  /**
   * What to do if the checkpoint still fails after retries and no declared
   * outcome or recovery matched.
   *   fail     - stop, return a hard failure with evidence
   *   escalate - pause and hand the live session to a human
   *   continue - tolerate (only for genuinely optional steps, e.g. a dismissal)
   */
  onFailure: z.enum(['fail', 'escalate', 'continue']).default('fail'),
  /** Resolution tier observed at record time; replay compares to detect drift. */
  recordedTier: z.string().optional(),
});
export type Step = z.infer<typeof zStep>;

// ---------------------------------------------------------------------------
// Outcomes and recoveries: the error taxonomy, declared per capability
// ---------------------------------------------------------------------------

/**
 * A legitimate business answer. Detected *before* a checkpoint failure is
 * considered, so that "no such member" returns cleanly instead of surfacing as
 * "expected element not found". Conflating these two is the mistake the brief
 * calls out, and separating them is why detection order matters.
 */
export const zOutcome = z.object({
  code: z.string(),
  description: z.string(),
  detect: zCondition,
  /** Where it can occur. Narrow scoping avoids false positives mid-flow. */
  afterStep: z.string().optional(),
  /** Data to return alongside the outcome, e.g. the validation message. */
  extract: z.array(zExtraction).default([]),
});
export type Outcome = z.infer<typeof zOutcome>;

/**
 * A transient/interstitial condition the replayer is allowed to clear by
 * itself. Bounded by `maxPerRun` so a recovery loop can never become an
 * unbounded agent: this is the only self-directed behaviour in the replay path,
 * and it is a fixed, reviewed, pre-declared list of actions.
 */
export const zRecovery = z.object({
  name: z.string(),
  description: z.string(),
  detect: zCondition,
  do: z.array(zStepAction),
  maxPerRun: z.number().int().min(1).max(5).default(2),
  /** Re-run the interrupted step after recovering. */
  retryStep: z.boolean().default(true),
});
export type Recovery = z.infer<typeof zRecovery>;

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

export const zAppIdentity = z.object({
  /** The vendor product, NOT the tenant. Two credit unions on the same core share this. */
  vendor: z.string(),
  product: z.string(),
  /** Semver range the flow is believed to hold for. */
  versionRange: z.string().default('*'),
  surface: z.enum(['web', 'legacy-web', 'desktop']),
});

export const zCapability = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Stable, namespaced, human-meaningful. This is the name an agent calls. */
    id: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /**
     * draft     - recorded but unverified; may only be replayed attended
     * approved  - a human signed off; may run unattended, including risky steps
     * deprecated- kept for audit, not callable
     */
    status: z.enum(['draft', 'approved', 'deprecated']).default('draft'),
    /** One line an LLM reads when choosing a tool. */
    summary: z.string(),
    description: z.string(),
    app: zAppIdentity,
    /**
     * null for a base capability. A tenant-specific artifact sets this and
     * `basedOn`, and carries only the deltas (see CapabilityOverlay).
     */
    tenantId: z.string().nullable().default(null),

    entry: z.object({
      /** Template URI. Parameterized so tenants differ only by base URL. */
      uri: z.string(),
      /** Names of params that must be present to establish a session. */
      requiresSession: z.boolean().default(false),
    }),

    inputs: z.record(zParamSpec).default({}),
    outputs: z.array(zExtraction).default([]),
    steps: z.array(zStep).min(1),

    /** The final assertion. Without this the capability cannot claim success. */
    success: zCondition,

    outcomes: z.array(zOutcome).default([]),
    recoveries: z.array(zRecovery).default([]),

    policy: z
      .object({
        allowedOrigins: z.array(z.string()).default([]),
        maxSteps: z.number().int().positive().default(40),
        maxDurationMs: z.number().int().positive().default(120_000),
        /** Set automatically when any step is risky. */
        containsRiskyActions: z.boolean().default(false),
      })
      .default({}),

    provenance: z.object({
      recordedAt: z.string(),
      /** How it was discovered. An artifact recorded by a model is auditable. */
      recordedBy: z.object({
        kind: z.enum(['llm-discovery', 'human-authored', 'derived']),
        model: z.string().optional(),
        provider: z.string().optional(),
      }),
      runId: z.string(),
      goal: z.string(),
      /** Digest only. The raw transcript lives in evidence, not in the capability. */
      transcriptDigest: z.string().optional(),
      basedOn: z.object({ capabilityId: z.string(), version: z.string() }).optional(),
    }),

    /** Populated by `cua verify`. Gates unattended use in the catalog. */
    stability: z
      .object({
        runs: z.number().int().min(0).default(0),
        successes: z.number().int().min(0).default(0),
        lastVerifiedAt: z.string().optional(),
      })
      .default({ runs: 0, successes: 0 }),
  })
  .superRefine((cap, ctx) => {
    const stepIds = new Set<string>();
    for (const s of cap.steps) {
      if (stepIds.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate step id: ${s.id}`, path: ['steps'] });
      }
      stepIds.add(s.id);
    }
    for (const o of cap.outcomes) {
      if (o.afterStep && !stepIds.has(o.afterStep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `outcome ${o.code} references unknown step ${o.afterStep}`,
          path: ['outcomes'],
        });
      }
    }
    // A secret must come from the secret store and must never be exemplified.
    for (const [name, p] of Object.entries(cap.inputs)) {
      if (p.sensitivity === 'secret' && p.source !== 'secret-store') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `input '${name}' is secret and must have source 'secret-store'`,
          path: ['inputs', name],
        });
      }
      if (p.source === 'secret-store' && !p.secretKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `input '${name}' needs a secretKey`,
          path: ['inputs', name],
        });
      }
      if (p.example && p.sensitivity !== 'public' && p.sensitivity !== 'identifier') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `input '${name}' may not carry an example at sensitivity ${p.sensitivity}`,
          path: ['inputs', name],
        });
      }
    }
    // Risky steps must be reflected in the policy block, so the catalog can gate
    // on one field instead of re-walking the step list.
    const risky = cap.steps.some((s) => s.risk === 'risky');
    if (risky && !cap.policy.containsRiskyActions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'capability has risky steps but policy.containsRiskyActions is false',
        path: ['policy', 'containsRiskyActions'],
      });
    }
  });

export type Capability = z.infer<typeof zCapability>;

// ---------------------------------------------------------------------------
// Tenant overlays: reuse across institutions running the same vendor product
// ---------------------------------------------------------------------------

/**
 * Hundreds of tenants run the same core banking product, skinned and configured
 * differently. Re-recording per tenant would be both expensive and unauditable
 * (you would have N unrelated flows that are supposedly "the same capability").
 *
 * Instead: one base capability per vendor product, plus a thin per-tenant
 * overlay that patches only what actually differs — the base URL, a renamed
 * button, an extra confirmation step some institutions enable. The overlay is
 * small enough to review in a pull request, and drift shows up as an overlay
 * growing rather than as a silent behaviour change.
 */
export const zOverlay = z.object({
  schemaVersion: z.literal('cua.overlay/v1'),
  tenantId: z.string(),
  overlayFor: z.object({ capabilityId: z.string(), versionRange: z.string() }),
  /** Replaces entry.uri; the usual case is nothing but a different host. */
  entryUri: z.string().optional(),
  /** Per-step shallow patches of the target descriptor and/or timings. */
  steps: z
    .record(
      z.object({
        target: zTargetDescriptor.partial().optional(),
        text: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        /** Skip a step this tenant does not have (e.g. no dual-approval prompt). */
        skip: z.boolean().optional(),
      }),
    )
    .default({}),
  /** Extra interstitials this tenant shows (SSO notice, EULA banner). */
  extraRecoveries: z.array(zRecovery).default([]),
  notes: z.string().optional(),
});
export type Overlay = z.infer<typeof zOverlay>;

export function parseCapability(raw: unknown): Capability {
  return zCapability.parse(raw);
}
export function parseOverlay(raw: unknown): Overlay {
  return zOverlay.parse(raw);
}
