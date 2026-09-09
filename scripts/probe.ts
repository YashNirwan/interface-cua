/**
 * Development probe: drive the surface by hand and print what it perceives.
 * Not part of the product — this is the tool used to check that the
 * accessible-name cascade and frame walking actually work against the target.
 */
import { createSession } from '../src/runtime.js';

const steps = process.argv.slice(2);

const session = await createSession({ mode: 'discovery', headless: true, runId: 'probe' });
try {
  await session.surface.act({ type: 'navigate', uri: 'http://127.0.0.1:8099/meridian/login' });
  let obs = await session.surface.observe();
  console.log('--- LOGIN ---');
  for (const n of obs.nodes) console.log(`${n.ref}\t${n.role}\t${JSON.stringify(n.name)}\tsection=${n.section ?? '-'}\tframe=${n.framePath.join('>') || '(top)'}\tnameFrom=${n.hint?.nameFrom}`);

  const user = obs.nodes.find((n) => n.role === 'textbox' && /user/i.test(n.name));
  const pass = obs.nodes.find((n) => n.sensitive);
  const signon = obs.nodes.find((n) => n.role === 'button' && /sign on/i.test(n.name));
  console.log('\nresolved:', { user: user?.name, pass: pass?.name, signon: signon?.name });
  if (!user || !pass || !signon) throw new Error('login controls not perceived');

  await session.surface.act({ type: 'type', target: { ref: user.ref }, text: process.env.MERIDIAN_USER ?? 'demo.operator' });
  await session.surface.act({ type: 'type', target: { ref: pass.ref }, text: process.env.MERIDIAN_PASSWORD ?? 'Passw0rd!demo' });
  await session.surface.act({ type: 'click', target: { ref: signon.ref } });

  obs = await session.surface.observe();
  console.log('\n--- AFTER SIGN ON ---', obs.location.uri);
  const frames = new Set(obs.nodes.map((n) => n.framePath.join('>') || '(top)'));
  console.log('frames perceived:', [...frames]);
  for (const n of obs.nodes.slice(0, 40)) console.log(`${n.ref}\t${n.role}\t${JSON.stringify(n.name)}\tsection=${n.section ?? '-'}\tframe=${n.framePath.join('>') || '(top)'}`);

  if (steps.includes('member')) {
    await session.surface.act({ type: 'navigate', uri: 'http://127.0.0.1:8099/meridian/member/100482' });
    obs = await session.surface.observe();
    console.log('\n--- MEMBER 100482 ---');
    for (const n of obs.nodes) console.log(`${n.ref}\t${n.role}\t${JSON.stringify(n.name)}\tsection=${n.section ?? '-'}\tord=${n.ordinal}`);
    console.log('\nTEXT:', obs.text.slice(0, 600));
  }
} finally {
  await session.dispose();
}
