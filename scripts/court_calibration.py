#!/usr/bin/env python3
"""
court_calibration.py — One-time tool to define your court boundary.

Extracts a reference frame from a video, displays it, and lets you click
the corners of YOUR court. Saves the boundary as court_mask.json which is
reused for all videos from the same camera position.

This mask tells motion_analysis.py to only measure movement inside your court,
filtering out players on adjacent courts visible in the background.

Usage:
    python3 scripts/court_calibration.py <video_path> [output_json]

Controls:
    Left click  — place a corner (click all 4 corners of your court)
    Right click — undo last corner
    Enter/Space — confirm and save
    Escape      — cancel without saving
    R           — reset all corners
"""

import cv2
import json
import subprocess
import sys
import numpy as np
import os

DEFAULT_OUTPUT = 'court_mask.json'
DISPLAY_WIDTH  = 1280   # scale frame to this width for display
POINT_COLOR    = (0, 255, 0)
LINE_COLOR     = (0, 255, 0)
FILL_COLOR     = (0, 255, 0)
TEXT_COLOR     = (255, 255, 255)
SHADOW_COLOR   = (0, 0, 0)


def get_video_info(video_path: str) -> dict:
    cmd = [
        'ffprobe', '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration',
        '-of', 'json',
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    s = json.loads(result.stdout)['streams'][0]
    return {
        'width':    int(s['width']),
        'height':   int(s['height']),
        'duration': float(s.get('duration', 60)),
    }


def extract_frame(video_path: str, t: float, width: int, height: int) -> np.ndarray:
    cmd = [
        'ffmpeg', '-v', 'error',
        '-ss', str(t),
        '-i', video_path,
        '-frames:v', '1',
        '-f', 'rawvideo',
        '-pix_fmt', 'bgr24',
        'pipe:1',
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or len(proc.stdout) == 0:
        print(f"[calibration] ERROR: Could not extract frame at {t}s", file=sys.stderr)
        sys.exit(1)
    return np.frombuffer(proc.stdout, dtype=np.uint8).reshape((height, width, 3))


def draw_overlay(canvas: np.ndarray, points: list, scale: float) -> np.ndarray:
    """Draw current points and polygon onto the display canvas."""
    overlay = canvas.copy()

    if len(points) >= 2:
        pts = np.array([[int(x * scale), int(y * scale)] for x, y in points], dtype=np.int32)
        # Draw filled polygon with alpha if closed (4+ points)
        if len(points) >= 3:
            fill = canvas.copy()
            cv2.fillPoly(fill, [pts], FILL_COLOR)
            cv2.addWeighted(fill, 0.25, overlay, 0.75, 0, overlay)
        cv2.polylines(overlay, [pts], len(points) >= 4, LINE_COLOR, 2)

    for i, (x, y) in enumerate(points):
        px, py = int(x * scale), int(y * scale)
        cv2.circle(overlay, (px, py), 7, POINT_COLOR, -1)
        cv2.circle(overlay, (px, py), 7, (0, 0, 0), 2)
        label = str(i + 1)
        # shadow
        cv2.putText(overlay, label, (px + 11, py + 1), cv2.FONT_HERSHEY_SIMPLEX, 0.6, SHADOW_COLOR, 2)
        cv2.putText(overlay, label, (px + 10, py),     cv2.FONT_HERSHEY_SIMPLEX, 0.6, TEXT_COLOR,   2)

    # Instructions
    lines = [
        f"Points: {len(points)}/4",
        "Left click = add corner",
        "Right click = undo",
        "R = reset",
        "Enter/Space = save" if len(points) >= 3 else "Need at least 3 corners",
        "Esc = cancel",
    ]
    for i, line in enumerate(lines):
        y = 25 + i * 22
        cv2.putText(overlay, line, (11, y + 1), cv2.FONT_HERSHEY_SIMPLEX, 0.55, SHADOW_COLOR, 2)
        cv2.putText(overlay, line, (10, y),     cv2.FONT_HERSHEY_SIMPLEX, 0.55, TEXT_COLOR,   1)

    return overlay


def calibrate(video_path: str, output_path: str) -> None:
    print(f"[calibration] Extracting reference frame from {video_path} ...", file=sys.stderr)
    info = get_video_info(video_path)
    orig_w, orig_h = info['width'], info['height']
    duration = info['duration']

    # Extract a frame from 20% into the video (usually mid-warmup or early play)
    t = max(5.0, min(duration * 0.20, 60.0))
    frame = extract_frame(video_path, t, orig_w, orig_h)

    # Scale for display
    scale = DISPLAY_WIDTH / orig_w
    disp_w = int(orig_w * scale)
    disp_h = int(orig_h * scale)
    display_base = cv2.resize(frame, (disp_w, disp_h))

    # Stored as fractions of original resolution — works regardless of video size
    points = []   # list of (x_frac, y_frac)

    window = 'Court Calibration'
    cv2.namedWindow(window, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window, disp_w, disp_h)

    def on_mouse(event, x, y, flags, _):
        # Convert display coords → fractions
        x_frac = x / (disp_w * scale) if scale != 1 else x / disp_w
        y_frac = y / (disp_h * scale) if scale != 1 else y / disp_h
        # Simpler: display pixel → fraction of display → fraction of original
        x_frac = x / disp_w
        y_frac = y / disp_h
        if event == cv2.EVENT_LBUTTONDOWN:
            points.append((x_frac, y_frac))
        elif event == cv2.EVENT_RBUTTONDOWN and points:
            points.pop()

    cv2.setMouseCallback(window, on_mouse)
    print("[calibration] Window opened. Click the 4 corners of your court.", file=sys.stderr)
    print("[calibration] Go clockwise: top-left → top-right → bottom-right → bottom-left", file=sys.stderr)

    while True:
        canvas = draw_overlay(display_base.copy(), points, 1.0)
        cv2.imshow(window, canvas)
        key = cv2.waitKey(30) & 0xFF

        if key == 27:   # Escape
            print("[calibration] Cancelled.", file=sys.stderr)
            cv2.destroyAllWindows()
            sys.exit(0)

        elif key in (13, 32) and len(points) >= 3:  # Enter or Space
            break

        elif key == ord('r') or key == ord('R'):
            points.clear()

    cv2.destroyAllWindows()

    # Save mask as fractional coordinates + original resolution metadata
    data = {
        'video_width':  orig_w,
        'video_height': orig_h,
        'points': [[x, y] for x, y in points],
    }
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"[calibration] Saved {len(points)}-point court mask → {output_path}", file=sys.stderr)
    print(f"[calibration] Set courtMaskPath: '{output_path}' in config.js to activate.", file=sys.stderr)

    # Quick visual confirmation — show the mask on the original frame
    pts_px = np.array([[int(x * orig_w), int(y * orig_h)] for x, y in points], dtype=np.int32)
    mask = np.zeros((orig_h, orig_w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts_px], 255)
    masked = frame.copy()
    masked[mask == 0] = (masked[mask == 0] * 0.35).astype(np.uint8)
    preview = cv2.resize(masked, (disp_w, disp_h))
    cv2.imshow('Court Mask Preview (press any key to close)', preview)
    cv2.waitKey(0)
    cv2.destroyAllWindows()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: court_calibration.py <video_path> [output_json]", file=sys.stderr)
        print("       output_json defaults to court_mask.json", file=sys.stderr)
        sys.exit(1)

    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT
    calibrate(sys.argv[1], out)
