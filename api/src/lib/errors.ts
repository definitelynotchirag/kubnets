/**
 * Domain errors that the HTTP layer maps to specific status codes.
 * Kept separate from plain `Error` so the routes never have to match on message text.
 */
export class StoreLimitReachedError extends Error {
  constructor(limit: number) {
    super(`Maximum number of stores (${limit}) reached`);
    this.name = "StoreLimitReachedError";
  }
}

export class UnsupportedEngineError extends Error {
  constructor(engine: string) {
    super(
      `Engine "${engine}" is an architecture stub in Round 1 and cannot be provisioned. Use "woocommerce".`
    );
    this.name = "UnsupportedEngineError";
  }
}
