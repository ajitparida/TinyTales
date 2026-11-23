import React, { useEffect, useMemo, useState } from 'react';
import { User } from 'firebase/auth';
import {
  ArrowLeft,
  BookOpen,
  Clock,
  Cloud,
  Lock,
  LogOut,
  Mic,
  Moon,
  Plus,
  Star,
  Trash2,
  UserPlus,
  Volume2,
} from 'lucide-react';
import {
  AgeGroup,
  AvatarId,
  BedtimeSettings,
  ChildProfile,
  ReadingLogEntry,
  ReadingSpeed,
  Story,
  VoicePersonaId,
  VoicePreferences,
} from '../types/story';
import { VOICE_PERSONAS } from '../lib/audioEngine';
import {
  clearAllAiVoiceCache,
  clearAllParentVoices,
  clearParentVoicesForStory,
  listParentVoiceSummary,
} from '../lib/mediaStore';

interface ParentalDashboardProps {
  user: User | null;
  authLoading: boolean;
  isGateUnlocked: boolean;
  childrenProfiles: ChildProfile[];
  activeChildId: string;
  readingLogs: ReadingLogEntry[];
  allStories: Story[];
  bedtimeSettings: BedtimeSettings;
  voicePreferences: VoicePreferences;
  onUnlockGate: () => void;
  onBackToLibrary: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSelectChild: (childId: string) => void;
  onAddChild: (input: { name: string; ageGroup: AgeGroup; avatar: AvatarId }) => Promise<void>;
  onDeleteChild: (childId: string) => Promise<void>;
  onUpdateBedtimeSettings: (next: BedtimeSettings) => Promise<void>;
  onUpdateVoicePreferences: (next: VoicePreferences) => void;
}

const AVATAR_OPTIONS: { id: AvatarId; label: string }[] = [
  { id: 'duck', label: 'Pip Duck' },
  { id: 'bear', label: 'Milo Bear' },
  { id: 'firefly', label: 'Luma Firefly' },
  { id: 'fox', label: 'Barnaby Fox' },
];

export function ParentalDashboard({
  user,
  authLoading,
  isGateUnlocked,
  childrenProfiles,
  activeChildId,
  readingLogs,
  allStories,
  bedtimeSettings,
  voicePreferences,
  onUnlockGate,
  onBackToLibrary,
  onSignIn,
  onSignOut,
  onSelectChild,
  onAddChild,
  onDeleteChild,
  onUpdateBedtimeSettings,
  onUpdateVoicePreferences,
}: ParentalDashboardProps) {
  // Simple arithmetic adult gate
  const [challenge] = useState(() => {
    const a = 6 + Math.floor(Math.random() * 6);
    const b = 3 + Math.floor(Math.random() * 6);
    return { a, b, answer: a + b };
  });
  const [gateInput, setGateInput] = useState('');
  const [gateError, setGateError] = useState(false);

  // Add child form state
  const [showAddChild, setShowAddChild] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAge, setNewAge] = useState<AgeGroup>('2-3');
  const [newAvatar, setNewAvatar] = useState<AvatarId>('duck');
  const [savingChild, setSavingChild] = useState(false);

  // Parent voice clips manager state
  const [parentVoiceCounts, setParentVoiceCounts] = useState<Record<string, number>>({});
  const [voiceManagerNotice, setVoiceManagerNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isGateUnlocked) return;
    let active = true;
    void listParentVoiceSummary().then((summary) => {
      if (active) setParentVoiceCounts(summary);
    });
    return () => {
      active = false;
    };
  }, [isGateUnlocked]);

  const totalParentClips = useMemo(
    () => Object.values(parentVoiceCounts).reduce((sum, n) => sum + n, 0),
    [parentVoiceCounts]
  );

  const handleClearBookVoices = async (storyId: string, title: string) => {
    const removed = await clearParentVoicesForStory(storyId);
    const updated = await listParentVoiceSummary();
    setParentVoiceCounts(updated);
    setVoiceManagerNotice(`Cleared ${removed} voice clip(s) from “${title}”.`);
  };

  const handleClearAllParentVoices = async () => {
    const removed = await clearAllParentVoices();
    setParentVoiceCounts({});
    setVoiceManagerNotice(
      removed > 0
        ? `Cleared all ${removed} saved parent voice recordings.`
        : 'No parent voice recordings to clear.'
    );
  };

  const handleClearAiCache = async () => {
    const removed = await clearAllAiVoiceCache();
    setVoiceManagerNotice(
      removed > 0
        ? `Cleared ${removed} cached AI audio files.`
        : 'AI voice cache is already empty.'
    );
  };

  const activeChild =
    childrenProfiles.find((c) => c.id === activeChildId) || childrenProfiles[0];

  const childLogs = useMemo(() => {
    if (!activeChild) return readingLogs;
    return readingLogs.filter((l) => l.childId === activeChild.id);
  }, [readingLogs, activeChild]);

  const moralsLearned = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of childLogs) {
      counts.set(log.moralTitle, (counts.get(log.moralTitle) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [childLogs]);

  const bedtimeSessionsCount = useMemo(
    () => childLogs.filter((l) => l.usedBedtimeMode).length,
    [childLogs]
  );

  const handleGateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (Number(gateInput.trim()) === challenge.answer) {
      setGateError(false);
      onUnlockGate();
    } else {
      setGateError(true);
    }
  };

  const handleCreateChild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setSavingChild(true);
    try {
      await onAddChild({
        name: newName.trim().slice(0, 40),
        ageGroup: newAge,
        avatar: newAvatar,
      });
      setNewName('');
      setShowAddChild(false);
    } finally {
      setSavingChild(false);
    }
  };

  if (!isGateUnlocked) {
    return (
      <main className="max-w-md mx-auto px-4 py-16">
        <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/15 text-[#2F7A5E] dark:text-[#E5A94C] flex items-center justify-center mx-auto mb-4">
            <Lock className="w-6 h-6" />
          </div>
          <h1 className="font-display text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
            Parent Area Check
          </h1>
          <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] mb-6 leading-relaxed">
            Solve this quick math check to view reading progress and customize bedtime settings.
          </p>

          <form onSubmit={handleGateSubmit} className="space-y-4">
            <div className="font-mono text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] tabular-nums">
              {challenge.a} + {challenge.b} = ?
            </div>
            <input
              type="number"
              inputMode="numeric"
              value={gateInput}
              onChange={(e) => {
                setGateInput(e.target.value);
                setGateError(false);
              }}
              placeholder="Enter answer"
              className="w-full px-4 py-3 text-center rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#D8D1C4] dark:border-[#34405E] text-base font-mono tabular-nums"
              autoFocus
            />
            {gateError && (
              <p className="text-xs text-[#C84B58] dark:text-[#F299A3]">
                Not quite right—please try again.
              </p>
            )}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onBackToLibrary}
                className="flex-1 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 py-2.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-sm font-semibold cursor-pointer"
              >
                Enter Dashboard
              </button>
            </div>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-10 space-y-8">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBackToLibrary}
            className="inline-flex items-center gap-2 text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] mb-2 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Return to Child Library
          </button>
          <h1 className="font-display text-3xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
            Parental Dashboard
          </h1>
        </div>

        {/* Cloud Sync / Google Sign-In Status */}
        <div className="flex items-center gap-3 bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-xl px-4 py-2.5">
          <Cloud className="w-4 h-4 text-[#2F7A5E] dark:text-[#5CA49B] shrink-0" />
          {user ? (
            <>
              <div className="text-xs">
                <div className="font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                  {user.displayName || 'Parent Account'}
                </div>
                <div className="text-[#5C646B] dark:text-[#A4AEC2]">
                  Cloud sync active across devices
                </div>
              </div>
              <button
                type="button"
                onClick={onSignOut}
                className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </>
          ) : (
            <>
              <div className="text-xs">
                <div className="font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                  Guest Mode (This Device)
                </div>
                <div className="text-[#5C646B] dark:text-[#A4AEC2]">
                  Sign in with Google to sync progress & books
                </div>
              </div>
              <button
                type="button"
                disabled={authLoading}
                onClick={onSignIn}
                className="ml-2 px-3.5 py-1.5 rounded-lg bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-xs font-semibold whitespace-nowrap cursor-pointer"
              >
                {authLoading ? 'Signing in...' : 'Sign In with Google'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Child Reader Selector + KPI Strip */}
      <section className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 mb-6 border-b border-[#E6E1D8] dark:border-[#2A324B]">
          <div className="flex flex-wrap items-center gap-2">
            {childrenProfiles.map((child) => {
              const selected = activeChild?.id === child.id;
              return (
                <div key={child.id} className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelectChild(child.id)}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      selected
                        ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                        : 'bg-[#F3EFE8] dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
                    }`}
                  >
                    {child.name} ({child.ageGroup} yrs)
                  </button>
                  {childrenProfiles.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void onDeleteChild(child.id)}
                      aria-label={`Remove ${child.name}`}
                      className="p-1.5 text-[#5C646B] hover:text-[#C84B58] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setShowAddChild((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] whitespace-nowrap cursor-pointer"
          >
            <UserPlus className="w-3.5 h-3.5" />
            Add Child Reader
          </button>
        </div>

        {showAddChild && (
          <form
            onSubmit={(e) => void handleCreateChild(e)}
            className="mb-6 p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1">
                Child Name
              </label>
              <input
                type="text"
                required
                maxLength={40}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Maya"
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1A2033] border border-[#D8D1C4] dark:border-[#34405E] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1">
                Age Group
              </label>
              <select
                value={newAge}
                onChange={(e) => setNewAge(e.target.value as AgeGroup)}
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1A2033] border border-[#D8D1C4] dark:border-[#34405E] text-sm"
              >
                <option value="2-3">Ages 2–3</option>
                <option value="4-5">Ages 4–5</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1">
                Story Companion
              </label>
              <select
                value={newAvatar}
                onChange={(e) => setNewAvatar(e.target.value as AvatarId)}
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1A2033] border border-[#D8D1C4] dark:border-[#34405E] text-sm"
              >
                {AVATAR_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={savingChild}
              className="inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-sm font-semibold cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Save Profile
            </button>
          </form>
        )}

        {/* Full-Width 4-Column Tabular KPI Strip */}
        {activeChild && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B]">
              <div className="flex items-center gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                <BookOpen className="w-3.5 h-3.5" />
                Stories Completed
              </div>
              <div className="font-mono text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] tabular-nums">
                {activeChild.storiesCompleted}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B]">
              <div className="flex items-center gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                <Clock className="w-3.5 h-3.5" />
                Minutes Read
              </div>
              <div className="font-mono text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] tabular-nums">
                {activeChild.totalMinutesRead} min
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B]">
              <div className="flex items-center gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                <Star className="w-3.5 h-3.5 text-[#D98A1C] dark:text-[#E5A94C]" />
                Moral Stars Earned
              </div>
              <div className="font-mono text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] tabular-nums">
                {activeChild.starsEarned}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B]">
              <div className="flex items-center gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                <Moon className="w-3.5 h-3.5" />
                Bedtime Reads
              </div>
              <div className="font-mono text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF] tabular-nums">
                {bedtimeSessionsCount}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Two-Column Lower Section: Customized Bedtime Mode + Reading History & Morals */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Customized Bedtime Mode Panel */}
        <section className="lg:col-span-5 bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                Customized Bedtime Mode
              </h2>
              <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-1 leading-relaxed">
                Shape a calm evening routine with twilight hues, sleep timer limits, and gentle lullaby audio.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={bedtimeSettings.bedtimeEnabled}
              onClick={() =>
                void onUpdateBedtimeSettings({
                  ...bedtimeSettings,
                  bedtimeEnabled: !bedtimeSettings.bedtimeEnabled,
                })
              }
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                bedtimeSettings.bedtimeEnabled
                  ? 'bg-[#E5A94C] text-[#121624]'
                  : 'bg-[#F3EFE8] dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2]'
              }`}
            >
              {bedtimeSettings.bedtimeEnabled ? 'Bedtime On' : 'Bedtime Off'}
            </button>
          </div>

          {/* Warm Dimness Slider */}
          <div>
            <div className="flex items-center justify-between text-xs font-semibold mb-2">
              <label htmlFor="dimness-slider" className="text-[#24292E] dark:text-[#EDE9DF]">
                Screen Warm Dimness
              </label>
              <span className="font-mono tabular-nums text-[#5C646B] dark:text-[#A4AEC2]">
                {bedtimeSettings.bedtimeDimness}%
              </span>
            </div>
            <input
              id="dimness-slider"
              type="range"
              min={0}
              max={55}
              step={5}
              value={bedtimeSettings.bedtimeDimness}
              onChange={(e) =>
                void onUpdateBedtimeSettings({
                  ...bedtimeSettings,
                  bedtimeDimness: Number(e.target.value),
                })
              }
              className="w-full accent-[#2F7A5E] dark:accent-[#E5A94C]"
            />
          </div>

          {/* Sleep Timer */}
          <div>
            <div className="text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
              Sleep Timer Limit
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {[0, 10, 15, 20, 30].map((mins) => (
                <button
                  key={mins}
                  type="button"
                  onClick={() =>
                    void onUpdateBedtimeSettings({
                      ...bedtimeSettings,
                      sleepTimerMinutes: mins,
                    })
                  }
                  className={`py-2 rounded-lg text-xs font-semibold font-mono tabular-nums transition-colors cursor-pointer ${
                    bedtimeSettings.sleepTimerMinutes === mins
                      ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                      : 'bg-[#F3EFE8] dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2]'
                  }`}
                >
                  {mins === 0 ? 'Off' : `${mins}m`}
                </button>
              ))}
            </div>
          </div>

          {/* Max Stories per Bedtime Session */}
          <div>
            <div className="text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
              Maximum Stories Per Bedtime Session
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {[1, 2, 3, 5].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() =>
                    void onUpdateBedtimeSettings({
                      ...bedtimeSettings,
                      maxStoriesPerSession: count,
                    })
                  }
                  className={`py-2 rounded-lg text-xs font-semibold font-mono tabular-nums transition-colors cursor-pointer ${
                    bedtimeSettings.maxStoriesPerSession === count
                      ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                      : 'bg-[#F3EFE8] dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2]'
                  }`}
                >
                  {count} {count === 1 ? 'book' : 'books'}
                </button>
              ))}
            </div>
          </div>

          {/* Toggles */}
          <div className="space-y-3 pt-2 border-t border-[#E6E1D8] dark:border-[#2A324B]">
            {(
              [
                {
                  key: 'calmVoiceDefault',
                  label: 'Calm Bedtime Storyteller Voice',
                  desc: 'Uses softer, unhurried AI narration when Bedtime Mode is active.',
                },
                {
                  key: 'ambientLullaby',
                  label: 'Gentle Lullaby Hum',
                  desc: 'Plays a soft pentatonic lullaby pad during evening reading.',
                },
                {
                  key: 'reducedMotion',
                  label: 'Reduced Animation Motion',
                  desc: 'Calms character bounces and transitions before sleep.',
                },
              ] as const
            ).map((item) => {
              const checked = bedtimeSettings[item.key];
              return (
                <div key={item.key} className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF] flex items-center gap-1.5">
                      {item.key === 'ambientLullaby' && <Volume2 className="w-3.5 h-3.5" />}
                      {item.label}
                    </div>
                    <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                      {item.desc}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    onClick={() =>
                      void onUpdateBedtimeSettings({
                        ...bedtimeSettings,
                        [item.key]: !checked,
                      })
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-colors cursor-pointer ${
                      checked
                        ? 'bg-[#2F7A5E] dark:bg-[#5CA49B] text-white dark:text-[#121624]'
                        : 'bg-[#F3EFE8] dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    {checked ? 'On' : 'Off'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Reading Progress History & Morals Practiced */}
        <section className="lg:col-span-7 bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7 space-y-6">
          <div>
            <h2 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
              Reading Progress & Values Learned
            </h2>
            <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-1">
              Every completed story logs the moral explored with {activeChild?.name || 'your child'}.
            </p>
          </div>

          {/* Morals Summary */}
          {moralsLearned.length > 0 && (
            <div className="pb-5 border-b border-[#E6E1D8] dark:border-[#2A324B]">
              <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2.5">
                Positive Values Reinforced
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {moralsLearned.map(([moral, count]) => (
                  <div
                    key={moral}
                    className="flex items-center gap-1.5 text-[#24292E] dark:text-[#EDE9DF]"
                  >
                    <Star className="w-3.5 h-3.5 text-[#D98A1C] dark:text-[#E5A94C] fill-current" />
                    <span className="font-medium">{moral}</span>
                    <span className="font-mono text-xs text-[#5C646B] dark:text-[#A4AEC2] tabular-nums">
                      ({count}×)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reading Log Table */}
          {childLogs.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] mb-4">
                No completed stories logged yet for {activeChild?.name || 'this reader'}. Finish a
                storybook through its Moral page to record the first star!
              </p>
              <button
                type="button"
                onClick={onBackToLibrary}
                className="px-4 py-2 rounded-xl bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624] text-xs font-semibold cursor-pointer"
              >
                Open Storybook Library
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#E6E1D8] dark:border-[#2A324B] text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2]">
                    <th className="pb-3 pr-4">Story</th>
                    <th className="pb-3 pr-4">Moral</th>
                    <th className="pb-3 pr-4">Mode</th>
                    <th className="pb-3 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6E1D8]/70 dark:divide-[#2A324B]/70 text-sm">
                  {childLogs.slice(0, 12).map((log) => (
                    <tr key={log.id}>
                      <td className="py-3 pr-4 font-medium text-[#24292E] dark:text-[#EDE9DF]">
                        {log.storyTitle}
                      </td>
                      <td className="py-3 pr-4 text-[#5C646B] dark:text-[#A4AEC2]">
                        {log.moralTitle}
                      </td>
                      <td className="py-3 pr-4 text-xs text-[#5C646B] dark:text-[#A4AEC2]">
                        {log.usedBedtimeMode ? 'Bedtime' : 'Daytime'}
                      </td>
                      <td className="py-3 text-right font-mono text-xs text-[#5C646B] dark:text-[#A4AEC2] tabular-nums">
                        {Math.max(1, Math.round(log.durationSeconds / 60))} min
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Storyteller Voices & Parent Voice Clips Manager */}
      <section className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-6 sm:p-7 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
              Voice Narration & Parent Recordings
            </h2>
            <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-1">
              Choose the default AI storyteller persona and reading speed, or review and clear saved parent voice clips.
            </p>
          </div>
          {voiceManagerNotice && (
            <span className="text-xs font-medium text-[#2F7A5E] dark:text-[#5CA49B]">
              {voiceManagerNotice}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Default Voice Engine, Storyteller Persona & Speed */}
          <div className="lg:col-span-6 space-y-4">
            <div>
              <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                Narration Voice Engine
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onUpdateVoicePreferences({
                      ...voicePreferences,
                      voiceEngine: 'ai',
                    })
                  }
                  className={`text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                    (voicePreferences.voiceEngine ?? 'ai') === 'ai'
                      ? 'bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/15 border-[#2F7A5E] dark:border-[#E5A94C]'
                      : 'bg-[#FAF8F4] dark:bg-[#121624] border-[#E6E1D8] dark:border-[#2A324B] hover:border-[#C5BDB0]'
                  }`}
                >
                  <div className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                    AI Storyteller
                  </div>
                  <div className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                    Expressive Gemini studio voices (auto-switches if daily free quota is reached)
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateVoicePreferences({
                      ...voicePreferences,
                      voiceEngine: 'device',
                    })
                  }
                  className={`text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                    voicePreferences.voiceEngine === 'device'
                      ? 'bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/15 border-[#2F7A5E] dark:border-[#E5A94C]'
                      : 'bg-[#FAF8F4] dark:bg-[#121624] border-[#E6E1D8] dark:border-[#2A324B] hover:border-[#C5BDB0]'
                  }`}
                >
                  <div className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                    Built-in Device Voice
                  </div>
                  <div className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                    Unlimited, instant offline narration using your device’s natural speech voice
                  </div>
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                Default Storyteller Tone
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {VOICE_PERSONAS.map((persona) => {
                  const selected = voicePreferences.voicePersona === persona.id;
                  return (
                    <button
                      key={persona.id}
                      type="button"
                      onClick={() =>
                        onUpdateVoicePreferences({
                          ...voicePreferences,
                          voicePersona: persona.id as VoicePersonaId,
                        })
                      }
                      className={`text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/15 border-[#2F7A5E] dark:border-[#E5A94C]'
                          : 'bg-[#FAF8F4] dark:bg-[#121624] border-[#E6E1D8] dark:border-[#2A324B] hover:border-[#C5BDB0]'
                      }`}
                    >
                      <div className="text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                        {persona.label}
                      </div>
                      <div className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
                        {persona.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-2">
                Default Reading Speed
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { value: 0.8 as ReadingSpeed, label: '0.8× Gentle' },
                    { value: 1 as ReadingSpeed, label: '1.0× Normal' },
                    { value: 1.15 as ReadingSpeed, label: '1.15× Lively' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onUpdateVoicePreferences({
                        ...voicePreferences,
                        readingSpeed: opt.value,
                      })
                    }
                    className={`py-2 rounded-xl text-xs font-semibold font-mono tabular-nums transition-colors cursor-pointer ${
                      voicePreferences.readingSpeed === opt.value
                        ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                        : 'bg-[#F3EFE8] dark:bg-[#121624] text-[#5C646B] dark:text-[#A4AEC2]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Saved Parent Voice Clips & Clear Controls */}
          <div className="lg:col-span-6 p-5 rounded-xl bg-[#FAF8F4] dark:bg-[#121624] border border-[#E6E1D8] dark:border-[#2A324B] space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                <Mic className="w-4 h-4 text-[#C84B58] dark:text-[#E06D7A]" />
                <span>Saved Parent Recordings ({totalParentClips})</span>
              </div>
              {totalParentClips > 0 && (
                <button
                  type="button"
                  onClick={() => void handleClearAllParentVoices()}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#C84B58] dark:text-[#E06D7A] hover:underline cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear All Clips
                </button>
              )}
            </div>

            {totalParentClips === 0 ? (
              <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] leading-relaxed">
                No parent voice recordings saved on this device yet. Open any story and tap{' '}
                <strong>Record Voice</strong> to capture clear, noise-reduced voiceovers for your child.
              </p>
            ) : (
              <ul className="divide-y divide-[#E6E1D8] dark:divide-[#2A324B] text-sm">
                {Object.entries(parentVoiceCounts).map(([storyId, count]) => {
                  const matched = allStories.find((s) => s.id === storyId);
                  const title = matched?.title || storyId;
                  return (
                    <li
                      key={storyId}
                      className="py-2.5 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="font-medium text-[#24292E] dark:text-[#EDE9DF]">
                          {title}
                        </div>
                        <div className="text-xs text-[#5C646B] dark:text-[#A4AEC2] tabular-nums">
                          {count} recorded {count === 1 ? 'page' : 'pages'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleClearBookVoices(storyId, title)}
                        className="px-2.5 py-1 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] hover:border-[#C84B58]/50 cursor-pointer"
                      >
                        Clear Book
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="pt-3 border-t border-[#E6E1D8] dark:border-[#2A324B] flex items-center justify-between gap-3">
              <span className="text-xs text-[#5C646B] dark:text-[#A4AEC2]">
                Refresh preloaded AI narration cache if you want fresh voice synthesis.
              </span>
              <button
                type="button"
                onClick={() => void handleClearAiCache()}
                className="text-xs font-semibold text-[#2F7A5E] dark:text-[#5CA49B] hover:underline whitespace-nowrap cursor-pointer"
              >
                Clear AI Cache
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
