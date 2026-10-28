// Captures the microphone, downsamples to 16-bit PCM @ 16kHz mono (the
// format Gemini Live expects for realtime audio input), and hands base64
// chunks to the caller to send over the WebSocket.

export interface MicrophoneHandle {
  stop: () => void;
}

const TARGET_SAMPLE_RATE = 16000;

export async function startMicrophoneCapture(
  onChunk: (base64Pcm16: string) => void
): Promise<MicrophoneHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);

  // ScriptProcessorNode is deprecated but universally supported and simple
  // enough for this POC; an AudioWorklet would need a separately loaded
  // module file for no real benefit here.
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const inputSampleRate = audioContext.sampleRate;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = downsample(input, inputSampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPCM(resampled);
    onChunk(arrayBufferToBase64(pcm16.buffer));
  };

  // The processor must be connected to a destination to run in all browsers;
  // we never write to the output buffer, so it stays silent (no feedback).
  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}

function downsample(input: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (targetRate === inputRate) return input;
  const ratio = inputRate / targetRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    output[i] = input[Math.floor(i * ratio)];
  }
  return output;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
