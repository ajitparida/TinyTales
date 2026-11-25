import { Story, VoicePersonaId } from '../types/story';
import {
  auth,
  getPublishedMediaCloud,
  getStoryMediaCloud,
  savePublishedMediaCloud,
  saveStoryMediaCloud,
} from './firebase';
import { compressImageForCloudSync } from './watercolorFilter';

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

const SYNCED_MEDIA_STORAGE_PREFIX = 'meadowtale_cloud_media_synced_v1:';

function readSyncedMediaIds(uid: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${SYNCED_MEDIA_STORAGE_PREFIX}${uid}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function markMediaIdSynced(uid: string, mediaId: string): void {
  try {
    const existing = readSyncedMediaIds(uid);
    existing.add(mediaId);
    localStorage.setItem(
      `${SYNCED_MEDIA_STORAGE_PREFIX}${uid}`,
      JSON.stringify(Array.from(existing).slice(-500))
    );
  } catch {
    // Ignore storage errors
  }
}

/**
 * Saves a custom storybook illustration to local IndexedDB for instant offline access
 * AND syncs a crisp compressed copy to Firestore (/users/{uid}/media/{mediaId}) when signed in
 * so incognito windows and other devices display the exact same artwork.
 */
export async function saveStoryMedia(
  storyId: string,
  mediaId: string,
  dataUrl: string
): Promise<void> {
  if (!mediaId || !dataUrl) return;
  await saveMediaDataUrl(mediaId, dataUrl);

  const uid = auth.currentUser?.uid;
  if (!uid || !dataUrl.startsWith('data:image/')) return;

  try {
    const compressed = await compressImageForCloudSync(dataUrl);
    const saved = await saveStoryMediaCloud(uid, storyId, mediaId, compressed.dataUrl);
    if (saved) {
      markMediaIdSynced(uid, mediaId);
    }
  } catch (err) {
    console.warn('Could not sync story image to cloud:', err);
  }
}

/**
 * Resolves a custom or admin-published storybook illustration: checks local IndexedDB first,
 * then fetches from Firestore (/users/{uid}/media/{mediaId} or /publishedMedia/{mediaId})
 * and caches it locally in IndexedDB.
 */
export async function resolveStoryMediaUrl(
  mediaId: string,
  options?: { preferPublished?: boolean }
): Promise<string | null> {
  if (!mediaId) return null;

  const localUrl = await getMediaDataUrl(mediaId);
  if (localUrl) return localUrl;

  const uid = auth.currentUser?.uid;
  let cloudUrl: string | null = null;

  if (options?.preferPublished) {
    cloudUrl = await getPublishedMediaCloud(mediaId);
    if (!cloudUrl && uid) {
      cloudUrl = await getStoryMediaCloud(uid, mediaId);
    }
  } else {
    if (uid) {
      cloudUrl = await getStoryMediaCloud(uid, mediaId);
    }
    if (!cloudUrl) {
      cloudUrl = await getPublishedMediaCloud(mediaId);
    }
  }

  if (cloudUrl) {
    void saveMediaDataUrl(mediaId, cloudUrl);
    return cloudUrl;
  }
  return null;
}

/**
 * Copies all page & cover artwork for a storybook into /publishedMedia/{mediaId}
 * so visitors on the main site (including signed-out & incognito guests) see identical illustrations.
 */
export async function publishStoryMediaToCloud(uid: string, story: Story): Promise<number> {
  if (!uid) return 0;
  const candidateIds = new Set<string>();
  if (story.coverMediaId) candidateIds.add(story.coverMediaId);
  for (const page of story.pages) {
    if (page.mediaId) candidateIds.add(page.mediaId);
  }

  let uploaded = 0;
  for (const mediaId of candidateIds) {
    if (!mediaId) continue;
    const sourceUrl = await resolveStoryMediaUrl(mediaId);
    if (!sourceUrl || !sourceUrl.startsWith('data:image/')) continue;
    const compressed = await compressImageForCloudSync(sourceUrl);
    const ok = await savePublishedMediaCloud(uid, story.id, mediaId, compressed.dataUrl);
    if (ok) uploaded++;
  }
  return uploaded;
}

const activeBackfillRuns = new Set<string>();

/**
 * Quietly uploads any pre-existing local custom story images (created before cloud media sync
 * was added) from this browser's IndexedDB to Firestore once per mediaId so they appear
 * identically in incognito windows and on other devices.
 */
export async function backfillLocalStoryMediaToCloud(
  uid: string,
  stories: Story[]
): Promise<number> {
  if (!uid || stories.length === 0) return 0;

  const syncedSet = readSyncedMediaIds(uid);
  let uploaded = 0;

  for (const story of stories) {
    if (!story.isCustom) continue;
    const candidateIds = new Set<string>();
    if (story.coverMediaId) candidateIds.add(story.coverMediaId);
    for (const page of story.pages) {
      if (page.mediaId) candidateIds.add(page.mediaId);
    }

    for (const mediaId of candidateIds) {
      if (!mediaId || syncedSet.has(mediaId) || activeBackfillRuns.has(`${uid}:${mediaId}`)) {
        continue;
      }
      const localUrl = await getMediaDataUrl(mediaId);
      if (!localUrl || !localUrl.startsWith('data:image/')) continue;

      const runKey = `${uid}:${mediaId}`;
      activeBackfillRuns.add(runKey);
      try {
        const compressed = await compressImageForCloudSync(localUrl);
        const ok = await saveStoryMediaCloud(uid, story.id, mediaId, compressed.dataUrl);
        if (ok) {
          markMediaIdSynced(uid, mediaId);
          syncedSet.add(mediaId);
          uploaded++;
        }
      } finally {
        activeBackfillRuns.delete(runKey);
      }
    }
  }

  return uploaded;
}
