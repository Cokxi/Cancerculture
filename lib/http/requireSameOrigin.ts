export class SameOriginError extends Error {
  readonly status = 403;

  constructor() {
    super("Request origin is not allowed");
  }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type") ?? "";

  if (
    !origin ||
    origin !== new URL(request.url).origin ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new SameOriginError();
  }
}
