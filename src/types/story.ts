export type AgeGroup = '2-3' | '4-5';

export type CharacterReaction = 'bounce' | 'wiggle' | 'sparkle';

export type AvatarId = 'duck' | 'bear' | 'firefly' | 'fox';

export type BackdropId =
  | 'pond'
  | 'forest'
  | 'twilight'
  | 'bridge'
  | 'meadow'
  | 'cottage'
  | 'starlight'
  | 'brook';

export interface CharacterHotspot {
  id: string;
  name: string;
  x: number; // Percentage 15-85
  y: number; // Percentage 15-85
  dialogue: string;
  soundCue: 'splash' | 'chime' | 'giggle' | 'chirp' | 'twinkle';
  reaction: CharacterReaction;
}

export interface StoryPage {
  id: string;
  text: string;
  sceneSummary: string;
  imageUrl?: string; // Static asset path for curated stories
  mediaId?: string; // IndexedDB media key for parent-scanned stories
  visualMode?: 'photo' | 'watercolor' | 'scene' | 'redraw';
  fallbackArtId?: BackdropId;
  hotspots: CharacterHotspot[];
}

export interface Story {
  id: string;
  title: string;
  subtitle: string;
  ageGroup: AgeGroup;
  moralTitle: string;
  moralLesson: string;
  parentDiscussionPrompt: string;
  coverImageUrl?: string;
  coverMediaId?: string;
  coverFallbackId: BackdropId;
  readMinutes: number;
  isCustom?: boolean;
  isPublished?: boolean;
  pages: StoryPage[];
  createdAtMs?: number;
}

export interface ChildProfile {
  id: string;
  ownerId?: string;
  name: string;
  ageGroup: AgeGroup;
  avatar: AvatarId;
  starsEarned: number;
  totalMinutesRead: number;
  storiesCompleted: number;
}

export interface BedtimeSettings {
  bedtimeEnabled: boolean;
  bedtimeDimness: number; // 0 to 60
  sleepTimerMinutes: number; // 0 = off, 10, 15, 20, 30
  maxStoriesPerSession: number; // 1 to 10
  calmVoiceDefault: boolean;
  ambientLullaby: boolean;
  reducedMotion: boolean;
}

export interface ReadingLogEntry {
  id: string;
  childId: string;
  storyId: string;
  storyTitle: string;
  moralTitle: string;
  durationSeconds: number;
  usedBedtimeMode: boolean;
  completedAtMs: number;
}

export type VoicePersonaId = 'warm' | 'lullaby' | 'playful' | 'fireside' | 'adventure';

export type ReadingSpeed = 0.8 | 1 | 1.15;

export type VoiceEngine = 'ai' | 'device';

export interface VoicePreferences {
  voiceEngine?: VoiceEngine;
  voicePersona: VoicePersonaId;
  readingSpeed: ReadingSpeed;
  autoRead: boolean;
}

export type AppView = 'library' | 'reader' | 'scanner' | 'parents';
