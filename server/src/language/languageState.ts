import { INITIAL_LANGUAGE, LanguageCode, MAX_SEGMENT_HISTORY } from "./languageConfig.js";

export interface LanguageUtterance {
  text: string;
  language: LanguageCode;
  timestamp: number;
}

export interface LanguageState {
  currentLanguage: LanguageCode;
  segmentHistory: LanguageUtterance[];
  lastSwitchTimestamp: number;
}

export function createInitialLanguageState(): LanguageState {
  return {
    currentLanguage: INITIAL_LANGUAGE,
    segmentHistory: [],
    lastSwitchTimestamp: Date.now(),
  };
}

export function trimHistory(history: LanguageUtterance[]): LanguageUtterance[] {
  return history.slice(-MAX_SEGMENT_HISTORY);
}
