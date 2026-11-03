import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as typeof globalThis & { resqivaPrisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (globalForPrisma.resqivaPrisma) return globalForPrisma.resqivaPrisma;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  if (process.env.NODE_ENV !== "production") globalForPrisma.resqivaPrisma = client;
  return client;
}
