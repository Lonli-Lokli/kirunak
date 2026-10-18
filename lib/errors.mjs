// A refusal the command line prints on stderr and exits with: 1 refused, 2 usage.
export class KError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export const refuse = (message) => new KError(message, 1);
export const usage = (message) => new KError(message, 2);
