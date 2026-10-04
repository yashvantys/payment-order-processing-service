import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

console.log(
    'DATABASE_URL:',
    process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@'),
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
    adapter,
});

try {
    await prisma.$connect();

    console.log('Prisma connected');

    const result = await prisma.$queryRaw`
    SELECT current_database(), current_user, now()
  `;

    console.log('Database result:', result);

    await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        console.log('Transaction started successfully');
    });

    console.log('Transaction test passed');
} catch (error) {
    console.error('Prisma test failed:', error);
} finally {
    await prisma.$disconnect();
    await pool.end();
}