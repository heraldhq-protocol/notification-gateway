/**
 * Jest setup — auto-mock modules that use ESM syntax incompatible with ts-jest.
 *
 * Prisma 7 generates ESM-only client code. Since NestJS tests run under
 * CommonJS (ts-jest), we mock the Prisma client and adapter via moduleNameMapper
 * in package.json to redirect to src/__mocks__/*.js files.
 *
 * The actual PrismaService is always injected as a mock in tests anyway.
 */

// We don't need manual jest.mock() here anymore, they are handled in package.json

