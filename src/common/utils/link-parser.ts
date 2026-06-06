export type LinkType = 'image' | 'video' | 'url';

export interface ParsedLink {
  label: string;
  url: string;
  startIndex: number;
  endIndex: number;
  linkType: LinkType;
}

export interface ParseMarkdownLinksResult {
  cleanText: string;
  links: ParsedLink[];
}

const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)(?:[?#]|$)/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi|mkv|flv)(?:[?#]|$)/i;
const IMAGE_DOMAINS =
  /^(https?:\/\/)?(i\.)?imgur\.com|cdn\.dialect\.so|images\.unsplash\.com|media\.giphy\.com/i;
const VIDEO_DOMAINS =
  /^(https?:\/\/)?(player\.)?youtube\.com|cdn\.dialect\.so|v\.imeo\.com|media\.giphy\.com/i;

function detectLinkType(url: string): LinkType {
  const lowerUrl = url.toLowerCase();

  if (IMAGE_EXTENSIONS.test(lowerUrl) || IMAGE_DOMAINS.test(lowerUrl)) {
    return 'image';
  }
  if (VIDEO_EXTENSIONS.test(lowerUrl) || VIDEO_DOMAINS.test(lowerUrl)) {
    return 'video';
  }
  return 'url';
}

export function parseMarkdownLinks(text: string): ParseMarkdownLinksResult {
  const links: ParsedLink[] = [];
  let cleanText = text;
  let match: RegExpExecArray | null;

  const regex = new RegExp(MARKDOWN_LINK_REGEX.source, 'g');

  while ((match = regex.exec(text)) !== null) {
    const url = match[2];
    links.push({
      label: match[1],
      url,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      linkType: detectLinkType(url),
    });
  }

  cleanText = text.replace(MARKDOWN_LINK_REGEX, '$1');

  return {
    cleanText,
    links,
  };
}

export function convertLinksToHtml(text: string, links: ParsedLink[]): string {
  if (links.length === 0) return text;

  let result = text;
  const sortedLinks = [...links].sort((a, b) => b.startIndex - a.startIndex);

  for (const link of sortedLinks) {
    const before = result.slice(0, link.startIndex);
    const after = result.slice(link.endIndex);
    const htmlElement = renderHtmlElement(link);
    result = before + htmlElement + after;
  }

  return result;
}

function renderHtmlElement(link: ParsedLink): string {
  const safeUrl = escapeHtml(link.url);
  const safeLabel = escapeHtml(link.label);

  switch (link.linkType) {
    case 'image':
      return `<a href="${safeUrl}"><img src="${safeUrl}" alt="${safeLabel}" style="max-width:100%;height:auto;" /></a>`;
    case 'video':
      return `<a href="${safeUrl}">${safeLabel}</a>`;
    case 'url':
    default:
      return `<a href="${safeUrl}">${safeLabel}</a>`;
  }
}

export function extractMediaLinks(links: ParsedLink[]): {
  images: string[];
  videos: string[];
  normalLinks: ParsedLink[];
} {
  const images: string[] = [];
  const videos: string[] = [];
  const normalLinks: ParsedLink[] = [];

  for (const link of links) {
    switch (link.linkType) {
      case 'image':
        images.push(link.url);
        break;
      case 'video':
        videos.push(link.url);
        break;
      case 'url':
      default:
        normalLinks.push(link);
    }
  }

  return { images, videos, normalLinks };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

/**
 * Strip all markdown formatting from text, producing plain text suitable for SMS.
 *
 * Handles: bold, italic, strikethrough, inline code, fenced code blocks, headers,
 * blockquotes, horizontal rules, and markdown tables.
 * Links are reduced to their label text.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Fenced code blocks → [code]
  result = result.replace(/```[\s\S]*?```/g, '[code]');

  // Inline code → bare text
  result = result.replace(/`([^`]+)`/g, '$1');

  // Markdown links [label](url) → label
  result = result.replace(MARKDOWN_LINK_REGEX, '$1');

  // Table separator lines (e.g. |---|---|) → remove entirely
  result = result.replace(/^\|[-:| ]+\|[ \t]*$/gm, '');

  // Table data rows | cell | cell | → cell | cell (strip outer pipes)
  result = result.replace(/^\|(.+)\|[ \t]*$/gm, (_match, inner) => {
    return inner
      .split('|')
      .map((cell: string) => cell.trim())
      .filter(Boolean)
      .join(' | ');
  });

  // Bold: **text** and __text__
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  result = result.replace(/__([^_\n]+)__/g, '$1');

  // Italic: *text* and _text_ (single)
  result = result.replace(/\*([^*\n]+)\*/g, '$1');
  result = result.replace(/_([^_\n]+)_/g, '$1');

  // Strikethrough: ~~text~~
  result = result.replace(/~~([^~\n]+)~~/g, '$1');

  // ATX headers: ## Title → Title
  result = result.replace(/^#{1,6}\s+/gm, '');

  // Horizontal rules: ---, ***, ___
  result = result.replace(/^(\*{3,}|-{3,}|_{3,})[ \t]*$/gm, '');

  // Blockquotes: > text → text
  result = result.replace(/^>\s*/gm, '');

  // Collapse 3+ blank lines to 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

export function injectVariables(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}
