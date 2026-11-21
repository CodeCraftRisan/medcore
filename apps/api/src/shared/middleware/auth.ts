import type { RequestHandler } from 'express';
import {
  verifyAccessToken,
  type AccessClaims,
} from '../../modules/auth/accessToken.js';
import type { Role } from '../../modules/auth/auth.schemas.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessClaims;
  }
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = /^Bearer ([^\s]+)$/i.exec(req.get('Authorization') ?? '')?.[1];
  const claims = token ? verifyAccessToken(token) : undefined;
  if (!claims) {
    res.status(401).json({ code: 'UNAUTHORIZED' });
    return;
  }

  req.auth = claims;
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      res.status(401).json({ code: 'UNAUTHORIZED' });
      return;
    }

    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ code: 'FORBIDDEN' });
      return;
    }

    next();
  };
}
