import type { AttachmentKind, PendingAttachment } from '../types/chat';

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_TOTAL_UPLOAD_BYTES = 40 * 1024 * 1024; // 40 MiB aggregate per request
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_PROMPT_CHARS = 8000;

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.mov',
  '.webm',
  '.mpeg',
  '.mpg',
  '.avi',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.docx',
]);

export const FILE_INPUT_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.mpeg,.mpg,.avi,.pdf,.txt,.md,.csv,.json,.docx,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,application/pdf,text/plain,text/markdown,text/csv,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

export function classifyFileKind(file: File): AttachmentKind {
  const ext = getExtension(file.name);
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) || file.type.startsWith('image/')) {
    return 'image';
  }
  if (['.mp4', '.mov', '.webm', '.mpeg', '.mpg', '.avi'].includes(ext) || file.type.startsWith('video/')) {
    return 'video';
  }
  return 'document';
}

export function calculateTotalAttachmentBytes(
  files: ReadonlyArray<{ size: number }>
): number {
  return files.reduce(
    (sum, item) => sum + (Number.isFinite(item.size) && item.size > 0 ? item.size : 0),
    0
  );
}

export function validateFile(file: File): string | null {
  const ext = getExtension(file.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `"${file.name}" is not a supported format. Allowed: JPG, PNG, WEBP, MP4, MOV, WEBM, PDF, TXT, MD, CSV, JSON, DOCX.`;
  }
  if (file.size <= 0) {
    return `"${file.name}" is empty and cannot be attached.`;
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return `"${file.name}" (${formatFileSize(file.size)}) exceeds the 25 MB limit per file.`;
  }
  return null;
}

export interface BatchAttachmentValidationResult {
  accepted: File[];
  errors: string[];
}

export function validateAttachmentBatch(
  incomingFiles: File[],
  existingFiles: ReadonlyArray<{ size: number }> = []
): BatchAttachmentValidationResult {
  const errors: string[] = [];
  const accepted: File[] = [];

  const availableSlots = MAX_ATTACHMENTS_PER_MESSAGE - existingFiles.length;
  if (availableSlots <= 0) {
    return {
      accepted: [],
      errors: [`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`],
    };
  }

  if (incomingFiles.length > availableSlots) {
    errors.push(`Only ${MAX_ATTACHMENTS_PER_MESSAGE} files can be attached per message.`);
  }

  let runningTotalBytes = calculateTotalAttachmentBytes(existingFiles);
  const candidates = incomingFiles.slice(0, availableSlots);

  for (const file of candidates) {
    const fileError = validateFile(file);
    if (fileError) {
      errors.push(fileError);
      continue;
    }

    if (runningTotalBytes + file.size > MAX_TOTAL_UPLOAD_BYTES) {
      errors.push(
        `Adding "${file.name}" (${formatFileSize(file.size)}) exceeds the 40 MB total upload limit per message.`
      );
      continue;
    }

    runningTotalBytes += file.size;
    accepted.push(file);
  }

  return { accepted, errors };
}

export interface OutgoingPayloadValidationResult {
  valid: boolean;
  code?:
    | 'EMPTY_REQUEST'
    | 'PROMPT_TOO_LONG'
    | 'TOO_MANY_FILES'
    | 'FILE_TOO_LARGE'
    | 'TOTAL_UPLOAD_TOO_LARGE'
    | 'INVALID_UPLOAD';
  error?: string;
}

export function validateOutgoingPayload(params: {
  message: string;
  files: File[];
}): OutgoingPayloadValidationResult {
  const { message, files } = params;

  if (!message.trim() && files.length === 0) {
    return {
      valid: false,
      code: 'EMPTY_REQUEST',
      error: 'Please enter a message or attach a supported file.',
    };
  }

  if (message.length > MAX_PROMPT_CHARS) {
    return {
      valid: false,
      code: 'PROMPT_TOO_LONG',
      error: `Your message is too long (${message.length.toLocaleString()} characters). Please keep it within ${MAX_PROMPT_CHARS.toLocaleString()} characters.`,
    };
  }

  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      valid: false,
      code: 'TOO_MANY_FILES',
      error: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
    };
  }

  for (const file of files) {
    const ext = getExtension(file.name);
    if (!ALLOWED_EXTENSIONS.has(ext) || file.size <= 0) {
      return {
        valid: false,
        code: 'INVALID_UPLOAD',
        error: validateFile(file) ?? `"${file.name}" could not be attached.`,
      };
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return {
        valid: false,
        code: 'FILE_TOO_LARGE',
        error: `"${file.name}" (${formatFileSize(file.size)}) exceeds the 25 MB limit per file.`,
      };
    }
  }

  const totalBytes = calculateTotalAttachmentBytes(files);
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return {
      valid: false,
      code: 'TOTAL_UPLOAD_TOO_LARGE',
      error: `Total attached files (${formatFileSize(totalBytes)}) exceed the 40 MB limit per message.`,
    };
  }

  return { valid: true };
}

/** Creates a compact JPEG/WebP thumbnail data URL so image previews persist safely in IndexedDB */
async function createCompactImagePreview(file: File): Promise<string> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 480;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/webp', 0.82);
          URL.revokeObjectURL(objectUrl);
          resolve(dataUrl);
          return;
        }
      } catch {
        // Fallback below
      }
      URL.revokeObjectURL(objectUrl);
      resolve('');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve('');
    };
    img.src = objectUrl;
  });
}

export async function preparePendingAttachment(file: File): Promise<PendingAttachment> {
  const kind = classifyFileKind(file);
  let previewUrl: string | undefined;

  if (kind === 'image') {
    previewUrl = await createCompactImagePreview(file);
    if (!previewUrl) {
      previewUrl = URL.createObjectURL(file);
    }
  } else if (kind === 'video') {
    previewUrl = URL.createObjectURL(file);
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    kind,
    previewUrl,
    file,
  };
}
