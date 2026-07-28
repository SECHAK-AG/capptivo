/**
 * One-shot camera TCC prompt for the recorder WebView.
 * Stops tracks immediately — the face-cam bubble owns the real preview stream.
 */
export async function probeCameraPermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true,
    });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}
