import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRequestGuard,
  injectToken,
  securityHeaders,
  TOKEN_HEADER,
} from '../src/request-guard.ts';
import type { GuardRequest } from '../src/request-guard.ts';

const PORT = 8742;
const TOKEN = 'jeton-de-test-0123456789';

function guard(extra: { extraHosts?: string[] } = {}) {
  return createRequestGuard({ port: PORT, token: TOKEN, ...extra });
}

function req(
  method: string,
  headers: Record<string, string | string[]>,
): GuardRequest {
  return { method, headers };
}

const SAME = `127.0.0.1:${PORT}`;

test('GET same-origin sans Origin : accepté', () => {
  assert.equal(guard().check(req('GET', { host: SAME })).ok, true);
});

test('POST légitime (Origin + jeton) : accepté', () => {
  const v = guard().check(
    req('POST', {
      host: SAME,
      origin: `http://${SAME}`,
      'sec-fetch-site': 'same-origin',
      [TOKEN_HEADER]: TOKEN,
    }),
  );
  assert.equal(v.ok, true);
});

test('client non navigateur (sans Origin) avec jeton : accepté', () => {
  const v = guard().check(req('PUT', { host: SAME, [TOKEN_HEADER]: TOKEN }));
  assert.equal(v.ok, true);
});

test('S1 : POST depuis un site tiers (text/plain, sans jeton) : refusé', () => {
  const v = guard().check(
    req('POST', {
      host: SAME,
      origin: 'https://attaquant-evil.example',
      'content-type': 'text/plain',
      'sec-fetch-site': 'cross-site',
    }),
  );
  assert.deepEqual(v.ok, false);
  if (!v.ok) assert.equal(v.status, 403);
});

test('S1 : Origin tiers seul (sans Sec-Fetch-Site) : refusé même avec jeton', () => {
  const v = guard().check(
    req('PUT', {
      host: SAME,
      origin: 'https://attaquant-evil.example',
      [TOKEN_HEADER]: TOKEN,
    }),
  );
  assert.equal(v.ok, false);
});

test('S1 : DNS rebinding (Host attaquant) : 421', () => {
  const v = guard().check(
    req('GET', { host: 'attaquant.example', origin: 'http://attaquant.example' }),
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.status, 421);
});

test('Host avec mauvais port : 421', () => {
  const v = guard().check(req('GET', { host: '127.0.0.1:9999' }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.status, 421);
});

test('Host absent : 421', () => {
  const v = guard().check(req('GET', {}));
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.status, 421);
});

test('Host en majuscules et localhost / [::1] : acceptés', () => {
  const g = guard();
  assert.equal(g.check(req('GET', { host: `LOCALHOST:${PORT}` })).ok, true);
  assert.equal(g.check(req('GET', { host: `[::1]:${PORT}` })).ok, true);
});

test('Origin « null » (iframe sandboxée) : refusé', () => {
  const v = guard().check(req('GET', { host: SAME, origin: 'null' }));
  assert.equal(v.ok, false);
});

test('autre service localhost (same-site) : refusé', () => {
  const v = guard().check(
    req('GET', {
      host: SAME,
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-site',
    }),
  );
  assert.equal(v.ok, false);
});

test('Sec-Fetch-Site: none (saisie dans la barre d’adresse) : accepté', () => {
  const v = guard().check(req('GET', { host: SAME, 'sec-fetch-site': 'none' }));
  assert.equal(v.ok, true);
});

test('GET cross-site : refusé', () => {
  const v = guard().check(
    req('GET', { host: SAME, 'sec-fetch-site': 'cross-site' }),
  );
  assert.equal(v.ok, false);
});

test('POST same-origin sans jeton : refusé', () => {
  const v = guard().check(
    req('POST', { host: SAME, origin: `http://${SAME}`, 'sec-fetch-site': 'same-origin' }),
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.status, 403);
});

test('POST avec mauvais jeton (même longueur, longueur différente) : refusé sans exception', () => {
  const g = guard();
  const sameLength = 'x'.repeat(TOKEN.length);
  assert.equal(
    g.check(req('POST', { host: SAME, [TOKEN_HEADER]: sameLength })).ok,
    false,
  );
  assert.equal(
    g.check(req('POST', { host: SAME, [TOKEN_HEADER]: 'court' })).ok,
    false,
  );
});

test('DELETE et OPTIONS exigent aussi le jeton', () => {
  const g = guard();
  assert.equal(g.check(req('DELETE', { host: SAME })).ok, false);
  assert.equal(g.check(req('OPTIONS', { host: SAME })).ok, false);
  assert.equal(
    g.check(req('DELETE', { host: SAME, [TOKEN_HEADER]: TOKEN })).ok,
    true,
  );
});

test('en-têtes dupliqués (tableau) : refusés', () => {
  const g = guard();
  assert.equal(g.check(req('GET', { host: [SAME, SAME] })).ok, false);
  assert.equal(
    g.check(req('GET', { host: SAME, origin: [`http://${SAME}`, 'http://x'] })).ok,
    false,
  );
  assert.equal(
    g.check(req('POST', { host: SAME, [TOKEN_HEADER]: [TOKEN, TOKEN] })).ok,
    false,
  );
});

test('port fourni par fonction (listen sur le port 0)', () => {
  let port = 0;
  const g = createRequestGuard({ port: () => port, token: TOKEN });
  port = 51234;
  assert.equal(g.check(req('GET', { host: '127.0.0.1:51234' })).ok, true);
  assert.equal(g.check(req('GET', { host: '127.0.0.1:0' })).ok, false);
});

test('extraHosts : nom explicite accepté, autre refusé', () => {
  const g = guard({ extraHosts: ['uchi.local'] });
  assert.equal(g.check(req('GET', { host: `uchi.local:${PORT}` })).ok, true);
  assert.equal(g.check(req('GET', { host: `autre.local:${PORT}` })).ok, false);
});

test('jeton aléatoire par défaut : unique, 43 caractères base64url', () => {
  const a = createRequestGuard({ port: PORT });
  const b = createRequestGuard({ port: PORT });
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
});

test('les raisons de refus ne divulguent aucun chemin', () => {
  const v = guard().check(req('POST', { host: SAME }));
  if (!v.ok) assert.doesNotMatch(v.reason, /[\\/]|[A-Z]:/);
});

test('injectToken : avant </head>, ou en tête si absent', () => {
  assert.equal(
    injectToken('<head><title>x</title></head><body></body>', 'T'),
    '<head><title>x</title><meta name="uchi-token" content="T"></head><body></body>',
  );
  assert.equal(
    injectToken('<p>x</p>', 'T'),
    '<meta name="uchi-token" content="T"><p>x</p>',
  );
});

test('securityHeaders : jeu attendu, en minuscules', () => {
  const h = securityHeaders();
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.match(h['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  for (const name of Object.keys(h)) assert.equal(name, name.toLowerCase());
});