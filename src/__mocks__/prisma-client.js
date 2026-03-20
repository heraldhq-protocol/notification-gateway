/**
 * Mock for prisma/generated/client.
 * Used by Jest (ts-jest CJS mode) since the real Prisma 7 generated client
 * uses ESM syntax that Jest cannot parse.
 *
 * The actual PrismaService is always injected as a mock provider in tests.
 */
class PrismaClientMock {
    constructor(_opts) { }
    $connect() { return Promise.resolve(); }
    $disconnect() { return Promise.resolve(); }
}

module.exports = { PrismaClient: PrismaClientMock };
