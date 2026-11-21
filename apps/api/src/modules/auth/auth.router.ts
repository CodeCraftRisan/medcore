import cookieParser from 'cookie-parser';
import {
  Router,
  type Request,
  type Response,
  type CookieOptions,
} from 'express';
import { env } from '../../config/env.js';
import { credentialsSchema, refreshTokenSchema } from './auth.schemas.js';
import { login, logout, register, rotateRefreshToken } from './auth.service.js';

const cookieName = 'refresh_token';
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/auth',
};

function readRefreshToken(req: Request): string | undefined {
  const cookie: unknown = req.cookies[cookieName];
  const fallback: unknown =
    env.NODE_ENV === 'test' ? req.body?.refreshToken : undefined;
  const parsed = refreshTokenSchema.safeParse(cookie ?? fallback);
  return parsed.success ? parsed.data : undefined;
}

function sendSession(
  res: Response,
  session: { accessToken: string; refreshToken: string; expiresAt: Date },
): void {
  res.cookie(cookieName, session.refreshToken, {
    ...cookieOptions,
    maxAge: Math.max(0, session.expiresAt.getTime() - Date.now()),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ accessToken: session.accessToken });
}

export const authRouter = Router();
authRouter.use(cookieParser());

authRouter.post('/register', async (req, res) => {
  const input = credentialsSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ code: 'INVALID_INPUT' });
    return;
  }

  const user = await register(input.data);
  if (!user) {
    res.status(409).json({ code: 'EMAIL_ALREADY_REGISTERED' });
    return;
  }
  res.status(201).json({ user });
});

authRouter.post('/login', async (req, res) => {
  const input = credentialsSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ code: 'INVALID_INPUT' });
    return;
  }

  const session = await login(input.data);
  if (!session) {
    res.status(401).json({ code: 'INVALID_CREDENTIALS' });
    return;
  }
  sendSession(res, session);
});

authRouter.post('/refresh', async (req, res) => {
  const token = readRefreshToken(req);
  const result = token
    ? await rotateRefreshToken(token)
    : ({ status: 'invalid' } as const);
  if (result.status === 'rotated') {
    sendSession(res, result.session);
    return;
  }

  res.clearCookie(cookieName, cookieOptions);
  res.status(401).json({
    code:
      result.status === 'reused'
        ? 'TOKEN_REUSE_DETECTED'
        : 'INVALID_REFRESH_TOKEN',
  });
});

authRouter.post('/logout', async (req, res) => {
  const token = readRefreshToken(req);
  if (token) await logout(token);
  res.clearCookie(cookieName, cookieOptions);
  res.status(204).end();
});
