import { describe, expect, test } from 'vitest';
import {
  UpdateService,
  compareVersions,
  judgeVerification,
  parseManifest,
  type UpdateBackend,
  type UpdateManifest,
  type UpdateState,
  type VerifyReport,
} from '../src';

const SHA = 'a'.repeat(64);

function manifestJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    product: 'atlas',
    version: '0.86.0',
    downloadUrl: 'https://github.com/x/y/releases/download/v0.86.0/Atlas_0.86.0_x64-setup.exe',
    sha256: SHA,
    sizeBytes: 1000,
    releaseNotes: ['Faster replies', 'Fixed a crash'],
    mandatory: false,
    ...over,
  });
}

const goodReport: VerifyReport = {
  sha256: SHA,
  sizeBytes: 1000,
  product: 'Atlas',
  version: '0.86.0',
  signature: 'unsigned',
};

function fakeBackend(over: Partial<UpdateBackend> = {}) {
  const calls: string[] = [];
  const backend: UpdateBackend = {
    fetchManifest: async () => manifestJson(),
    download: async (_url, onProgress) => {
      calls.push('download');
      onProgress(500, 1000);
      onProgress(1000, 1000);
      return { path: 'pkg', sizeBytes: 1000 };
    },
    cancelDownload: async () => {
      calls.push('cancel');
    },
    verify: async () => {
      calls.push('verify');
      return goodReport;
    },
    install: async () => {
      calls.push('install');
    },
    restart: async () => {
      calls.push('restart');
    },
    startupStatus: async () => ({ outcome: 'none' }),
    confirmLaunch: async () => {
      calls.push('confirm');
    },
    ...over,
  };
  return { backend, calls };
}

function service(backend: UpdateBackend, over: Record<string, unknown> = {}) {
  const svc = new UpdateService({
    backend,
    manifestUrl: 'https://example.com/latest.json',
    product: 'atlas',
    currentVersion: '0.85.0',
    policy: { requireSignature: false, expectedProduct: 'Atlas' },
    ...over,
  });
  const seen: UpdateState['status'][] = [];
  svc.subscribe((s) => seen.push(s.status));
  return { svc, seen };
}

describe('versions', () => {
  test('ordering', () => {
    expect(compareVersions('0.86.0', '0.85.0')).toBe(1);
    expect(compareVersions('0.85.0', '0.85.0')).toBe(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('nope', '1.0.0')).toBeNull();
  });
});

describe('parseManifest', () => {
  test('accepts a complete manifest', () => {
    const r = parseManifest(manifestJson(), 'atlas');
    expect(r.ok).toBe(true);
  });

  test.each([
    ['not json', 'nope'],
    ['no hash', manifestJson({ sha256: undefined })],
    ['short hash', manifestJson({ sha256: 'abc' })],
    ['http link', manifestJson({ downloadUrl: 'http://example.com/a.exe' })],
    ['file link', manifestJson({ downloadUrl: 'file:///C:/a.exe' })],
    ['bad version', manifestJson({ version: 'latest' })],
    ['wrong product', manifestJson({ product: 'novacut' })],
    ['negative size', manifestJson({ sizeBytes: -5 })],
    ['odd signature', manifestJson({ signature: { algorithm: 'rsa', keyId: 'k', value: 'v' } })],
  ])('refuses %s', (_name, input) => {
    expect(parseManifest(input, 'atlas').ok).toBe(false);
  });

  test('caps and cleans release notes', () => {
    const r = parseManifest(
      manifestJson({ releaseNotes: ['  a  ', '', 5, ...Array(30).fill('x')] }),
    );
    expect(r.ok && r.manifest.releaseNotes.length).toBe(12);
    expect(r.ok && r.manifest.releaseNotes[0]).toBe('a');
  });
});

describe('judgeVerification — every check must pass', () => {
  const manifest = (parseManifest(manifestJson()) as { ok: true; manifest: UpdateManifest })
    .manifest;
  const policy = { requireSignature: false, expectedProduct: 'Atlas' };

  test('a matching package passes', async () => {
    expect((await judgeVerification(goodReport, manifest, policy)).ok).toBe(true);
  });

  test.each([
    ['wrong hash', { sha256: 'b'.repeat(64) }],
    ['wrong size', { sizeBytes: 999 }],
    ['wrong product', { product: 'SomethingElse' }],
    ['unreadable product', { product: null }],
    ['wrong version', { version: '0.85.0' }],
    ['unreadable version', { version: null }],
    ['broken signature', { signature: 'invalid' as const }],
  ])('refuses %s', async (_n, over) => {
    const v = await judgeVerification({ ...goodReport, ...over }, manifest, policy);
    expect(v.ok).toBe(false);
  });

  test('an unsigned installer passes only while signing is not required', async () => {
    expect((await judgeVerification(goodReport, manifest, policy)).ok).toBe(true);
    const strict = { ...policy, requireSignature: true };
    expect((await judgeVerification(goodReport, manifest, strict)).ok).toBe(false);
    expect(
      (await judgeVerification({ ...goodReport, signature: 'valid' }, manifest, strict)).ok,
    ).toBe(true);
  });

  test('a manifest signature is checked when a verifier is configured, ignored when not', async () => {
    const signed = {
      ...manifest,
      signature: { algorithm: 'ed25519' as const, keyId: 'k', value: 'v' },
    };
    expect((await judgeVerification(goodReport, signed, policy)).ok).toBe(true);
    expect((await judgeVerification(goodReport, signed, policy, { verify: () => false })).ok).toBe(
      false,
    );
    expect(
      (
        await judgeVerification(goodReport, signed, policy, {
          verify: () => {
            throw new Error('boom');
          },
        })
      ).ok,
    ).toBe(false);
    expect((await judgeVerification(goodReport, signed, policy, { verify: () => true })).ok).toBe(
      true,
    );
  });
});

describe('the service', () => {
  test('a newer version is offered, an equal or older one is not', async () => {
    const { backend } = fakeBackend();
    expect(await service(backend).svc.checkForUpdate()).toBe('available');

    const same = fakeBackend({ fetchManifest: async () => manifestJson({ version: '0.85.0' }) });
    expect(await service(same.backend).svc.checkForUpdate()).toBe('up-to-date');

    const older = fakeBackend({ fetchManifest: async () => manifestJson({ version: '0.80.0' }) });
    expect(await service(older.backend).svc.checkForUpdate()).toBe('up-to-date');
  });

  test('a silent check stays silent when the network is down; a manual one says so', async () => {
    const { backend } = fakeBackend({
      fetchManifest: async () => {
        throw new Error('offline');
      },
    });
    const a = service(backend);
    expect(await a.svc.checkForUpdate()).toBe('error');
    expect(a.svc.getState().status).toBe('hidden');

    const b = service(backend);
    expect(await b.svc.checkForUpdate({ manual: true })).toBe('error');
    expect(b.svc.getState()).toMatchObject({ status: 'failed', stage: 'check' });
  });

  test('a garbage manifest is an error, never an update', async () => {
    const { backend } = fakeBackend({ fetchManifest: async () => '<html>404</html>' });
    const { svc } = service(backend);
    expect(await svc.checkForUpdate({ manual: true })).toBe('error');
    expect(svc.getState().status).toBe('failed');
  });

  test('too old to update in place is explained, not attempted', async () => {
    const { backend } = fakeBackend({
      fetchManifest: async () => manifestJson({ minimumVersion: '0.90.0' }),
    });
    const { svc } = service(backend);
    await svc.checkForUpdate({ manual: true });
    expect(svc.getState()).toMatchObject({ status: 'failed', stage: 'check' });
  });

  test('the full flow runs every step in order and passes through every state', async () => {
    const { backend, calls } = fakeBackend();
    const { svc, seen } = service(backend);
    await svc.checkForUpdate();
    await svc.update();
    expect(calls).toEqual(['download', 'verify', 'install', 'restart']);
    expect(seen).toEqual([
      'available',
      'downloading',
      'downloading',
      'downloading',
      'verifying',
      'installing',
      'restarting',
    ]);
  });

  test('progress carries the numbers', async () => {
    const { backend } = fakeBackend();
    const { svc } = service(backend);
    const progress: number[] = [];
    svc.subscribe((s) => {
      if (s.status === 'downloading') progress.push(s.received);
    });
    await svc.checkForUpdate();
    await svc.update();
    expect(progress).toEqual([0, 500, 1000]);
  });

  test('a failed verification stops before install — nothing is run', async () => {
    const { backend, calls } = fakeBackend({
      verify: async () => ({ ...goodReport, sha256: 'b'.repeat(64) }),
    });
    const { svc } = service(backend);
    await svc.checkForUpdate();
    await svc.update();
    expect(calls).toEqual(['download']);
    expect(svc.getState()).toMatchObject({ status: 'failed', stage: 'verify' });
  });

  test('an installer for another product or version is never installed', async () => {
    for (const over of [{ product: 'NovaCut' }, { version: '0.99.0' }]) {
      const { backend, calls } = fakeBackend({ verify: async () => ({ ...goodReport, ...over }) });
      const { svc } = service(backend);
      await svc.checkForUpdate();
      await svc.update();
      expect(calls).not.toContain('install');
      expect(calls).not.toContain('restart');
    }
  });

  test('a failed download is reported, and Try again re-enters at the download', async () => {
    let attempts = 0;
    const { backend, calls } = fakeBackend({
      download: async () => {
        attempts++;
        if (attempts === 1) throw new Error('connection reset');
        calls.push('download');
        return { path: 'pkg', sizeBytes: 1000 };
      },
    });
    const { svc } = service(backend);
    await svc.checkForUpdate();
    await svc.update();
    expect(svc.getState()).toMatchObject({ status: 'failed', stage: 'download' });
    await svc.retry();
    expect(calls).toEqual(['download', 'verify', 'install', 'restart']);
  });

  test('a failed install is reported and the app is not closed', async () => {
    const { backend, calls } = fakeBackend({
      install: async () => {
        throw new Error('disk full');
      },
    });
    const { svc } = service(backend);
    await svc.checkForUpdate();
    await svc.update();
    expect(calls).not.toContain('restart');
    expect(svc.getState()).toMatchObject({ status: 'failed', stage: 'install' });
  });

  test('cancelling a download returns to "available"', async () => {
    let release: () => void = () => {};
    const { backend } = fakeBackend({
      download: () =>
        new Promise((_res, rej) => {
          release = () => rej(new Error('cancelled'));
        }),
      cancelDownload: async () => release(),
    });
    const { svc } = service(backend);
    await svc.checkForUpdate();
    const running = svc.update();
    await Promise.resolve();
    await svc.cancel();
    await running;
    expect(svc.getState().status).toBe('available');
  });

  test('Later hides this version, and only this version', async () => {
    const stored: { v: string | null } = { v: null };
    const memory = {
      dismissedVersion: async () => stored.v,
      dismiss: async (v: string) => {
        stored.v = v;
      },
    };
    const first = service(fakeBackend().backend, { memory });
    await first.svc.checkForUpdate();
    await first.svc.dismiss();
    expect(first.svc.getState().status).toBe('hidden');

    // a later launch, same version: still hidden
    const second = service(fakeBackend().backend, { memory });
    expect(await second.svc.checkForUpdate()).toBe('dismissed');

    // pressing "Check for updates" always shows it
    expect(await second.svc.checkForUpdate({ manual: true })).toBe('available');

    // a newer version is offered again
    const third = service(
      fakeBackend({ fetchManifest: async () => manifestJson({ version: '0.87.0' }) }).backend,
      { memory },
    );
    expect(await third.svc.checkForUpdate()).toBe('available');
  });

  test('a mandatory update has no Later and ignores an old one', async () => {
    const memory = { dismissedVersion: async () => '0.86.0', dismiss: async () => {} };
    const { backend } = fakeBackend({
      fetchManifest: async () => manifestJson({ mandatory: true }),
    });
    const { svc } = service(backend, { memory });
    expect(await svc.checkForUpdate()).toBe('available');
    await svc.dismiss();
    expect(svc.getState().status).toBe('available');
  });

  test('after a restart: updated is announced and the launch confirmed', async () => {
    const { backend, calls } = fakeBackend({
      startupStatus: async () => ({
        outcome: 'updated',
        fromVersion: '0.85.0',
        toVersion: '0.86.0',
      }),
    });
    const { svc } = service(backend, { currentVersion: '0.86.0' });
    await svc.announceStartup();
    expect(svc.getState()).toMatchObject({ status: 'complete', version: '0.86.0' });
    expect(calls).toContain('confirm');
  });

  test('after a rollback: the failure is shown as rolled back', async () => {
    const { backend } = fakeBackend({
      startupStatus: async () => ({
        outcome: 'rolled-back',
        fromVersion: '0.85.0',
        toVersion: '0.86.0',
      }),
    });
    const { svc } = service(backend);
    await svc.announceStartup();
    expect(svc.getState()).toMatchObject({ status: 'failed', rolledBack: true });
  });

  test('an ordinary launch just confirms and shows nothing', async () => {
    const { backend, calls } = fakeBackend();
    const { svc } = service(backend);
    await svc.announceStartup();
    expect(svc.getState().status).toBe('hidden');
    expect(calls).toContain('confirm');
  });
});
