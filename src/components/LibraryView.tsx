import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Camera, Moon, PenLine, Search, Sparkles, Star, X } from 'lucide-react';
import { AgeGroup, BedtimeSettings, ChildProfile, ReadingLogEntry, Story } from '../types/story';
import { BACKDROP_ART_MAP } from '../data/curatedStories';
import { resolveStoryMediaUrl } from '../lib/mediaStore';
import { StoryCard } from './StoryCard';

type LibraryFilter = 'all' | AgeGroup | 'scanned';

interface LibraryViewProps {
  curatedStories: Story[];
  customStories: Story[];
  cloudSyncKey?: string;
  isAdmin?: boolean;
  publishedStoryIds?: Set<string>;
  childrenProfiles: ChildProfile[];
  activeChildId: string;
  readingLogs: ReadingLogEntry[];
  bedtimeSettings: BedtimeSettings;
  sleepRemainingSeconds: number | null;
  bedtimeStoriesLeft: number | null;
  onSelectChild: (childId: string) => void;
  onOpenStory: (story: Story) => void;
  onOpenScanner: () => void;
  onOpenManualCreator: () => void;
  onEditCustomStory: (story: Story) => void;
  onDeleteCustomStory: (story: Story) => void | Promise<void>;
  onPublishCustomStory?: (story: Story) => void | Promise<void>;
  onUnpublishCustomStory?: (story: Story) => void | Promise<void>;
}

export function LibraryView({
  curatedStories,
  customStories,
  cloudSyncKey = '',
  isAdmin = false,
  publishedStoryIds,
  childrenProfiles,
  activeChildId,
  readingLogs,
  bedtimeSettings,
  sleepRemainingSeconds,
  bedtimeStoriesLeft,
  onSelectChild,
  onOpenStory,
  onOpenScanner,
  onOpenManualCreator,
  onEditCustomStory,
  onDeleteCustomStory,
  onPublishCustomStory,
  onUnpublishCustomStory,
}: LibraryViewProps) {
  const activeChild =
    childrenProfiles.find((c) => c.id === activeChildId) || childrenProfiles[0];

  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const allStories = useMemo(
    () => [...customStories, ...curatedStories],
    [customStories, curatedStories]
  );

  const completedStoryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const log of readingLogs) {
      if (!activeChild || log.childId === activeChild.id) {
        ids.add(log.storyId);
      }
    }
    return ids;
  }, [readingLogs, activeChild]);

  const filteredStories = useMemo(() => {
    let base = allStories;
    if (filter === 'scanned') {
      base = customStories;
    } else if (filter === '2-3' || filter === '4-5') {
      base = allStories.filter((s) => s.ageGroup === filter);
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;

    return base.filter((story) => {
      return (
        story.title.toLowerCase().includes(q) ||
        story.moralTitle.toLowerCase().includes(q) ||
        story.moralLesson.toLowerCase().includes(q) ||
        story.subtitle.toLowerCase().includes(q)
      );
    });
  }, [allStories, customStories, filter, searchQuery]);

  // Pick a featured story matching the active child's age group (or bedtime favorite when in bedtime mode)
  const featuredStory = useMemo(() => {
    if (bedtimeSettings.bedtimeEnabled) {
      const luma = curatedStories.find((s) => s.id === 'luma-firefly-glow');
      if (luma) return luma;
    }
    if (activeChild) {
      const match = allStories.find((s) => s.ageGroup === activeChild.ageGroup);
      if (match) return match;
    }
    return curatedStories[0];
  }, [allStories, curatedStories, activeChild, bedtimeSettings.bedtimeEnabled]);

  const featuredFallbackCover =
    featuredStory.coverImageUrl ||
    BACKDROP_ART_MAP[featuredStory.coverFallbackId] ||
    BACKDROP_ART_MAP.forest;

  const [featuredCoverUrl, setFeaturedCoverUrl] = useState<string>(featuredFallbackCover);
  const [featuredImageError, setFeaturedImageError] = useState(false);

  useEffect(() => {
    let active = true;
    const fallback =
      featuredStory.coverImageUrl ||
      BACKDROP_ART_MAP[featuredStory.coverFallbackId] ||
      BACKDROP_ART_MAP.forest;

    if (featuredStory.coverImageUrl) {
      setFeaturedCoverUrl(featuredStory.coverImageUrl);
      setFeaturedImageError(false);
      return;
    }

    const mediaKey = featuredStory.coverMediaId || featuredStory.pages[0]?.mediaId;
    const isFeaturedPublished = Boolean(
      featuredStory.isPublished || publishedStoryIds?.has(featuredStory.id)
    );
    if (mediaKey) {
      void resolveStoryMediaUrl(mediaKey, { preferPublished: isFeaturedPublished }).then((url) => {
        if (!active) return;
        setFeaturedCoverUrl(url || fallback);
        setFeaturedImageError(false);
      });
    } else {
      setFeaturedCoverUrl(fallback);
      setFeaturedImageError(false);
    }

    return () => {
      active = false;
    };
  }, [
    featuredStory.id,
    featuredStory.coverImageUrl,
    featuredStory.coverMediaId,
    featuredStory.coverFallbackId,
    featuredStory.pages,
    featuredStory.isPublished,
    publishedStoryIds,
    cloudSyncKey,
  ]);

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 lg:py-10">
      {/* Bedtime Session Quiet Ribbon */}
      {bedtimeSettings.bedtimeEnabled && (
        <div className="mb-8 px-5 py-3.5 rounded-2xl bg-[#1A2033] border border-[#2A324B] flex flex-wrap items-center justify-between gap-4 text-sm text-[#EDE9DF]">
          <div className="flex items-center gap-3">
            <Moon className="w-4 h-4 text-[#E5A94C] shrink-0" />
            <span>
              Bedtime Mode is active — soft twilight colors, calm voice narration, and gentle pacing.
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-[#A4AEC2] font-mono tabular-nums">
            {sleepRemainingSeconds !== null && (
              <span>Sleep timer: {formatTimer(sleepRemainingSeconds)}</span>
            )}
            {bedtimeStoriesLeft !== null && (
              <span>
                {bedtimeStoriesLeft} {bedtimeStoriesLeft === 1 ? 'story' : 'stories'} left tonight
              </span>
            )}
          </div>
        </div>
      )}

      {/* Hero Split (Balanced 2-Column with items-stretch) */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-7 lg:gap-8 items-stretch mb-9 sm:mb-12">
        <div className="lg:col-span-6 flex flex-col justify-between bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-5 sm:p-8 watercolor-paper-frame">
          <div>
            {activeChild && (
              <div className="flex flex-wrap items-center justify-between gap-2.5 mb-4 pb-3.5 border-b border-[#E6E1D8] dark:border-[#2A324B]">
                <div className="flex items-center flex-wrap gap-2 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2]">
                  <span>Reading for {activeChild.name}</span>
                  <span aria-hidden="true">·</span>
                  <span>Ages {activeChild.ageGroup}</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-[#D98A1C] dark:text-[#E5A94C] tabular-nums">
                    <Star className="w-3.5 h-3.5 fill-current" />
                    {activeChild.starsEarned} {activeChild.starsEarned === 1 ? 'star' : 'stars'}
                  </span>
                </div>
                {childrenProfiles.length > 1 && (
                  <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar max-w-full">
                    {childrenProfiles.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => onSelectChild(child.id)}
                        className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors active:scale-95 whitespace-nowrap cursor-pointer ${
                          child.id === activeChild.id
                            ? 'bg-[#2F7A5E] dark:bg-[#E5A94C] text-white dark:text-[#121624]'
                            : 'text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42]'
                        }`}
                      >
                        {child.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <h1 className="font-display text-2xl sm:text-4xl lg:text-[2.6rem] font-semibold leading-[1.15] text-[#24292E] dark:text-[#EDE9DF] mb-3.5">
              {bedtimeSettings.bedtimeEnabled
                ? 'Quiet watercolor tales for sleepy eyes'
                : 'Warm watercolor stories ready to tap and hear'}
            </h1>
            <p className="text-sm sm:text-base text-[#5C646B] dark:text-[#A4AEC2] leading-relaxed max-w-xl mb-6">
              Tap friendly characters on every page, listen with expressive AI voices or a parent’s
              own voice recording, and share a gentle moral at the end of every book.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() => onOpenStory(featuredStory)}
              className="inline-flex items-center justify-center gap-2.5 min-h-[48px] px-5 py-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-all active:scale-[0.98] whitespace-nowrap cursor-pointer"
            >
              <BookOpen className="w-4 h-4 shrink-0" />
              <span className="truncate">Read “{featuredStory.title}”</span>
            </button>
            <div className="grid grid-cols-2 sm:flex items-center gap-2.5 sm:gap-3">
              <button
                type="button"
                onClick={onOpenScanner}
                className="inline-flex items-center justify-center gap-2 min-h-[48px] px-4 sm:px-5 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F4EFE6] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-sm font-semibold transition-all active:scale-[0.98] whitespace-nowrap cursor-pointer"
              >
                <Camera className="w-4 h-4 shrink-0" />
                Scan Book
              </button>
              <button
                type="button"
                onClick={onOpenManualCreator}
                className="inline-flex items-center justify-center gap-2 min-h-[48px] px-4 sm:px-5 py-3 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F4EFE6] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-sm font-semibold transition-all active:scale-[0.98] whitespace-nowrap cursor-pointer"
              >
                <PenLine className="w-4 h-4 shrink-0" />
                Add Manually
              </button>
            </div>
          </div>
        </div>

        {/* Featured Watercolor Spread */}
        <button
          type="button"
          onClick={() => onOpenStory(featuredStory)}
          className="lg:col-span-6 group relative rounded-2xl overflow-hidden border border-[#E6E1D8] dark:border-[#2A324B] bg-[#F1ECE2] dark:bg-[#151A2B] min-h-[280px] text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2F7A5E]"
        >
          {!featuredImageError && featuredCoverUrl ? (
            <img
              src={featuredCoverUrl}
              alt={featuredStory.title}
              referrerPolicy="no-referrer"
              onError={() => setFeaturedImageError(true)}
              className="w-full h-full lg:h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="w-full h-full min-h-[280px] bg-gradient-to-br from-[#EFECE4] to-[#E3DACB] dark:from-[#1A2033] dark:to-[#242D45]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent flex flex-col justify-end p-6 sm:p-8">
            <div className="text-xs font-medium text-white/85 mb-1.5 flex items-center gap-2">
              <span>Featured Story</span>
              <span aria-hidden="true">·</span>
              <span>Ages {featuredStory.ageGroup}</span>
              <span aria-hidden="true">·</span>
              <span>Moral: {featuredStory.moralTitle}</span>
            </div>
            <h2 className="font-display text-2xl sm:text-3xl font-semibold text-white leading-tight mb-1">
              {featuredStory.title}
            </h2>
            <p className="text-sm text-white/85 max-w-lg line-clamp-2">
              {featuredStory.subtitle}
            </p>
          </div>
        </button>
      </section>

      {/* Workspace Filter Toolbar */}
      <section aria-label="Storybook shelf">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-7 pb-4 border-b border-[#E6E1D8] dark:border-[#2A324B]">
          <div>
            <h2 className="font-display text-2xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
              Storybook Shelf
            </h2>
            <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
              Choose stories tailored for toddlers (2–3) or preschoolers (4–5), plus your family’s custom books.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            {/* Search by Title or Moral */}
            <div className="relative w-full sm:w-64">
              <Search
                aria-hidden="true"
                className="w-4 h-4 text-[#5C646B] dark:text-[#A4AEC2] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search title or moral..."
                aria-label="Search storybooks by title or moral lesson"
                className="w-full min-h-[44px] pl-9 pr-10 py-2 rounded-xl bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] text-sm text-[#24292E] dark:text-[#EDE9DF] placeholder:text-[#5C646B]/75 dark:placeholder:text-[#A4AEC2]/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2F7A5E] dark:focus-visible:outline-[#E5A94C]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div
              role="tablist"
              aria-label="Filter stories by age group"
              className="flex items-center gap-1 p-1 rounded-xl bg-[#EFECE5] dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] overflow-x-auto no-scrollbar max-w-full"
            >
              {(
                [
                  { id: 'all', label: 'All Books' },
                  { id: '2-3', label: 'Ages 2–3' },
                  { id: '4-5', label: 'Ages 4–5' },
                  { id: 'scanned', label: `My Books (${customStories.length})` },
                ] as const
              ).map((tab) => {
                const active = filter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(tab.id)}
                    className={`min-h-[38px] px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors active:scale-95 whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF] shadow-xs'
                        : 'text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {filteredStories.length === 0 ? (
          searchQuery.trim() ? (
            <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-10 text-center max-w-xl mx-auto my-8">
              <div className="w-12 h-12 rounded-xl bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/15 text-[#2F7A5E] dark:text-[#E5A94C] flex items-center justify-center mx-auto mb-4">
                <Search className="w-6 h-6" />
              </div>
              <h3 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
                No matching stories found
              </h3>
              <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] mb-6 leading-relaxed">
                We couldn’t find any books matching “{searchQuery.trim()}” in this shelf. Try searching
                for a value like kindness, courage, sharing, or honesty.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setFilter('all');
                }}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer"
              >
                Show All Stories
              </button>
            </div>
          ) : (
            <div className="bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-10 text-center max-w-xl mx-auto my-8">
              <div className="w-12 h-12 rounded-xl bg-[#2F7A5E]/10 dark:bg-[#E5A94C]/15 text-[#2F7A5E] dark:text-[#E5A94C] flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-6 h-6" />
              </div>
              <h3 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF] mb-2">
                No custom storybooks yet
              </h3>
              <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] mb-6 leading-relaxed">
                Snap photos of a physical book from your shelf, or write and upload your own story
                pages manually with custom text and artwork.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={onOpenScanner}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                  Scan a Book
                </button>
                <button
                  type="button"
                  onClick={onOpenManualCreator}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] hover:bg-[#F4EFE6] dark:hover:bg-[#232B42] text-[#24292E] dark:text-[#EDE9DF] text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer"
                >
                  <PenLine className="w-4 h-4" />
                  Add Manually
                </button>
              </div>
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 sm:gap-6">
            {filteredStories.map((story) => {
              const storyIsPublished = Boolean(
                story.isPublished || publishedStoryIds?.has(story.id)
              );
              return (
                <StoryCard
                  key={story.id}
                  story={story}
                  cloudSyncKey={cloudSyncKey}
                  isCompleted={completedStoryIds.has(story.id)}
                  isAdmin={isAdmin}
                  isPublished={storyIsPublished}
                  onSelect={onOpenStory}
                  onEditCustom={story.isCustom ? onEditCustomStory : undefined}
                  onDeleteCustom={story.isCustom ? onDeleteCustomStory : undefined}
                  onPublishCustom={isAdmin && story.isCustom ? onPublishCustomStory : undefined}
                  onUnpublishCustom={
                    isAdmin && storyIsPublished ? onUnpublishCustomStory : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
