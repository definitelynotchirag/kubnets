import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing store service
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    store: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Mock the worker to prevent actual provisioning
vi.mock("../workers/provisioner.worker.js", () => ({
  enqueueProvision: vi.fn(),
  enqueueDeletion: vi.fn(),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {
    MAX_STORES: 5,
    STORE_DOMAIN: "localtest.me",
  },
}));

import { prisma } from "../lib/prisma.js";
import { createStore, listStores, getStore, deleteStore } from "../services/store.service.js";

const mockPrisma = vi.mocked(prisma);

describe("StoreService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createStore", () => {
    it("should create a store when under limit", async () => {
      mockPrisma.store.count.mockResolvedValue(0);
      mockPrisma.store.create.mockResolvedValue({
        id: "test-uuid",
        namespace: "store-abc12345",
        engine: "woocommerce",
        status: "Pending",
        url: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const store = await createStore("woocommerce");

      expect(store.engine).toBe("woocommerce");
      expect(store.status).toBe("Pending");
      expect(mockPrisma.store.create).toHaveBeenCalled();
    });

    it("should reject when max stores reached", async () => {
      mockPrisma.store.count.mockResolvedValue(5);

      await expect(createStore("woocommerce")).rejects.toThrow("Maximum");
    });
  });

  describe("listStores", () => {
    it("should return all stores", async () => {
      mockPrisma.store.findMany.mockResolvedValue([]);
      const stores = await listStores();
      expect(stores).toEqual([]);
    });
  });

  describe("getStore", () => {
    it("should return null for missing store", async () => {
      mockPrisma.store.findUnique.mockResolvedValue(null);
      const store = await getStore("nonexistent");
      expect(store).toBeNull();
    });
  });

  describe("deleteStore", () => {
    it("should return null for missing store", async () => {
      mockPrisma.store.findUnique.mockResolvedValue(null);
      const store = await deleteStore("nonexistent");
      expect(store).toBeNull();
    });

    it("should mark store as Deleting", async () => {
      const existing = {
        id: "test-uuid",
        namespace: "store-abc",
        engine: "woocommerce",
        status: "Ready",
        url: "http://store-abc.localtest.me",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.store.findUnique.mockResolvedValue(existing);
      mockPrisma.store.update.mockResolvedValue({ ...existing, status: "Deleting" });

      const store = await deleteStore("test-uuid");
      expect(store?.status).toBe("Deleting");
    });

    it("should not re-delete a Deleting store", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: "test-uuid",
        namespace: "store-abc",
        engine: "woocommerce",
        status: "Deleting",
        url: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const store = await deleteStore("test-uuid");
      expect(store?.status).toBe("Deleting");
      expect(mockPrisma.store.update).not.toHaveBeenCalled();
    });
  });
});
