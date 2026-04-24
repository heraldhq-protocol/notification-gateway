import { Injectable, Logger } from '@nestjs/common';

const BLOCKED_PROTOCOLS = [
  'javascript:',
  'vbscript:',
  'data:',
  'mailto:',
  'tel:',
  'blob:',
  'filesystem:',
];

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

const ALLOWED_HOSTS = [
  'useherald.xyz',
  'notify.useherald.xyz',
  'cdn.useherald.xyz',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ucshdejvxzanuxlxrano.supabase.co',
];

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];

export interface UrlValidationResult {
  valid: boolean;
  url?: string;
  error?: string;
}

export interface UrlValidationOptions {
  allowMailto?: boolean;
  allowTel?: boolean;
  allowDataImages?: boolean;
  allowedHosts?: string[];
}

@Injectable()
export class UrlValidator {
  private readonly logger = new Logger(UrlValidator.name);

  isAllowed(url: string, options?: UrlValidationOptions): boolean {
    try {
      const result = this.validate(url, options);
      return result.valid;
    } catch {
      return false;
    }
  }

  validate(url: string, options?: UrlValidationOptions): UrlValidationResult {
    if (!url || typeof url !== 'string') {
      return { valid: false, error: 'URL is required' };
    }

    const trimmedUrl = url.trim().toLowerCase();

    const blockedProtocols = [...BLOCKED_PROTOCOLS];
    if (!options?.allowMailto) {
      blockedProtocols.push('mailto:');
    }
    if (!options?.allowTel) {
      blockedProtocols.push('tel:');
    }

    for (const protocol of blockedProtocols) {
      if (trimmedUrl.startsWith(protocol)) {
        return { valid: false, error: `Protocol '${protocol}' is blocked` };
      }
    }

    if (trimmedUrl.startsWith('data:')) {
      if (!options?.allowDataImages) {
        return { valid: false, error: 'Data URLs are not allowed' };
      }
      const isImage = trimmedUrl.startsWith('data:image/');
      if (!isImage) {
        return { valid: false, error: 'Only image data URLs are allowed' };
      }
    }

    if (
      trimmedUrl.startsWith('http:') ||
      trimmedUrl.startsWith('https://')
    ) {
      const allowedHosts = options?.allowedHosts ?? ALLOWED_HOSTS;
      const parsedUrl = new URL(trimmedUrl.startsWith('http:')
        ? trimmedUrl
        : `https://${trimmedUrl.replace(/^\/\//, '')}`);
      
      const isAllowedHost = allowedHosts.some(
        (host) =>
          parsedUrl.hostname === host ||
          parsedUrl.hostname.endsWith(`.${host}`),
      );

      if (!isAllowedHost) {
        return {
          valid: false,
          error: `Host '${parsedUrl.hostname}' is not in the allowed list`,
        };
      }
    }

    return { valid: true, url };
  }

  validateAllUrls(html: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const urlPattern = /(?:src|href)=["']([^"']+)["']/gi;
    let match;

    while ((match = urlPattern.exec(html)) !== null) {
      const url = match[1];
      if (!this.isAllowed(url)) {
        errors.push(`Blocked URL: ${url}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  validateImageUrls(html: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const imgPattern = /<img[^>]+src=["']([^"']+)["']/gi;
    let match;

    while ((match = imgPattern.exec(html)) !== null) {
      const src = match[1];

      if (!this.isAllowed(src)) {
        errors.push(`Blocked image URL: ${src}`);
        continue;
      }

      if (!src.startsWith('data:') && !src.startsWith('http')) {
        errors.push(`Invalid image URL: ${src}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  getBlockedProtocols(): string[] {
    return [...BLOCKED_PROTOCOLS];
  }

  getAllowedHosts(): string[] {
    return [...ALLOWED_HOSTS];
  }
}
