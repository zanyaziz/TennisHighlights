#!/usr/bin/env python3
"""
serve_detection.py — Find the exact serve start frame for each play segment.

For each segment, scans backward through the preceding quiet period looking for
the ball toss: either wrist elevated above the shoulder (MediaPipe Pose).
Falls back to segment start if MediaPipe is unavailable or pose not detected.

Camera assumption: GoPro mounted behind the baseline. The server appears near
the bottom-centre of the frame. MediaPipe works well with back-facing poses.

Usage:
    python3 serve_detection.py <video_path> <segments.json> <output.json>
                               [search_window_secs] [min_wrist_rise_frames] [wrist_threshold]
"""

import cv2
import json
import sys

# ── Try to import MediaPipe ──────────────────────────────────────────────────
try:
    import mediapipe as mp
    _mp_pose = mp.solutions.pose
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False
    print("[serve_detection] WARNING: mediapipe not installed — using motion-onset fallback.", file=sys.stderr)
    print("[serve_detection] Install with:  pip3 install mediapipe", file=sys.stderr)


def detect_serves(
    video_path: str,
    segments: list,
    output_path: str,
    search_window: float = 8.0,
    min_rise_frames: int = 3,
    wrist_threshold: float = 0.08,
) -> None:

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[serve_detection] ERROR: Cannot open {video_path}", file=sys.stderr)
        sys.exit(1)

    actual_fps = cap.get(cv2.CAP_PROP_FPS)
    results = []

    pose_ctx = None
    if HAS_MEDIAPIPE:
        pose_ctx = _mp_pose.Pose(
            min_detection_confidence=0.4,
            min_tracking_confidence=0.4,
            model_complexity=0,   # 0 = fastest (Lite), good enough for serve detection
        )

    for seg in segments:
        seg_start: float = seg["start"]
        seg_end: float = seg["end"]

        # Scan window: from (seg_start - search_window) up to seg_start
        scan_start = max(0.0, seg_start - search_window)
        scan_start_frame = int(scan_start * actual_fps)
        scan_end_frame = int(seg_start * actual_fps)

        serve_frame = None

        if pose_ctx is not None:
            cap.set(cv2.CAP_PROP_POS_FRAMES, scan_start_frame)

            # Track the most recent ball-toss gesture found in the scan window.
            # We want the LAST one before the segment starts (closest to the rally).
            wrist_rise_start_frame = None
            last_serve_frame = None

            for fi in range(scan_start_frame, scan_end_frame + 1):
                ret, frame = cap.read()
                if not ret:
                    break

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = pose_ctx.process(rgb)

                if res.pose_landmarks:
                    lm = res.pose_landmarks.landmark
                    PL = _mp_pose.PoseLandmark

                    rw = lm[PL.RIGHT_WRIST]
                    lw = lm[PL.LEFT_WRIST]
                    rs = lm[PL.RIGHT_SHOULDER]
                    ls = lm[PL.LEFT_SHOULDER]

                    # In MediaPipe, y is 0 at TOP → smaller y = higher on screen.
                    # Wrist raised = wrist.y < shoulder.y - threshold
                    r_raised = rw.y < rs.y - wrist_threshold
                    l_raised = lw.y < ls.y - wrist_threshold

                    if r_raised or l_raised:
                        if wrist_rise_start_frame is None:
                            wrist_rise_start_frame = fi
                    else:
                        if wrist_rise_start_frame is not None:
                            rise_duration = fi - wrist_rise_start_frame
                            if rise_duration >= min_rise_frames:
                                last_serve_frame = wrist_rise_start_frame
                            wrist_rise_start_frame = None

            # If wrist was still raised at scan window end
            if wrist_rise_start_frame is not None:
                rise_duration = scan_end_frame - wrist_rise_start_frame
                if rise_duration >= min_rise_frames:
                    last_serve_frame = wrist_rise_start_frame

            serve_frame = last_serve_frame

        # Convert frame → timestamp
        if serve_frame is not None:
            serve_time = round(serve_frame / actual_fps, 3)
            detected = True
        else:
            serve_time = round(seg_start, 3)
            detected = False

        status = "✓ detected" if detected else "→ fallback to segment start"
        print(
            f"[serve_detection] Seg {seg_start:.1f}s–{seg_end:.1f}s  serve={serve_time:.1f}s  {status}",
            file=sys.stderr,
        )

        results.append({
            "segment_start": round(seg_start, 3),
            "segment_end": round(seg_end, 3),
            "serve_time": serve_time,
            "detected": detected,
        })

    if pose_ctx:
        pose_ctx.close()
    cap.release()

    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)

    detected_count = sum(1 for r in results if r["detected"])
    print(
        f"[serve_detection] Done — {detected_count}/{len(results)} serves detected via MediaPipe",
        file=sys.stderr,
    )


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: serve_detection.py <video> <segments.json> <output.json>", file=sys.stderr)
        sys.exit(1)

    kwargs = {}
    if len(sys.argv) > 4: kwargs["search_window"] = float(sys.argv[4])
    if len(sys.argv) > 5: kwargs["min_rise_frames"] = int(sys.argv[5])
    if len(sys.argv) > 6: kwargs["wrist_threshold"] = float(sys.argv[6])

    with open(sys.argv[2]) as f:
        segs = json.load(f)

    detect_serves(sys.argv[1], segs, sys.argv[3], **kwargs)
