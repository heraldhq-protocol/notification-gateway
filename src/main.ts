import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module.js';
import { HeraldExceptionFilter } from './common/exceptions/exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js';
import { ResponseTimeInterceptor } from './common/interceptors/response-time.interceptor.js';

/**
 * Herald Notification Gateway — Bootstrap
 *
 * Configures:
 * - Helmet (security headers)
 * - CORS
 * - Swagger (API documentation at /docs)
 * - Global ValidationPipe (class-validator)
 * - Global exception filter
 * - Logging + timeout + response-time interceptors
 * - compression
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // ── Security ───────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: false, // API-only service
    }),
  );
  app.use(compression());

  // ── CORS ───────────────────────────────────────────────────
  app.enableCors({
    origin:
      process.env.NODE_ENV === 'production'
        ? ['https://app.herald.xyz', 'https://notify.herald.xyz']
        : '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // ── Global Pipes ───────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ── Global Filters & Interceptors ─────────────────────────
  app.useGlobalFilters(new HeraldExceptionFilter());
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TimeoutInterceptor(30_000), // 30s timeout
    new ResponseTimeInterceptor(),
  );

  // ── Swagger ────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Herald Notification Gateway')
    .setDescription(
      'Privacy-preserving notification delivery for Solana protocols.\n\n' +
        '**Authentication:** All endpoints require a `Bearer hrld_xxx` API key.\n\n' +
        '**Rate Limits:** Developer: 2 req/s | Growth: 20 req/s | Scale: 100 req/s | Enterprise: 500 req/s',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addTag('Notifications', 'Send and track notifications')
    .addTag('Webhooks', 'Manage webhook endpoints')
    .addTag('Analytics', 'Delivery analytics and usage')
    .addTag('Protocol', 'Protocol self-service')
    .addTag('Health', 'Service health checks')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'Herald Gateway API',
    customCss: `
      .swagger-ui .topbar { background-color: #0A1628; }
      .swagger-ui .topbar .topbar-wrapper .link::after { content: " — Herald Notification Gateway"; }
    `,
  });

  // ── Start ──────────────────────────────────────────────────
  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`\n✉️  Herald Gateway listening on http://localhost:${port}`);
  console.log(`📖 Swagger docs at http://localhost:${port}/docs`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV ?? 'development'}\n`);
}

bootstrap();
