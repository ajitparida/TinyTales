import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, BookPlus, ShieldCheck } from 'lucide-react';
import { AppView } from '../types/story';

interface MobileBottomNavProps {
  activeView: AppView;
  hidden: boolean;
  reducedMotion?: boolean;
  onNavigate: (view: AppView) => void;
}

const MOBILE_TABS: {
  id: 'library' | 'scanner' | 'parents';
  label: string;
  icon: typeof BookOpen;
}[] = [
  { id: 'library', label: 'Library', icon: BookOpen },
  { id: 'scanner', label: 'Add Book', icon: BookPlus },
  { id: 'parents', label: 'Parents', icon: ShieldCheck },
];

export function MobileBottomNav({
  activeView,
  hidden,
  reducedMotion = false,
  onNavigate,
}: MobileBottomNavProps) {
  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.nav
          aria-label="Mobile primary navigation"
          initial={reducedMotion ? { opacity: 0 } : { y: 80, opacity: 0 }}
          animate={reducedMotion ? { opacity: 1 } : { y: 0, opacity: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { y: 80, opacity: 0 }}
          transition={
            reducedMotion
              ? { duration: 0.1 }
              : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }
          }
          className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-[#FAF8F4]/92 dark:bg-[#121624]/92 backdrop-blur-md border-t border-[#E6E1D8] dark:border-[#2A324B] pb-safe"
        >
          <div className="grid grid-cols-3 h-14 max-w-md mx-auto px-2">
            {MOBILE_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive =
                tab.id === 'library'
                  ? activeView === 'library' || activeView === 'reader'
                  : activeView === tab.id;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onNavigate(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`relative flex flex-col items-center justify-center min-h-[44px] min-w-[44px] gap-0.5 rounded-xl transition-colors active:scale-95 cursor-pointer ${
                    isActive
                      ? 'text-[#2F7A5E] dark:text-[#E5A94C]'
                      : 'text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF]'
                  }`}
                >
                  <span className="relative flex items-center justify-center w-12 h-7 rounded-full">
                    {isActive && (
                      <motion.span
                        layoutId="mobile-bottom-tab-pill"
                        transition={
                          reducedMotion
                            ? { duration: 0.05 }
                            : { type: 'spring', stiffness: 450, damping: 34 }
                        }
                        className="absolute inset-0 rounded-full bg-[#2F7A5E]/12 dark:bg-[#E5A94C]/16"
                      />
                    )}
                    <Icon
                      className={`relative z-10 w-[21px] h-[21px] transition-transform ${
                        isActive ? 'stroke-[2.3]' : 'stroke-[1.85]'
                      }`}
                    />
                  </span>
                  <span
                    className={`text-[11px] leading-none tracking-tight ${
                      isActive ? 'font-semibold' : 'font-medium'
                    }`}
                  >
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        </motion.nav>
      )}
    </AnimatePresence>
  );
}
