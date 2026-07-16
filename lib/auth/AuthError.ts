export class AuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "AUTH_ERROR") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export function getAuthErrorStatus(error: unknown) {
  if (error instanceof AuthError) {
    return error.status;
  }

  if (error instanceof Response) {
    return error.status;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return null;
}

export function getAuthErrorCode(error: unknown) {
  return error instanceof AuthError ? error.code : null;
}
