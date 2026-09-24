import { describe, expect, it } from 'vitest';
import { shouldAutoJoinRedirect } from './joinGuard';

describe('shouldAutoJoinRedirect', () => {
  it('does not redirect into a stale resumed room with a different PIN', () => {
    expect(shouldAutoJoinRedirect({ targetPin: 'BBBBBB', selfPin: 'AAAAAA', status: 'connected' })).toBe(false);
  });

  it('redirects once the connected seat matches the PIN actually being joined', () => {
    expect(shouldAutoJoinRedirect({ targetPin: 'BBBBBB', selfPin: 'BBBBBB', status: 'connected' })).toBe(true);
  });

  it('redirects while still connecting to the matching PIN, not just once fully connected', () => {
    expect(shouldAutoJoinRedirect({ targetPin: 'BBBBBB', selfPin: 'BBBBBB', status: 'connecting' })).toBe(true);
  });

  it('does not redirect before any join target is known', () => {
    expect(shouldAutoJoinRedirect({ targetPin: null, selfPin: 'AAAAAA', status: 'connected' })).toBe(false);
  });

  it('does not redirect before a seat is established', () => {
    expect(shouldAutoJoinRedirect({ targetPin: 'BBBBBB', selfPin: null, status: 'idle' })).toBe(false);
  });
});
