import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'member';
  tokenId: string;
  tokenKind: 'session' | 'api';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
  interface FastifyInstance {
    /** onRequest hook: rejects the request with 401 unless a valid token is sent. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** The signed-in user for this request (throws 401 if there is none). */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export const Uuid = Type.String({ format: 'uuid' });
export const ProjectParams = Type.Object({ projectId: Uuid });

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  }),
});

/** Every protected route advertises bearer auth in the OpenAPI document. */
export const secured = [{ bearerAuth: [] }];

/** Headers for serving user-supplied bytes safely from the API origin. */
export function sendFile(
  reply: FastifyReply,
  opts: { filename: string; contentType: string; body: Buffer; download?: boolean; etag?: string },
): FastifyReply {
  const disposition = opts.download ? 'attachment' : 'inline';
  const ascii = opts.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  reply
    .header('Content-Type', opts.contentType)
    .header(
      'Content-Disposition',
      `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opts.filename)}`,
    )
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-cache');
  // Uploaded SVG/HTML-ish files must never run script on the API origin. PDFs are
  // exempt: browsers refuse to show a PDF that is served inside a sandbox.
  if (!opts.contentType.startsWith('application/pdf')) {
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }
  if (opts.etag) reply.header('ETag', `"${opts.etag}"`);
  return reply.send(opts.body);
}
