import { SecretsManager } from '@aws-sdk/client-secrets-manager';

export interface SecretsConfig {
  [key: string]: string | undefined;
}

const isProduction = process.env.NODE_ENV === 'production';
const isStaging = process.env.NODE_ENV === 'staging';

export default async function secretsLoader(): Promise<SecretsConfig> {
  const secretId = process.env.SECRET_ID;
  const region = process.env.AWS_REGION || 'us-east-1';

  if (!secretId) {
    if (isProduction || isStaging) {
      throw new Error(
        'SECRET_ID is required in staging/production environment. Set SECRET_ENTITY environment variable.',
      );
    }
    return {};
  }

  if (!isProduction && !isStaging) {
    console.warn(
      `SECRET_ID is set ("${secretId}") but NODE_ENV is "${process.env.NODE_ENV}". Only staging/production should use AWS Secrets Manager.`,
    );
  }

  const client = new SecretsManager({
    region,
    maxAttempts: 3,
  });

  try {
    const response = await client.getSecretValue({ SecretId: secretId });

    if (!response.SecretString) {
      throw new Error(`Secret "${secretId}" has empty SecretString`);
    }

    const parsedSecrets = JSON.parse(response.SecretString);

    return {
      ...parsedSecrets,
      NODE_ENV: process.env.NODE_ENV,
      AWS_REGION: region,
      SECRET_ID: secretId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to fetch AWS secret "${secretId}": ${message}`);
  }
}
