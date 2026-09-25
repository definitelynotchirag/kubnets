import { Router } from "express";
import { createStoreSchema, storeIdParamSchema } from "@urumi/shared";
import { validate } from "../middleware/validate.js";
import { createStoreLimiter } from "../middleware/rate-limit.js";
import * as storeService from "../services/store.service.js";
import { getAuditLogs } from "../services/audit.service.js";
import { StoreLimitReachedError, UnsupportedEngineError } from "../lib/errors.js";

export const storesRouter = Router();

// POST /api/stores
storesRouter.post("/", createStoreLimiter, validate(createStoreSchema, "body"), async (req, res, next) => {
  try {
    const store = await storeService.createStore(req.body.engine, req.ip);
    res.status(201).json({ store });
  } catch (err: unknown) {
    if (err instanceof StoreLimitReachedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof UnsupportedEngineError) {
      res.status(501).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// GET /api/stores
storesRouter.get("/", async (_req, res, next) => {
  try {
    const stores = await storeService.listStores();
    res.json({ stores });
  } catch (err) {
    next(err);
  }
});

// GET /api/stores/:id
storesRouter.get("/:id", validate(storeIdParamSchema, "params"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const store = await storeService.getStore(id);
    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    res.json({ store });
  } catch (err) {
    next(err);
  }
});

// GET /api/stores/:id/logs
storesRouter.get("/:id/logs", validate(storeIdParamSchema, "params"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const logs = await getAuditLogs(id);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/stores/:id
storesRouter.delete("/:id", validate(storeIdParamSchema, "params"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const store = await storeService.deleteStore(id, req.ip);
    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    res.json({ message: "Store deletion initiated", store });
  } catch (err) {
    next(err);
  }
});
