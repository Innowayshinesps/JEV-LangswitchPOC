import { askJev, LanguageDecision } from "../jev/jevClient.js";
import { shouldSkipJev } from "./prefilter.js";
import { LanguageCode } from "./languageConfig.js";
import { LanguageState, trimHistory } from "./languageState.js";

export interface ProcessTimings {
  utteranceCompleteAt: number;
  jevRequestStartAt: number;
  jevResponseAt: number;
  stateUpdatedAt: number;
  jevLatencyMs: number;
  decisionLatencyMs: number;
  skippedJev: boolean;
}

export interface ProcessResult {
  decision: LanguageDecision;
  state: LanguageState;
  timings: ProcessTimings;
}

// context.md section 32: multiple JEV requests must not race and corrupt
// state. This manager processes utterances strictly one at a time per call,
// via a simple promise chain - sufficient for a single-connection POC.
export class LanguageSwitchManager {
  private state: LanguageState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(initialState: LanguageState) {
    this.state = initialState;
  }

  getState(): LanguageState {
    return this.state;
  }

  processUtterance(utterance: string): Promise<ProcessResult> {
    const run = () => this.processUtteranceInternal(utterance);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async processUtteranceInternal(utterance: string): Promise<ProcessResult> {
    const utteranceCompleteAt = Date.now();

    if (shouldSkipJev(utterance)) {
      this.appendToHistory(utterance, this.state.currentLanguage);
      const now = Date.now();
      return {
        decision: { languageChanged: false, newLanguage: null, reason: "prefiltered" },
        state: this.state,
        timings: {
          utteranceCompleteAt,
          jevRequestStartAt: now,
          jevResponseAt: now,
          stateUpdatedAt: now,
          jevLatencyMs: 0,
          decisionLatencyMs: now - utteranceCompleteAt,
          skippedJev: true,
        },
      };
    }

    const jevRequestStartAt = Date.now();
    const decision = await askJev(this.state.currentLanguage, this.state.segmentHistory, utterance);
    const jevResponseAt = Date.now();

    if (
      decision.languageChanged &&
      decision.newLanguage &&
      decision.newLanguage !== this.state.currentLanguage
    ) {
      this.state = {
        currentLanguage: decision.newLanguage,
        segmentHistory: [{ text: utterance, language: decision.newLanguage, timestamp: Date.now() }],
        lastSwitchTimestamp: Date.now(),
      };
    } else {
      this.appendToHistory(utterance, this.state.currentLanguage);
    }

    const stateUpdatedAt = Date.now();

    return {
      decision,
      state: this.state,
      timings: {
        utteranceCompleteAt,
        jevRequestStartAt,
        jevResponseAt,
        stateUpdatedAt,
        jevLatencyMs: jevResponseAt - jevRequestStartAt,
        decisionLatencyMs: stateUpdatedAt - utteranceCompleteAt,
        skippedJev: false,
      },
    };
  }

  private appendToHistory(utterance: string, language: LanguageCode) {
    this.state.segmentHistory = trimHistory([
      ...this.state.segmentHistory,
      { text: utterance, language, timestamp: Date.now() },
    ]);
  }
}
