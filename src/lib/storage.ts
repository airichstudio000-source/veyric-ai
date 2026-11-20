import type { Conversation, MessageAttachment } from '../types/chat';

export const DB_NAME = 'veyric_ai_storage';
export const DB_VERSION = 2;
export const LEGACY_STORE_NAME = 'conversations';
export const USER_STORE_NAME = 'user_conversations';
export const LEGACY_LS_FALLBACK_KEY = 'veyric_ai_conversations_v1';
export const USER_LS_KEY_PREFIX = 'veyric_ai_conversations_v2_uid_';

interface StoredUserConversation extends Conversation {
  ownerUid: string;
}

function normalizeUid(uid: string | null | undefined): string | null {
  if (typeof uid !== 'string') return null;
  const trimmed = uid.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getUserLocalStorageKey(uid: string): string {
  return `${USER_LS_KEY_PREFIX}${encodeURIComponent(uid)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Preserve any existing legacy v1 store untouched without migrating or assigning an ownerUid.
      if (!db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        const legacyStore = db.createObjectStore(LEGACY_STORE_NAME, { keyPath: 'id' });
        legacyStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(USER_STORE_NAME)) {
        const userStore = db.createObjectStore(USER_STORE_NAME, {
          keyPath: ['ownerUid', 'id'],
        });
        userStore.createIndex('ownerUid', 'ownerUid', { unique: false });
        userStore.createIndex('ownerUpdatedAt', ['ownerUid', 'updatedAt'], {
          unique: false,
        });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
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

function sanitizeConversationForStorage(
  conversation: Conversation,
  ownerUid: string
): StoredUserConversation {
  return {
    ...conversation,
    ownerUid,
    messages: conversation.messages
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

function loadFromUserLocalStorage(ownerUid: string): Conversation[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(getUserLocalStorageKey(ownerUid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is StoredUserConversation =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as Conversation).id === 'string' &&
          (item as StoredUserConversation).ownerUid === ownerUid
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function writeToUserLocalStorage(ownerUid: string, items: StoredUserConversation[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getUserLocalStorageKey(ownerUid), JSON.stringify(items));
  } catch {
    // Storage quota exceeded or unavailable; fail silently without breaking active UI
  }
}

export async function loadAllConversations(uid: string): Promise<Conversation[]> {
  const ownerUid = normalizeUid(uid);
  if (!ownerUid) {
    return [];
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
    return await new Promise<Conversation[]>((resolve, reject) => {
      const tx = db!.transaction(USER_STORE_NAME, 'readonly');
      const store = tx.objectStore(USER_STORE_NAME);
      const index = store.index('ownerUid');
      const req = index.getAll(ownerUid);
      req.onsuccess = () => {
        const rawItems = (req.result as StoredUserConversation[]) ?? [];
        const owned = rawItems.filter(
          (item) => item && item.ownerUid === ownerUid && typeof item.id === 'string'
        );
        owned.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(owned);
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to read conversations'));
    });
  } catch {
    return loadFromUserLocalStorage(ownerUid);
  } finally {
    db?.close();
  }
}

export async function saveConversation(
  uid: string,
  conversation: Conversation
): Promise<void> {
  const ownerUid = normalizeUid(uid);
  if (!ownerUid) {
    return;
  }
  if (conversation.ownerUid && conversation.ownerUid !== ownerUid) {
    return;
  }

  const clean = sanitizeConversationForStorage(conversation, ownerUid);
  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(USER_STORE_NAME, 'readwrite');
      const store = tx.objectStore(USER_STORE_NAME);
      store.put(clean);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save conversation'));
    });
  } catch {
    const existing = loadFromUserLocalStorage(ownerUid).map((c) => ({
      ...c,
      ownerUid,
    }));
    const filtered = existing.filter((c) => c.id !== clean.id);
    filtered.unshift(clean);
    writeToUserLocalStorage(ownerUid, filtered.slice(0, 40));
  } finally {
    db?.close();
  }
}

export async function removeConversation(
  uid: string,
  conversationId: string
): Promise<void> {
  const ownerUid = normalizeUid(uid);
  if (!ownerUid || !conversationId) {
    return;
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(USER_STORE_NAME, 'readwrite');
      const store = tx.objectStore(USER_STORE_NAME);
      store.delete([ownerUid, conversationId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete conversation'));
    });
  } catch {
    const existing = loadFromUserLocalStorage(ownerUid).map((c) => ({
      ...c,
      ownerUid,
    }));
    const filtered = existing.filter((c) => c.id !== conversationId);
    writeToUserLocalStorage(ownerUid, filtered);
  } finally {
    db?.close();
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
