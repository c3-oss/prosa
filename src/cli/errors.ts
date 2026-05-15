/** Error intended for direct CLI display without a stack trace. */
export class CliUserError extends Error {
  readonly exitCode = 1

  constructor(message: string) {
    super(message)
    this.name = 'CliUserError'
  }
}

export function isCliUserError(error: unknown): error is CliUserError {
  return error instanceof CliUserError
}
