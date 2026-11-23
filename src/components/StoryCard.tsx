import { useEffect, useState } from 'react';
import { BookOpen, Loader2, Pencil, Trash2 } from 'lucide-react';
import { Story } from '../types/story';
import { BACKDROP_ART_MAP } from '../data/curatedStories';
import { getMediaDataUrl } from '../lib/mediaStore';

interface StoryCardProps {
  story: Story;
  isCompleted?: boolean;
  onSelect: (story: Story) => void;
  onEditCustom?: (story: Story) => void;
  onDeleteCustom?: (story: Story) => void | Promise<void>;
}

export function StoryCard({
  story,
  isCompleted = false,
  onSelect,
  onEditCustom,
  onDeleteCustom,
}: StoryCardProps) {
  const [resolvedCover, setResolvedCover] = useState<string>(
    story.coverImageUrl || BACKDROP_ART_MAP[story.coverFallbackId] || BACKDROP_ART_MAP.forest
  );
  const [imageError, setImageError] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    if (story.coverImageUrl) {
      setResolvedCover(story.coverImageUrl);
      setImageError(false);
      return;
    }
    if (story.coverMediaId) {
      void getMediaDataUrl(story.coverMediaId).then((url) => {
        if (!active) return;
        if (url) {
          setResolvedCover(url);
          setImageError(false);
        } else {
          setResolvedCover(BACKDROP_ART_MAP[story.coverFallbackId] || BACKDROP_ART_MAP.forest);
        }
      });
    } else {
      setResolvedCover(BACKDROP_ART_MAP[story.coverFallbackId] || BACKDROP_ART_MAP.forest);
    }
    return () => {
      active = false;
    };
  }, [story.coverImageUrl, story.coverMediaId, story.coverFallbackId]);

  return (
    <article className="group flex flex-col bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <button
        type="button"
        onClick={() => onSelect(story)}
        className="text-left flex flex-col flex-1 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2F7A5E]"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#F1ECE2] dark:bg-[#151A2B]">
          {!imageError ? (
            <img
              src={resolvedCover}
              alt={story.title}
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-gradient-to-br from-[#EFECE4] to-[#E3DACB] dark:from-[#1A2033] dark:to-[#242D45]">
              <BookOpen className="w-9 h-9 text-[#2F7A5E] dark:text-[#E5A94C] mb-2" />
              <span className="font-display text-base font-semibold text-[#24292E] dark:text-[#EDE9DF]">
                {story.title}
              </span>
            </div>
          )}
        </div>

        <div className="p-5 flex flex-col flex-1">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] mb-2">
            <span>Ages {story.ageGroup}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{story.readMinutes} min</span>
            <span aria-hidden="true">·</span>
            <span>Moral: {story.moralTitle}</span>
            {story.isCustom && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#2F7A5E] dark:text-[#E5A94C]">Scanned Book</span>
              </>
            )}
          </div>

          <h3 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF] leading-snug mb-2 group-hover:text-[#2F7A5E] dark:group-hover:text-[#E5A94C] transition-colors">
            {story.title}
          </h3>

          <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] leading-relaxed line-clamp-2 flex-1">
            {story.subtitle}
          </p>

          <div className="mt-4 pt-3.5 border-t border-[#E6E1D8]/80 dark:border-[#2A324B] flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-[#2F7A5E] dark:text-[#E5A94C]">
              {isCompleted ? 'Read Again' : 'Open Storybook'}
            </span>
            <span className="text-xs text-[#5C646B] dark:text-[#A4AEC2] tabular-nums">
              {story.pages.length} {story.pages.length === 1 ? 'page' : 'pages'}
            </span>
          </div>
        </div>
      </button>

      {story.isCustom && (onEditCustom || onDeleteCustom) && (
        <div className="px-5 pb-4 -mt-1 flex items-center justify-between gap-3">
          {onEditCustom ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditCustom(story);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2F7A5E] dark:text-[#E5A94C] hover:underline transition-colors cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit Book
            </button>
          ) : (
            <span />
          )}

          {onDeleteCustom && (
            <button
              type="button"
              disabled={isDeleting}
              onClick={async (e) => {
                e.stopPropagation();
                if (isDeleting) return;
                setIsDeleting(true);
                try {
                  await onDeleteCustom(story);
                } finally {
                  setIsDeleting(false);
                }
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#C84B58] dark:hover:text-[#E06D7A] transition-colors disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
            >
              {isDeleting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              {isDeleting ? 'Removing...' : 'Remove'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
