import type { DrinkTallyRow } from '@fdg/game-core';
import { drinkTallyHeadline, sipsLabel } from '@/lib/drinkCopy';
import { Card } from './ui';

export const DrinkTally = ({
  rows,
  viewerId,
}: {
  readonly rows: readonly DrinkTallyRow[];
  readonly viewerId: string | null;
}): React.JSX.Element => {
  const total = rows.reduce((sum, row) => sum + row.sips, 0);
  return (
    <Card>
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-white/50">Drink tally</h2>
      <p className="mb-3 text-xs text-white/50">{drinkTallyHeadline(total)}</p>
      <ol className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.playerId}
            className={`flex items-center justify-between rounded-xl px-4 py-3 text-base ${
              row.playerId === viewerId && row.sips > 0 ? 'bg-amber-700/30 ring-1 ring-amber-500' : 'bg-white/5'
            }`}
          >
            <span className="font-semibold">{row.nickname}</span>
            <span className={`font-black tabular-nums ${row.sips > 0 ? 'text-amber-300' : 'text-white/40'}`}>
              {sipsLabel(row.sips)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
};
