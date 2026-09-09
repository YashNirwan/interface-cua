/**
 * The surface abstraction: the seam between "how we perceive and act on a UI"
 * and "the recorded flow".
 *
 * Everything above this file (recorder, artifact, replay executor, policy,
 * escalation) is written against these types and knows nothing about
 * Playwright, the DOM, CSS, or pixels. That is deliberate: the same replay
 * engine must be able to drive a modern web app, a frameset-era legacy web app,
 * and eventually a native desktop window over UIAutomation/AX APIs.
 *
 * The design rule we enforce to keep that true:
 *
 *   Nothing above this seam may name a CSS selector, an XPath, or a coordinate.
 *
 * A flow refers to controls only by *semantic descriptors* (role + accessible
 * name + structural context). Every surface implementation is responsible for
 * turning a descriptor back into something it can act on. Selectors are an
 * implementation detail of a surface, never part of a capability.
 */

/** Which family of surface an artifact was recorded against. */
export type SurfaceKind = 'web' | 'legacy-web' | 'desktop';

/**
 * Roles are deliberately a small, surface-independent vocabulary rather than the
 * full ARIA set. Each surface adapter maps its native taxonomy onto these:
 *   web      -> ARIA roles
 *   desktop  -> UIA ControlType / AX AXRole
 * Keeping the vocabulary small is what makes a descriptor portable; anything
 * exotic degrades to 'generic' and is disambiguated by name + context instead.
 */
export const UI_ROLES = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listitem',
  'menuitem',
  'tab',
  'heading',
  'cell',
  'row',
  'table',
  'dialog',
  'alert',
  'image',
  'text',
  'region',
  'generic',
] as const;
export type UiRole = (typeof UI_ROLES)[number];

/**
 * A single perceived control or piece of content.
 *
 * `ref` is ephemeral — valid only for the observation that produced it. It is
 * how the LLM points at something during discovery ("click n17"). It is
 * deliberately NOT stored in artifacts: refs are positional and would rot
 * instantly. At record time a ref is converted into a TargetDescriptor.
 */
export interface UiNode {
  /** Ephemeral handle, unique within one Observation. */
  ref: string;
  role: UiRole;
  /** Computed accessible name (see accessible-name.ts for the cascade). */
  name: string;
  /** Current value for inputs/selects. Redacted before it reaches any log. */
  value?: string;
  /** Options for combobox/radio groups, so the model can pick a legal value. */
  options?: string[];
  disabled?: boolean;
  checked?: boolean;
  /** Frame/window chain, outermost first. Legacy framesets make this load-bearing. */
  framePath: string[];
  /**
   * Nearest enclosing named region: a fieldset legend, a heading above the
   * block, a table caption, a dialog title. This is the single most useful
   * disambiguator in legacy apps, where a page has six "Search" buttons and
   * the only thing distinguishing them is which panel they sit in.
   */
  section?: string;
  /** Index among nodes sharing (role, name, framePath, section). Stable-ish; last-resort. */
  ordinal: number;
  /** Text adjacent to the control — the de-facto label in table-layout apps. */
  textNear?: string[];
  /**
   * Surface-specific resolution hints (a DOM id, a control automation id).
   * Deliberately typed as opaque and only ever consulted as a LOW-priority
   * tier during resolution — legacy frameworks generate ids like
   * `ctl00$MainContent$txtMemberId` that change when a developer reorders a
   * panel, so they must never outrank semantics.
   */
  hint?: Record<string, string>;
  /** True if the surface believes this node holds sensitive data (password fields etc). */
  sensitive?: boolean;
}

/** Where we are. Generalizes "URL" so a desktop surface can report a window identity. */
export interface SurfaceLocation {
  /** Web: full URL. Desktop: an app:// pseudo-URI. */
  uri: string;
  /** Web: document.title. Desktop: window title. */
  title: string;
  /** Canonicalized path with volatile segments parameterized (/member/100482 -> /member/:id). */
  canonicalPath?: string;
}

/** One perception of the surface. */
export interface Observation {
  surfaceKind: SurfaceKind;
  location: SurfaceLocation;
  nodes: UiNode[];
  /** Flattened visible text. Used by outcome/recovery detectors and by the model. */
  text: string;
  capturedAt: string;
  /** Set when the perception itself failed (page crashed, app not responding). */
  degraded?: { reason: string };
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export type NameMatch = 'exact' | 'normalized' | 'contains' | 'template';

/**
 * How a capability names a control. This is the portable, storable form.
 *
 * Robustness reasoning (defended in REPORT.md §3): we rank identification
 * strategies by how tightly they couple to things a vendor can change without
 * changing the app's meaning.
 *
 *   role + accessible name   <- changes only if the UI's *meaning* changes
 *   + enclosing section      <- disambiguates repeated controls
 *   + ordinal                <- positional, brittle, last resort
 *   + surface hint (dom id)  <- framework-generated, brittle, lowest priority
 *
 * We store all of them and resolve in that order, so a descriptor degrades
 * gracefully instead of failing outright — and we report which tier fired,
 * which is our drift signal.
 */
export interface TargetDescriptor {
  role: UiRole;
  name: string;
  nameMatch: NameMatch;
  framePath: string[];
  section?: string;
  ordinal?: number;
  textNear?: string[];
  hint?: Record<string, string>;
  /** Human-readable note explaining why this control was chosen; for reviewers. */
  note?: string;
}

/** Which tier of the cascade produced a match. Lower = more semantic = healthier. */
export type ResolutionTier =
  | 'exact-name-in-section'
  | 'exact-name-in-frame'
  | 'normalized-name'
  | 'contains-name'
  | 'near-text'
  | 'surface-hint'
  | 'ordinal';

export const RESOLUTION_TIER_ORDER: ResolutionTier[] = [
  'exact-name-in-section',
  'exact-name-in-frame',
  'normalized-name',
  'contains-name',
  'near-text',
  'surface-hint',
  'ordinal',
];

export type Resolution =
  | { ok: true; node: UiNode; tier: ResolutionTier; candidates: 1 }
  | { ok: false; reason: 'not-found'; tried: ResolutionTier[] }
  | { ok: false; reason: 'ambiguous'; tier: ResolutionTier; candidates: number; sample: string[] };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The action vocabulary. Kept small on purpose — every verb here has to be
 * implementable on a desktop surface too, so there is no `hover`, no
 * `scrollIntoView`, no `evaluate`. Anything a surface needs to do to make an
 * action work (scrolling, focusing, waiting for the frame) is the adapter's
 * problem, not the flow's.
 */
export type Action =
  | { type: 'navigate'; uri: string }
  | { type: 'click'; target: TargetRef }
  | { type: 'type'; target: TargetRef; text: string; submit?: boolean }
  | { type: 'select'; target: TargetRef; value: string }
  | { type: 'press'; key: string }
  | { type: 'read'; target: TargetRef }
  | { type: 'wait'; ms?: number; forText?: string };

/** During discovery we act on ephemeral refs; during replay, on descriptors. */
export type TargetRef = { ref: string } | { descriptor: TargetDescriptor };

export type ActionType = Action['type'];

export interface ActResult {
  ok: boolean;
  /** For `read`. */
  value?: string;
  /** How the target was found, when the action had one. Drives drift detection. */
  tier?: ResolutionTier;
  /** The node acted upon, so the recorder can build a descriptor from it. */
  node?: UiNode;
  error?: { class: string; message: string };
}

export interface CaptureOptions {
  /** CSS-free instruction to the surface: blank out nodes marked sensitive. */
  maskSensitive?: boolean;
}

export interface SurfaceCapture {
  /** PNG bytes; may be undefined for surfaces that cannot render (headless desktop). */
  screenshot?: Buffer;
  /** Raw structural snapshot for debugging. Surface-specific, evidence-only. */
  snapshot?: string;
}

/**
 * The contract every surface adapter implements.
 *
 * Note there is no `page`, no `driver`, no escape hatch. If a caller could
 * reach the underlying automation handle, the policy gate and the session lease
 * could both be bypassed, and neither would be a real guarantee.
 */
export interface Surface {
  readonly kind: SurfaceKind;
  observe(): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  resolve(descriptor: TargetDescriptor): Promise<Resolution>;
  capture(opts?: CaptureOptions): Promise<SurfaceCapture>;
  /**
   * Hand the live session to a human and get it back. Implementations must
   * operate on the SAME session (same browser context / same window), never a
   * fresh one — that is the whole point of the handoff.
   */
  humanControl: HumanControlPort;
  dispose(): Promise<void>;
}

/**
 * The part of the surface that makes human takeover possible.
 * Kept as its own port so a headless/CI surface can declare it unsupported
 * rather than pretending.
 */
export interface HumanControlPort {
  /** Can a person actually drive this session right now? */
  readonly available: boolean;
  /** Make the session visible/interactive to an operator; returns a locator for it. */
  expose(): Promise<{ how: string; detail: string }>;
  /** Start capturing what the human does. Values are redacted at capture time. */
  startRecording(sink: (ev: HumanAction) => void): Promise<void>;
  stopRecording(): Promise<void>;
}

/** What a human did while holding the lease. Recorded as evidence, never replayed blindly. */
export interface HumanAction {
  at: string;
  kind: 'click' | 'input' | 'navigate' | 'key' | 'note';
  role?: UiRole;
  name?: string;
  /** Always redacted — we record that a value was entered, not what it was. */
  valueShape?: string;
  uri?: string;
}
