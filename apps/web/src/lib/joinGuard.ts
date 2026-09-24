/**
 * Guards the join form's auto-redirect against a stale, already-resumed room session.
 *
 * `RoomProvider` auto-resumes whatever room is in `localStorage` on mount — necessary so a dropped
 * connection or a page refresh mid-game resumes the same seat. But that means `self` can already be
 * populated with an *old* room by the time someone opens a join link for a *different* PIN. Without
 * this guard, the join form would redirect straight into the stale old room instead of ever showing
 * the join form for the new one. Only redirect once the connected seat's PIN actually matches the
 * PIN being joined.
 */
export const shouldAutoJoinRedirect = (input: {
  readonly targetPin: string | null;
  readonly selfPin: string | null;
  readonly status: string;
}): boolean => {
  if (input.targetPin === null || input.selfPin === null) return false;
  if (input.selfPin !== input.targetPin) return false;
  return input.status === 'connected' || input.status === 'connecting';
};
