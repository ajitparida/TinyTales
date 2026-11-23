import { User } from 'firebase/auth';
import { AppView } from '../types/story';

interface TopBarProps {
  activeView: AppView;
  bedtimeEnabled: boolean;
  user: User | null;
  authLoading: boolean;
  onNavigate: (view: AppView) => void;
  onToggleBedtime: () => void;
  onSignIn: () => void;
  onOpenParents: () => void;
}

export function TopBar({
  activeView,
  bedtimeEnabled,
  user,
  authLoading,
  onNavigate,
  onToggleBedtime,
  onSignIn,
  onOpenParents,
}: TopBarProps) {
  const navItemClass = (isActive: boolean) =>
    `text-sm font-medium transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b-2 ${
      isActive
        ? 'text-[#24292E] dark:text-[#EDE9DF] border-[#2F7A5E] dark:border-[#E5A94C]'
        : 'text-[#5C646B] dark:text-[#A4AEC2] border-transparent hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
    }`;

  return (
    <header className="sticky top-0 z-30 bg-[#FAF8F4]/95 dark:bg-[#121624]/95 backdrop-blur-sm border-b border-[#E6E1D8] dark:border-[#2A324B]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('library')}
          className="font-display text-xl font-bold tracking-tight text-[#24292E] dark:text-[#EDE9DF] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#2F7A5E] rounded-sm cursor-pointer"
        >
          Meadowtale
        </button>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav aria-label="Primary navigation" className="flex items-center gap-5 sm:gap-7 overflow-x-auto">
          <button
            type="button"
            onClick={() => onNavigate('library')}
            className={`${navItemClass(activeView === 'library' || activeView === 'reader')} cursor-pointer`}
          >
            Library
          </button>
          <button
            type="button"
            onClick={() => onNavigate('scanner')}
            className={`${navItemClass(activeView === 'scanner')} cursor-pointer`}
          >
            Add Book
          </button>
          <button
            type="button"
            onClick={onToggleBedtime}
            className={`${navItemClass(bedtimeEnabled)} cursor-pointer`}
          >
            {bedtimeEnabled ? 'Daytime' : 'Bedtime'}
          </button>
          <button
            type="button"
            onClick={onOpenParents}
            className={`${navItemClass(activeView === 'parents')} cursor-pointer`}
          >
            Parents
          </button>
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="shrink-0">
          {user ? (
            <button
              type="button"
              onClick={onOpenParents}
              className="px-4 py-2 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap shrink-0 max-w-[160px] truncate cursor-pointer"
            >
              {user.displayName?.split(' ')[0] || 'Parent Account'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              disabled={authLoading}
              className="px-4 py-2 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 cursor-pointer"
            >
              {authLoading ? 'Signing In...' : 'Sign In'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
