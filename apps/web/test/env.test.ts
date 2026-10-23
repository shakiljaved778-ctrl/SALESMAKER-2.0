import { describe, expect, it } from 'vitest';

import { webEnvProblems } from '../src/server/env';

describe('web environment check', () => {
  it('names missing and invalid variables, never their values', () => {
    expect(webEnvProblems({})).toEqual(['CONTROL_API_BASE_URL', 'WEB_BASE_DOMAIN']);
    expect(
      webEnvProblems({ CONTROL_API_BASE_URL: 'not a url', WEB_BASE_DOMAIN: 'salesmaker.test' }),
    ).toEqual(['CONTROL_API_BASE_URL']);
  });

  it('is empty when the required settings are valid', () => {
    expect(
      webEnvProblems({
        CONTROL_API_BASE_URL: 'https://cp.salesmaker.test',
        WEB_BASE_DOMAIN: 'salesmaker.test',
      }),
    ).toEqual([]);
  });
});
