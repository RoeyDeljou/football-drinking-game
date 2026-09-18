/**
 * 6-character room PINs from an unambiguous alphabet (no `0/O`, `1/I`) — easy to read aloud and
 * type on a phone.
 */

import { randomInt } from 'node:crypto';

export const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PIN_LENGTH = 6;

export const generatePin = (): string => {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1) {
    pin += PIN_ALPHABET[randomInt(0, PIN_ALPHABET.length)];
  }
  return pin;
};

export const isValidPinFormat = (value: string): boolean =>
  value.length === PIN_LENGTH && [...value].every((char) => PIN_ALPHABET.includes(char));

export const normalizePin = (value: string): string => value.trim().toUpperCase();
