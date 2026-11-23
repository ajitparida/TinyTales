import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Maximize2,
  Minimize2,
  Move,
  Paintbrush,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  ImageFrameSettings,
  renderFramedPageImage,
  renderWatercolorStorybookStyle,
} from '../lib/watercolorFilter';

interface PageImageFramingModalProps {
  sourceImageUrl: string;
  pageLabel: string;
  onCancel: () => void;
  onApply: (framedDataUrl: string) => void;
}

const DEFAULT_FRAME: ImageFrameSettings = {
  fitMode: 'cover',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
};

const QUICK_CROP_PRESETS: Array<{
  id: string;
  label: string;
  settings: Partial<ImageFrameSettings>;
}> = [
  {
    id: 'center',
    label: 'Center Art',
    settings: { fitMode: 'cover', zoom: 1.15, offsetX: 0, offsetY: 0 },
  },
  {
    id: 'top',
    label: 'Top Half (Screenshots)',
    settings: { fitMode: 'cover', zoom: 1.35, offsetX: 0, offsetY: 0.42 },
  },
  {
    id: 'bottom',
    label: 'Bottom Half',
    settings: { fitMode: 'cover', zoom: 1.35, offsetX: 0, offsetY: -0.42 },
  },
  {
    id: 'fit',
    label: 'Whole Image',
    settings: { fitMode: 'contain', zoom: 1, offsetX: 0, offsetY: 0 },
  },
];

export function PageImageFramingModal({
  sourceImageUrl,
  pageLabel,
  onCancel,
  onApply,
}: PageImageFramingModalProps) {
  const [settings, setSettings] = useState<ImageFrameSettings>(DEFAULT_FRAME);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({ w: 4, h: 3 });
  const [applyWatercolorOnSave, setApplyWatercolorOnSave] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      if (img.width > 0 && img.height > 0) {
        setNaturalSize({ w: img.width, h: img.height });
      }
    };
    img.src = sourceImageUrl;
  }, [sourceImageUrl]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startOffsetX: settings.offsetX,
      startOffsetY: settings.offsetY,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dx = (e.clientX - dragStartRef.current.clientX) / (rect.width * 0.5);
    const dy = (e.clientY - dragStartRef.current.clientY) / (rect.height * 0.5);

    setSettings((prev) => ({
      ...prev,
      offsetX: Math.max(-1.2, Math.min(1.2, dragStartRef.current!.startOffsetX + dx)),
      offsetY: Math.max(-1.2, Math.min(1.2, dragStartRef.current!.startOffsetY + dy)),
    }));
  };

  const handlePointerUp = () => {
    dragStartRef.current = null;
    setIsDragging(false);
  };

  const handleRotate = () => {
    setSettings((prev) => ({
      ...prev,
      rotationDeg: (((prev.rotationDeg + 90) % 360) as 0 | 90 | 180 | 270),
    }));
  };

  const handleApply = async () => {
    setIsApplying(true);
    try {
      const framedUrl = await renderFramedPageImage(sourceImageUrl, settings);
      const finalUrl = applyWatercolorOnSave
        ? await renderWatercolorStorybookStyle(framedUrl)
        : framedUrl;
      onApply(finalUrl);
    } finally {
      setIsApplying(false);
    }
  };

  const isQuarterTurn = settings.rotationDeg === 90 || settings.rotationDeg === 270;
  const effW = isQuarterTurn ? naturalSize.h : naturalSize.w;
  const effH = isQuarterTurn ? naturalSize.w : naturalSize.h;
  const stageW = 4;
  const stageH = 3;
  const baseScaleUnits =
    settings.fitMode === 'contain'
      ? Math.min(stageW / effW, stageH / effH)
      : Math.max(stageW / effW, stageH / effH);
  const drawWPercent = ((naturalSize.w * baseScaleUnits * settings.zoom) / stageW) * 100;
  const drawHPercent = ((naturalSize.h * baseScaleUnits * settings.zoom) / stageH) * 100;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#121624]/75 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={`Resize and crop ${pageLabel}`}
    >
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#E6E1D8] dark:border-[#2A324B] flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-xl font-semibold text-[#24292E] dark:text-[#EDE9DF]">
              Resize & Crop · {pageLabel}
            </h3>
            <p className="text-xs text-[#5C646B] dark:text-[#A4AEC2] mt-0.5">
              Drag to position artwork, zoom out or in to remove screenshot bars, and frame cleanly in 4:3.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close resize editor"
            className="p-2 rounded-lg text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Interactive 4:3 Storybook Frame Stage */}
          <div
            ref={stageRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={`relative aspect-[4/3] w-full max-h-[380px] mx-auto rounded-xl overflow-hidden bg-[#FAF6EE] border-2 border-[#2F7A5E]/40 dark:border-[#E5A94C]/40 select-none touch-none ${
              isDragging ? 'cursor-grabbing' : 'cursor-grab'
            }`}
          >
            <img
              src={sourceImageUrl}
              alt="Resize preview"
              draggable={false}
              style={{
                position: 'absolute',
                left: `${50 + settings.offsetX * 50}%`,
                top: `${50 + settings.offsetY * 50}%`,
                width: `${drawWPercent}%`,
                height: `${drawHPercent}%`,
                maxWidth: 'none',
                maxHeight: 'none',
                transform: `translate(-50%, -50%) rotate(${settings.rotationDeg}deg)`,
                transformOrigin: 'center center',
              }}
            />

            {/* Subtle Composition Thirds Guides */}
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-35">
              <div className="border-r border-b border-white/70" />
              <div className="border-r border-b border-white/70" />
              <div className="border-b border-white/70" />
              <div className="border-r border-b border-white/70" />
              <div className="border-r border-b border-white/70" />
              <div className="border-b border-white/70" />
              <div className="border-r border-white/70" />
              <div className="border-r border-white/70" />
              <div />
            </div>

            <div className="pointer-events-none absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-lg bg-[#121624]/70 text-white text-[11px] font-medium flex items-center gap-1.5">
              <Move className="w-3 h-3" />
              Drag to reposition
            </div>
          </div>

          {/* Quick Screenshot Crop Presets */}
          <div>
            <div className="text-[11px] font-semibold text-[#5C646B] dark:text-[#A4AEC2] mb-1.5">
              Quick Crop Focus
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {QUICK_CROP_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      ...preset.settings,
                    }))
                  }
                  className="px-2.5 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] bg-[#FAF8F4] dark:bg-[#121624] hover:border-[#2F7A5E] dark:hover:border-[#E5A94C] text-xs font-medium text-[#24292E] dark:text-[#EDE9DF] transition-colors cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Fit/Fill Mode, Rotate & Reset Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2EFE8] dark:bg-[#121624]">
              <button
                type="button"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    fitMode: 'cover',
                    zoom: 1,
                    offsetX: 0,
                    offsetY: 0,
                  }))
                }
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  settings.fitMode === 'cover'
                    ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                    : 'text-[#5C646B] dark:text-[#A4AEC2]'
                }`}
              >
                <Maximize2 className="w-3.5 h-3.5" />
                Fill Frame
              </button>
              <button
                type="button"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    fitMode: 'contain',
                    zoom: 1,
                    offsetX: 0,
                    offsetY: 0,
                  }))
                }
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  settings.fitMode === 'contain'
                    ? 'bg-white dark:bg-[#27304A] text-[#24292E] dark:text-[#EDE9DF]'
                    : 'text-[#5C646B] dark:text-[#A4AEC2]'
                }`}
              >
                <Minimize2 className="w-3.5 h-3.5" />
                Fit Whole Image
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRotate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold text-[#24292E] dark:text-[#EDE9DF] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" />
                Rotate 90°
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettings(DEFAULT_FRAME);
                  setApplyWatercolorOnSave(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2] hover:text-[#24292E] dark:hover:text-[#EDE9DF] cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>
          </div>

          {/* Zoom / Resize Slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-[#5C646B] dark:text-[#A4AEC2]">
              <span>Image Size / Zoom</span>
              <span className="font-mono tabular-nums text-[#24292E] dark:text-[#EDE9DF]">
                {Math.round(settings.zoom * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    zoom: Math.max(0.5, Number((prev.zoom - 0.1).toFixed(2))),
                  }))
                }
                className="p-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] cursor-pointer"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <input
                type="range"
                min={0.5}
                max={2.5}
                step={0.05}
                value={settings.zoom}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    zoom: Number(e.target.value),
                  }))
                }
                className="flex-1 accent-[#2F7A5E] dark:accent-[#E5A94C]"
              />
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    zoom: Math.min(2.5, Number((prev.zoom + 0.1).toFixed(2))),
                  }))
                }
                className="p-1.5 rounded-lg border border-[#D8D1C4] dark:border-[#34405E] text-[#5C646B] dark:text-[#A4AEC2] hover:bg-[#F3EFE8] dark:hover:bg-[#232B42] cursor-pointer"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Optional Watercolor Finish + Footer Actions */}
          <div className="pt-3 border-t border-[#E6E1D8] dark:border-[#2A324B] flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[#24292E] dark:text-[#EDE9DF] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyWatercolorOnSave}
                onChange={(e) => setApplyWatercolorOnSave(e.target.checked)}
                className="w-4 h-4 rounded accent-[#2F7A5E] dark:accent-[#E5A94C]"
              />
              <Paintbrush className="w-3.5 h-3.5 text-[#2F7A5E] dark:text-[#E5A94C]" />
              <span>Soften into watercolor paper finish</span>
            </label>

            <div className="flex items-center gap-2.5 ml-auto">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 rounded-xl border border-[#D8D1C4] dark:border-[#34405E] text-sm font-semibold text-[#5C646B] dark:text-[#A4AEC2] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isApplying}
                onClick={() => void handleApply()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#E5A94C] dark:hover:bg-[#D69738] text-white dark:text-[#121624] text-sm font-semibold transition-colors disabled:opacity-60 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                {isApplying ? 'Applying...' : 'Apply Crop & Frame'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
