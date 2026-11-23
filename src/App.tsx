import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { CURATED_STORIES } from './data/curatedStories';
import {
  auth,
  createChildProfileCloud,
  DEFAULT_BEDTIME_SETTINGS,
  deleteChildProfileCloud,
  deleteCustomStoryCloud,
  ensureParentAccount,
  recordReadingCompletionCloud,
  saveBedtimeSettingsCloud,
  saveCustomStoryCloud,
  signInParentWithGoogle,
  signOutParent,
  subscribeChildProfiles,
  subscribeCustomStories,
  subscribeReadingLogs,
  updateCustomStoryCloud,
} from './lib/firebase';
import { setAmbientLullabyActive } from './lib/audioEngine';
import {
  AgeGroup,
  AppView,
  AvatarId,
  BedtimeSettings,
  ChildProfile,
  ReadingLogEntry,
  Story,
  VoicePreferences,
} from './types/story';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopBar } from './components/TopBar';
import { LibraryView } from './components/LibraryView';
import { StoryReader } from './components/StoryReader';
import { StoryScanner } from './components/StoryScanner';
import { ParentalDashboard } from './components/ParentalDashboard';
import { BedtimeCompleteOverlay } from './components/BedtimeCompleteOverlay';

const LOCAL_CHILDREN_KEY = 'meadowtale_local_children_v1';
const LOCAL_STORIES_KEY = 'meadowtale_local_stories_v1';
const LOCAL_LOGS_KEY = 'meadowtale_local_logs_v1';
const LOCAL_BEDTIME_KEY = 'meadowtale_local_bedtime_v1';
const LOCAL_VOICE_PREFS_KEY = 'meadowtale_voice_prefs_v1';

const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  voiceEngine: 'ai',
  voicePersona: 'warm',
  readingSpeed: 1,
  autoRead: false,
};

const DEFAULT_GUEST_CHILDREN: ChildProfile[] = [
  {
    id: 'guest_child_1',
    name: 'Leo',
    ageGroup: '2-3',
    avatar: 'duck',
    starsEarned: 0,
    totalMinutesRead: 0,
    storiesCompleted: 0,
  },
  {
    id: 'guest_child_2',
    name: 'Maya',
    ageGroup: '4-5',
    avatar: 'firefly',
    starsEarned: 0,
    totalMinutesRead: 0,
    storiesCompleted: 0,
  },
];

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function MeadowtaleApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);

  const [activeView, setActiveView] = useState<AppView>('library');
  const [selectedStory, setSelectedStory] = useState<Story | null>(null);
  const [editingStory, setEditingStory] = useState<Story | null>(null);
  const [scannerCreateMode, setScannerCreateMode] = useState<'scan' | 'manual'>('scan');
  const [isParentGateUnlocked, setIsParentGateUnlocked] = useState(false);

  const [childrenProfiles, setChildrenProfiles] = useState<ChildProfile[]>(() =>
    readLocalJson(LOCAL_CHILDREN_KEY, DEFAULT_GUEST_CHILDREN)
  );
  const [activeChildId, setActiveChildId] = useState<string>(
    () => readLocalJson<ChildProfile[]>(LOCAL_CHILDREN_KEY, DEFAULT_GUEST_CHILDREN)[0]?.id || ''
  );
  const [customStories, setCustomStories] = useState<Story[]>(() =>
    readLocalJson(LOCAL_STORIES_KEY, [])
  );
  const [readingLogs, setReadingLogs] = useState<ReadingLogEntry[]>(() =>
    readLocalJson(LOCAL_LOGS_KEY, [])
  );
  const [bedtimeSettings, setBedtimeSettings] = useState<BedtimeSettings>(() =>
    readLocalJson(LOCAL_BEDTIME_KEY, DEFAULT_BEDTIME_SETTINGS)
  );
  const [voicePreferences, setVoicePreferences] = useState<VoicePreferences>(() => ({
    ...DEFAULT_VOICE_PREFERENCES,
    ...readLocalJson(LOCAL_VOICE_PREFS_KEY, DEFAULT_VOICE_PREFERENCES),
  }));

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_VOICE_PREFS_KEY, JSON.stringify(voicePreferences));
    } catch {
      // Ignore storage errors
    }
  }, [voicePreferences]);

  // Bedtime session timer & cap tracking
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState<number | null>(null);
  const [bedtimeStoriesReadThisSession, setBedtimeStoriesReadThisSession] = useState(0);
  const [bedtimeLockReason, setBedtimeLockReason] = useState<'timer' | 'stories' | null>(null);

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3600);
  }, []);

  // Listen for Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Sync Firestore when parent is signed in
  useEffect(() => {
    if (!authReady || !user) return;
    let active = true;
    let unsubChildren: (() => void) | null = null;
    let unsubStories: (() => void) | null = null;
    let unsubLogs: (() => void) | null = null;

    void (async () => {
      try {
        const cloudBedtime = await ensureParentAccount(user);
        if (!active) return;
        setBedtimeSettings(cloudBedtime);

        unsubChildren = subscribeChildProfiles(user.uid, async (cloudChildren) => {
          if (!active) return;
          if (cloudChildren.length === 0) {
            // Seed two starter age-tier reader profiles on first sign-in
            await createChildProfileCloud(user.uid, {
              name: 'Little Reader (2–3)',
              ageGroup: '2-3',
              avatar: 'duck',
            });
            return;
          }
          setChildrenProfiles(cloudChildren);
          setActiveChildId((prev) =>
            cloudChildren.some((c) => c.id === prev) ? prev : cloudChildren[0].id
          );
        });

        unsubStories = subscribeCustomStories(user.uid, (cloudStories) => {
          if (!active) return;
          setCustomStories(cloudStories);
        });

        unsubLogs = subscribeReadingLogs(user.uid, (cloudLogs) => {
          if (!active) return;
          setReadingLogs(cloudLogs);
        });
      } catch (err) {
        console.error('Firebase sync error:', err);
        showToast('Could not connect to cloud sync; continuing in local mode.');
      }
    })();

    return () => {
      active = false;
      unsubChildren?.();
      unsubStories?.();
      unsubLogs?.();
    };
  }, [authReady, user, showToast]);

  // Persist local guest state when signed out
  useEffect(() => {
    if (user) return;
    try {
      localStorage.setItem(LOCAL_CHILDREN_KEY, JSON.stringify(childrenProfiles));
      localStorage.setItem(LOCAL_STORIES_KEY, JSON.stringify(customStories));
      localStorage.setItem(LOCAL_LOGS_KEY, JSON.stringify(readingLogs));
      localStorage.setItem(LOCAL_BEDTIME_KEY, JSON.stringify(bedtimeSettings));
    } catch {
      // Ignore storage quota errors
    }
  }, [user, childrenProfiles, customStories, readingLogs, bedtimeSettings]);

  // Apply Bedtime Twilight dark mode & reduced motion classes to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (bedtimeSettings.bedtimeEnabled) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    if (bedtimeSettings.bedtimeEnabled && bedtimeSettings.reducedMotion) {
      root.classList.add('reduced-motion-mode');
    } else {
      root.classList.remove('reduced-motion-mode');
    }
  }, [bedtimeSettings.bedtimeEnabled, bedtimeSettings.reducedMotion]);

  // Manage ambient lullaby audio
  useEffect(() => {
    setAmbientLullabyActive(
      Boolean(bedtimeSettings.bedtimeEnabled && bedtimeSettings.ambientLullaby)
    );
    return () => {
      setAmbientLullabyActive(false);
    };
  }, [bedtimeSettings.bedtimeEnabled, bedtimeSettings.ambientLullaby]);

  // Manage Bedtime sleep countdown timer
  useEffect(() => {
    if (!bedtimeSettings.bedtimeEnabled || bedtimeSettings.sleepTimerMinutes <= 0) {
      setSleepRemainingSeconds(null);
      return;
    }
    setSleepRemainingSeconds(bedtimeSettings.sleepTimerMinutes * 60);
    setBedtimeStoriesReadThisSession(0);
    setBedtimeLockReason(null);
  }, [bedtimeSettings.bedtimeEnabled, bedtimeSettings.sleepTimerMinutes]);

  useEffect(() => {
    if (!bedtimeSettings.bedtimeEnabled || sleepRemainingSeconds === null || bedtimeLockReason) {
      return;
    }
    const id = window.setInterval(() => {
      setSleepRemainingSeconds((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          setBedtimeLockReason('timer');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [bedtimeSettings.bedtimeEnabled, sleepRemainingSeconds, bedtimeLockReason]);

  const handleSignIn = async () => {
    setAuthLoading(true);
    try {
      await signInParentWithGoogle();
      showToast('Signed in! Progress and scanned books now sync across devices.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Sign-in cancelled.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOutParent();
    setChildrenProfiles(readLocalJson(LOCAL_CHILDREN_KEY, DEFAULT_GUEST_CHILDREN));
    setCustomStories(readLocalJson(LOCAL_STORIES_KEY, []));
    setReadingLogs(readLocalJson(LOCAL_LOGS_KEY, []));
    showToast('Signed out of parent account.');
  };

  const handleUpdateBedtimeSettings = async (next: BedtimeSettings) => {
    setBedtimeSettings(next);
    if (!next.bedtimeEnabled) {
      setBedtimeLockReason(null);
    }
    if (user) {
      try {
        await saveBedtimeSettingsCloud(user.uid, next);
      } catch (err) {
        console.error(err);
        showToast('Updated locally; cloud sync will retry shortly.');
      }
    }
  };

  const handleToggleBedtime = () => {
    void handleUpdateBedtimeSettings({
      ...bedtimeSettings,
      bedtimeEnabled: !bedtimeSettings.bedtimeEnabled,
    });
  };

  const handleAddChild = async (input: {
    name: string;
    ageGroup: AgeGroup;
    avatar: AvatarId;
  }) => {
    if (user) {
      const id = await createChildProfileCloud(user.uid, input);
      setActiveChildId(id);
    } else {
      const newChild: ChildProfile = {
        id: `guest_child_${Date.now()}`,
        name: input.name,
        ageGroup: input.ageGroup,
        avatar: input.avatar,
        starsEarned: 0,
        totalMinutesRead: 0,
        storiesCompleted: 0,
      };
      setChildrenProfiles((prev) => [...prev, newChild]);
      setActiveChildId(newChild.id);
    }
    showToast(`Added reader profile for ${input.name}.`);
  };

  const handleDeleteChild = async (childId: string) => {
    if (childrenProfiles.length <= 1) return;
    if (user) {
      await deleteChildProfileCloud(user.uid, childId);
    } else {
      setChildrenProfiles((prev) => prev.filter((c) => c.id !== childId));
    }
    if (activeChildId === childId) {
      const remaining = childrenProfiles.find((c) => c.id !== childId);
      if (remaining) setActiveChildId(remaining.id);
    }
  };

  const handleStoryCompleted = useCallback(
    (story: Story, durationSeconds: number) => {
      const activeChild =
        childrenProfiles.find((c) => c.id === activeChildId) || childrenProfiles[0];
      if (!activeChild) return;

      const addedMinutes = Math.max(1, Math.round(durationSeconds / 60));

      if (user) {
        void recordReadingCompletionCloud(
          user.uid,
          activeChild,
          story,
          durationSeconds,
          bedtimeSettings.bedtimeEnabled
        );
      } else {
        setChildrenProfiles((prev) =>
          prev.map((c) =>
            c.id === activeChild.id
              ? {
                  ...c,
                  starsEarned: c.starsEarned + 1,
                  totalMinutesRead: c.totalMinutesRead + addedMinutes,
                  storiesCompleted: c.storiesCompleted + 1,
                }
              : c
          )
        );
        setReadingLogs((prev) => [
          {
            id: `local_log_${Date.now()}`,
            childId: activeChild.id,
            storyId: story.id,
            storyTitle: story.title,
            moralTitle: story.moralTitle,
            durationSeconds,
            usedBedtimeMode: bedtimeSettings.bedtimeEnabled,
            completedAtMs: Date.now(),
          },
          ...prev,
        ]);
      }

      if (bedtimeSettings.bedtimeEnabled) {
        setBedtimeStoriesReadThisSession((prev) => {
          const next = prev + 1;
          if (next >= bedtimeSettings.maxStoriesPerSession) {
            window.setTimeout(() => setBedtimeLockReason('stories'), 4000);
          }
          return next;
        });
      }

      showToast(`${activeChild.name} earned a Moral Star for ${story.moralTitle}!`);
    },
    [
      activeChildId,
      childrenProfiles,
      user,
      bedtimeSettings.bedtimeEnabled,
      bedtimeSettings.maxStoriesPerSession,
      showToast,
    ]
  );

  const handleSaveScannedStory = async (story: Story, isUpdate: boolean) => {
    if (isUpdate) {
      if (user) {
        await updateCustomStoryCloud(user.uid, story);
      } else {
        setCustomStories((prev) => prev.map((s) => (s.id === story.id ? story : s)));
      }
      setEditingStory(null);
      setSelectedStory(story);
      setActiveView('reader');
      showToast(`Updated “${story.title}”!`);
      return;
    }

    if (user) {
      await saveCustomStoryCloud(user.uid, story);
    } else {
      setCustomStories((prev) => [story, ...prev]);
    }
    setEditingStory(null);
    setSelectedStory(story);
    setActiveView('reader');
    showToast(`Saved “${story.title}” to your storybook shelf!`);
  };

  const handleOpenEditCustomStory = (story: Story) => {
    setEditingStory(story);
    setActiveView('scanner');
  };

  const handleDeleteCustomStory = async (story: Story) => {
    if (user) {
      await deleteCustomStoryCloud(user.uid, story.id);
    } else {
      setCustomStories((prev) => prev.filter((s) => s.id !== story.id));
    }
    if (selectedStory?.id === story.id) {
      setSelectedStory(null);
    }
    if (editingStory?.id === story.id) {
      setEditingStory(null);
    }
    showToast(`Removed “${story.title}” from scanned books.`);
  };

  const activeChild =
    childrenProfiles.find((c) => c.id === activeChildId) || childrenProfiles[0];

  const bedtimeStoriesLeft = bedtimeSettings.bedtimeEnabled
    ? Math.max(0, bedtimeSettings.maxStoriesPerSession - bedtimeStoriesReadThisSession)
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF8F4] dark:bg-[#121624] text-[#24292E] dark:text-[#EDE9DF] relative">
      {/* Bedtime Warm Dimness Scrim (pointer-events-none so interactions remain unobstructed) */}
      {bedtimeSettings.bedtimeEnabled && bedtimeSettings.bedtimeDimness > 0 && (
        <div
          aria-hidden="true"
          style={{ opacity: bedtimeSettings.bedtimeDimness / 100 }}
          className="fixed inset-0 z-40 pointer-events-none bg-[#1B1205] mix-blend-multiply transition-opacity duration-300"
        />
      )}

      <TopBar
        activeView={activeView}
        bedtimeEnabled={bedtimeSettings.bedtimeEnabled}
        user={user}
        authLoading={authLoading}
        onNavigate={(view) => {
          setActiveView(view);
          if (view !== 'reader') setSelectedStory(null);
          if (view !== 'scanner') setEditingStory(null);
        }}
        onToggleBedtime={handleToggleBedtime}
        onSignIn={() => void handleSignIn()}
        onOpenParents={() => setActiveView('parents')}
      />

      <div className="flex-1">
        {activeView === 'library' && (
          <LibraryView
            curatedStories={CURATED_STORIES}
            customStories={customStories}
            childrenProfiles={childrenProfiles}
            activeChildId={activeChildId}
            readingLogs={readingLogs}
            bedtimeSettings={bedtimeSettings}
            sleepRemainingSeconds={sleepRemainingSeconds}
            bedtimeStoriesLeft={bedtimeStoriesLeft}
            onSelectChild={setActiveChildId}
            onOpenStory={(story) => {
              setSelectedStory(story);
              setActiveView('reader');
            }}
            onOpenScanner={() => {
              setEditingStory(null);
              setScannerCreateMode('scan');
              setActiveView('scanner');
            }}
            onOpenManualCreator={() => {
              setEditingStory(null);
              setScannerCreateMode('manual');
              setActiveView('scanner');
            }}
            onEditCustomStory={handleOpenEditCustomStory}
            onDeleteCustomStory={(story) => void handleDeleteCustomStory(story)}
          />
        )}

        {activeView === 'reader' && selectedStory && (
          <StoryReader
            story={selectedStory}
            bedtimeSettings={bedtimeSettings}
            voicePreferences={voicePreferences}
            onUpdateVoicePreferences={setVoicePreferences}
            onEditStory={selectedStory.isCustom ? handleOpenEditCustomStory : undefined}
            onExit={() => {
              setSelectedStory(null);
              setActiveView('library');
            }}
            onStoryCompleted={handleStoryCompleted}
          />
        )}

        {activeView === 'scanner' && (
          <StoryScanner
            key={editingStory ? `edit_${editingStory.id}` : `create_${scannerCreateMode}`}
            defaultAgeGroup={activeChild?.ageGroup || '2-3'}
            isSignedIn={Boolean(user)}
            editingStory={editingStory}
            initialCreateMode={scannerCreateMode}
            onCancel={() => {
              if (editingStory && selectedStory?.id === editingStory.id) {
                setEditingStory(null);
                setActiveView('reader');
              } else {
                setEditingStory(null);
                setActiveView('library');
              }
            }}
            onSaveStory={handleSaveScannedStory}
          />
        )}

        {activeView === 'parents' && (
          <ParentalDashboard
            user={user}
            authLoading={authLoading}
            isGateUnlocked={isParentGateUnlocked}
            childrenProfiles={childrenProfiles}
            activeChildId={activeChildId}
            readingLogs={readingLogs}
            allStories={[...customStories, ...CURATED_STORIES]}
            bedtimeSettings={bedtimeSettings}
            voicePreferences={voicePreferences}
            onUnlockGate={() => setIsParentGateUnlocked(true)}
            onBackToLibrary={() => setActiveView('library')}
            onSignIn={() => void handleSignIn()}
            onSignOut={() => void handleSignOut()}
            onSelectChild={setActiveChildId}
            onAddChild={handleAddChild}
            onDeleteChild={handleDeleteChild}
            onUpdateBedtimeSettings={handleUpdateBedtimeSettings}
            onUpdateVoicePreferences={setVoicePreferences}
          />
        )}
      </div>

      {/* Quiet Editorial Footer */}
      <footer className="border-t border-[#E6E1D8] dark:border-[#2A324B] mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-[#5C646B] dark:text-[#A4AEC2]">
          <span className="font-display font-semibold text-sm text-[#24292E] dark:text-[#EDE9DF]">
            Meadowtale
          </span>
          <span>Gentle illustrated picture books for ages 2–5, crafted with a moral in every tale.</span>
        </div>
      </footer>

      {/* Bedtime Completion Screen */}
      {bedtimeLockReason && (
        <BedtimeCompleteOverlay
          reason={bedtimeLockReason}
          onExtendBedtime={() => {
            setBedtimeLockReason(null);
            setBedtimeStoriesReadThisSession((n) => Math.max(0, n - 1));
            if (bedtimeSettings.sleepTimerMinutes > 0) {
              setSleepRemainingSeconds(10 * 60);
            }
          }}
          onExitBedtime={() => {
            setBedtimeLockReason(null);
            void handleUpdateBedtimeSettings({
              ...bedtimeSettings,
              bedtimeEnabled: false,
            });
          }}
        />
      )}

      {/* Subtle Toast Confirmation */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 max-w-sm px-4 py-3 rounded-xl bg-[#24292E] dark:bg-[#EDE9DF] text-white dark:text-[#121624] text-sm font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MeadowtaleApp />
    </ErrorBoundary>
  );
}
