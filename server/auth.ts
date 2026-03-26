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

  const token = authHeader.slice(7);

  if (token !== process.env.ADMIN_API_KEY) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}
