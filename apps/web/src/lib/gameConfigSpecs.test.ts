import { describe, expect, it } from 'vitest';
import { GAME_CONFIG_SPECS as ENGINE_SPECS } from '../../../../packages/game-core/src/modules/config-specs';
import { M6_BINGO_VOCABULARY } from '../../../../packages/game-core/src/modules/m6-match-bingo';
import { BINGO_VOCABULARY, GAME_CONFIG_SPECS } from './gameConfigSpecs';

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('the web mirror of the engine config specs', () => {
  it('lists exactly the engine games, with identical defaults and fields', () => {
    expect(Object.keys(GAME_CONFIG_SPECS).sort()).toEqual(Object.keys(ENGINE_SPECS).sort());
    for (const [id, engine] of Object.entries(ENGINE_SPECS)) {
      expect(plain(GAME_CONFIG_SPECS[id]?.defaults)).toEqual(plain(engine?.defaults));
      expect(plain(GAME_CONFIG_SPECS[id]?.fields)).toEqual(plain(engine?.fields));
    }
  });

  it('matches the Bingo vocabulary', () => {
    expect(plain(BINGO_VOCABULARY)).toEqual(plain(M6_BINGO_VOCABULARY));
  });
});
