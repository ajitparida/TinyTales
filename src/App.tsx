import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { AnimatePresence, motion } from 'motion/react';
import { CURATED_STORIES } from './data/curatedStories';
import {
  auth,
  checkIsAdminCloud,
  createChildProfileCloud,
  DEFAULT_BEDTIME_SETTINGS,
  deleteChildProfileCloud,
  deleteCustomStoryCloud,
  deleteStoryMediaCloud,
  ensureParentAccount,
  publishStoryCloud,
  recordReadingCompletionCloud,
  saveBedtimeSettingsCloud,
  saveCustomStoryCloud,
  signInParentWithGoogle,
  signOutParent,
  subscribeChildProfiles,
  subscribeCustomStories,
  subscribePublishedStories,
  subscribeReadingLogs,
  unpublishStoryCloud,
  updateCustomStoryCloud,
} from './lib/firebase';
import { setAmbientLullabyActive } from './lib/audioEngine';
import { backfillLocalStoryMediaToCloud, publishStoryMediaToCloud } from './lib/mediaStore';
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
import { MobileBottomNav } from './components/MobileBottomNav';
import { IpadSidebarRail } from './components/IpadSidebarRail';
import { LibraryView } from './components/LibraryView';
import { StoryReader } from './components/StoryReader';
import { StoryScanner } from './components/StoryScanner';
import { ParentalDashboard } from './components/ParentalDashboard';
import { BedtimeCompleteOverlay } from './components/BedtimeCompleteOverlay';

type NavTransitionType = 'tab-forward' | 'tab-backward' | 'push' | 'pop';

const TAB_ORDER: Record<AppView, number> = {
  library: 0,
  reader: 0,
  scanner: 1,
  parents: 2,
};

const LOCAL_IPAD_SIDEBAR_KEY = 'meadowtale_ipad_sidebar_v1';

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
  const [isAdmin, setIsAdmin] = useState(false);
  const [publishedStories, setPublishedStories] = useState<Story[]>([]);

  const [activeView, setActiveView] = useState<AppView>('library');
  const [navTransition, setNavTransition] = useState<NavTransitionType>('tab-forward');
  const [ipadSidebarExpanded, setIpadSidebarExpanded] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_IPAD_SIDEBAR_KEY);
      if (saved === 'true') return true;
      if (saved === 'false') return false;
    } catch {
      // Ignore storage access issues
    }
    return typeof window !== 'undefined' ? window.innerWidth >= 1024 : true;
  });
  const [selectedStory, setSelectedStory] = useState<Story | null>(null);
  const [editingStory, setEditingStory] = useState<Story | null>(null);
  const [scannerCreateMode, setScannerCreateMode] = useState<'scan' | 'manual'>('scan');
  const [isParentGateUnlocked, setIsParentGateUnlocked] = useState(false);

  const navigateToView = useCallback(
    (nextView: AppView, explicitTransition?: NavTransitionType) => {
      setActiveView((prevView) => {
        if (explicitTransition) {
          setNavTransition(explicitTransition);
        } else if (nextView === 'reader') {
          setNavTransition('push');
        } else if (prevView === 'reader') {
          setNavTransition('pop');
        } else {
          setNavTransition(
            TAB_ORDER[nextView] >= TAB_ORDER[prevView] ? 'tab-forward' : 'tab-backward'
          );
        }
        return nextView;
      });
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    []
  );

  const handleToggleIpadSidebar = useCallback(() => {
    setIpadSidebarExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LOCAL_IPAD_SIDEBAR_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

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

  // Subscribe to admin-published main-site storybooks (visible to all visitors & incognito sessions)
  useEffect(() => {
    const unsubPublished = subscribePublishedStories(
      (stories) => {
        setPublishedStories(stories);
      },
      (err) => {
        console.warn('Could not load published stories:', err);
      }
    );
    return () => unsubPublished();
  }, []);

  // Resolve verified Admin role when auth state changes
  useEffect(() => {
    if (!authReady || !user) {
      setIsAdmin(false);
      return;
    }
    let active = true;
    void checkIsAdminCloud(user).then((adminOk) => {
      if (active) setIsAdmin(adminOk);
    });
    return () => {
      active = false;
    };
  }, [authReady, user]);

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
          // Backfill any pre-existing local IndexedDB illustrations so incognito & other devices show them
          void backfillLocalStoryMediaToCloud(user.uid, cloudStories);
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

  // Apply Bedtime Twilight dark mode, reduced motion & mobile status-bar theme-color
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
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', bedtimeSettings.bedtimeEnabled ? '#121624' : '#2F7A5E');
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

  const publishedStoryIds = useMemo(
    () => new Set(publishedStories.map((s) => s.id)),
    [publishedStories]
  );

  // Merge admin-published stories with curated catalog (avoiding duplicates with owner's customStories)
  const publicCatalogStories = useMemo(() => {
    const customIds = new Set(customStories.map((s) => s.id));
    const visiblePublished = publishedStories.filter((s) => !customIds.has(s.id));
    return [...visiblePublished, ...CURATED_STORIES];
  }, [publishedStories, customStories]);

  const collectStoryMediaIds = (story: Story): string[] => {
    const ids: string[] = [];
    if (story.coverMediaId) ids.push(story.coverMediaId);
    for (const p of story.pages) {
      if (p.mediaId) ids.push(p.mediaId);
    }
    return ids;
  };

  const handlePublishCustomStory = async (story: Story) => {
    if (!user || !isAdmin) {
      showToast('Admin sign-in is required to publish stories to the main site.');
      return;
    }
    try {
      await publishStoryMediaToCloud(user.uid, story);
      await publishStoryCloud(user.uid, story);
      showToast(`Published “${story.title}” to the main site for all visitors!`);
    } catch (err) {
      console.error('Publish story error:', err);
      showToast('Could not publish story to main site. Please try again.');
    }
  };

  const handleUnpublishCustomStory = async (story: Story) => {
    if (!user || !isAdmin) {
      showToast('Admin sign-in is required to unpublish stories.');
      return;
    }
    try {
      await unpublishStoryCloud(story.id, collectStoryMediaIds(story));
      showToast(`Unpublished “${story.title}” from the main site.`);
    } catch (err) {
      console.error('Unpublish story error:', err);
      showToast('Could not unpublish story. Please try again.');
    }
  };

  const handleSaveScannedStory = async (
    story: Story,
    isUpdate: boolean,
    shouldPublish = false
  ) => {
    if (isUpdate) {
      if (user) {
        await updateCustomStoryCloud(user.uid, story);
      } else {
        setCustomStories((prev) => prev.map((s) => (s.id === story.id ? story : s)));
      }

      let publishSuffix = '';
      if (user && isAdmin) {
        if (shouldPublish) {
          await publishStoryMediaToCloud(user.uid, story);
          await publishStoryCloud(user.uid, story);
          publishSuffix = ' & updated on main site';
        } else if (publishedStoryIds.has(story.id)) {
          await unpublishStoryCloud(story.id, collectStoryMediaIds(story));
          publishSuffix = ' & unpublished from main site';
        }
      }

      setEditingStory(null);
      setSelectedStory(story);
      navigateToView('reader', 'push');
      showToast(`Updated “${story.title}”${publishSuffix}!`);
      return;
    }

    if (user) {
      await saveCustomStoryCloud(user.uid, story);
    } else {
      setCustomStories((prev) => [story, ...prev]);
    }

    let publishSuffix = '';
    if (user && isAdmin && shouldPublish) {
      await publishStoryMediaToCloud(user.uid, story);
      await publishStoryCloud(user.uid, story);
      publishSuffix = ' & published to main site';
    }

    setEditingStory(null);
    setSelectedStory(story);
    navigateToView('reader', 'push');
    showToast(`Saved “${story.title}”${publishSuffix}!`);
  };

  const handleOpenEditCustomStory = (story: Story) => {
    setEditingStory(story);
    navigateToView('scanner', 'push');
  };

  const handleDeleteCustomStory = async (story: Story) => {
    const mediaIds = collectStoryMediaIds(story);
    if (user) {
      await deleteCustomStoryCloud(user.uid, story.id);
      void deleteStoryMediaCloud(user.uid, mediaIds);
      if (isAdmin && publishedStoryIds.has(story.id)) {
        try {
          await unpublishStoryCloud(story.id, mediaIds);
        } catch {
          // Ignore if already unpublished
        }
      }
    } else {
      setCustomStories((prev) => prev.filter((s) => s.id !== story.id));
    }
    if (selectedStory?.id === story.id) {
      setSelectedStory(null);
    }
    if (editingStory?.id === story.id) {
      setEditingStory(null);
    }
    showToast(`Removed “${story.title}” from your custom books.`);
  };

  const activeChild =
    childrenProfiles.find((c) => c.id === activeChildId) || childrenProfiles[0];

  const bedtimeStoriesLeft = bedtimeSettings.bedtimeEnabled
    ? Math.max(0, bedtimeSettings.maxStoriesPerSession - bedtimeStoriesReadThisSession)
    : null;

  const isImmersiveReader = activeView === 'reader' && Boolean(selectedStory);
  const reducedMotion = Boolean(bedtimeSettings.bedtimeEnabled && bedtimeSettings.reducedMotion);

  const handlePrimaryNavigate = useCallback(
    (view: AppView) => {
      navigateToView(view);
      if (view !== 'reader') setSelectedStory(null);
      if (view !== 'scanner') setEditingStory(null);
    },
    [navigateToView]
  );

  const viewSlideOffset = useMemo(() => {
    if (reducedMotion) return { enterX: 0, exitX: 0 };
    switch (navTransition) {
      case 'push':
        return { enterX: 32, exitX: -20 };
      case 'pop':
        return { enterX: -28, exitX: 24 };
      case 'tab-backward':
        return { enterX: -22, exitX: 22 };
      case 'tab-forward':
      default:
        return { enterX: 22, exitX: -22 };
    }
  }, [navTransition, reducedMotion]);

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row xl:flex-col bg-[#FAF8F4] dark:bg-[#121624] text-[#24292E] dark:text-[#EDE9DF] relative overflow-x-clip">
      {/* Bedtime Warm Dimness Scrim (pointer-events-none so interactions remain unobstructed) */}
      {bedtimeSettings.bedtimeEnabled && bedtimeSettings.bedtimeDimness > 0 && (
        <div
          aria-hidden="true"
          style={{ opacity: bedtimeSettings.bedtimeDimness / 100 }}
          className="fixed inset-0 z-40 pointer-events-none bg-[#1B1205] mix-blend-multiply transition-opacity duration-300"
        />
      )}

      {/* Tablet / iPad Collapsible Left Sidebar Rail (768px–1279px), auto-hidden in Immersive Reader */}
      {!isImmersiveReader && (
        <IpadSidebarRail
          activeView={activeView}
          expanded={ipadSidebarExpanded}
          bedtimeEnabled={bedtimeSettings.bedtimeEnabled}
          user={user}
          authLoading={authLoading}
          reducedMotion={reducedMotion}
          onToggleExpanded={handleToggleIpadSidebar}
          onNavigate={handlePrimaryNavigate}
          onToggleBedtime={handleToggleBedtime}
          onSignIn={() => void handleSignIn()}
          onOpenParents={() => handlePrimaryNavigate('parents')}
        />
      )}

      <div className="flex-1 min-w-0 flex flex-col min-h-[100dvh]">
        {/* Mobile Slim Top Header (< 768px) & Editorial Desktop Header (>= 1280px), auto-hidden in Immersive Reader */}
        {!isImmersiveReader && (
          <TopBar
            activeView={activeView}
            bedtimeEnabled={bedtimeSettings.bedtimeEnabled}
            user={user}
            authLoading={authLoading}
            onNavigate={handlePrimaryNavigate}
            onToggleBedtime={handleToggleBedtime}
            onSignIn={() => void handleSignIn()}
            onOpenParents={() => handlePrimaryNavigate('parents')}
          />
        )}

        {/* Direction-Aware Native Screen Transition Stage */}
        <div className={`flex-1 min-w-0 ${!isImmersiveReader ? 'pb-mobile-nav md:pb-0' : 'pb-safe'}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeView === 'reader' ? `reader_${selectedStory?.id || 'none'}` : activeView}
              initial={
                reducedMotion
                  ? { opacity: 1 }
                  : { opacity: 0, x: viewSlideOffset.enterX }
              }
              animate={{ opacity: 1, x: 0 }}
              exit={
                reducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, x: viewSlideOffset.exitX }
              }
              transition={
                reducedMotion
                  ? { duration: 0.08 }
                  : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }
              }
              className="w-full"
            >
              {activeView === 'library' && (
                <LibraryView
                  curatedStories={publicCatalogStories}
                  customStories={customStories}
                  cloudSyncKey={user?.uid || ''}
                  isAdmin={isAdmin}
                  publishedStoryIds={publishedStoryIds}
                  childrenProfiles={childrenProfiles}
                  activeChildId={activeChildId}
                  readingLogs={readingLogs}
                  bedtimeSettings={bedtimeSettings}
                  sleepRemainingSeconds={sleepRemainingSeconds}
                  bedtimeStoriesLeft={bedtimeStoriesLeft}
                  onSelectChild={setActiveChildId}
                  onOpenStory={(story) => {
                    setSelectedStory(story);
                    navigateToView('reader', 'push');
                  }}
                  onOpenScanner={() => {
                    setEditingStory(null);
                    setScannerCreateMode('scan');
                    navigateToView('scanner', 'tab-forward');
                  }}
                  onOpenManualCreator={() => {
                    setEditingStory(null);
                    setScannerCreateMode('manual');
                    navigateToView('scanner', 'tab-forward');
                  }}
                  onEditCustomStory={handleOpenEditCustomStory}
                  onDeleteCustomStory={handleDeleteCustomStory}
                  onPublishCustomStory={handlePublishCustomStory}
                  onUnpublishCustomStory={handleUnpublishCustomStory}
                />
              )}

              {activeView === 'reader' && selectedStory && (
                <StoryReader
                  story={selectedStory}
                  cloudSyncKey={user?.uid || ''}
                  bedtimeSettings={bedtimeSettings}
                  voicePreferences={voicePreferences}
                  onUpdateVoicePreferences={setVoicePreferences}
                  onToggleBedtime={handleToggleBedtime}
                  onEditStory={selectedStory.isCustom ? handleOpenEditCustomStory : undefined}
                  onExit={() => {
                    setSelectedStory(null);
                    navigateToView('library', 'pop');
                  }}
                  onStoryCompleted={handleStoryCompleted}
                />
              )}

              {activeView === 'scanner' && (
                <StoryScanner
                  key={editingStory ? `edit_${editingStory.id}` : `create_${scannerCreateMode}`}
                  defaultAgeGroup={activeChild?.ageGroup || '2-3'}
                  isSignedIn={Boolean(user)}
                  isAdmin={isAdmin}
                  isAlreadyPublished={Boolean(editingStory && publishedStoryIds.has(editingStory.id))}
                  editingStory={editingStory}
                  initialCreateMode={scannerCreateMode}
                  onCancel={() => {
                    if (editingStory && selectedStory?.id === editingStory.id) {
                      setEditingStory(null);
                      navigateToView('reader', 'pop');
                    } else {
                      setEditingStory(null);
                      navigateToView('library', 'pop');
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
                  allStories={[...customStories, ...publicCatalogStories]}
                  bedtimeSettings={bedtimeSettings}
                  voicePreferences={voicePreferences}
                  onUnlockGate={() => setIsParentGateUnlocked(true)}
                  onBackToLibrary={() => navigateToView('library', 'tab-backward')}
                  onSignIn={() => void handleSignIn()}
                  onSignOut={() => void handleSignOut()}
                  onSelectChild={setActiveChildId}
                  onAddChild={handleAddChild}
                  onDeleteChild={handleDeleteChild}
                  onUpdateBedtimeSettings={handleUpdateBedtimeSettings}
                  onUpdateVoicePreferences={setVoicePreferences}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Quiet Editorial Footer (shown on tablet & desktop outside Immersive Reader) */}
        {!isImmersiveReader && (
          <footer className="hidden md:block border-t border-[#E6E1D8] dark:border-[#2A324B] mt-12">
            <div className="max-w-7xl mx-auto px-6 lg:px-8 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-[#5C646B] dark:text-[#A4AEC2]">
              <span className="font-display font-semibold text-sm text-[#24292E] dark:text-[#EDE9DF]">
                Meadowtale
              </span>
              <span>Gentle illustrated picture books for ages 2–5, crafted with a moral in every tale.</span>
            </div>
          </footer>
        )}
      </div>

      {/* Native Mobile Bottom Tab Bar (< 768px), automatically hidden in Immersive Story Reader */}
      <MobileBottomNav
        activeView={activeView}
        hidden={isImmersiveReader}
        reducedMotion={reducedMotion}
        onNavigate={handlePrimaryNavigate}
      />

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

      {/* Subtle Toast Confirmation (clears mobile bottom tab bar automatically) */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            role="status"
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className={`fixed right-4 left-4 sm:left-auto sm:right-5 z-50 sm:max-w-sm px-4 py-3 rounded-2xl bg-[#24292E] dark:bg-[#EDE9DF] text-white dark:text-[#121624] text-sm font-medium shadow-lg ${
              isImmersiveReader ? 'bottom-safe-toast' : 'bottom-mobile-toast md:bottom-safe-toast'
            }`}
          >
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
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
