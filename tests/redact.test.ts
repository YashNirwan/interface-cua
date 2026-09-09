/**
 * Redaction. The product requirement and the compliance requirement pull in
 * opposite directions here, and the tests pin both ends: secrets and PII must
 * never survive into evidence, but a balance is the legitimate RETURN VALUE of
 * these capabilities and must survive intact.
 */
import { describe, expect, it } from 'vitest';
import { DefaultRedactor } from '../src/policy/redact.js';
import { loadPolicy } from '../src/policy/config.js';

const r = new DefaultRedactor(loadPolicy());

describe('text scrubbing', () => {
  it('removes an SSN', () => {
    const out = r.text('member ssn 123-45-6789 on file');
    expect(out).not.toContain('123-45-6789');
    expect(out).toContain('REDACTED');
  });

  it('removes a card number', () => {
    expect(r.text('card 4111 1111 1111 1111 declined')).not.toContain('4111');
  });

  it('removes a bearer token and an api key', () => {
    expect(r.text('Authorization: Bearer sk-ant-abc123456789xyz')).not.toContain('sk-ant-abc123456789xyz');
    expect(r.text('api_key=abcdef0123456789')).not.toContain('abcdef0123456789');
  });

  it('removes a password even when the label varies', () => {
    expect(r.text('password: Passw0rd!demo')).not.toContain('Passw0rd!demo');
    expect(r.text('PWD=hunter2hunter2')).not.toContain('hunter2hunter2');
  });

  it('DOES NOT scrub money amounts', () => {
    // Regression guard: balances are what these capabilities exist to return.
    // A redactor that eats them turns every successful run into a useless one.
    const line = 'Current Balance: $4,812.55 and $1,204.09';
    expect(r.text(line)).toBe(line);
  });

  it('leaves ordinary page furniture alone', () => {
    const line = 'Member Search — Riverton Main branch, status Active';
    expect(r.text(line)).toBe(line);
  });
});

describe('value redaction by declared sensitivity', () => {
  it('passes public values through unchanged', () => {
    expect(r.value('Active', 'public')).toBe('Active');
  });

  it('tokenizes identifiers so a log is correlatable but not disclosive', () => {
    const out = String(r.value('100482', 'identifier'));
    expect(out).not.toBe('100482');
    expect(out.startsWith('id:')).toBe(true);
  });

  it('fully redacts financial and PII values', () => {
    expect(r.value(4812.55, 'financial')).toBe('[REDACTED]');
    expect(r.value('Dana Whitfield', 'pii')).toBe('[REDACTED]');
  });

  it('never emits a secret in any form', () => {
    expect(r.value('Passw0rd!demo', 'secret')).toBe('[SECRET]');
  });
});

describe('shape', () => {
  it('describes a value without revealing it', () => {
    expect(r.shape('100482')).toBe('6 digits');
    expect(r.shape('')).toBe('empty');
    expect(r.shape(true)).toBe('boolean');
  });
});

describe('deep object scrubbing', () => {
  it('scrubs nested strings and arrays', () => {
    const out = r.object({ a: { b: ['ssn 123-45-6789'] } }) as { a: { b: string[] } };
    expect(out.a.b[0]).not.toContain('123-45-6789');
  });

  it('redacts by key name regardless of the value', () => {
    const out = r.object({ password: 'anything', cookie: 'sid=abc', nested: { apiKey: 'zzz' } }) as Record<string, unknown>;
    expect(out.password).toBe('[SECRET]');
    expect(out.cookie).toBe('[SECRET]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[SECRET]');
  });

  it('summarizes buffers instead of serializing page bytes into a log', () => {
    const out = r.object({ png: Buffer.from('abcd') }) as Record<string, unknown>;
    expect(String(out.png)).toMatch(/buffer/i);
  });

  it('survives a cycle', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(() => r.object(a)).not.toThrow();
  });

  it('does not mutate the caller’s object', () => {
    const original = { password: 'secret-value' };
    r.object(original);
    expect(original.password).toBe('secret-value');
  });
});
