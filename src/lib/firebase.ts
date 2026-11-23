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
