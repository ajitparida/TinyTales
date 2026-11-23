import { VoicePersonaId } from '../types/story';

const DB_NAME = 'meadowtale_media_v1';
const STORE_NAME = 'media_blobs';

function openMediaDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveMediaDataUrl(key: string, dataUrl: string): Promise<void> {
  try {
    const db = await openMediaDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(dataUrl, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('IndexedDB save failed:', err);
  }
}

export async function getMediaDataUrl(key: string): Promise<string | null> {
  if (!key) return null;
  try {
    const db = await openMediaDB();
    const result = await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch (err) {
    console.warn('IndexedDB read failed:', err);
    return null;
  }
}

export async function deleteMediaKey(key: string): Promise<void> {
  if (!key) return;
  try {
    const db = await openMediaDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('IndexedDB delete failed:', err);
  }
}

export async function listMediaKeysByPrefix(prefix: string): Promise<string[]> {
  try {
    const db = await openMediaDB();
    const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return allKeys
      .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
      .sort();
  } catch (err) {
    console.warn('IndexedDB list keys failed:', err);
    return [];
  }
}

export async function clearMediaKeysByPrefix(prefix: string): Promise<number> {
  try {
    const matchingKeys = await listMediaKeysByPrefix(prefix);
    if (matchingKeys.length === 0) return 0;
    const db = await openMediaDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const key of matchingKeys) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return matchingKeys.length;
  } catch (err) {
    console.warn('IndexedDB clear prefix failed:', err);
    return 0;
  }
}

export function parentVoiceKey(storyId: string, pageId: string): string {
  return `parent_voice:${storyId}:${pageId}`;
}

export function ttsCacheKey(
  storyId: string,
  pageId: string,
  mode: 'daytime' | 'bedtime',
  voicePersona: VoicePersonaId = 'warm'
): string {
  return `ai_tts:${storyId}:${pageId}:${mode}:${voicePersona}`;
}

export function characterVoiceKey(storyId: string, hotspotId: string): string {
  return `char_tts:${storyId}:${hotspotId}`;
}

export async function listParentVoiceSummary(): Promise<Record<string, number>> {
  const keys = await listMediaKeysByPrefix('parent_voice:');
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const parts = key.split(':');
    const storyId = parts[1];
    if (storyId) {
      counts[storyId] = (counts[storyId] || 0) + 1;
    }
  }
  return counts;
}

export async function clearParentVoicesForStory(storyId: string): Promise<number> {
  return clearMediaKeysByPrefix(`parent_voice:${storyId}:`);
}

export async function clearAllParentVoices(): Promise<number> {
  return clearMediaKeysByPrefix('parent_voice:');
}

export async function clearAllAiVoiceCache(): Promise<number> {
  const pageCount = await clearMediaKeysByPrefix('ai_tts:');
  const charCount = await clearMediaKeysByPrefix('char_tts:');
  return pageCount + charCount;
}
