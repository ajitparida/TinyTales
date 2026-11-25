import React, { useEffect } from 'react';
import { AnimatePresence, motion, PanInfo } from 'motion/react';
import { X } from 'lucide-react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  reducedMotion?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  reducedMotion = false,
  children,
  footer,
}: BottomSheetProps) {
  // Lock background scroll & bind Escape key while open
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y > 90 || info.velocity.y > 420) {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center md:items-end md:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          {/* Dimmed translucent backdrop */}
          <motion.button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.05 : 0.2 }}
            className="fixed inset-0 bg-[#121624]/45 dark:bg-black/65 backdrop-blur-xs cursor-default"
          />

          {/* Draggable native bottom sheet container */}
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { y: '100%' }}
            animate={reducedMotion ? { opacity: 1 } : { y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { y: '100%' }}
            transition={
              reducedMotion
                ? { duration: 0.1 }
                : { type: 'spring', stiffness: 390, damping: 36, mass: 0.9 }
            }
            drag={reducedMotion ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.45 }}
            onDragEnd={handleDragEnd}
            className="relative z-10 w-full max-w-xl bg-[#FAF8F4] dark:bg-[#1A2033] border-t md:border border-[#E6E1D8] dark:border-[#2A324B] rounded-t-3xl md:rounded-3xl shadow-2xl flex flex-col max-h-[86dvh] overflow-hidden"
          >
            {/* Centered drag handle affordance */}
            <div className="pt-2.5 pb-1 flex justify-center shrink-0 cursor-grab active:cursor-grabbing">
              <div className="w-10 h-1.5 rounded-full bg-[#D8D1C4] dark:bg-[#34405E]" />
            </div>

            {/* Sheet Header */}
            <div className="px-5 pt-1.5 pb-3.5 border-b border-[#E6E1D8] dark:border-[#2A324B] flex items-center justify-between gap-3 shrink-0">
              <div className="min-w-0">
                <h2 className="font-display text-lg font-semibold text-[#24292E] dark:text-[#EDE9DF] truncate">
                  {title}
                </h2>
                {subtitle && (
                  <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5 truncate">
                    {subtitle}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={`Close ${title}`}
                className="min-w-[44px] min-h-[44px] -mr-2 rounded-xl flex items-center justify-center text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] hover:bg-[#EFECE5] dark:hover:bg-[#232B42] transition-colors active:scale-95 cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Sheet Body (stop drag propagation inside scrollable content) */}
            <div
              onPointerDownCapture={(e) => e.stopPropagation()}
              className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-4"
            >
              {children}
            </div>

            {/* Optional Pinned Footer + Safe Area Bottom Padding */}
            <div className={`shrink-0 pb-safe ${footer ? 'px-5 pt-3 border-t border-[#E6E1D8] dark:border-[#2A324B] bg-[#FAF8F4]/95 dark:bg-[#1A2033]/95' : 'h-2'}`}>
              {footer ? <div className="pb-3">{footer}</div> : null}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
