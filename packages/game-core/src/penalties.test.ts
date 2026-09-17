import { describe, expect, it } from 'vitest';
import { asPlayerId, asRoundId, asSessionId } from './ids.js';
import {
  applyPenalties,
  DEFAULT_PENALTY_CAPS,
  penalty,
  penaltyEventSchema,
  resolvePenaltyRecipients,
  tallySips,
} from './penalties.js';

const A = asPlayerId('a');
const B = asPlayerId('b');
const C = asPlayerId('c');
const ROSTER = [A, B, C];
const SESSION = asSessionId('s1');
const ROUND = asRoundId('r1');

const run = (
  events: Parameters<typeof applyPenalties>[0]['events'],
  caps = DEFAULT_PENALTY_CAPS,
  sessionSipsByPlayer: Readonly<Partial<Record<typeof A, number>>> = {},
  roundSipsByPlayer: Readonly<Partial<Record<typeof A, number>>> = {},
) =>
  applyPenalties({
    events,
    participantIds: ROSTER,
    caps,
    sessionId: SESSION,
    roundId: ROUND,
    sessionSipsByPlayer,
    roundSipsByPlayer,
  });

describe('target resolution', () => {
  it('maps self to the subject only', () => {
    expect(resolvePenaltyRecipients(penalty(A, 'self', 2, 'WRONG_ANSWER'), ROSTER)).toEqual([A]);
  });

  it('maps others to everyone but the subject', () => {
    expect(resolvePenaltyRecipients(penalty(A, 'others', 2, 'ROUND_WON'), ROSTER)).toEqual([B, C]);
  });

  it('maps everyone to the whole roster', () => {
    expect(resolvePenaltyRecipients(penalty(A, 'everyone', 1, 'BINGO_LINE'), ROSTER)).toEqual(ROSTER);
  });

  it('drops a subject who is no longer in the room', () => {
    expect(resolvePenaltyRecipients(penalty(asPlayerId('ghost'), 'self', 2, 'NO_ANSWER'), ROSTER)).toEqual(
      [],
    );
  });
});

describe('caps', () => {
  it('caps a single oversized penalty', () => {
    const result = run([penalty(A, 'self', 99, 'WRONG_ANSWER')], {
      perPenalty: 3,
      perRound: 100,
      perSession: 100,
    });
    expect(result.recorded[0]?.appliedSips).toBe(3);
    expect(result.recorded[0]?.requestedSips).toBe(99);
    expect(result.recorded[0]?.cappedBy).toBe('perPenalty');
  });

  it('caps the per-round accumulation across several penalties', () => {
    const result = run(
      [
        penalty(A, 'self', 3, 'WRONG_ANSWER'),
        penalty(A, 'self', 3, 'LOST_MARKET'),
        penalty(A, 'self', 3, 'NO_ANSWER'),
      ],
      { perPenalty: 5, perRound: 4, perSession: 100 },
    );
    expect(result.sipsByPlayer[A]).toBe(4);
    expect(result.recorded.map((entry) => entry.appliedSips)).toEqual([3, 1, 0]);
    expect(result.recorded[2]?.cappedBy).toBe('perRound');
  });

  it('caps against sips already accrued this session', () => {
    const result = run(
      [penalty(A, 'self', 5, 'WRONG_ANSWER')],
      {
        perPenalty: 10,
        perRound: 10,
        perSession: 8,
      },
      { [A]: 6 },
    );
    expect(result.sipsByPlayer[A]).toBe(2);
    expect(result.recorded[0]?.cappedBy).toBe('perSession');
  });

  it('records a zero penalty rather than silently dropping it', () => {
    const result = run([penalty(A, 'self', 4, 'WRONG_ANSWER')], {
      perPenalty: 10,
      perRound: 10,
      perSession: 0,
    });
    expect(result.recorded).toHaveLength(1);
    expect(result.recorded[0]?.appliedSips).toBe(0);
  });
});

describe('bookkeeping', () => {
  it('expands one everyone-penalty into one record per recipient', () => {
    const result = run([penalty(A, 'everyone', 1, 'BINGO_LINE')]);
    expect(result.recorded).toHaveLength(3);
    expect(result.recorded.map((entry) => entry.recipientId)).toEqual(ROSTER);
    expect(result.recorded.every((entry) => entry.playerId === A)).toBe(true);
  });

  it('rounds and floors fractional or negative magnitudes', () => {
    const result = run([penalty(A, 'self', 2.6, 'WRONG_ANSWER'), penalty(B, 'self', -5, 'NO_ANSWER')]);
    expect(result.recorded[0]?.appliedSips).toBe(3);
    expect(result.recorded[1]?.appliedSips).toBe(0);
  });

  it('tallies sips per recipient', () => {
    const result = run([penalty(A, 'others', 2, 'PERFECT_SLIP'), penalty(B, 'self', 1, 'WRONG_ANSWER')]);
    expect(tallySips(result.recorded)).toEqual({ [B]: 3, [C]: 2 });
  });

  it('carries machine-readable meta through untouched', () => {
    const result = run([penalty(A, 'self', 2, 'DISTANCE_FROM_TARGET', { distance: 7 })]);
    expect(result.recorded[0]?.meta).toEqual({ distance: 7 });
    expect(result.recorded[0]?.reason).toBe('DISTANCE_FROM_TARGET');
  });

  it('validates host-issued penalties at the boundary', () => {
    expect(
      penaltyEventSchema.safeParse({
        playerId: 'a',
        target: 'self',
        sips: 2,
        reason: 'HOST_MANUAL',
        meta: null,
      }).success,
    ).toBe(true);
    expect(
      penaltyEventSchema.safeParse({ playerId: 'a', target: 'self', sips: 2, reason: 'nonsense', meta: null })
        .success,
    ).toBe(false);
    expect(
      penaltyEventSchema.safeParse({
        playerId: 'a',
        target: 'nobody',
        sips: 2,
        reason: 'HOST_MANUAL',
        meta: null,
      }).success,
    ).toBe(false);
  });
});
