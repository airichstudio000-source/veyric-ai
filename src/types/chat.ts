export type AttachmentKind = 'image' | 'video' | 'document';

export type ContentBlockType =
  | 'video_script'
  | 'content_writing'
  | 'storytelling'
  | 'image_prompt'
  | 'video_prompt'
  | 'social_caption'
  | 'marketing_copy'
  | 'professional_email';

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: AttachmentKind;
  /** Persistent or session preview data URL for images; object URL during active session for videos */
  previewUrl?: string;
}

export interface PendingAttachment extends MessageAttachment {
  file: File;
}

export interface GroundingSource {
  title: string;
  uri: string;
  domain: string;
}

export interface GroundingInfo {
  enabled: boolean;
  used: boolean;
  searchQueries: string[];
  sources: GroundingSource[];
}

export type StreamPhase = 'processing_files' | 'searching' | 'generating';

export type ChatErrorKind = 'quota' | 'auth' | 'retryable';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  attachments?: MessageAttachment[];
  grounding?: GroundingInfo;
  isStreaming?: boolean;
  streamPhase?: StreamPhase;
  error?: string;
  errorKind?: ChatErrorKind;
  followUpSuggestions?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
