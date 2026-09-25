import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DirectoryUnavailableError } from '../src/server/tenant-directory';

// Next's request APIs are replaced by plain fakes; the tests drive the Host header and the
// directory answer and assert which navigation (redirect / notFound) the page would take.
const state = vi.hoisted(() => ({
  host: null as string | null,
  resolve: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(state.host ? { host: state.host } : {})),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('../src/server/deps', () => ({
  bffDeps: () => ({
    directory: { resolve: state.resolve },
    baseDomain: 'salesmaker.test',
    scheme: 'https',
  }),
}));

const { requestWorkspace } = await import('../src/server/request-tenant');
const { requireApex, requireWorkspace } = await import('../src/server/guards');

const ACME = { tenantId: 't1', slug: 'acme', name: 'Acme', status: 'ACTIVE' };

describe('requestWorkspace', () => {
  beforeEach(() => {
    state.host = 'acme.salesmaker.test';
    state.resolve.mockReset();
  });

  it('classifies the apex without a directory lookup', async () => {
    state.host = 'salesmaker.test';
    expect(await requestWorkspace()).toEqual({ kind: 'apex' });
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it('treats a malformed or missing host as unknown', async () => {
    state.host = null;
    expect(await requestWorkspace()).toEqual({ kind: 'unknown' });
  });

  it('resolves a workspace host through the directory', async () => {
    state.resolve.mockResolvedValue(ACME);
    expect(await requestWorkspace()).toEqual({ kind: 'workspace', tenant: ACME });
    expect(state.resolve).toHaveBeenCalledWith('acme.salesmaker.test');
    state.resolve.mockResolvedValue(null);
    expect(await requestWorkspace()).toEqual({ kind: 'unknown' });
  });

  it('sends a directory outage to maintenance, never to a 404', async () => {
    state.resolve.mockRejectedValue(new DirectoryUnavailableError(new Error('down')));
    await expect(requestWorkspace()).rejects.toThrow('redirect:/maintenance');
    state.resolve.mockRejectedValue(new TypeError('bug'));
    await expect(requestWorkspace()).rejects.toThrow('bug');
  });
});

describe('page guards', () => {
  beforeEach(() => {
    state.resolve.mockReset();
  });

  it('requireWorkspace returns the tenant, or sends the apex to find-workspace, or 404s', async () => {
    state.host = 'acme.salesmaker.test';
    state.resolve.mockResolvedValue(ACME);
    expect(await requireWorkspace()).toEqual(ACME);
    state.host = 'salesmaker.test';
    await expect(requireWorkspace()).rejects.toThrow('redirect:/find-workspace');
    state.host = 'ghost.salesmaker.test';
    state.resolve.mockResolvedValue(null);
    await expect(requireWorkspace()).rejects.toThrow('notFound');
  });

  it('requireApex passes on the apex and forwards workspace hosts to it', async () => {
    state.host = 'salesmaker.test';
    expect(await requireApex('/signup')).toEqual({
      baseDomain: 'salesmaker.test',
      scheme: 'https',
    });
    state.host = 'acme.salesmaker.test';
    state.resolve.mockResolvedValue(ACME);
    await expect(requireApex('/signup')).rejects.toThrow('redirect:https://salesmaker.test/signup');
  });
});
