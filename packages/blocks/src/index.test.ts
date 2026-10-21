import { PACKAGE_NAME as KERNEL_PACKAGE_NAME } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { DEPENDS_ON, PACKAGE_NAME } from './index.js';

describe('@mozaika/blocks', () => {
  it('exposes its package name and builds on the kernel', () => {
    expect(PACKAGE_NAME).toBe('@mozaika/blocks');
    expect(DEPENDS_ON).toContain(KERNEL_PACKAGE_NAME);
  });
});
