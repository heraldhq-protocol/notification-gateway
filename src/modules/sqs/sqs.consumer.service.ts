import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import { QueueNames } from '../queue/queue.constants';

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private readonly sqs: SQSClient;
  private readonly queueUrl?: string;
  private active = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectQueue(QueueNames.BOUNCE) private readonly bounceQueue: Queue,
  ) {
    this.queueUrl = this.config.get<string>('SQS_SES_QUEUE_URL');
    // SQS queue is co-located with SES — use SES_REGION, not the primary AWS_REGION
    this.sqs = new SQSClient({
      region: this.config.get<string>('SES_REGION', 'us-east-1'),
      maxAttempts: 3,
    });
  }

  onModuleInit() {
    if (!this.queueUrl) {
      this.logger.log('SQS_SES_QUEUE_URL not set — SQS polling disabled');
      return;
    }
    this.active = true;
    void this.poll();
    this.logger.log('SQS SES notification polling started', {
      queueUrl: this.queueUrl,
    });
  }

  onModuleDestroy() {
    this.active = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.sqs.destroy();
  }

  private async poll() {
    if (!this.active) return;

    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 30,
        }),
      );

      if (result.Messages && result.Messages.length > 0) {
        const entries: { Id: string; ReceiptHandle: string }[] = [];

        for (const msg of result.Messages) {
          try {
            await this.processMessage(msg);
            if (msg.ReceiptHandle && msg.MessageId) {
              entries.push({
                Id: msg.MessageId,
                ReceiptHandle: msg.ReceiptHandle,
              });
            }
          } catch (err) {
            this.logger.error('Failed to process SQS message', {
              messageId: msg.MessageId,
              error: (err as Error).message,
            });
          }
        }

        if (entries.length > 0) {
          await this.sqs.send(
            new DeleteMessageBatchCommand({
              QueueUrl: this.queueUrl,
              Entries: entries,
            }),
          );
        }
      }
    } catch (err) {
      this.logger.error('SQS poll error', { error: (err as Error).message });
    }

    if (this.active) {
      this.pollTimer = setTimeout(() => void this.poll(), 1000);
    }
  }

  private async processMessage(msg: any) {
    let body: any;

    try {
      body = typeof msg.Body === 'string' ? JSON.parse(msg.Body) : msg.Body;
    } catch {
      this.logger.warn('Invalid JSON in SQS message body');
      return;
    }

    const notificationType = body.notificationType ?? body.Type;

    if (notificationType === 'SubscriptionConfirmation') {
      this.logger.log('SNS subscription confirmation received via SQS');
      return;
    }

    const messageData =
      typeof body.Message === 'string'
        ? JSON.parse(body.Message)
        : (body.Message ?? body);

    await this.bounceQueue.add('ses-bounce', messageData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    this.logger.debug('Enqueued SES notification from SQS', {
      notificationType: messageData.notificationType,
      messageId: messageData.mail?.messageId,
    });
  }
}
