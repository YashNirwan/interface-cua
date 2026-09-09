/**
 * Human takeover of a live browser session.
 *
 * The requirement is that the operator drives THE SAME session — not a fresh
 * one — so the state the automation built up (a login, a search, a half-filled
 * form) is still there when they arrive. That rules out the easy
 * implementation of "spawn a browser pointed at the same URL", which loses the
 * session cookie, the form state, and any server-side wizard step.
 *
 * Two takeover modes, because a bank's automation runs headless in a data
 * centre but a developer debugs it on a laptop:
 *
 *   headed   the operator is handed the actual Chromium window and clicks in
 *            it directly. Their actions are captured by a page-side recorder.
 *   headless nobody can click a window that is not drawn, so the operator
 *            console proxies actions into this same page over HTTP. Same
 *            session, same cookies, same tab — just a different input device.
 *
 * Both are real control transfer. The headless path is what makes the feature
 * exercisable in CI and in the committed evidence.
 */

import type { Browser, Page } from 'playwright';
import type { HumanAction, HumanControlPort } from '../types.js';
import { HUMAN_RECORDER_SCRIPT } from './perceive.js';

export class BrowserHumanControl implements HumanControlPort {
  private sink?: (ev: HumanAction) => void;
  private bound = false;
  private onNav?: () => void;

  constructor(
    private readonly page: Page,
    private readonly browser: Browser,
    private readonly headed: boolean,
  ) {}

  get available(): boolean {
    return this.headed;
  }

  async expose(): Promise<{ how: string; detail: string }> {
    if (this.headed) {
      try {
        await this.page.bringToFront();
      } catch {
        // Best effort: on some platforms the window manager refuses. The
        // operator can still find the window; failing the handoff over this
        // would be worse than a slightly clumsy one.
      }
      return { how: 'headed-chromium', detail: this.page.url() };
    }
    return {
      how: 'console-proxy',
      detail: `${this.page.url()} (headless: drive this session from the operator console)`,
    };
  }

  async startRecording(sink: (ev: HumanAction) => void): Promise<void> {
    this.sink = sink;

    if (!this.bound) {
      // exposeBinding survives navigation; the init script does not, so the
      // two are installed by different mechanisms on purpose.
      await this.page.exposeBinding('__cuaHumanEvent', (_src, payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        this.emit({
          at: new Date().toISOString(),
          kind: (p.kind as HumanAction['kind']) ?? 'note',
          role: p.role as HumanAction['role'],
          name: typeof p.name === 'string' ? p.name : undefined,
          valueShape: typeof p.valueShape === 'string' ? p.valueShape : undefined,
          uri: typeof p.uri === 'string' ? p.uri : undefined,
        });
      });
      await this.page.addInitScript(HUMAN_RECORDER_SCRIPT);
      this.bound = true;
    }

    await this.inject();
    this.onNav = () => {
      this.emit({ at: new Date().toISOString(), kind: 'navigate', uri: this.page.url() });
      void this.inject();
    };
    this.page.on('framenavigated', this.onNav);
  }

  async stopRecording(): Promise<void> {
    if (this.onNav) this.page.off('framenavigated', this.onNav);
    this.onNav = undefined;
    this.sink = undefined;
  }

  /** Record something the console did on the operator's behalf. */
  note(action: HumanAction): void {
    this.emit(action);
  }

  private emit(ev: HumanAction): void {
    this.sink?.(ev);
  }

  private async inject(): Promise<void> {
    // Re-evaluate in every frame: a frameset app navigates individual frames
    // without a top-level navigation, and an init script only covers new
    // documents we happen to catch.
    await Promise.all(
      this.page.frames().map(async (f) => {
        try {
          await f.evaluate(HUMAN_RECORDER_SCRIPT);
        } catch {
          // Frame detached mid-injection; the next navigation re-injects.
        }
      }),
    );
  }

  /** Exposed for diagnostics; not part of the port. */
  get isHeaded(): boolean {
    return this.headed;
  }

  async close(): Promise<void> {
    await this.stopRecording();
    void this.browser;
  }
}
