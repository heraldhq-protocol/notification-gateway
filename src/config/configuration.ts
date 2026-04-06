import { EnvironmentSchema, type GatewayConfig } from './configuration.schema';

/**
 * NestJS ConfigModule factory function.
 * Validates process.env against the Zod schema and returns typed config.
 * Throws on startup if any required variable is missing or invalid.
 */
export function loadConfiguration(): GatewayConfig {
  const result = EnvironmentSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`❌ Invalid configuration:\n${formatted}`);
  }

  return result.data;
}

export { type GatewayConfig } from './configuration.schema';
