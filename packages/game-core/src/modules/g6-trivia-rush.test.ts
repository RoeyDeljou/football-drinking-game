import { describe, expect, it } from 'vitest';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import {
  ALL_BUILT,
  asRoundView,
  generateWith,
  HOST,
  mustGenerate,
  P2,
  P3,
  playerViews,
  sampleData,
  sub,
  T0,
} from '../harness.test-utils.js';
import { DEFAULT_SCORING } from '../scoring.js';
import { G6_DEFAULT_CONFIG, g6TriviaRush as module } from './g6-trivia-rush.js';

interface G6Public {
  readonly question: {
    readonly kind: string;
    readonly subjectName: string | null;
  };
  readonly options: readonly { readonly id: string; readonly label: string }[];
}
interface G6Solution {
  readonly optionId: string;
  readonly label: string;
  readonly subjectPlayerId: string | null;
}

const score = (
  round: ReturnType<typeof asRoundView>,
  submissions: readonly ReturnType<typeof sub>[],
  config: unknown = G6_DEFAULT_CONFIG,
) =>
  module.scoreRound({
    config,
    round,
    submissions,
    players: playerViews([HOST, P2, P3]),
    scoring: DEFAULT_SCORING,
    now: T0,
  });

describe('G6 generation', () => {
  it('is a general game driven by season stats', () => {
    expect(module.id).toBe('G6');
    expect(module.category).toBe('general');
    expect(module.dataRequirements).toEqual(['hasPlayerSeasonStats']);
  });

  it('produces a four-way question whose answer is one of the options', () => {
    const generated = mustGenerate(module);
    const payload = generated.publicPayload as G6Public;
    const solution = generated.solution as G6Solution;
    expect(payload.options.length).toBeGreaterThanOrEqual(2);
    expect(payload.options.length).toBeLessThanOrEqual(G6_DEFAULT_CONFIG.optionCount);
    expect(new Set(payload.options.map((option) => option.id)).size).toBe(payload.options.length);
    expect(payload.options.some((option) => option.id === solution.optionId)).toBe(true);
    expect(G6_DEFAULT_CONFIG.questionKinds).toContain(payload.question.kind);
  });

  it('labels every option with data, not with engine copy', () => {
    const payload = mustGenerate(module).publicPayload as G6Public;
    const knownLabels = new Set([
      ...ALL_BUILT.map((entry) => entry.player.name),
      ...ALL_BUILT.map((entry) => entry.player.nationality ?? ''),
      'Home City',
      'Away United',
    ]);
    expect(payload.options.every((option) => knownLabels.has(option.label))).toBe(true);
  });

  it('answers a "most goals" question with the genuine leader', () => {
    const generated = mustGenerate(module, {
      config: { ...G6_DEFAULT_CONFIG, questionKinds: ['MOST_GOALS'] },
    });
    const payload = generated.publicPayload as G6Public;
    const solution = generated.solution as G6Solution;
    const goalsOf = (id: string): number =>
      ALL_BUILT.find((entry) => entry.player.id === id)?.stats.goals ?? -1;
    const best = Math.max(...payload.options.map((option) => goalsOf(option.id)));
    expect(goalsOf(solution.optionId)).toBe(best);
  });

  it('never serves a stat question with a tied leader', () => {
    const flat = sampleData({
      seasonStats: ALL_BUILT.map((entry) => ({ ...entry.stats, goals: 5 })),
    });
    const result = generateWith(module, {
      config: { ...G6_DEFAULT_CONFIG, questionKinds: ['MOST_GOALS'] },
      data: flat,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('unambiguous');
  });

  it('asks an attribute question about a named subject', () => {
    // Two teams in the fixture, so a "which club?" question can only offer two options.
    const generated = mustGenerate(module, {
      config: { ...G6_DEFAULT_CONFIG, questionKinds: ['TEAM_OF'], optionCount: 2 },
    });
    const payload = generated.publicPayload as G6Public;
    const solution = generated.solution as G6Solution;
    // The subject is named, but its footballer id is withheld until reveal.
    expect(payload.question).not.toHaveProperty('subjectPlayerId');
    expect(payload.question.subjectName).not.toBeNull();
    const subject = ALL_BUILT.find((entry) => entry.player.id === solution.subjectPlayerId);
    expect(subject?.player.name).toBe(payload.question.subjectName);
    expect(solution.optionId).toBe(subject?.player.teamId);
  });

  it('cannot build a nationality question with too few distinct nationalities', () => {
    const result = generateWith(module, {
      config: { ...G6_DEFAULT_CONFIG, questionKinds: ['NATIONALITY_OF'] },
      data: sampleData({
        players: ALL_BUILT.map((entry) => ({ ...entry.player, nationality: 'England' })),
      }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails with no data at all', () => {
    const result = generateWith(module, { data: EMPTY_DATA_CONTEXT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INSUFFICIENT_DATA');
  });

  it('does not repeat a question already asked this session', () => {
    const first = mustGenerate(module, { seed: 4 });
    const second = mustGenerate(module, { seed: 4, usedContentKeys: [first.contentKey] });
    expect(second.contentKey).not.toBe(first.contentKey);
  });
});

describe('G6 validation and scoring', () => {
  const generated = mustGenerate(module);
  const round = asRoundView(generated);
  const answer = (generated.solution as G6Solution).optionId;
  const wrong = (generated.publicPayload as G6Public).options.find((option) => option.id !== answer)?.id;

  it('accepts an offered option only', () => {
    const validate = (raw: unknown) =>
      module.validateSubmission({
        config: G6_DEFAULT_CONFIG,
        round,
        playerId: HOST,
        raw,
        submittedAt: T0,
        elapsedMs: 0,
        alreadySubmitted: false,
      });
    expect(validate({ optionId: answer }).ok).toBe(true);
    const unknown = validate({ optionId: 'nope' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('UNKNOWN_OPTION');
    const malformed = validate({});
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe('SCHEMA');
  });

  it('rewards speed heavily inside a short window', () => {
    const outcome = score(round, [
      sub(HOST, { optionId: answer }, 500),
      sub(P2, { optionId: answer }, 11_000),
    ]);
    const host = outcome.scores.find((entry) => entry.playerId === HOST)?.points ?? 0;
    const guest = outcome.scores.find((entry) => entry.playerId === P2)?.points ?? 0;
    expect(host).toBeGreaterThan(guest);
    expect(outcome.winnerIds).toEqual([HOST]);
  });

  it('charges wrong answers and silence, and by default not the last correct answer', () => {
    const outcome = score(round, [
      sub(HOST, { optionId: answer }, 100),
      sub(P2, { optionId: answer }, 5_000),
      sub(P3, { optionId: wrong }, 100),
    ]);
    expect(outcome.penalties).toHaveLength(1);
    expect(outcome.penalties[0]).toMatchObject({ playerId: P3, reason: 'WRONG_ANSWER', sips: 2 });
  });

  it('can punish the last correct answer when configured', () => {
    const outcome = score(
      round,
      [sub(HOST, { optionId: answer }, 100), sub(P2, { optionId: answer }, 5_000)],
      { ...G6_DEFAULT_CONFIG, lastCorrectSips: 1, noAnswerSips: 0 },
    );
    expect(outcome.penalties).toEqual([
      { playerId: P2, target: 'self', sips: 1, reason: 'LAST_CORRECT', meta: null },
    ]);
  });

  it('summarizes the round for the reveal screen without any prose', () => {
    const outcome = score(round, [sub(HOST, { optionId: answer }, 100)]);
    expect(outcome.summary).toEqual({
      questionKind: (generated.publicPayload as G6Public).question.kind,
      answerOptionId: answer,
      correctCount: 1,
    });
  });
});
