import type { Request, Response, NextFunction } from "express";

/**
 * Wrap an async route handler so rejections bubble to the Express error
 * middleware instead of hanging the request. Mirrors IRP-funnel's pattern.
 */
export default function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}