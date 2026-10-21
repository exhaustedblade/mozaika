import { PACKAGE_NAME as KERNEL_PACKAGE_NAME } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { DEPENDS_ON, PACKAGE_NAME } from './index.js';

describe('@mozaika/mcp', () => {
  it('exposes its package name and builds on the kernel', () => {
    expect(PACKAGE_NAME).toBe('@mozaika/mcp');
    expect(DEPENDS_ON).toContain(KERNEL_PACKAGE_NAME);
  });
});
