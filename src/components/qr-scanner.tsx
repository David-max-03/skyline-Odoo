"use client";

import jsQR from "jsqr";
import { Camera, CameraOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Notice } from "./ui";

type ScannerState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "scanning" }
  | { phase: "error"; message: string };

function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow it in the browser's site settings, or type the code below.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device. Type the ticket code below instead.";
  }
  if (name === "NotReadableError") {
    return "The camera is in use by another app. Close it and try again, or type the code below.";
  }
  return "The camera could not be started. Type the ticket code below instead.";
}

/**
 * Reads QR codes from the device camera and calls `onScan` with the decoded
 * text. The same code is not reported twice within three seconds, so holding
 * a ticket in front of the camera does not fire repeatedly.
 */
export function QrScanner({ onScan }: { onScan: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const onScanRef = useRef(onScan);
  const [state, setState] = useState<ScannerState>({ phase: "idle" });

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState({ phase: "idle" });
  }, []);

  const start = useCallback(async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState({
        phase: "error",
        message: "Camera scanning needs HTTPS (or localhost). Type the ticket code below instead.",
      });
      return;
    }
    setState({ phase: "starting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      setState({ phase: "scanning" });
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setState({ phase: "error", message: describeCameraError(error) });
    }
  }, []);

  // Decode loop: sample the video a few times a second while scanning.
  useEffect(() => {
    if (state.phase !== "scanning") return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || !context || video.readyState < 2 || video.videoWidth === 0) return;
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (!found?.data) return;
      const nowMs = Date.now();
      if (found.data === lastRef.current.text && nowMs - lastRef.current.at < 3000) return;
      lastRef.current = { text: found.data, at: nowMs };
      onScanRef.current(found.data);
    }, 160);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  // Release the camera when the page is left.
  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  const active = state.phase === "scanning" || state.phase === "starting";

  return (
    <div>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-card bg-night sm:aspect-video">
        <video ref={videoRef} playsInline muted className="size-full object-cover" aria-label="Camera preview" />
        {state.phase === "scanning" && (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="size-[58%] max-h-64 max-w-64 rounded-2xl border-2 border-white/90 shadow-[0_0_0_100vmax_rgb(11_18_32/0.45)]" />
          </div>
        )}
        {!active && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <Camera className="size-8 text-on-night-muted" aria-hidden />
            <p className="text-sm text-on-night-muted">Point the camera at the QR code on a ticket.</p>
            <Button onClick={start} icon={Camera}>
              Start camera
            </Button>
          </div>
        )}
        {state.phase === "starting" && (
          <p role="status" className="absolute inset-x-0 bottom-3 text-center text-sm text-on-night">
            Starting camera…
          </p>
        )}
      </div>
      {state.phase === "scanning" && (
        <Button variant="ghost" size="sm" icon={CameraOff} className="mt-2" onClick={stop}>
          Stop camera
        </Button>
      )}
      {state.phase === "error" && (
        <Notice tone="warn" icon={CameraOff} className="mt-3">
          {state.message}
        </Notice>
      )}
    </div>
  );
}
