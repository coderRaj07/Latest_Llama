import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./vite";
import { initializeDatabase } from "./db";
import csurf from "csurf";
import cookieParser from "cookie-parser";
import helmet from 'helmet';

export const app = express();

// Apply Helmet middleware for secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // For development, can tighten in production
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://js.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false, // For development compatibility
  crossOriginResourcePolicy: { policy: "cross-origin" }, // For development compatibility
}));

// Rate limiting would be added here in production

app.use(express.json({ limit: '2mb' })); // Limit JSON body size
app.use(express.urlencoded({ extended: false, limit: '2mb' })); // Limit URL-encoded body size
app.use(cookieParser());

// Configure CSRF protection with detailed error logging
const csrfProtection = csurf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  },
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  // Custom error handler
  value: (req) => {
    const token = req.headers['x-csrf-token'] as string;
    console.log('CSRF Token from request:', token);
    return token;
  }
});

const csrfExemptRoutes = [
  '/api/login', '/api/register', '/api/logout', '/api/me', '/api/csrf-token',
  '/api/job-postings/latest', '/api/professional-profiles/featured',
  '/api/professionals/me', '/api/professionals/me/expertise',
  '/api/professionals/me/certifications', '/api/company-profiles',
  '/api/company-profiles/by-user', '/api/resources/featured',
  '/api/create-test-admin', '/api/create-admin', '/api/admin/make-admin',
  '/api/admin/company-profiles', '/api/admin/professional-profiles',
  '/api/admin/job-postings', '/api/admin/resources',
  '/api/admin/auth/login', '/api/admin/auth/logout', '/api/admin/auth/refresh-token',
  '/api/admin/founder', '/api/reviews', '/api/notifications', '/api/notifications/unread',
  '/api/notifications/read-all', '/api/notification-preferences',
  '/api/auth/google', '/api/auth/google/callback',
  '/api/auth/linkedin', '/api/auth/linkedin/callback'
];

const methodSpecificExemptions = [
  { path: '/api/professionals/me', method: 'PUT' },
  { path: '/api/professionals/me/expertise', method: 'POST' },
  { path: '/api/professionals/me/certifications', method: 'POST' },
  { path: '/api/company-profiles', method: 'POST' },
  { path: '/api/company-profiles/:id', method: 'PUT' },
  { path: '/api/admin/auth/login', method: 'POST' },
  { path: '/api/admin/auth/logout', method: 'POST' },
  { path: '/api/admin/auth/refresh-token', method: 'POST' }
];

const idBasedPatterns = [
  '/api/company-profiles/:id', '/api/professionals/:id', '/api/job-postings/:id',
  '/api/resources/:id', '/api/admin/company-profiles/:id/verify',
  '/api/admin/company-profiles/:id/featured', '/api/admin/professional-profiles/:id/featured',
  '/api/admin/job-postings/:id/featured', '/api/admin/job-postings/:id/status',
  '/api/admin/resources/:id/featured', '/api/admin/resources/:id',
  '/api/reviews/:id', '/api/professionals/:id/reviews', '/api/companies/:id/reviews',
  '/api/consultations/:id/review', '/api/notifications/:id', '/api/notifications/:id/read'
];

const matchesPattern = (path: string, pattern: string): boolean => {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) =>
    part.startsWith(':') || part === pathParts[i]
  );
};

app.use((req, res, next) => {
  if (
    csrfExemptRoutes.includes(req.path) ||
    idBasedPatterns.some(p => matchesPattern(req.path, p)) ||
    methodSpecificExemptions.some(p => p.path === req.path && p.method === req.method) ||
    (req.method === 'GET' && req.path.startsWith('/api/me/'))
  ) {
    console.log(`CSRF bypassed for ${req.method} ${req.path}`);
    return next();
  }
  csrfProtection(req, res, next);
});

// Add CSRF token to response for client-side use
app.use((req: any, res: any, next) => {
  if (req.csrfToken) {
    res.cookie('XSRF-TOKEN', req.csrfToken(), {
      httpOnly: false, // Client-side JavaScript needs to access it
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
  }
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await initializeDatabase();
  await registerRoutes(app);

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  }
})();

// ✅ No server.listen — export app for serverless
export default app;
