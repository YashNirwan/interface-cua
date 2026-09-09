/**
 * The web `Surface` implementation.
 *
 * Everything Playwright-specific in this system lives in this file and its two
 * helpers. Above the `Surface` interface, nothing knows this is a browser.
 *
 * Notable choices:
 *
 *  - We never call `page.locator(css)` with a selector derived from a
 *    capability. Actions are dispatched against `[data-cua-ref="…"]`, an
 *    attribute we stamped ourselves microseconds earlier during perception.
 *    So the only selector in the system is one we control completely, and
 *    descriptor -> element goes through the resolution cascade instead.
 *
 *  - Settling waits for the DOM to stop mutating, not for `networkidle`.
 *    `networkidle` is a well-known flake source on enterprise apps that
 *    long-poll or keep an analytics socket open — it either hangs for the full
 *    timeout or returns early depending on unrelated traffic. Quiescence of the
 *    thing we actually care about (the DOM) is both faster and more honest.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import {
  type ActResult,
  type Action,
  type CaptureOptions,
  type Observation,
  type Resolution,
  type ResolutionTier,
  type Surface,
  type SurfaceCapture,
  type SurfaceKind,
  type TargetDescriptor,
  type TargetRef,
  type UiNode,
} from '../types.js';
import { canonicalizePath } from '../canonicalize.js';
import { perceiveScriptFor, type RawFrame } from './perceive.js';
import { describeNode, resolveDescriptor } from './resolve.js';
import { BrowserHumanControl } from './human-control.js';

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  defaultTimeoutMs?: number;
  /** Invoked before every action. Throwing here prevents the action. */
  beforeAct?: (action: Action) => void | Promise<void>;
}

export class PlaywrightSurface implements Surface {
  readonly kind: SurfaceKind = 'legacy-web';
  readonly humanControl: BrowserHumanControl;
  private lastNodes: UiNode[] = [];

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly opts: Required<Pick<PlaywrightSurfaceOptions, 'defaultTimeoutMs'>> & PlaywrightSurfaceOptions,
    headed: boolean,
  ) {
    this.humanControl = new BrowserHumanControl(page, browser, headed);
  }

  // -- perception ----------------------------------------------------------

  async observe(): Promise<Observation> {
    const frames = this.page.frames();
    const nodes: UiNode[] = [];
    const texts: string[] = [];
    let degraded: Observation['degraded'];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      let raw: RawFrame;
      try {
        raw = (await frame.evaluate(perceiveScriptFor(i))) as RawFrame;
      } catch (e) {
        // A frame can detach mid-walk (legacy apps reload frames constantly).
        // One unreadable frame must not blind us to the other four.
        degraded = { reason: `frame ${i} unreadable: ${(e as Error).message.slice(0, 120)}` };
        continue;
      }
      const framePath = framePathOf(frame);
      for (const n of raw.nodes) {
        nodes.push({
          ref: n.ref,
          role: n.role,
          name: n.name,
          value: n.value,
          options: n.options,
          disabled: n.disabled,
          checked: n.checked,
          framePath,
          section: n.section,
          ordinal: (n as unknown as { ordinal?: number }).ordinal ?? 0,
          textNear: n.textNear,
          hint: { ...n.hint, nameFrom: n.nameFrom },
          sensitive: n.sensitive,
        });
      }
      if (raw.text.trim()) texts.push(raw.text);
    }

    this.lastNodes = nodes;
    const uri = this.page.url();
    const obs: Observation = {
      surfaceKind: this.kind,
      location: { uri, title: await this.safeTitle(), canonicalPath: canonicalizePath(uri) },
      nodes,
      text: texts.join('\n'),
      capturedAt: new Date().toISOString(),
    };
    if (degraded) obs.degraded = degraded;
    return obs;
  }

  async resolve(descriptor: TargetDescriptor): Promise<Resolution> {
    const obs = await this.observe();
    return resolveDescriptor(descriptor, obs.nodes);
  }

  // -- action --------------------------------------------------------------

  async act(action: Action): Promise<ActResult> {
    await this.opts.beforeAct?.(action);
    const timeout = this.opts.defaultTimeoutMs;

    try {
      switch (action.type) {
        case 'navigate': {
          await this.page.goto(action.uri, { waitUntil: 'domcontentloaded', timeout });
          await this.settle();
          return { ok: true };
        }
        case 'press': {
          await this.page.keyboard.press(action.key);
          await this.settle();
          return { ok: true };
        }
        case 'wait': {
          if (action.forText) {
            const found = await this.waitForText(action.forText, action.ms ?? timeout);
            return found ? { ok: true } : { ok: false, error: { class: 'timeout', message: `text "${action.forText}" did not appear within ${action.ms ?? timeout}ms` } };
          }
          await this.page.waitForTimeout(action.ms ?? 500);
          return { ok: true };
        }
        case 'click':
        case 'type':
        case 'select':
        case 'read': {
          const found = await this.locate(action.target);
          if (!found.ok) return found.result;
          const { node, locator } = found;

          if (action.type === 'read') {
            const value = node.value ?? node.name;
            return { ok: true, value, node, tier: found.tier };
          }
          if (action.type === 'click') {
            await locator.click({ timeout });
          } else if (action.type === 'type') {
            await locator.fill('', { timeout });
            await locator.fill(action.text, { timeout });
            if (action.submit) await locator.press('Enter');
          } else {
            // Prefer the visible label; fall back to the underlying value.
            // Legacy selects frequently have opaque values ("01", "MM") whose
            // meaning lives only in the label a human reads.
            try {
              await locator.selectOption({ label: action.value }, { timeout });
            } catch {
              await locator.selectOption(action.value, { timeout });
            }
          }
          await this.settle();
          return { ok: true, node, tier: found.tier };
        }
      }
    } catch (e) {
      return { ok: false, error: classifyError(e) };
    }
  }

  // -- evidence ------------------------------------------------------------

  async capture(opts?: CaptureOptions): Promise<SurfaceCapture> {
    const mask = opts?.maskSensitive !== false;
    let screenshot: Buffer | undefined;
    try {
      screenshot = await this.page.screenshot({
        fullPage: true,
        timeout: 8000,
        ...(mask ? { mask: [this.page.locator('[data-cua-sensitive="1"]')] } : {}),
      });
    } catch {
      screenshot = undefined; // a screenshot failure must not fail the run
    }
    // Deliberately a semantic snapshot rather than raw HTML: raw markup of a
    // member record would persist regulated data into evidence, which is the
    // exact thing the safety requirement forbids.
    const snapshot = this.lastNodes
      .map((n) => `${n.framePath.join('>') || '(top)'} | ${n.role} | ${n.section ?? '-'} | ${n.name}`)
      .join('\n');
    return { screenshot, snapshot };
  }

  async dispose(): Promise<void> {
    await this.humanControl.close().catch(() => {});
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  // -- internals -----------------------------------------------------------

  private async locate(
    target: TargetRef,
  ): Promise<{ ok: true; node: UiNode; locator: ReturnType<Frame['locator']>; tier?: ResolutionTier } | { ok: false; result: ActResult }> {
    let node: UiNode | undefined;
    let tier: ResolutionTier | undefined;

    if ('ref' in target) {
      node = this.lastNodes.find((n) => n.ref === target.ref);
      if (!node) {
        // The observation the ref came from is stale. Re-observe once: the
        // page may simply have settled further since.
        const obs = await this.observe();
        node = obs.nodes.find((n) => n.ref === target.ref);
      }
      if (!node) {
        return { ok: false, result: { ok: false, error: { class: 'target_not_found', message: `ref ${target.ref} is no longer on the page` } } };
      }
    } else {
      const obs = await this.observe();
      const res = resolveDescriptor(target.descriptor, obs.nodes);
      if (!res.ok) {
        const message =
          res.reason === 'ambiguous'
            ? `descriptor matched ${res.candidates} controls at tier ${res.tier}: ${res.sample.join(' | ')}`
            : `no control matched ${describeDescriptor(target.descriptor)} (tried ${res.tried.join(', ')})`;
        return { ok: false, result: { ok: false, error: { class: res.reason === 'ambiguous' ? 'target_ambiguous' : 'target_not_found', message } } };
      }
      node = res.node;
      tier = res.tier;
    }

    const frame = this.frameFor(node);
    if (!frame) {
      return { ok: false, result: { ok: false, error: { class: 'target_not_found', message: `frame ${node.framePath.join('>')} is gone` } } };
    }
    return { ok: true, node, locator: frame.locator(`[data-cua-ref="${node.ref}"]`), tier };
  }

  private frameFor(node: UiNode): Frame | undefined {
    const want = node.framePath.join('>');
    return this.page.frames().find((f) => framePathOf(f).join('>') === want);
  }

  private async safeTitle(): Promise<string> {
    try {
      return await this.page.title();
    } catch {
      return '';
    }
  }

  private async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    const needle = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const f of this.page.frames()) {
        try {
          const body = (await f.evaluate(() => document.body?.innerText ?? '')) as string;
          if (body.replace(/\s+/g, ' ').toLowerCase().includes(needle)) return true;
        } catch {
          /* frame detached; try the next one */
        }
      }
      await this.page.waitForTimeout(150);
    }
    return false;
  }

  /**
   * Wait for the DOM to go quiet. Bounded hard, because a page that never
   * stops mutating (a clock, a ticker) must not stall the run — after the cap
   * we proceed and let the step's checkpoint be the judge of readiness.
   */
  private async settle(quietMs = 250, capMs = 3000): Promise<void> {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: capMs });
    } catch {
      /* already loaded, or still loading; the mutation watch below decides */
    }
    try {
      await this.page.evaluate(
        ([quiet, cap]) =>
          new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const done = () => {
              observer.disconnect();
              clearTimeout(timer);
              resolve();
            };
            const bump = () => {
              clearTimeout(timer);
              timer = setTimeout(done, quiet as number);
            };
            const observer = new MutationObserver(bump);
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            bump();
            setTimeout(done, cap as number);
          }),
        [quietMs, capMs] as const,
      );
    } catch {
      /* navigation raced the evaluate; the next observe() picks up the truth */
    }
  }
}

function framePathOf(frame: Frame): string[] {
  const path: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    const name = f.name() || lastSegment(f.url()) || 'frame';
    path.unshift(name);
    f = f.parentFrame();
  }
  return path;
}

function lastSegment(url: string): string {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean);
    return p[p.length - 1] ?? '';
  } catch {
    return '';
  }
}

function describeDescriptor(d: TargetDescriptor): string {
  return `${d.role} '${d.name}'${d.section ? ` in section '${d.section}'` : ''}${d.framePath.length ? ` [frame: ${d.framePath.join('>')}]` : ''}`;
}

function classifyError(e: unknown): { class: string; message: string } {
  const msg = (e as Error)?.message ?? String(e);
  if (/Timeout|timeout exceeded/i.test(msg)) return { class: 'timeout', message: msg.split('\n')[0] ?? msg };
  if (/net::|ERR_|Navigation failed|frame was detached/i.test(msg)) return { class: 'surface_error', message: msg.split('\n')[0] ?? msg };
  return { class: 'surface_error', message: msg.split('\n')[0] ?? msg };
}

export { describeNode };

export async function createPlaywrightSurface(opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
  // CUA_HEADLESS=0 forces a visible window, which is what makes a real human
  // takeover possible on a developer machine.
  const headless = process.env.CUA_HEADLESS === '0' ? false : (opts.headless ?? true);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    // A frameset app is the target; nothing here needs a service worker, and
    // disabling them removes a class of nondeterminism from replay.
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.defaultTimeoutMs ?? 10_000);
  return new PlaywrightSurface(browser, context, page, { defaultTimeoutMs: opts.defaultTimeoutMs ?? 10_000, ...opts }, !headless);
}
