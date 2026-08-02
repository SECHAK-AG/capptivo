/** Microphone permission probe only.
 *
 * Recording narration is native (SCK / WASAPI / Pulse). Never open a lasting
 * getUserMedia audio session in the recorder WebView — on macOS that tears down
 * the camera bubble's AVFoundation session (black facecam).
 */

/** WebRTC voice processing off — on macOS, echo cancellation ducks other apps' audio. */
export const MIC_AUDIO_PROCESSING_OFF = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

/** One-shot mic TCC prompt when `enumerateDevices` returns unlabeled devices. */
export async function probeMicPermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...MIC_AUDIO_PROCESSING_OFF },
      video: false,
    });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}
