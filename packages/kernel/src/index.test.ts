import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@mozaika/kernel', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@mozaika/kernel');
  });
});
