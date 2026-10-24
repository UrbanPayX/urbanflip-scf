import { describe, expect, it } from 'vitest';
import { PASSPHRASES, parseFragment, parseOrigin } from '../src/params';

const FULL = '#investor=inv-42&deal=UF42&session=tok.abc&network=public&parent=https%3A%2F%2Fapp.urbanflip.io&lang=en';

describe('parseFragment', () => {
  it('reads every param from the fragment', () => {
    const r = parseFragment(FULL);
    expect(r).toEqual({
      ok: true,
      params: {
        investorId: 'inv-42',
        dealId: 'UF42',
        session: 'tok.abc',
        network: 'public',
        networkPassphrase: PASSPHRASES.public,
        parentOrigin: 'https://app.urbanflip.io',
        lang: 'en',
      },
    });
  });

  it('defaults network to testnet and lang to es; unknown lang falls back to es', () => {
    const r = parseFragment('#investor=i&deal=d&session=s&parent=https://app.urbanflip.io&lang=fr');
    expect(r.ok && r.params.network).toBe('testnet');
    expect(r.ok && r.params.networkPassphrase).toBe(PASSPHRASES.testnet);
    expect(r.ok && r.params.lang).toBe('es');
  });

  it('keeps a literal "+" and decodes percent-escapes in the session token', () => {
    const r = parseFragment('#investor=i&deal=d&session=a+b%2Fc%3D&parent=https://app.urbanflip.io');
    expect(r.ok && r.params.session).toBe('a+b/c=');
  });

  it('lists every missing or invalid param and keeps a valid parent for reporting', () => {
    const r = parseFragment('#deal=bad%20id&network=mainnet&parent=https://app.urbanflip.io&lang=en');
    expect(r).toEqual({
      ok: false,
      lang: 'en',
      invalid: ['investor', 'deal', 'session', 'network'],
      parentOrigin: 'https://app.urbanflip.io',
      investorId: '',
      dealId: 'bad id',
    });
  });

  it('rejects an empty fragment', () => {
    const r = parseFragment('');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.invalid).toEqual(['investor', 'deal', 'session', 'parent']);
  });

  it('rejects a session token with whitespace', () => {
    const r = parseFragment('#investor=i&deal=d&session=a%20b&parent=https://app.urbanflip.io');
    expect(!r.ok && r.invalid).toEqual(['session']);
  });
});

describe('parseOrigin', () => {
  it('accepts exact https origins and http only on localhost', () => {
    expect(parseOrigin('https://app.urbanflip.io')).toBe('https://app.urbanflip.io');
    expect(parseOrigin('https://urbanflip.bubbleapps.io:8443')).toBe('https://urbanflip.bubbleapps.io:8443');
    expect(parseOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(parseOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it.each([
    ['*'],
    ['null'],
    [''],
    ['https://app.urbanflip.io/'],
    ['https://app.urbanflip.io/dashboard'],
    ['https://app.urbanflip.io?x=1'],
    ['http://app.urbanflip.io'],
    ['javascript:alert(1)'],
    ['app.urbanflip.io'],
  ])('rejects %j', (value) => {
    expect(parseOrigin(value)).toBeUndefined();
  });
});
