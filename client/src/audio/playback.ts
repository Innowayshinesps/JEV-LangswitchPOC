// Queues incoming base64 PCM16 @ 24kHz chunks (Gemini Live's audio output
// format) and schedules them back-to-back so playback stays gapless.

// Hard-stopping a playing AudioBufferSourceNode (as flush() needs to, to cut
// off old-language audio on a switch) jumps the waveform straight to zero
// wherever it happened to be, which is an audible click/pop unless the
// amplitude is ramped down first. Symmetrically, starting a fresh source
// right after a flush can click on its way up if its first sample isn't
// near zero. Both get a very short (inaudible-as-a-fade) linear ramp.
const FADE_SECONDS = 0.008;

interface ScheduledChunk {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioPlaybackQueue {
  private audioContext: AudioContext;
  private nextStartTime = 0;
  private scheduled: ScheduledChunk[] = [];
  private fadeInNextChunk = false;

  constructor(private sampleRate = 24000) {
    this.audioContext = new AudioContext({ sampleRate });
  }

  enqueue(base64Pcm16: string): void {
    const pcm16 = base64ToInt16Array(base64Pcm16);
    const float32 = int16ToFloat32(pcm16);

    const buffer = this.audioContext.createBuffer(1, float32.length, this.sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.audioContext.destination);
    source.onended = () => {
      this.scheduled = this.scheduled.filter((chunk) => chunk.source !== source);
    };

    const now = this.audioContext.currentTime;
    const startAt = Math.max(now, this.nextStartTime);

    if (this.fadeInNextChunk) {
      this.fadeInNextChunk = false;
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + FADE_SECONDS);
    }

    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.scheduled.push({ source, gain });
  }

  // Immediately stops and discards anything queued or currently playing, and
  // resets the schedule so the next enqueue() starts right away. Used when a
  // language switch is confirmed, so any already-buffered old-language audio
  // gets cut instead of playing out before the new-language reply arrives.
  flush(): void {
    const now = this.audioContext.currentTime;
    for (const { source, gain } of this.scheduled) {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
        source.stop(now + FADE_SECONDS);
      } catch {
        // Already stopped/ended - fine to ignore.
      }
    }
    this.scheduled = [];
    this.nextStartTime = 0;
    this.fadeInNextChunk = true;
  }

  close(): void {
    void this.audioContext.close();
  }
}

function base64ToInt16Array(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function int16ToFloat32(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
  }
  return output;
}
