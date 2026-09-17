/**
 * The engine has exactly one thrown error type, and it means "the engine was handed state it
 * could not have produced itself" — i.e. a bug or a corrupted store, never bad user input.
 * User input failures are returned as typed rejections, never thrown.
 */
export class EngineInvariantError extends Error {
  public override readonly name = 'EngineInvariantError';

  public constructor(message: string) {
    super(message);
  }
}
