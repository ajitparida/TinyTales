import { User } from 'firebase/auth';
import { motion } from 'motion/react';
import {
  BookOpen,
  BookPlus,
  Loader2,
  LogIn,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { AppView } from '../types/story';

interface IpadSidebarRailProps {
  activeView: AppView;
  expanded: boolean;
  bedtimeEnabled: boolean;
  user: User | null;
  authLoading: boolean;
  reducedMotion?: boolean;
  onToggleExpanded: () => void;
  onNavigate: (view: AppView) => void;
  onToggleBedtime: () => void;
  onSignIn: () => void;
  onOpenParents: () => void;
}

const RAIL_ITEMS: {
  id: 'library' | 'scanner' | 'parents';
  label: string;
  icon: typeof BookOpen;
}[] = [
  { id: 'library', label: 'Library', icon: BookOpen },
  { id: 'scanner', label: 'Add Book', icon: BookPlus },
  { id: 'parents', label: 'Parents', icon: ShieldCheck },
];

export function IpadSidebarRail({
  activeView,
  expanded,
  bedtimeEnabled,
  user,
  authLoading,
  reducedMotion = false,
  onToggleExpanded,
  onNavigate,
  onToggleBedtime,
  onSignIn,
  onOpenParents,
}: IpadSidebarRailProps) {
  const firstName = user?.displayName?.split(' ')[0] || 'Parent';
  const initial = firstName.charAt(0).toUpperCase();

  return (
    <motion.aside
      aria-label="Tablet navigation sidebar"
      initial={false}
      animate={{ width: expanded ? 232 : 76 }}
      transition={
        reducedMotion
          ? { duration: 0.05 }
          : { type: 'spring', stiffness: 360, damping: 34 }
      }
      className="hidden md:flex xl:hidden flex-col sticky top-0 h-[100dvh] shrink-0 z-30 bg-[#FAF8F4]/95 dark:bg-[#121624]/95 backdrop-blur-md border-r border-[#E6E1D8] dark:border-[#2A324B] pt-safe pb-safe pl-safe overflow-hidden select-none"
    >
      {/* Top Wordmark + iPadOS Collapse Toggle */}
      <div
        className={`h-16 px-3 flex items-center border-b border-[#E6E1D8]/80 dark:border-[#2A324B]/80 shrink-0 ${
          expanded ? 'justify-between' : 'justify-center'
        }`}
      >
        {expanded && (
          <button
            type="button"
            onClick={() => onNavigate('library')}
            className="font-display text-xl font-bold tracking-tight text-[#24292E] dark:text-[#EDE9DF] whitespace-nowrap truncate pl-1.5 cursor-pointer"
          >
            Meadowtale
          </button>
        )}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#EFECE5] dark:hover:bg-[#1E263D] transition-colors active:scale-95 cursor-pointer shrink-0"
        >
          {expanded ? (
            <PanelLeftClose className="w-5 h-5" />
          ) : (
            <PanelLeftOpen className="w-5 h-5" />
          )}
        </button>
      </div>

      {/* Primary Destination Stack */}
      <nav aria-label="Primary tablet navigation" className="flex-1 px-2.5 py-4 space-y-1.5">
        {RAIL_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            item.id === 'library'
              ? activeView === 'library' || activeView === 'reader'
              : activeView === item.id;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              title={!expanded ? item.label : undefined}
              aria-current={isActive ? 'page' : undefined}
              className={`relative w-full min-h-[48px] rounded-2xl flex items-center transition-colors active:scale-[0.98] cursor-pointer ${
                expanded ? 'px-3.5 gap-3 justify-start' : 'justify-center px-0'
              } ${
                isActive
                  ? 'bg-[#2F7A5E]/12 dark:bg-[#E5A94C]/16 text-[#2F7A5E] dark:text-[#E5A94C] font-semibold'
                  : 'text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#EFECE5]/80 dark:hover:bg-[#1E263D] hover:text-[#24292E] dark:hover:text-[#EDE9DF] font-medium'
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="ipad-rail-indicator"
                  transition={
                    reducedMotion
                      ? { duration: 0.05 }
                      : { type: 'spring', stiffness: 420, damping: 32 }
                  }
                  className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r-full bg-[#2F7A5E] dark:bg-[#E5A94C]"
                />
              )}
              <Icon className="w-5 h-5 shrink-0" />
              {expanded && (
                <span className="text-sm whitespace-nowrap truncate">{item.label}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom Utility Controls: Bedtime Mode + Parent Account */}
      <div className="px-2.5 py-3.5 border-t border-[#E6E1D8]/80 dark:border-[#2A324B]/80 space-y-2 shrink-0">
        <button
          type="button"
          onClick={onToggleBedtime}
          aria-pressed={bedtimeEnabled}
          title={!expanded ? (bedtimeEnabled ? 'Switch to Daytime' : 'Switch to Bedtime') : undefined}
          className={`w-full min-h-[46px] rounded-2xl flex items-center transition-colors active:scale-[0.98] cursor-pointer ${
            expanded ? 'px-3.5 gap-3 justify-start' : 'justify-center px-0'
          } ${
            bedtimeEnabled
              ? 'bg-[#E5A94C]/18 text-[#E5A94C] font-semibold'
              : 'text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#EFECE5]/80 dark:hover:bg-[#1E263D] hover:text-[#24292E] dark:hover:text-[#EDE9DF] font-medium'
          }`}
        >
          {bedtimeEnabled ? (
            <Sun className="w-5 h-5 shrink-0" />
          ) : (
            <Moon className="w-5 h-5 shrink-0" />
          )}
          {expanded && (
            <span className="text-sm whitespace-nowrap truncate">
              {bedtimeEnabled ? 'Daytime Mode' : 'Bedtime Mode'}
            </span>
          )}
        </button>

        {user ? (
          <button
            type="button"
            onClick={onOpenParents}
            title={!expanded ? `${firstName} (Parent Account)` : undefined}
            className={`w-full min-h-[46px] rounded-2xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] flex items-center transition-colors active:scale-[0.98] cursor-pointer ${
              expanded ? 'px-3 gap-2.5 justify-start' : 'justify-center px-0'
            }`}
          >
            <span className="w-7 h-7 rounded-full bg-white/20 dark:bg-[#121624]/15 flex items-center justify-center text-xs font-bold shrink-0">
              {initial}
            </span>
            {expanded && (
              <span className="text-sm font-semibold whitespace-nowrap truncate">
                {firstName}
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            disabled={authLoading}
            title={!expanded ? 'Sign In' : undefined}
            className={`w-full min-h-[46px] rounded-2xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] flex items-center transition-colors active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer ${
              expanded ? 'px-3.5 gap-2.5 justify-center' : 'justify-center px-0'
            }`}
          >
            {authLoading ? (
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            ) : (
              <LogIn className="w-4 h-4 shrink-0" />
            )}
            {expanded && (
              <span className="text-sm font-semibold whitespace-nowrap">
                {authLoading ? 'Signing In...' : 'Sign In'}
              </span>
            )}
          </button>
        )}
      </div>
    </motion.aside>
  );
}
