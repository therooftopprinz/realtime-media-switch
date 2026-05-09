/**
 * Opus path uses WebCodecs AudioEncoder / AudioDecoder (48 kHz mono, 5 ms frames target).
 */
export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_CHANNELS = 1;
/** Target frame duration in microseconds (5 ms). */
export const OPUS_FRAME_DURATION_US = 5000;

/**
 * @param {AudioEncoder} enc
 * @param {AudioData} audioData
 */
export function encodeAudioFrame(enc, audioData) {
  enc.encode(audioData);
  audioData.close();
}
