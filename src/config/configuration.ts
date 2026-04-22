import { EnvironmentSchema, type GatewayConfig } from './configuration.schema';
import secretsLoader from './secrets.loader';

/**
 * NestJS ConfigModule factory function.
 * Validates process.env against the Zod schema and returns typed config.
 * Throws on startup if any required variable is missing or invalid.
 */
export async function loadConfiguration(): Promise<GatewayConfig> {
  const isProduction = process.env.NODE_ENV === 'production';
  const isStaging = process.env.NODE_ENV === 'staging';

  let rawConfig: Record<string, unknown>;

  if (isProduction || isStaging) {
    rawConfig = await secretsLoader();
  } else {
    rawConfig = process.env;
  }

  const result = EnvironmentSchema.safeParse(rawConfig);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`❌ Invalid configuration:\n${formatted}`);
  }

  return result.data;
}

export { type GatewayConfig } from './configuration.schema';
