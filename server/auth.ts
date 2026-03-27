import type { Request, Response, NextFunction } from "express";

/**
 * Middleware: validates Bearer token against ADMIN_API_KEY env var.
 * Used for all /api/admin/* routes.
 */
export function adminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }

  const token = authHeader.slice(7).trim();
  const expected = (process.env.ADMIN_API_KEY ?? "").trim();

  if (!expected) {
    res.status(500).json({ error: "ADMIN_API_KEY not configured on server" });
    return;
  }

  if (token !== expected) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}
