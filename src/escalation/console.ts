/**
 * The operator console.
 *
 * This is deliberately a bare surface, not a co-browsing product. Its job is to
 * make the requirement literally true: a human sees why the run stopped, acts on
 * the SAME live session, and hands it back. Everything else is scope.
 *
 * The one non-obvious design decision is `POST /intervention/:id/act`.
 *
 * The naive version of "let a human take over" is "run the browser headed and
 * tell the operator to click". That works on a laptop and fails everywhere
 * else — in CI, in a container, on a remote worker, the session has no screen
 * for a person to reach. If human takeover only works when the browser is
 * headed, then the escalation path does not exist in production, which is the
 * only place it matters.
 *
 * So the console proxies actions into the live session: the operator picks a
 * control by role + accessible name (the same semantic vocabulary the artifacts
 * use — no selectors leak up here either), the console POSTs an `Action`, and
 * the broker executes it against the very surface the automation was using.
 * `GET /observe` gives them the refreshable view to act against. Same session,
 * same lease, same recorded evidence, no screen required.
 *
 * Guards: an act is refused with 409 unless the intervention is open/in_progress
 * AND the session lease is held by 'human'. The console cannot be used to elbow
 * the automation aside mid-step.
 *
 * NOTE on `surfaceFor`: whatever surface this returns is driven on the human's
 * behalf. If you hand it an automation-guarded surface wrapper, its lease
 * assertion will reject every operator action — by design. Pass the raw surface
 * (or one guarded for 'human'); the broker performs the holder check itself.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import express from 'express';
import type { Request, Response } from 'express';

import { UI_ROLES, type Action, type Observation, type TargetDescriptor, type UiRole, type Surface } from '../surface/types.js';
import { EscalationStateError, type InterventionRequest, type InterventionResolutionKind } from './types.js';
import type { LocalEscalationBroker } from './broker.js';

const DEFAULT_PORT = 7788;
/** Cap on nodes sent to the console. An operator cannot read 4000 rows anyway. */
const OBSERVE_NODE_LIMIT = 250;

export interface OperatorConsoleDeps {
  broker: LocalEscalationBroker;
  port?: number;
  /** Lets the console drive the same live session when the browser is headless. */
  surfaceFor?: (runId: string) => Surface | undefined;
}

export async function startOperatorConsole(deps: OperatorConsoleDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const { broker } = deps;
  const port = deps.port ?? DEFAULT_PORT;
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const defaultOperator = process.env['CUA_OPERATOR'] ?? 'operator@local';

  // -- list -----------------------------------------------------------------
  app.get('/', async (_req: Request, res: Response) => {
    const open = await broker.list({ status: ['open', 'in_progress'] });
    const recent = (await broker.list()).filter((r) => r.status === 'resolved' || r.status === 'abandoned').slice(-15).reverse();
    res.type('html').send(renderList(open, recent));
  });

  /** Poll target for the 2s refresh on the list page. */
  app.get('/api/interventions', async (_req: Request, res: Response) => {
    res.json(await broker.list());
  });

  // -- detail ---------------------------------------------------------------
  app.get('/intervention/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const request = await broker.get(id);
    if (!request) {
      res.status(404).type('html').send(page('not found', `<p class="err">no intervention <code>${esc(id)}</code></p><p><a href="/">back</a></p>`));
      return;
    }
    const resolution = broker.resolutionOf(id);
    res.type('html').send(renderDetail(request, defaultOperator, resolution?.kind, broker.leaseHolderOf(id)));
  });

  /** JSON view of the request, so the detail page can poll for "someone else resolved it". */
  app.get('/api/intervention/:id', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const request = await broker.get(id);
    if (!request) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ request, resolution: broker.resolutionOf(id) ?? null, humanActions: broker.humanActionsOf(id), leaseHolder: broker.leaseHolderOf(id) ?? null });
  });

  // -- live view of the session --------------------------------------------
  app.get('/intervention/:id/observe', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const request = await broker.get(id);
    if (!request) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      const obs = await broker.observeFor(id, deps.surfaceFor?.(request.runId));
      res.json(compactObservation(obs));
    } catch (err) {
      sendError(res, err);
    }
  });

  // -- the live-control proxy ----------------------------------------------
  app.post('/intervention/:id/act', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const request = await broker.get(id);
    if (!request) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body: unknown = req.body;
    const action = parseAction(isRecord(body) ? body['action'] : undefined);
    if (!action) {
      res.status(400).json({ error: 'bad_action', detail: 'expected { action: Action } using role+name descriptors' });
      return;
    }
    try {
      const result = await broker.actAsHuman(id, action, deps.surfaceFor?.(request.runId));
      res.json({ ok: result.ok, tier: result.tier ?? null, value: result.value ?? null, error: result.error ?? null });
    } catch (err) {
      sendError(res, err);
    }
  });

  // -- resolution -----------------------------------------------------------
  app.post('/intervention/:id/resolve', async (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: 'bad_body' });
      return;
    }
    const kind = body['kind'];
    if (typeof kind !== 'string' || !isResolutionKind(kind)) {
      res.status(400).json({ error: 'bad_kind' });
      return;
    }
    const operator = typeof body['operator'] === 'string' && body['operator'].trim() ? body['operator'].trim() : defaultOperator;
    const note = typeof body['note'] === 'string' && body['note'].trim() ? body['note'].trim() : undefined;
    try {
      const resolution = await broker.resolve(id, note === undefined ? { kind, operator } : { kind, operator, note });
      res.json(resolution);
    } catch (err) {
      sendError(res, err);
    }
  });

  // -- masked screenshots ---------------------------------------------------
  // The path is a wildcard because RunLogger returns a run-relative path that
  // may include a subdirectory (`captures/int_x.png`), not a bare filename.
  app.get('/screenshot/:runId/*', async (req: Request, res: Response) => {
    const runId = String(req.params['runId']);
    const rest = String((req.params as Record<string, unknown>)['0'] ?? '');
    // Path-traversal guard: resolve, then require the result to still live
    // inside this run's evidence directory. Never trust the URL to be tame —
    // this server may be reachable from an operator's laptop.
    const runDir = path.resolve(broker.evidenceRoot, runId);
    const target = path.resolve(runDir, rest);
    if (target !== runDir && !target.startsWith(runDir + path.sep)) {
      res.status(400).type('text/plain').send('bad path');
      return;
    }
    if (!/\.(png|jpg|jpeg)$/i.test(target)) {
      res.status(415).type('text/plain').send('images only');
      return;
    }
    try {
      const buf = await fs.readFile(target);
      res.type(target.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg').send(buf);
    } catch {
      res.status(404).type('text/plain').send('no such capture');
    }
  });

  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.on('error', reject);
  });

  const url = `http://localhost:${port}`;
  // Telling the broker a console exists is load-bearing: it disables the
  // non-interactive auto-resolve affordance, because a human *can* now answer.
  broker.attachConsole(url);

  return {
    url,
    close: async () => {
      broker.detachConsole();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isResolutionKind(s: string): s is InterventionResolutionKind {
  return s === 'resume' || s === 'skip' || s === 'approve' || s === 'abort';
}

function isUiRole(s: string): s is UiRole {
  return (UI_ROLES as readonly string[]).includes(s);
}

/**
 * Narrow untrusted JSON into an `Action`. Written out longhand rather than with
 * a schema library so the accepted shape is obvious at review time: only the
 * five verbs the console offers, and targets only by descriptor — there is no
 * way to smuggle a selector or a coordinate through this endpoint.
 */
function parseAction(v: unknown): Action | undefined {
  if (!isRecord(v)) return undefined;
  const type = v['type'];
  if (typeof type !== 'string') return undefined;

  if (type === 'navigate') {
    const uri = v['uri'];
    return typeof uri === 'string' && uri ? { type: 'navigate', uri } : undefined;
  }
  if (type === 'press') {
    const key = v['key'];
    return typeof key === 'string' && key ? { type: 'press', key } : undefined;
  }

  const target = parseTarget(v['target']);
  if (!target) return undefined;
  if (type === 'click') return { type: 'click', target: { descriptor: target } };
  if (type === 'read') return { type: 'read', target: { descriptor: target } };
  if (type === 'type') {
    const text = v['text'];
    return typeof text === 'string' ? { type: 'type', target: { descriptor: target }, text } : undefined;
  }
  if (type === 'select') {
    const value = v['value'];
    return typeof value === 'string' ? { type: 'select', target: { descriptor: target }, value } : undefined;
  }
  return undefined;
}

function parseTarget(v: unknown): TargetDescriptor | undefined {
  if (!isRecord(v)) return undefined;
  const inner = isRecord(v['descriptor']) ? v['descriptor'] : v;
  const role = inner['role'];
  const name = inner['name'];
  if (typeof role !== 'string' || !isUiRole(role)) return undefined;
  if (typeof name !== 'string' || !name) return undefined;
  const framePathRaw = inner['framePath'];
  const framePath = Array.isArray(framePathRaw) ? framePathRaw.filter((x): x is string => typeof x === 'string') : [];
  const d: TargetDescriptor = { role, name, nameMatch: 'normalized', framePath };
  const section = inner['section'];
  if (typeof section === 'string' && section) d.section = section;
  d.note = 'entered by operator via console';
  return d;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof EscalationStateError) {
    const status = err.code === 'not_found' ? 404 : 409;
    res.status(status).json({ error: err.code, detail: err.message });
    return;
  }
  res.status(500).json({ error: 'internal', detail: err instanceof Error ? err.message : String(err) });
}

/** Values are dropped, not shown: the operator drives the session, they do not need it echoed back through an HTTP endpoint. */
function compactObservation(obs: Observation): {
  location: { uri: string; title: string };
  capturedAt: string;
  degraded?: string;
  nodeCount: number;
  nodes: Array<{ role: string; name: string; section?: string; disabled?: boolean; sensitive?: boolean; frame?: string }>;
  text: string;
} {
  const out = {
    location: { uri: obs.location.uri, title: obs.location.title },
    capturedAt: obs.capturedAt,
    nodeCount: obs.nodes.length,
    nodes: obs.nodes.slice(0, OBSERVE_NODE_LIMIT).map((n) => {
      const row: { role: string; name: string; section?: string; disabled?: boolean; sensitive?: boolean; frame?: string } = { role: n.role, name: n.name };
      if (n.section) row.section = n.section;
      if (n.disabled) row.disabled = true;
      if (n.sensitive) row.sensitive = true;
      if (n.framePath.length) row.frame = n.framePath.join('>');
      return row;
    }),
    text: obs.text.replace(/\s+/g, ' ').trim().slice(0, 4000),
  };
  return obs.degraded ? { ...out, degraded: obs.degraded.reason } : out;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:#0e1013;color:#d6dae0;
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:#7fb2ff;text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a1;margin:0 0 18px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a1;margin:26px 0 8px;
  border-bottom:1px solid #23262d;padding-bottom:6px}
.wrap{max-width:1080px;margin:0 auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1c1f25;vertical-align:top}
th{color:#6d7480;font-weight:400;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
tr:hover td{background:#14171c}
code,pre{font-family:inherit}
pre{background:#131620;border:1px solid #23262d;border-radius:4px;padding:12px;
  overflow:auto;max-height:420px;color:#b9c0cb;margin:0}
.pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;border:1px solid #333842;color:#c9d0da}
.pill.open{border-color:#7a5d1e;background:#2a2110;color:#f0c060}
.pill.in_progress{border-color:#1e5a7a;background:#0f2230;color:#63b6e6}
.pill.resolved{border-color:#256b3f;background:#10251a;color:#61d195}
.pill.abandoned{border-color:#6b2525;background:#251010;color:#e08585}
.grid{display:grid;grid-template-columns:150px 1fr;gap:6px 16px;margin:0}
.grid dt{color:#6d7480}
.grid dd{margin:0;color:#d6dae0;word-break:break-word}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{border:1px solid #23262d;border-radius:5px;padding:14px;background:#111419}
.card h3{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8b93a1}
.exp{color:#8fd6a8}.obs{color:#e6b06a}
img.shot{max-width:100%;border:1px solid #23262d;border-radius:4px;display:block}
button{font:inherit;background:#1b2029;color:#d6dae0;border:1px solid #333a45;border-radius:4px;
  padding:7px 14px;cursor:pointer}
button:hover{background:#232a35;border-color:#4a5361}
button.primary{background:#1d3a26;border-color:#2f6b45;color:#8fe0ac}
button.danger{background:#3a1d1d;border-color:#6b2f2f;color:#e79a9a}
button:disabled{opacity:.4;cursor:not-allowed}
input,select,textarea{font:inherit;background:#0b0d11;color:#d6dae0;border:1px solid #2a2f38;
  border-radius:4px;padding:6px 8px;width:100%}
label{display:block;font-size:11px;color:#6d7480;margin:0 0 4px;letter-spacing:.05em;text-transform:uppercase}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.row>div{flex:1 1 130px}
.actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.err{color:#e08585}
.ok{color:#8fe0ac}
.muted{color:#6d7480}
#log{margin-top:10px;font-size:12px;max-height:150px;overflow:auto}
#log div{padding:2px 0;border-bottom:1px solid #1c1f25}
`;

function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function renderList(open: InterventionRequest[], recent: InterventionRequest[]): string {
  const rows = (rs: InterventionRequest[]): string =>
    rs.length
      ? rs
          .map(
            (r) => `<tr>
  <td><a href="/intervention/${esc(r.id)}">${esc(r.id)}</a></td>
  <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
  <td>${esc(r.reason)}</td>
  <td>${esc(r.summary)}</td>
  <td class="muted">${esc(r.context.stepId ?? '-')}</td>
  <td class="muted">${esc(r.raisedAt)}</td>
</tr>`,
          )
          .join('')
      : `<tr><td colspan="6" class="muted">none</td></tr>`;

  const body = `<h1>operator console</h1>
<h2>awaiting a human</h2>
<table><thead><tr><th>id</th><th>status</th><th>reason</th><th>summary</th><th>step</th><th>raised</th></tr></thead>
<tbody id="open">${rows(open)}</tbody></table>
<h2>recently closed</h2>
<table><thead><tr><th>id</th><th>status</th><th>reason</th><th>summary</th><th>step</th><th>raised</th></tr></thead>
<tbody>${rows(recent)}</tbody></table>
<p class="muted">polling every 2s</p>`;

  // Plain fetch poll. No framework, no build step — this page has to work from
  // a cold checkout on an operator's machine.
  const script = `
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let last='';
async function poll(){
  try{
    const rs=await (await fetch('/api/interventions')).json();
    const open=rs.filter(r=>r.status==='open'||r.status==='in_progress');
    const html=open.length?open.map(r=>'<tr><td><a href="/intervention/'+esc(r.id)+'">'+esc(r.id)+'</a></td><td><span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span></td><td>'+esc(r.reason)+'</td><td>'+esc(r.summary)+'</td><td class="muted">'+esc(r.context.stepId||'-')+'</td><td class="muted">'+esc(r.raisedAt)+'</td></tr>').join(''):'<tr><td colspan="6" class="muted">none</td></tr>';
    if(html!==last){document.getElementById('open').innerHTML=html;last=html;}
  }catch(e){}
}
poll();setInterval(poll,2000);`;
  return page('operator console', body, script);
}

function renderDetail(
  r: InterventionRequest,
  defaultOperator: string,
  resolvedKind: InterventionResolutionKind | undefined,
  leaseHolder: 'automation' | 'human' | undefined,
): string {
  const c = r.context;
  const terminal = r.status === 'resolved' || r.status === 'abandoned';
  const shotUrl = c.screenshot ? `/screenshot/${encodeURIComponent(r.runId)}/${c.screenshot.split('/').map(encodeURIComponent).join('/')}` : undefined;

  const facts = `<dl class="grid">
<dt>id</dt><dd>${esc(r.id)}</dd>
<dt>run</dt><dd>${esc(r.runId)}</dd>
<dt>status</dt><dd><span class="pill ${esc(r.status)}">${esc(r.status)}</span>${resolvedKind ? ` <span class="muted">(${esc(resolvedKind)})</span>` : ''}</dd>
<dt>reason</dt><dd>${esc(r.reason)}</dd>
<dt>mode</dt><dd>${esc(c.mode)}</dd>
<dt>capability</dt><dd>${esc(c.capabilityId ?? '-')}${c.capabilityVersion ? ` @ ${esc(c.capabilityVersion)}` : ''}</dd>
<dt>goal</dt><dd>${esc(c.goal ?? '-')}</dd>
<dt>step</dt><dd>${esc(c.stepId ?? '-')}${c.stepIntent ? ` — ${esc(c.stepIntent)}` : ''}</dd>
<dt>location</dt><dd>${esc(c.location.title)}<br><span class="muted">${esc(c.location.uri)}</span></dd>
<dt>session held by</dt><dd>${leaseHolder ? `<span class="pill ${leaseHolder === 'human' ? 'in_progress' : 'open'}">${esc(leaseHolder)}</span>` : '<span class="muted">not live in this process</span>'}</dd>
<dt>raised</dt><dd>${esc(r.raisedAt)}</dd>
</dl>`;

  const expectedObserved = `<div class="two">
<div class="card"><h3>expected</h3><div class="exp">${esc(c.expected ?? '—')}</div></div>
<div class="card"><h3>observed</h3><div class="obs">${esc(c.observed ?? '—')}</div></div>
</div>`;

  const shot = shotUrl
    ? `<h2>screenshot (sensitive fields masked)</h2><img class="shot" src="${esc(shotUrl)}" alt="masked screenshot at the point of escalation">`
    : `<h2>screenshot</h2><p class="muted">no capture was written for this escalation</p>`;

  const snapshot = `<h2>semantic snapshot</h2><pre>${esc(c.snapshot ?? 'none')}</pre>`;

  const roleOptions = UI_ROLES.map((role) => `<option value="${esc(role)}"${role === 'button' ? ' selected' : ''}>${esc(role)}</option>`).join('');

  const actPanel = terminal
    ? ''
    : `<h2>act on the live session</h2>
<p class="muted">You hold the session. Actions below run against the same browser context the automation was using — pick a control the way the flow does, by role and accessible name.</p>
<div class="card">
  <div class="row">
    <div><label for="act">action</label><select id="act">
      <option value="click">click</option><option value="type">type</option>
      <option value="select">select</option><option value="press">press</option>
      <option value="navigate">navigate</option></select></div>
    <div><label for="role">role</label><select id="role">${roleOptions}</select></div>
    <div style="flex:2 1 260px"><label for="name">accessible name</label><input id="name" placeholder="Continue"></div>
    <div style="flex:2 1 260px"><label for="value">value / key / uri</label><input id="value" placeholder=""></div>
    <div style="flex:0 0 auto"><button id="send">Send</button></div>
  </div>
  <div class="row" style="margin-top:10px">
    <div style="flex:2 1 260px"><label for="section">section (optional)</label><input id="section" placeholder="Payment details"></div>
    <div style="flex:0 0 auto"><button id="refresh">Refresh view</button></div>
  </div>
  <div id="log"></div>
</div>
<h2>current view of the session</h2>
<pre id="obs">click Refresh to read the live session…</pre>`;

  const resolvePanel = terminal
    ? `<h2>resolution</h2><p class="muted">this intervention is ${esc(r.status)}; the session has already been handed back</p>`
    : `<h2>hand control back</h2>
<div class="card">
  <div class="row">
    <div><label for="operator">operator</label><input id="operator" value="${esc(defaultOperator)}"></div>
    <div style="flex:3 1 400px"><label for="note">note (what did you do, and why)</label><input id="note" placeholder="cleared the stale modal and re-selected the branch"></div>
  </div>
  <div class="actions">
    ${r.allowedResolutions.map((k) => `<button class="res ${k === 'abort' ? 'danger' : k === 'approve' || k === 'resume' ? 'primary' : ''}" data-kind="${esc(k)}">${esc(k)}</button>`).join('')}
  </div>
  <p class="muted">allowed here: ${esc(r.allowedResolutions.join(', '))} — the run decided which answers it can honour</p>
  <div id="resmsg"></div>
</div>`;

  const body = `<p><a href="/">&larr; all interventions</a></p>
<h1>${esc(r.summary)}</h1>
${facts}
<h2>expected vs observed</h2>
${expectedObserved}
${shot}
${snapshot}
${actPanel}
${resolvePanel}`;

  const script = `
const ID=${JSON.stringify(r.id)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const logEl=document.getElementById('log');
function log(msg,cls){ if(!logEl) return; const d=document.createElement('div'); d.className=cls||''; d.textContent=new Date().toISOString().slice(11,19)+'  '+msg; logEl.prepend(d); }
function descriptor(){
  const d={role:document.getElementById('role').value,name:document.getElementById('name').value,nameMatch:'normalized',framePath:[]};
  const s=document.getElementById('section').value; if(s) d.section=s; return d;
}
function buildAction(){
  const t=document.getElementById('act').value, v=document.getElementById('value').value;
  if(t==='navigate') return {type:'navigate',uri:v};
  if(t==='press') return {type:'press',key:v};
  if(t==='type') return {type:'type',target:{descriptor:descriptor()},text:v};
  if(t==='select') return {type:'select',target:{descriptor:descriptor()},value:v};
  return {type:'click',target:{descriptor:descriptor()}};
}
async function send(){
  const a=buildAction();
  const btn=document.getElementById('send'); btn.disabled=true;
  try{
    const res=await fetch('/intervention/'+ID+'/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a})});
    const j=await res.json();
    if(!res.ok){ log('REFUSED '+res.status+' '+(j.error||'')+' '+(j.detail||''),'err'); }
    else if(j.ok){ log('ok '+a.type+(j.tier?' via '+j.tier:'')+(j.value?' -> '+j.value:''),'ok'); await refresh(); }
    else { log('failed: '+(j.error?j.error.class+': '+j.error.message:'unknown'),'err'); }
  }catch(e){ log('network error: '+e,'err'); }
  finally{ btn.disabled=false; }
}
async function refresh(){
  const pre=document.getElementById('obs'); if(!pre) return;
  try{
    const res=await fetch('/intervention/'+ID+'/observe');
    const j=await res.json();
    if(!res.ok){ pre.textContent='cannot read session: '+(j.detail||j.error); return; }
    const lines=[j.location.title+'  —  '+j.location.uri,''];
    if(j.degraded) lines.push('DEGRADED: '+j.degraded,'');
    lines.push('CONTROLS ('+j.nodeCount+'):');
    for(const n of j.nodes){
      lines.push('  '+n.role.padEnd(9)+' "'+n.name+'"'+(n.section?'   section='+n.section:'')+(n.frame?'   frame='+n.frame:'')+(n.disabled?'   [disabled]':'')+(n.sensitive?'   [sensitive]':''));
    }
    lines.push('','TEXT:','  '+j.text);
    pre.textContent=lines.join('\\n');
  }catch(e){ pre.textContent='cannot read session: '+e; }
}
async function resolveWith(kind){
  const msg=document.getElementById('resmsg');
  document.querySelectorAll('button.res').forEach(b=>b.disabled=true);
  try{
    const res=await fetch('/intervention/'+ID+'/resolve',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({kind:kind,operator:document.getElementById('operator').value,note:document.getElementById('note').value})});
    const j=await res.json();
    if(!res.ok){ msg.innerHTML='<p class="err">'+esc(j.error+': '+(j.detail||''))+'</p>'; document.querySelectorAll('button.res').forEach(b=>b.disabled=false); return; }
    msg.innerHTML='<p class="ok">resolved as '+esc(j.kind)+' by '+esc(j.operator)+'; control handed back to the automation ('+j.humanActions.length+' human actions recorded)</p>';
    setTimeout(()=>location.reload(),900);
  }catch(e){ msg.innerHTML='<p class="err">'+esc(String(e))+'</p>'; document.querySelectorAll('button.res').forEach(b=>b.disabled=false); }
}
document.getElementById('send')?.addEventListener('click',send);
document.getElementById('refresh')?.addEventListener('click',refresh);
document.querySelectorAll('button.res').forEach(b=>b.addEventListener('click',()=>resolveWith(b.dataset.kind)));
if(document.getElementById('obs')) refresh();`;

  return page(`${r.id} — ${r.reason}`, body, script);
}
