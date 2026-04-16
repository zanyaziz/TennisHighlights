#!/usr/bin/env python3
"""
serve_detection.py — Find the precise serve start for each play segment.

Uses FFmpeg to pipe frames (handles H.265/HEVC GoPro footage), then applies
background subtraction + blob detection to locate the ball toss — an upward-
moving small blob in the pre-serve quiet window.

Falls back to segment start if the toss is not detected.

Camera assumption: GoPro mounted behind the baseline. The server appears near
the bottom-centre of the frame during their service game.

Usage:
    python3 serve_detection.py <video_path> <segments.json> <output.json>
                               [search_window_secs] [post_buffer]
"""

import json
import subprocess
import sys
from typing import Optional
import numpy as np
import cv2

FRAME_W = 320
FRAME_H = 180


def read_frames_ffmpeg(video_path: str, t_start: float, t_end: float):
    """Yield (frame_index, numpy BGR frame) for every frame in [t_start, t_end]."""
    duration = max(0.1, t_end - t_start)
    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(t_start),
        '-t',  str(duration),
        '-i',  video_path,
        '-vf', f'scale={FRAME_W}:{FRAME_H}',
        '-f',  'rawvideo',
        '-pix_fmt', 'bgr24',
        'pipe:1',
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_size = FRAME_W * FRAME_H * 3
    idx = 0
    while True:
        raw = proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape((FRAME_H, FRAME_W, 3))
        yield idx, frame
        idx += 1
    proc.stdout.close()
    proc.wait()


def detect_ball_toss(video_path: str, seg_start: float, search_window: float) -> Optional[float]:
    """
    Scan the quiet period before seg_start for a ball toss.

    Strategy:
      - Build a background model on the first ~2s (court is still).
      - Then track small foreground blobs frame-by-frame.
      - The ball toss = a small blob that moves upward (y decreasing) for
        several consecutive frames.

    Returns the timestamp of the toss start, or None if not found.
    """
    scan_start = max(0.0, seg_start - search_window)

    frames = list(read_frames_ffmpeg(video_path, scan_start, seg_start))
    if not frames:
        return None

    n_frames = len(frames)
    # Seed the background model on the first 20% of frames (quiet court)
    seed_count = max(1, n_frames // 5)

    subtractor = cv2.createBackgroundSubtractorMOG2(
        history=seed_count,
        varThreshold=40,
        detectShadows=False,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    # First pass: seed background
    for _, frame in frames[:seed_count]:
        subtractor.apply(frame, learningRate=0.5)

    # Second pass: detect blobs
    blob_tracks = []  # list of (frame_idx, cx, cy)

    for fi, frame in frames[seed_count:]:
        mask = subtractor.apply(frame, learningRate=0.01)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if 8 < area < 300:   # small blob — ball-sized at this resolution
                M = cv2.moments(cnt)
                if M['m00'] > 0:
                    cx = M['m10'] / M['m00']
                    cy = M['m01'] / M['m00']
                    blob_tracks.append((fi, cx, cy))

    if not blob_tracks:
        return None

    # Look for a run of frames where a small blob moves consistently upward
    # (cy decreasing = moving toward top of frame) over at least 4 frames.
    MIN_RISE_FRAMES = 4
    best_toss_fi = None

    for i in range(len(blob_tracks) - MIN_RISE_FRAMES):
        run = blob_tracks[i:i + MIN_RISE_FRAMES]
        frame_indices = [r[0] for r in run]
        cys = [r[2] for r in run]

        # Must be consecutive-ish frames (within 3 frames of each other)
        if frame_indices[-1] - frame_indices[0] > MIN_RISE_FRAMES + 3:
            continue

        # All y values must be decreasing (upward movement)
        if all(cys[j] > cys[j + 1] for j in range(len(cys) - 1)):
            best_toss_fi = frame_indices[0]
            # Don't break — take the last such run (closest to the serve)

    if best_toss_fi is None:
        return None

    # Convert local frame index back to absolute timestamp
    # frames list contains (original_fi, frame) but fi here is local to [seed_count:]
    # We need to map back: local fi → absolute time
    fps_estimate = n_frames / max(0.001, search_window)
    toss_time = scan_start + best_toss_fi / fps_estimate
    return round(toss_time, 3)


def detect_serves(
    video_path: str,
    segments: list,
    output_path: str,
    search_window: float = 8.0,
    post_buffer: float = 0.5,
) -> None:

    results = []

    for seg in segments:
        seg_start: float = seg['start']
        seg_end:   float = seg['end']

        toss_time = detect_ball_toss(video_path, seg_start, search_window)

        if toss_time is not None:
            serve_time = toss_time
            detected = True
        else:
            serve_time = round(seg_start, 3)
            detected = False

        status = '✓ toss detected' if detected else '→ fallback to segment start'
        print(
            f"[serve_detection] Seg {seg_start:.1f}s–{seg_end:.1f}s  "
            f"serve={serve_time:.1f}s  {status}",
            file=sys.stderr,
        )

        results.append({
            'segment_start': round(seg_start, 3),
            'segment_end':   round(seg_end, 3),
            'serve_time':    serve_time,
            'detected':      detected,
        })

    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)

    detected_count = sum(1 for r in results if r['detected'])
    print(
        f"[serve_detection] Done — {detected_count}/{len(results)} serves located via blob detection",
        file=sys.stderr,
    )


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: serve_detection.py <video> <segments.json> <output.json> "
              "[search_window] [post_buffer]", file=sys.stderr)
        sys.exit(1)

    kwargs = {}
    if len(sys.argv) > 4: kwargs['search_window'] = float(sys.argv[4])
    if len(sys.argv) > 5: kwargs['post_buffer']   = float(sys.argv[5])

    with open(sys.argv[2]) as f:
        segs = json.load(f)

    detect_serves(sys.argv[1], segs, sys.argv[3], **kwargs)
