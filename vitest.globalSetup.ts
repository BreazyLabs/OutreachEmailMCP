import { rmSync } from 'node:fs';

// Each test file seeds its own data-test/<name> database; leftovers from a
// previous run trip UNIQUE constraints on re-seed. Clear them once up front.
export default function setup(): void {
  rmSync('data-test', { recursive: true, force: true });
}
