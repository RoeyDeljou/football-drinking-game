import type { ProjectedPlayer, ProjectedRoom } from '@fdg/game-core';

export const nicknameOf = (room: ProjectedRoom, playerId: string): string =>
  room.players.find((player) => player.id === playerId)?.nickname ?? 'Someone';

export const playerOf = (room: ProjectedRoom, playerId: string): ProjectedPlayer | undefined =>
  room.players.find((player) => player.id === playerId);
