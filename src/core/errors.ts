/** An error that maps directly to an HTTP response. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required.', code = 'unauthorized') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'Not allowed.', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (message = 'Not found.', code = 'not_found') =>
  new HttpError(404, code, message);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new HttpError(409, code, message, details);
export const tooLarge = (message: string, code = 'too_large') =>
  new HttpError(413, code, message);
export const unavailable = (message: string, code = 'unavailable') =>
  new HttpError(503, code, message);
