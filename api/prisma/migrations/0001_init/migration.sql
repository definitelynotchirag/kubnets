-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "namespace" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'woocommerce',
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "url" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_namespace_key" ON "stores"("namespace");
