import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  AvatarId,
  AgeGroup,
  BedtimeSettings,
  ChildProfile,
  ReadingLogEntry,
  Story,
} from '../types/story';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const DEFAULT_BEDTIME_SETTINGS: BedtimeSettings = {
  bedtimeEnabled: false,
  bedtimeDimness: 20,
  sleepTimerMinutes: 15,
  maxStoriesPerSession: 2,
  calmVoiceDefault: true,
  ambientLullaby: false,
  reducedMotion: true,
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : `id_${Date.now()}`;
}

export function clampString(val: string, maxLen: number, fallback = ''): string {
  const trimmed = (val ?? '').trim();
  if (!trimmed) return fallback.slice(0, maxLen);
  return trimmed.slice(0, maxLen);
}

export function clampNumber(val: number, min: number, max: number): number {
  const num = Number.isFinite(val) ? val : min;
  return Math.max(min, Math.min(max, Math.round(num)));
}

export async function signInParentWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutParent(): Promise<void> {
  await signOut(auth);
}

export async function ensureParentAccount(user: User): Promise<BedtimeSettings> {
  const userPath = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      return {
        bedtimeEnabled: Boolean(data.bedtimeEnabled),
        bedtimeDimness: clampNumber(Number(data.bedtimeDimness ?? 20), 0, 60),
        sleepTimerMinutes: clampNumber(Number(data.sleepTimerMinutes ?? 15), 0, 60),
        maxStoriesPerSession: clampNumber(Number(data.maxStoriesPerSession ?? 2), 1, 10),
        calmVoiceDefault: Boolean(data.calmVoiceDefault ?? true),
        ambientLullaby: Boolean(data.ambientLullaby ?? false),
        reducedMotion: Boolean(data.reducedMotion ?? true),
      };
    }
    const payload = {
      uid: user.uid,
      displayName: clampString(user.displayName || 'Parent', 100, 'Parent'),
      ...DEFAULT_BEDTIME_SETTINGS,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, payload);
    return DEFAULT_BEDTIME_SETTINGS;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function saveBedtimeSettingsCloud(
  uid: string,
  settings: BedtimeSettings
): Promise<void> {
  const userPath = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      bedtimeEnabled: Boolean(settings.bedtimeEnabled),
      bedtimeDimness: clampNumber(settings.bedtimeDimness, 0, 60),
      sleepTimerMinutes: clampNumber(settings.sleepTimerMinutes, 0, 60),
      maxStoriesPerSession: clampNumber(settings.maxStoriesPerSession, 1, 10),
      calmVoiceDefault: Boolean(settings.calmVoiceDefault),
      ambientLullaby: Boolean(settings.ambientLullaby),
      reducedMotion: Boolean(settings.reducedMotion),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, userPath);
  }
}

export function subscribeChildProfiles(
  uid: string,
  onData: (children: ChildProfile[]) => void,
  onError?: (err: Error) => void
) {
  const colPath = `users/${uid}/children`;
  const q = query(
    collection(db, 'users', uid, 'children'),
    where('ownerId', '==', uid),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const list: ChildProfile[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerId: String(data.ownerId ?? uid),
          name: String(data.name ?? 'Little Reader'),
          ageGroup: data.ageGroup === '4-5' ? '4-5' : '2-3',
          avatar: (['duck', 'bear', 'firefly', 'fox'].includes(data.avatar)
            ? data.avatar
            : 'duck') as AvatarId,
          starsEarned: Number(data.starsEarned ?? 0),
          totalMinutesRead: Number(data.totalMinutesRead ?? 0),
          storiesCompleted: Number(data.storiesCompleted ?? 0),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

export async function createChildProfileCloud(
  uid: string,
  input: { name: string; ageGroup: AgeGroup; avatar: AvatarId }
): Promise<string> {
  const childId = sanitizeId(`child_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const path = `users/${uid}/children/${childId}`;
  try {
    await setDoc(doc(db, 'users', uid, 'children', childId), {
      ownerId: uid,
      name: clampString(input.name, 40, 'Little Reader'),
      ageGroup: input.ageGroup === '4-5' ? '4-5' : '2-3',
      avatar: input.avatar,
      starsEarned: 0,
      totalMinutesRead: 0,
      storiesCompleted: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return childId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteChildProfileCloud(uid: string, childId: string): Promise<void> {
  const path = `users/${uid}/children/${childId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'children', childId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeCustomStories(
  uid: string,
  onData: (stories: Story[]) => void,
  onError?: (err: Error) => void
) {
  const colPath = `users/${uid}/stories`;
  const q = query(
    collection(db, 'users', uid, 'stories'),
    where('ownerId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const list: Story[] = snapshot.docs.map((d) => {
        const data = d.data();
        const createdAt = data.createdAt as Timestamp | undefined;
        return {
          id: d.id,
          title: String(data.title ?? 'Scanned Story'),
          subtitle: String(data.subtitle ?? ''),
          ageGroup: data.ageGroup === '4-5' ? '4-5' : '2-3',
          moralTitle: String(data.moralTitle ?? 'Kindness'),
          moralLesson: String(data.moralLesson ?? ''),
          parentDiscussionPrompt: String(data.parentDiscussionPrompt ?? ''),
          coverMediaId: String(data.coverMediaId ?? ''),
          coverFallbackId: (['pond', 'forest', 'twilight', 'bridge'].includes(data.coverFallbackId)
            ? data.coverFallbackId
            : 'forest') as Story['coverFallbackId'],
          readMinutes: Number(data.readMinutes ?? 2),
          isCustom: true,
          pages: Array.isArray(data.pages) ? data.pages : [],
          createdAtMs: createdAt?.toMillis?.() ?? Date.now(),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

function buildSanitizedCustomStoryFields(story: Story) {
  const sanitizedPages = story.pages.slice(0, 10).map((p, idx) => ({
    id: sanitizeId(p.id || `page_${idx + 1}`),
    text: clampString(p.text, 3000, 'Turn the page to continue the story.'),
    sceneSummary: clampString(p.sceneSummary, 300, 'Storybook illustration'),
    mediaId: clampString(p.mediaId || '', 128),
    visualMode:
      p.visualMode === 'redraw'
        ? 'redraw'
        : p.visualMode === 'watercolor'
          ? 'watercolor'
          : 'photo',
    fallbackArtId: p.fallbackArtId || story.coverFallbackId || 'forest',
    hotspots: (p.hotspots || []).slice(0, 4).map((h, hIdx) => ({
      id: sanitizeId(h.id || `hs_${idx}_${hIdx}`),
      name: clampString(h.name, 40, 'Friend'),
      x: clampNumber(h.x, 15, 85),
      y: clampNumber(h.y, 15, 85),
      dialogue: clampString(h.dialogue, 120, 'Hello there!'),
      soundCue: h.soundCue || 'chime',
      reaction: h.reaction || 'bounce',
    })),
  }));

  return {
    title: clampString(story.title, 120, 'Our Scanned Storybook'),
    subtitle: clampString(story.subtitle, 180, 'Captured from your family bookshelf.'),
    ageGroup: story.ageGroup === '4-5' ? '4-5' : '2-3',
    moralTitle: clampString(story.moralTitle, 60, 'Kindness'),
    moralLesson: clampString(
      story.moralLesson,
      360,
      'Every story reminds us to be gentle, curious, and kind.'
    ),
    parentDiscussionPrompt: clampString(
      story.parentDiscussionPrompt,
      240,
      'What was your favorite part of this story?'
    ),
    coverMediaId: clampString(story.coverMediaId || sanitizedPages[0]?.mediaId || '', 128),
    coverFallbackId: story.coverFallbackId || 'forest',
    readMinutes: clampNumber(story.readMinutes || sanitizedPages.length, 1, 30),
    pages: sanitizedPages,
  };
}

export async function saveCustomStoryCloud(uid: string, story: Story): Promise<string> {
  const storyId = sanitizeId(story.id || `story_${Date.now()}`);
  const path = `users/${uid}/stories/${storyId}`;
  const fields = buildSanitizedCustomStoryFields(story);

  try {
    await setDoc(doc(db, 'users', uid, 'stories', storyId), {
      ownerId: uid,
      ...fields,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return storyId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateCustomStoryCloud(uid: string, story: Story): Promise<void> {
  const storyId = sanitizeId(story.id);
  const path = `users/${uid}/stories/${storyId}`;
  const fields = buildSanitizedCustomStoryFields(story);

  try {
    await updateDoc(doc(db, 'users', uid, 'stories', storyId), {
      ...fields,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteCustomStoryCloud(uid: string, storyId: string): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'stories', storyId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

const inflightCloudMediaReads = new Map<string, Promise<string | null>>();

/**
 * Saves or updates a compressed storybook illustration under /users/{uid}/media/{mediaId}
 * so the same parent login shows identical custom book artwork across devices & incognito windows.
 */
export async function saveStoryMediaCloud(
  uid: string,
  storyId: string,
  mediaId: string,
  dataUrl: string
): Promise<boolean> {
  const safeMediaId = sanitizeId(mediaId);
  const safeStoryId = sanitizeId(storyId);
  if (!dataUrl || !dataUrl.startsWith('data:image/') || dataUrl.length > 690_000) {
    return false;
  }

  const mimeMatch = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,/);
  const mimeType = (mimeMatch?.[1] || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
  const ref = doc(db, 'users', uid, 'media', safeMediaId);

  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      await updateDoc(ref, {
        dataUrl,
        mimeType,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ownerId: uid,
        storyId: safeStoryId,
        dataUrl,
        mimeType,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    console.warn('Cloud media sync write skipped:', error);
    return false;
  }
}

/**
 * Fetches a synced storybook illustration from /users/{uid}/media/{mediaId} with
 * inflight request deduplication so library hero & shelf cards share a single read.
 */
export async function getStoryMediaCloud(uid: string, mediaId: string): Promise<string | null> {
  const safeMediaId = sanitizeId(mediaId);
  if (!uid || !safeMediaId) return null;

  const cacheKey = `${uid}:${safeMediaId}`;
  const inflight = inflightCloudMediaReads.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'media', safeMediaId));
      if (!snap.exists()) return null;
      const data = snap.data();
      return typeof data.dataUrl === 'string' && data.dataUrl.startsWith('data:image/')
        ? data.dataUrl
        : null;
    } catch (error) {
      console.warn('Cloud media sync read skipped:', error);
      return null;
    } finally {
      inflightCloudMediaReads.delete(cacheKey);
    }
  })();

  inflightCloudMediaReads.set(cacheKey, promise);
  return promise;
}

/**
 * Deletes cloud media documents associated with a deleted custom storybook.
 */
export async function deleteStoryMediaCloud(uid: string, mediaIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(mediaIds.filter(Boolean).map((id) => sanitizeId(id))));
  await Promise.all(
    uniqueIds.map(async (mediaId) => {
      try {
        await deleteDoc(doc(db, 'users', uid, 'media', mediaId));
      } catch {
        // Ignore missing media docs during cleanup
      }
    })
  );
}

export const ADMIN_EMAILS = new Set([
  'ajit.parida01@gmail.com',
  'ajitparida01@gmail.com',
]);

/**
 * Checks whether the signed-in user has verified Admin privileges (matching the
 * server-enforced isAdmin() predicate in firestore.rules).
 */
export async function checkIsAdminCloud(user: User | null): Promise<boolean> {
  if (!user || !user.emailVerified) return false;
  if (ADMIN_EMAILS.has((user.email || '').trim().toLowerCase())) {
    return true;
  }
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

/**
 * Subscribes to admin-published storybooks visible to all visitors on the main site.
 * Uses only where('status', '==', 'published') and sorts client-side to avoid requiring
 * a custom composite index.
 */
export function subscribePublishedStories(
  onData: (stories: Story[]) => void,
  onError?: (err: Error) => void
) {
  const colPath = 'publishedStories';
  const q = query(collection(db, 'publishedStories'), where('status', '==', 'published'));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: Story[] = snapshot.docs.map((d) => {
        const data = d.data();
        const publishedAt = data.publishedAt as Timestamp | undefined;
        return {
          id: d.id,
          title: String(data.title ?? 'Published Story'),
          subtitle: String(data.subtitle ?? ''),
          ageGroup: data.ageGroup === '4-5' ? '4-5' : '2-3',
          moralTitle: String(data.moralTitle ?? 'Kindness'),
          moralLesson: String(data.moralLesson ?? ''),
          parentDiscussionPrompt: String(data.parentDiscussionPrompt ?? ''),
          coverMediaId: String(data.coverMediaId ?? ''),
          coverFallbackId: (['pond', 'forest', 'twilight', 'bridge'].includes(data.coverFallbackId)
            ? data.coverFallbackId
            : 'forest') as Story['coverFallbackId'],
          readMinutes: Number(data.readMinutes ?? 2),
          isCustom: false,
          isPublished: true,
          pages: Array.isArray(data.pages) ? data.pages : [],
          createdAtMs: publishedAt?.toMillis?.() ?? 0,
        };
      });
      list.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

/**
 * Publishes or updates a storybook on the public main site (/publishedStories/{storyId}).
 * Requires verified Admin privileges enforced by Firestore rules.
 */
export async function publishStoryCloud(uid: string, story: Story): Promise<string> {
  const storyId = sanitizeId(story.id || `story_${Date.now()}`);
  const path = `publishedStories/${storyId}`;
  const ref = doc(db, 'publishedStories', storyId);
  const fields = buildSanitizedCustomStoryFields(story);

  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      await updateDoc(ref, {
        ...fields,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        publishedBy: uid,
        status: 'published',
        ...fields,
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return storyId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Removes an admin-published storybook and its public artwork from the main site.
 */
export async function unpublishStoryCloud(
  storyId: string,
  mediaIds: string[] = []
): Promise<void> {
  const safeStoryId = sanitizeId(storyId);
  const path = `publishedStories/${safeStoryId}`;
  try {
    await deleteDoc(doc(db, 'publishedStories', safeStoryId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }

  const uniqueIds = Array.from(new Set(mediaIds.filter(Boolean).map((id) => sanitizeId(id))));
  await Promise.all(
    uniqueIds.map(async (mediaId) => {
      try {
        await deleteDoc(doc(db, 'publishedMedia', mediaId));
      } catch {
        // Ignore missing media docs during unpublish cleanup
      }
    })
  );
}

const inflightPublishedMediaReads = new Map<string, Promise<string | null>>();

/**
 * Publishes compressed artwork for a main-site published storybook under /publishedMedia/{mediaId}.
 */
export async function savePublishedMediaCloud(
  uid: string,
  storyId: string,
  mediaId: string,
  dataUrl: string
): Promise<boolean> {
  const safeMediaId = sanitizeId(mediaId);
  const safeStoryId = sanitizeId(storyId);
  if (!dataUrl || !dataUrl.startsWith('data:image/') || dataUrl.length > 690_000) {
    return false;
  }

  const mimeMatch = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,/);
  const mimeType = (mimeMatch?.[1] || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
  const ref = doc(db, 'publishedMedia', safeMediaId);

  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      await updateDoc(ref, {
        dataUrl,
        mimeType,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        publishedBy: uid,
        storyId: safeStoryId,
        dataUrl,
        mimeType,
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    console.warn('Published media upload failed:', error);
    return false;
  }
}

/**
 * Reads public artwork for an admin-published storybook from /publishedMedia/{mediaId}.
 */
export async function getPublishedMediaCloud(mediaId: string): Promise<string | null> {
  const safeMediaId = sanitizeId(mediaId);
  if (!safeMediaId) return null;

  const inflight = inflightPublishedMediaReads.get(safeMediaId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const snap = await getDoc(doc(db, 'publishedMedia', safeMediaId));
      if (!snap.exists()) return null;
      const data = snap.data();
      return typeof data.dataUrl === 'string' && data.dataUrl.startsWith('data:image/')
        ? data.dataUrl
        : null;
    } catch (error) {
      console.warn('Published media read skipped:', error);
      return null;
    } finally {
      inflightPublishedMediaReads.delete(safeMediaId);
    }
  })();

  inflightPublishedMediaReads.set(safeMediaId, promise);
  return promise;
}

export function subscribeReadingLogs(
  uid: string,
  onData: (logs: ReadingLogEntry[]) => void,
  onError?: (err: Error) => void
) {
  const colPath = `users/${uid}/readingLogs`;
  const q = query(
    collection(db, 'users', uid, 'readingLogs'),
    where('ownerId', '==', uid),
    orderBy('completedAt', 'desc')
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const list: ReadingLogEntry[] = snapshot.docs.map((d) => {
        const data = d.data();
        const completedAt = data.completedAt as Timestamp | undefined;
        return {
          id: d.id,
          childId: String(data.childId ?? ''),
          storyId: String(data.storyId ?? ''),
          storyTitle: String(data.storyTitle ?? 'Story'),
          moralTitle: String(data.moralTitle ?? 'Kindness'),
          durationSeconds: Number(data.durationSeconds ?? 60),
          usedBedtimeMode: Boolean(data.usedBedtimeMode),
          completedAtMs: completedAt?.toMillis?.() ?? Date.now(),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

export async function recordReadingCompletionCloud(
  uid: string,
  child: ChildProfile,
  story: Story,
  durationSeconds: number,
  usedBedtimeMode: boolean
): Promise<void> {
  const logId = sanitizeId(`log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const logPath = `users/${uid}/readingLogs/${logId}`;
  const safeDuration = clampNumber(durationSeconds, 10, 7200);
  const addedMinutes = Math.max(1, Math.round(safeDuration / 60));

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', uid, 'readingLogs', logId), {
      ownerId: uid,
      childId: child.id,
      storyId: sanitizeId(story.id),
      storyTitle: clampString(story.title, 120, 'Story'),
      moralTitle: clampString(story.moralTitle, 60, 'Kindness'),
      durationSeconds: safeDuration,
      usedBedtimeMode: Boolean(usedBedtimeMode),
      completedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'users', uid, 'children', child.id), {
      starsEarned: clampNumber(child.starsEarned + 1, 0, 10000),
      totalMinutesRead: clampNumber(child.totalMinutesRead + addedMinutes, 0, 100000),
      storiesCompleted: clampNumber(child.storiesCompleted + 1, 0, 10000),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, logPath);
  }
}
