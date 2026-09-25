import rateLimit from "express-rate-limit";

// General API rate limit: 100 requests per minute per IP
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Store creation rate limit: 5 per minute per IP (abuse prevention)
export const createStoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many store creation requests. Max 5 per minute." },
});
