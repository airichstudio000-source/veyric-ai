import type { Conversation, MessageAttachment } from '../types/chat';

const DB_NAME = 'veyric_ai_storage';
const DB_VERSION = 1;
const STORE_NAME = 'conversations';
const LS_FALLBACK_KEY = 'veyric_ai_conversations_v1';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function sanitizeAttachmentForStorage(att: MessageAttachment): MessageAttachment {
  // Blob URLs do not survive page reloads; keep only data URLs (compact image thumbnails)
  const persistablePreview =
    att.previewUrl && att.previewUrl.startsWith('data:') ? att.previewUrl : undefined;
  return {
    id: att.id,
    name: att.name,
    size: att.size,
    mimeType: att.mimeType,
    kind: att.kind,
    ...(persistablePreview ? { previewUrl: persistablePreview } : {}),
  };
}

function sanitizeConversationForStorage(conv: Conversation): Conversation {
  return {
    ...conv,
    messages: conv.messages
      .filter((m) => !m.isStreaming || m.content.trim().length > 0 || Boolean(m.error))
      .map((m) => ({
        ...m,
        isStreaming: false,
        streamPhase: undefined,
        ...(m.attachments
          ? { attachments: m.attachments.map(sanitizeAttachmentForStorage) }
          : {}),
      })),
  };
}

export async function loadAllConversations(): Promise<Conversation[]> {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as Conversation[]) ?? [];
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to read conversations'));
    });
  } catch {
    try {
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Conversation[];
      return Array.isArray(parsed)
        ? parsed.sort((a, b) => b.updatedAt - a.updatedAt)
        : [];
    } catch {
      return [];
    }
  }
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const clean = sanitizeConversationForStorage(conversation);
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(clean);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save conversation'));
    });
  } catch {
    try {
      const existing = await loadAllConversations();
      const filtered = existing.filter((c) => c.id !== clean.id);
      filtered.unshift(clean);
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(filtered.slice(0, 40)));
    } catch {
      // Storage quota exceeded; fail silently without breaking active UI
    }
  }
}

export async function removeConversation(conversationId: string): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(conversationId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete conversation'));
    });
  } catch {
    try {
      const existing = await loadAllConversations();
      const filtered = existing.filter((c) => c.id !== conversationId);
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(filtered));
    } catch {
      // Ignore fallback storage errors
    }
  }
}

export function deriveConversationTitle(text: string, attachmentNames: string[]): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned) {
    return cleaned.length > 46 ? `${cleaned.slice(0, 46).trim()}…` : cleaned;
  }
  if (attachmentNames.length === 1) {
    const name = attachmentNames[0];
    return name.length > 42 ? `${name.slice(0, 42)}…` : name;
  }
  if (attachmentNames.length > 1) {
    return `${attachmentNames.length} attached files`;
  }
  return 'New Conversation';
}
