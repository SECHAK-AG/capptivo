/** Face-cam bubble — setup preview and in-record capture (`cameraCapture.ts`). */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { bindCameraCaptureApi, ensureCameraCaptureSubscribed } from "./cameraCapture";
import { CAMERA_CAPTURE_FPS } from "../recorder/captureFps";

const DEVICE_EVENT = "camera://device";
const REVIVE_EVENT = "camera://revive";

function deviceFromUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get("device");
  return id && id.length > 0 ? id : null;
}

function streamIsLive(stream: MediaStream | null, video: HTMLVideoElement | null): boolean {
  if (!stream?.active) return false;
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return false;
  if (video && video.videoWidth === 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }
  return true;
}

export function CameraApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deviceRef = useRef<string | null>(deviceFromUrl());
  const openingRef = useRef<Promise<MediaStream | null> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reopen = async (
    deviceId: string,
    opts?: { force?: boolean },
  ): Promise<MediaStream | null> => {
    if (openingRef.current) return openingRef.current;

    if (
      !opts?.force &&
      deviceRef.current === deviceId &&
      streamIsLive(streamRef.current, videoRef.current)
    ) {
      return streamRef.current;
    }

    openingRef.current = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: CAMERA_CAPTURE_FPS, max: CAMERA_CAPTURE_FPS },
          },
        });
        const prev = streamRef.current;
        streamRef.current = stream;
        deviceRef.current = deviceId;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        for (const track of stream.getVideoTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (streamRef.current !== stream) return;
              const id = deviceRef.current;
              if (id) void reopen(id, { force: true });
            },
            { once: true },
          );
        }
        if (prev) for (const t of prev.getTracks()) t.stop();
        setError(null);
        return stream;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Camera unavailable");
        return null;
      } finally {
        openingRef.current = null;
      }
    })();

    return openingRef.current;
  };

  useLayoutEffect(() => {
    ensureCameraCaptureSubscribed();
    bindCameraCaptureApi({
      getDeviceId: () => deviceRef.current,
      getVideo: () => videoRef.current,
      // Unforced: a live preview stream is reused as-is. Re-acquiring on the
      // record path costs face-cam frames the screen track already has, and a
      // genuinely dead stream still reopens — `reopen` checks liveness, and the
      // track's `ended` handler covers a stream that dies mid-take.
      ensureStream: (deviceId) => reopen(deviceId),
    });
    const initial = deviceFromUrl();
    if (initial) void reopen(initial, { force: true });

    return () => {
      bindCameraCaptureApi(null);
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) for (const t of stream.getTracks()) t.stop();
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    const unlistenDevice = listen<string>(DEVICE_EVENT, (e) => {
      if (alive && e.payload) void reopen(e.payload);
    });
    const unlistenRevive = listen(REVIVE_EVENT, () => {
      const id = deviceRef.current;
      if (alive && id) void reopen(id, { force: true });
    });
    return () => {
      alive = false;
      void unlistenDevice.then((fn) => fn());
      void unlistenRevive.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="box-border h-full w-full cursor-grab bg-transparent p-1.5 active:cursor-grabbing"
    >
      <div className="pointer-events-none relative h-full w-full overflow-hidden rounded-2xl bg-neutral-900 ring-1 ring-white/25">
        <video
          ref={videoRef}
          className="h-full w-full scale-x-[-1] object-cover"
          muted
          playsInline
          autoPlay
        />
        {error ? (
          <p className="absolute inset-0 flex items-center justify-center bg-black/80 p-3 text-center text-[11px] text-white/80">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
