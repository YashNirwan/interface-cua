/**
 * Meridian Core — Express app and entry point.
 *
 * A deliberately archaic "bank back-office" web app used as the automation
 * target: framesets, table layout, WebForms-style control names, no test ids,
 * business outcomes returned as HTTP 200 pages rather than status codes.
 *
 * Run standalone:   npm run app
 * Run from a test:  const app = await startMeridian(0); ... await app.close();
 */

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';

import {
  type Account,
  type Member,
  appendAccount,
  findMember,
  isAccountType,
  resetMembers,
  searchBySurname,
} from './data.js';
import { FaultRegistry, createFaultsRouter, delay } from './faults.js';
import * as views from './views.js';

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

interface Session {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: number;
}

const SESSION_COOKIE = 'sid';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== '') {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

function sidOf(req: Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

/* ------------------------------------------------------------------ */
/* request helpers                                                     */
/* ------------------------------------------------------------------ */

function field(req: Request, name: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const raw = body?.[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function submitted(req: Request, name: string): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  return body !== undefined && Object.prototype.hasOwnProperty.call(body, name);
}

function routeId(req: Request): string {
  const v = req.params['id'];
  return typeof v === 'string' ? v : '';
}

function html(res: Response, body: string, status = 200): void {
  res.status(status).type('html').send(body);
}

/**
 * A "content" request is an actual application screen. The frameset shell and
 * the nav frame are excluded so that a one-shot fault armed before navigation
 * always lands on the screen under test rather than on frame chrome.
 */
function isContentPath(path: string): boolean {
  if (!path.startsWith('/meridian')) return false;
  if (path === '/meridian' || path === '/meridian/') return false;
  if (path === '/meridian/nav') return false;
  if (path.startsWith('/meridian/_faults')) return false;
  return true;
}

const MEMBER_DETAIL_PATH = /^\/meridian\/member\/[^/]+$/;

/** Accepts `50`, `50.00`, `$50`, `1,250.00`. Rejects anything else. */
function parseDeposit(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

export function createMeridianApp(): express.Express {
  const app = express();
  const sessions = new Map<string, Session>();
  const faults = new FaultRegistry();

  const credentials = {
    userId: process.env['MERIDIAN_USER'] ?? 'demo.operator',
    password: process.env['MERIDIAN_PASSWORD'] ?? 'Passw0rd!demo',
  };

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // The fault control surface is mounted first so arming a fault is never
  // itself delayed, expired or 500'd by a previously armed fault.
  app.use('/meridian/_faults', createFaultsRouter(faults, sidOf));

  /* ---- fault middleware -------------------------------------------- */

  app.use('/meridian', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const sid = sidOf(req);
      const header = req.get('x-fault-session') ?? null;
      const key = faults.resolveKey(sid, header);
      const path = req.path.startsWith('/meridian') ? req.path : `/meridian${req.path}`;

      await delay(faults.delayMs(key));

      if (!isContentPath(path)) {
        next();
        return;
      }

      const action = faults.takeBlockingFault(key);
      if (action.kind === 'expire') {
        if (sid) sessions.delete(sid);
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        res.redirect('/meridian/login?msg=expired');
        return;
      }
      if (action.kind === 'error500') {
        html(res, views.serverErrorPage(), 500);
        return;
      }

      if (req.method === 'GET' && MEMBER_DETAIL_PATH.test(path) && faults.takeNotice(key, req.originalUrl)) {
        html(res, views.systemNoticePage(req.originalUrl));
        return;
      }

      next();
    })().catch(next);
  });

  /* ---- sign on / off ----------------------------------------------- */

  app.get('/meridian/login', (req, res) => {
    html(res, views.loginPage(req.query['msg'] === 'expired' ? 'Your session has ended due to inactivity.' : undefined));
  });

  app.post('/meridian/login', (req, res) => {
    const userId = field(req, 'ctl00$MainContent$txtUserId');
    const password = field(req, 'ctl00$MainContent$txtPassword');

    if (userId !== credentials.userId || password !== credentials.password) {
      html(res, views.loginPage('Sign-on failed. Check your credentials.'));
      return;
    }

    const session: Session = { id: randomBytes(16).toString('hex'), userId, createdAt: Date.now() };
    sessions.set(session.id, session);
    res.cookie(SESSION_COOKIE, session.id, { path: '/', httpOnly: true, sameSite: 'lax' });
    res.redirect('/meridian');
  });

  app.get('/meridian/logout', (req, res) => {
    const sid = sidOf(req);
    if (sid) sessions.delete(sid);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect('/meridian/login');
  });

  /* ---- session guard ----------------------------------------------- */

  const requireSession = (req: Request, res: Response, next: NextFunction): void => {
    const sid = sidOf(req);
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      res.redirect('/meridian/login');
      return;
    }
    res.locals['session'] = session;
    next();
  };

  const currentSession = (res: Response): Session => res.locals['session'] as Session;

  /* ---- shell + navigation ------------------------------------------ */

  app.get('/meridian', requireSession, (_req, res) => {
    html(res, views.framesetPage());
  });

  app.get('/meridian/nav', requireSession, (_req, res) => {
    html(res, views.navPage(currentSession(res).userId));
  });

  app.get('/meridian/services', requireSession, (_req, res) => {
    html(res, views.accountServicesPage());
  });

  /* ---- search ------------------------------------------------------- */

  app.get('/meridian/search', requireSession, (_req, res) => {
    html(res, views.searchPage());
  });

  app.post('/meridian/search', requireSession, (req, res) => {
    if (submitted(req, 'ctl00$MainContent$btnClear')) {
      res.redirect('/meridian/search');
      return;
    }

    const memberId = field(req, 'ctl00$MainContent$txtMemberId');
    const surname = field(req, 'ctl00$MainContent$txtSurname');

    if (memberId !== '') {
      if (!/^\d{6}$/.test(memberId)) {
        html(
          res,
          views.validationPage(
            'Member Search',
            'Member ID must be a 6-digit number.',
            '/meridian/search',
            'Return to Member Search',
          ),
        );
        return;
      }
      if (findMember(memberId)) {
        res.redirect(`/meridian/member/${memberId}`);
        return;
      }
      html(res, views.notFoundPage());
      return;
    }

    if (surname !== '') {
      const matches = searchBySurname(surname);
      html(res, matches.length === 0 ? views.notFoundPage() : views.searchResultsPage(surname, matches));
      return;
    }

    html(res, views.notFoundPage());
  });

  /* ---- member detail ------------------------------------------------ */

  /** Resolve `:id`, rendering not-found / permission-denied itself when needed. */
  const resolveMember = (req: Request, res: Response): Member | null => {
    const member = findMember(routeId(req));
    if (!member) {
      html(res, views.notFoundPage());
      return null;
    }
    if (member.restricted) {
      html(res, views.permissionDeniedPage());
      return null;
    }
    return member;
  };

  app.get('/meridian/member/:id', requireSession, (req, res) => {
    const member = resolveMember(req, res);
    if (!member) return;
    html(res, views.memberPage(member));
  });

  app.post('/meridian/member/:id/account', requireSession, (req, res) => {
    const member = resolveMember(req, res);
    if (!member) return;
    const number = field(req, 'ctl00$MainContent$hidAccount');
    const account = member.accounts.find((a) => a.number === number);
    if (!account) {
      html(res, views.notFoundPage());
      return;
    }
    html(res, views.accountDetailPage(member, account));
  });

  app.post('/meridian/member/:id/activity', requireSession, (req, res) => {
    const member = resolveMember(req, res);
    if (!member) return;
    const index = Number.parseInt(field(req, 'ctl00$MainContent$hidEntry'), 10);
    const entry = Number.isInteger(index) ? member.activity[index] : undefined;
    if (!entry) {
      html(res, views.notFoundPage());
      return;
    }
    html(res, views.activityDetailPage(member, entry));
  });

  /* ---- sub-account flow (the irreversible one) ---------------------- */

  app.get('/meridian/member/:id/subaccount', requireSession, (req, res) => {
    const member = resolveMember(req, res);
    if (!member) return;
    html(res, views.subAccountFormPage(member));
  });

  app.post('/meridian/member/:id/subaccount', requireSession, (req, res) => {
    const member = resolveMember(req, res);
    if (!member) return;

    const rawType = field(req, 'ctl00$MainContent$ddlType');
    const type = isAccountType(rawType) ? rawType : 'Savings';
    const rawDeposit = field(req, 'ctl00$MainContent$txtDeposit');
    const purpose = field(req, 'ctl00$MainContent$txtPurpose');
    const deposit = parseDeposit(rawDeposit);

    if (deposit === null || deposit < 25) {
      html(
        res,
        views.validationPage(
          'Open Sub-Account',
          'Initial deposit must be at least $25.00.',
          `/meridian/member/${member.id}/subaccount`,
          'Return to Open Sub-Account',
        ),
      );
      return;
    }

    html(res, views.subAccountReviewPage(member, { type, deposit: deposit.toFixed(2), purpose }));
  });

  app.post('/meridian/member/:id/subaccount/confirm', requireSession, (req, res) => {
    const member = resolveMember(req, res);
    if (!member) return;

    if (submitted(req, 'ctl00$MainContent$btnCancel')) {
      res.redirect(`/meridian/member/${member.id}`);
      return;
    }

    const rawType = field(req, 'ctl00$MainContent$hidType');
    const type = isAccountType(rawType) ? rawType : 'Savings';
    const deposit = parseDeposit(field(req, 'ctl00$MainContent$hidDeposit'));

    if (deposit === null || deposit < 25) {
      html(
        res,
        views.validationPage(
          'Open Sub-Account',
          'Initial deposit must be at least $25.00.',
          `/meridian/member/${member.id}/subaccount`,
          'Return to Open Sub-Account',
        ),
      );
      return;
    }

    const account: Account = appendAccount(member, type, deposit);
    html(res, views.subAccountDonePage(member, account));
  });

  /* ---- notice acknowledgement --------------------------------------- */

  app.post('/meridian/_notice/ack', requireSession, (req, res) => {
    const key = faults.resolveKey(sidOf(req), req.get('x-fault-session') ?? null);
    const stashed = faults.takePendingUrl(key);
    const posted = field(req, 'ctl00$MainContent$hidReturn');
    const target =
      stashed ?? (posted.startsWith('/meridian/') && !posted.startsWith('//') ? posted : '/meridian/search');
    res.redirect(target);
  });

  /* ---- fallbacks ----------------------------------------------------- */

  app.get('/', (_req, res) => {
    res.redirect('/meridian');
  });

  app.use('/meridian', (_req, res) => {
    html(res, views.notFoundPage(), 404);
  });

  // Anything that actually throws presents as the same legacy 500 page.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[meridian] unhandled', err);
    if (res.headersSent) return;
    html(res, views.serverErrorPage(), 500);
  });

  return app;
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

export interface MeridianHandle {
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = Number.parseInt(process.env['MERIDIAN_PORT'] ?? '8099', 10);
const HOST = '127.0.0.1';

/** Start the app. Pass `0` to bind an ephemeral port (useful in tests). */
export async function startMeridian(port?: number): Promise<MeridianHandle> {
  resetMembers();

  const requested = port ?? (Number.isFinite(DEFAULT_PORT) ? DEFAULT_PORT : 8099);
  const server: Server = createServer(createMeridianApp());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : requested;
  const url = `http://${HOST}:${boundPort}/meridian`;

  console.log(`Meridian Core listening on http://${HOST}:${boundPort}/meridian`);

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startMeridian().catch((err: unknown) => {
    console.error('[meridian] failed to start', err);
    process.exitCode = 1;
  });
}

