/** One-shot camera TCC prompt — stops tracks immediately; preview lives in the bubble window. */
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
