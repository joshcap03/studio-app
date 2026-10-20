"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// What the member shows the call: their screen or camera, started with a tap and kept on their
// device. Nothing leaves it until they ask the agent to look ("look at this", or Snap); then one
// frame, downscaled to a JPEG, goes along with their words as an attachment. The mock voice
// shares a labeled drawing instead, so QA needs no screen picker or camera.

export type ShareKind = "screen" | "camera";

/** Longest edge of a snapshot: enough to read a screen, small enough to send. */
const MAX_EDGE = 1600;

export interface Share {
  kind: ShareKind | null;
  /** Live stream, for the small preview. */
  stream: MediaStream | null;
  /** Why the last start or snapshot failed, in plain words. */
  problem: string | null;
  canScreen: boolean;
  canCamera: boolean;
  start(kind: ShareKind): Promise<void>;
  stop(): void;
  /** One frame of what's shared, as a JPEG file; null when nothing is shared or it failed. */
  snap(): Promise<File | null>;
}

/** Plain words for a share that didn't start. */
export function shareProblem(kind: ShareKind, error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return kind === "camera" ? "Studio couldn't use your camera. Allow it for this site, then try again." : "Sharing didn't start.";
  }
  if (name === "NotFoundError") return kind === "camera" ? "No camera found." : "Nothing to share was found.";
  return kind === "camera" ? "Couldn't start your camera." : "Couldn't share your screen.";
}

/** A snapshot's file name, as the member would read it in the thread: "Screen snapshot 14.02.jpg". */
export function snapshotName(kind: ShareKind, at: Date): string {
  const time = `${String(at.getHours()).padStart(2, "0")}.${String(at.getMinutes()).padStart(2, "0")}`;
  return `${kind === "camera" ? "Camera" : "Screen"} snapshot ${time}.jpg`;
}

/** Scales `width`×`height` down so the longest edge is at most MAX_EDGE. */
export function snapshotSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A labeled moving drawing standing in for a screen under the mock voice. */
function mockStream(kind: ShareKind): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    frame += 1;
    ctx.fillStyle = "#1f1d1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#c9a56a";
    ctx.font = "bold 44px sans-serif";
    ctx.fillText(`Mock ${kind === "camera" ? "camera" : "screen"} share`, 60, 120);
    ctx.fillStyle = "#e8e4dc";
    ctx.font = "28px sans-serif";
    ctx.fillText("Not your real screen: a stand-in for testing.", 60, 180);
    ctx.fillText(`Frame ${frame}`, 60, 240);
  };
  draw();
  const timer = setInterval(draw, 500);
  const stream = canvas.captureStream(2);
  return { stream, stop: () => clearInterval(timer) };
}

export function useShare({ mock }: { mock: boolean }): Share {
  const [kind, setKind] = useState<ShareKind | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const live = useRef<{ stream: MediaStream; stopMock?: () => void; kind: ShareKind } | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);

  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const canScreen = mock || typeof media?.getDisplayMedia === "function";
  const canCamera = mock || typeof media?.getUserMedia === "function";

  const stop = useCallback(() => {
    const current = live.current;
    live.current = null;
    current?.stream.getTracks().forEach((t) => t.stop());
    current?.stopMock?.();
    if (video.current) video.current.srcObject = null;
    setKind(null);
    setStream(null);
  }, []);

  const start = useCallback(
    async (next: ShareKind) => {
      stop();
      setProblem(null);
      try {
        let shared: MediaStream;
        let stopMock: (() => void) | undefined;
        if (mock) {
          const m = mockStream(next);
          shared = m.stream;
          stopMock = m.stop;
        } else if (next === "screen") {
          shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        } else {
          shared = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        }
        // The member can stop sharing from the browser's own bar too.
        shared.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (live.current?.stream === shared) stop();
        });
        live.current = { stream: shared, stopMock, kind: next };
        if (!video.current) {
          video.current = document.createElement("video");
          video.current.muted = true;
          video.current.playsInline = true;
        }
        video.current.srcObject = shared;
        await video.current.play().catch(() => undefined);
        setKind(next);
        setStream(shared);
      } catch (error) {
        setProblem(shareProblem(next, error));
      }
    },
    [mock, stop],
  );

  const snap = useCallback(async (): Promise<File | null> => {
    const current = live.current;
    const v = video.current;
    if (!current || !v) return null;
    try {
      if (v.readyState < 2) await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
      const size = snapshotSize(v.videoWidth, v.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext("2d")!.drawImage(v, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
      if (!blob) throw new Error("no frame");
      return new File([blob], snapshotName(current.kind, new Date()), { type: "image/jpeg" });
    } catch {
      setProblem("Couldn't take a snapshot.");
      return null;
    }
  }, []);

  // Sharing ends with the call.
  useEffect(() => stop, [stop]);

  return { kind, stream, problem, canScreen, canCamera, start, stop, snap };
}
