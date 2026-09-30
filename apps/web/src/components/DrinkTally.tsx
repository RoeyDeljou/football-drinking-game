import type { DrinkTallyRow } from '@fdg/game-core';
import { drinkTallyHeadline, sipsLabel } from '@/lib/drinkCopy';
import { Card, Eyebrow } from './ui';

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
      <Eyebrow className="mb-1">Drink tally</Eyebrow>
      <p className="t-sm mb-3 text-fg-muted">{drinkTallyHeadline(total)}</p>
      <ol className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.playerId}
            className={`flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md border-2 px-4 py-3 text-base ${
              row.playerId === viewerId && row.sips > 0 ? 'border-accent bg-selected' : 'border-transparent bg-hover'
            }`}
          >
            <span className="min-w-0 flex-1 basis-32 font-semibold">{row.nickname}</span>
            <span className={`tnum ml-auto shrink-0 whitespace-nowrap font-black ${row.sips > 0 ? 'text-accent' : 'text-fg-subtle'}`}>
              {sipsLabel(row.sips)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
};
