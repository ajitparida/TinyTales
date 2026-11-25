import { User } from 'firebase/auth';
import { Loader2, Moon, Sun } from 'lucide-react';
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

  const firstName = user?.displayName?.split(' ')[0] || 'Account';

  return (
    <header className="md:hidden xl:block sticky top-0 z-30 bg-[#FAF8F4]/92 dark:bg-[#121624]/92 backdrop-blur-md border-b border-[#E6E1D8] dark:border-[#2A324B] pt-safe">
      {/* Compact Native Mobile Header (< 768px): 52px height to stay strictly under 15% mobile sticky cap */}
      <div className="xl:hidden px-4 h-[52px] flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onNavigate('library')}
          className="font-display text-lg font-bold tracking-tight text-[#24292E] dark:text-[#EDE9DF] whitespace-nowrap shrink-0 min-h-[44px] flex items-center cursor-pointer"
        >
          Meadowtale
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Quick Bedtime Mode Moon/Sun Toggle */}
          <button
            type="button"
            onClick={onToggleBedtime}
            aria-label={bedtimeEnabled ? 'Switch to Daytime Mode' : 'Switch to Bedtime Mode'}
            aria-pressed={bedtimeEnabled}
            className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-colors active:scale-95 cursor-pointer ${
              bedtimeEnabled
                ? 'bg-[#E5A94C]/18 text-[#E5A94C]'
                : 'text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#EFECE5] dark:hover:bg-[#1E263D] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
            }`}
          >
            {bedtimeEnabled ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          {user ? (
            <button
              type="button"
              onClick={onOpenParents}
              className="min-h-[38px] px-3 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors active:scale-95 whitespace-nowrap max-w-[110px] truncate cursor-pointer"
            >
              {firstName}
            </button>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              disabled={authLoading}
              className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-xs font-semibold transition-colors active:scale-95 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {authLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {authLoading ? 'Signing In...' : 'Sign In'}
            </button>
          )}
        </div>
      </div>

      {/* Editorial Desktop Top Navigation Bar (>= 1280px) */}
      <div className="hidden xl:flex max-w-7xl mx-auto px-8 h-16 items-center justify-between gap-8">
        <button
          type="button"
          onClick={() => onNavigate('library')}
          className="font-display text-xl font-bold tracking-tight text-[#24292E] dark:text-[#EDE9DF] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#2F7A5E] rounded-sm cursor-pointer"
        >
          Meadowtale
        </button>

        <nav aria-label="Primary navigation" className="flex items-center gap-7">
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
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {authLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {authLoading ? 'Signing In...' : 'Sign In'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
