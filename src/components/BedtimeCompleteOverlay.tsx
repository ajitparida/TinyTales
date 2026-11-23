import { Moon, Sun } from 'lucide-react';

interface BedtimeCompleteOverlayProps {
  reason: 'timer' | 'stories';
  onExtendBedtime: () => void;
  onExitBedtime: () => void;
}

export function BedtimeCompleteOverlay({
  reason,
  onExtendBedtime,
  onExitBedtime,
}: BedtimeCompleteOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 bg-[#0D101B]/95 backdrop-blur-md flex items-center justify-center p-6 text-[#EDE9DF]">
      <div className="max-w-md w-full bg-[#1A2033] border border-[#2A324B] rounded-2xl p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-[#E5A94C]/15 text-[#E5A94C] flex items-center justify-center mx-auto mb-5">
          <Moon className="w-7 h-7" />
        </div>
        <h2 className="font-display text-3xl font-semibold mb-3">
          Sweet Dreams, Little Reader
        </h2>
        <p className="text-sm text-[#A4AEC2] leading-relaxed mb-7">
          {reason === 'timer'
            ? 'Our bedtime reading timer has gently finished for tonight. Time to snuggle under the covers.'
            : 'We have finished all our bedtime stories for tonight. Time for cozy dreams.'}
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={onExtendBedtime}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-[#E5A94C] hover:bg-[#D69738] text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap cursor-pointer"
          >
            Parent: +1 More Story
          </button>
          <button
            type="button"
            onClick={onExitBedtime}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl border border-[#34405E] hover:bg-[#232B42] text-sm font-semibold whitespace-nowrap cursor-pointer"
          >
            <Sun className="w-4 h-4" />
            Switch to Daytime
          </button>
        </div>
      </div>
    </div>
  );
}
