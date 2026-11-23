import { useEffect, useRef } from 'react';

interface StoryConfettiProps {
  triggerKey: number;
  isBedtime: boolean;
  reducedMotion: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  tiltAngle: number;
  tiltSpeed: number;
  color: string;
  shape: 'ribbon' | 'circle' | 'star';
  opacity: number;
  life: number;
  maxLife: number;
}

const DAYTIME_COLORS = [
  '#2F7A5E', // Woodland Sage
  '#D98A1C', // Honey Marigold
  '#E5A94C', // Warm Sunbeam
  '#C84B58', // Soft Berry
  '#4A8BB2', // Pond Cerulean
  '#7BA97B', // Meadow Leaf
  '#F2C97D', // Buttercup
];

const BEDTIME_COLORS = [
  '#E5A94C', // Candlelight Amber
  '#5CA49B', // Twilight Teal
  '#F4D58D', // Soft Starlight
  '#9AB4D6', // Moonlit Blue
  '#EDE9DF', // Moonbeam Cream
];

function drawStar(ctx: CanvasRenderingContext2D, radius: number) {
  const spikes = 5;
  const innerRadius = radius * 0.46;
  let rot = (Math.PI / 2) * 3;
  const step = Math.PI / spikes;

  ctx.beginPath();
  ctx.moveTo(0, -radius);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(Math.cos(rot) * radius, Math.sin(rot) * radius);
    rot += step;
    ctx.lineTo(Math.cos(rot) * innerRadius, Math.sin(rot) * innerRadius);
    rot += step;
  }
  ctx.closePath();
  ctx.fill();
}

export function StoryConfetti({
  triggerKey,
  isBedtime,
  reducedMotion,
}: StoryConfettiProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (triggerKey <= 0) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || prefersReduced) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const width = window.innerWidth;
    const height = window.innerHeight;
    const palette = isBedtime ? BEDTIME_COLORS : DAYTIME_COLORS;
    const count = isBedtime ? 58 : 105;
    const particles: Particle[] = [];

    // Launch balanced celebratory plumes from left, center-top, and right
    const origins = [
      { x: width * 0.22, y: height * 0.32, angleCenter: -Math.PI / 2.6 },
      { x: width * 0.5, y: height * 0.24, angleCenter: -Math.PI / 2 },
      { x: width * 0.78, y: height * 0.32, angleCenter: -Math.PI + Math.PI / 2.6 },
    ];

    for (let i = 0; i < count; i++) {
      const origin = origins[i % origins.length];
      const spread = 1.15;
      const angle = origin.angleCenter + (Math.random() - 0.5) * spread;
      const speedBase = isBedtime ? 3.2 : 5.4;
      const speed = speedBase + Math.random() * (isBedtime ? 3.8 : 6.2);
      const shapeRoll = Math.random();
      const shape: Particle['shape'] =
        shapeRoll < 0.24 ? 'star' : shapeRoll < 0.45 ? 'circle' : 'ribbon';

      particles.push({
        x: origin.x + (Math.random() - 0.5) * 48,
        y: origin.y + (Math.random() - 0.5) * 24,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (isBedtime ? 0.6 : 1.8),
        size: shape === 'star' ? 6 + Math.random() * 5 : 5 + Math.random() * 6,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * (isBedtime ? 0.08 : 0.16),
        tiltAngle: Math.random() * Math.PI * 2,
        tiltSpeed: 0.05 + Math.random() * 0.08,
        color: palette[Math.floor(Math.random() * palette.length)],
        shape,
        opacity: 1,
        life: 0,
        maxLife: isBedtime ? 185 + Math.random() * 55 : 165 + Math.random() * 55,
      });
    }

    let rafId = 0;
    const gravity = isBedtime ? 0.065 : 0.135;
    const drag = 0.986;

    const frame = () => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      let aliveCount = 0;

      for (const p of particles) {
        p.life += 1;
        if (p.life >= p.maxLife || p.y > window.innerHeight + 40) continue;
        aliveCount += 1;

        p.vx *= drag;
        p.vy = p.vy * drag + gravity;
        p.x += p.vx + Math.sin(p.tiltAngle) * 0.55;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        p.tiltAngle += p.tiltSpeed;

        const fadeStart = p.maxLife * 0.68;
        p.opacity =
          p.life > fadeStart
            ? Math.max(0, 1 - (p.life - fadeStart) / (p.maxLife - fadeStart))
            : 1;

        ctx.save();
        ctx.globalAlpha = p.opacity * (isBedtime ? 0.85 : 0.95);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;

        if (p.shape === 'star') {
          drawStar(ctx, p.size);
        } else if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.55, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Paper confetti slip with soft flutter foreshortening
          const flutterScaleY = 0.35 + Math.abs(Math.cos(p.tiltAngle)) * 0.65;
          ctx.scale(1, flutterScaleY);
          const w = p.size * 1.35;
          const h = p.size * 0.72;
          ctx.beginPath();
          ctx.roundRect(-w / 2, -h / 2, w, h, 2);
          ctx.fill();
        }

        ctx.restore();
      }

      if (aliveCount > 0) {
        rafId = window.requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      }
    };

    rafId = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
  }, [triggerKey, isBedtime, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-50 pointer-events-none"
    />
  );
}
