#!/usr/bin/env python3
"""
motion_analysis.py — Compute per-frame motion energy across a video.

Reads every Nth frame via FFmpeg (handles H.265/HEVC GoPro footage),
computes mean absolute pixel difference from the previous sampled frame,
and outputs a JSON array of {t, e} samples.

Usage:
    python3 motion_analysis.py <video_path> <output_json> [sample_every_n_frames]
"""

import json
import subprocess
import sys
import numpy as np

RESIZE_WIDTH = 320
RESIZE_HEIGHT = 180


def get_video_info(video_path: str) -> dict:
    """Use ffprobe to get fps, total frames, and duration."""
    cmd = [
        'ffprobe', '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate,nb_frames,duration',
        '-of', 'json',
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    info = json.loads(result.stdout)['streams'][0]

    # r_frame_rate is a fraction string like "60000/1001"
    num, den = info['r_frame_rate'].split('/')
    fps = float(num) / float(den)

    duration = float(info.get('duration', 0))
    total_frames = int(info.get('nb_frames', round(fps * duration)))

    return {'fps': fps, 'total_frames': total_frames, 'duration': duration}


def analyze_motion(video_path: str, output_path: str, sample_every: int = 3) -> None:
    info = get_video_info(video_path)
    fps = info['fps']
    total_frames = info['total_frames']
    duration = info['duration']

    print(f"[motion_analysis] {video_path}", file=sys.stderr)
    print(f"[motion_analysis] {fps:.1f} fps | {total_frames} frames | {duration:.1f}s", file=sys.stderr)

    # Pipe raw frames from FFmpeg — works with H.265/HEVC GoPro footage
    cmd = [
        'ffmpeg', '-v', 'error',
        '-i', video_path,
        '-vf', f'scale={RESIZE_WIDTH}:{RESIZE_HEIGHT}',
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
        'pipe:1',
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    frame_size = RESIZE_WIDTH * RESIZE_HEIGHT
    samples = []
    prev_gray = None
    frame_idx = 0

    while True:
        raw = proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            break

        if frame_idx % sample_every == 0:
            gray = np.frombuffer(raw, dtype=np.uint8).reshape((RESIZE_HEIGHT, RESIZE_WIDTH))

            if prev_gray is not None:
                diff = np.abs(gray.astype(np.int16) - prev_gray.astype(np.int16))
                energy = float(np.mean(diff))
                timestamp = round(frame_idx / fps, 3)
                samples.append({"t": timestamp, "e": round(energy, 4)})

            prev_gray = gray

        frame_idx += 1

        if frame_idx % 900 == 0:
            pct = (frame_idx / total_frames) * 100
            print(f"[motion_analysis] {pct:.0f}%", file=sys.stderr, flush=True)

    proc.stdout.close()
    proc.wait()

    if not samples:
        print(f"[motion_analysis] ERROR: No frames read from {video_path}", file=sys.stderr)
        sys.exit(1)

    result = {
        "fps": fps,
        "total_frames": total_frames,
        "duration": round(duration, 3),
        "sample_every": sample_every,
        "samples": samples,
    }

    with open(output_path, "w") as f:
        json.dump(result, f)

    print(f"[motion_analysis] Done — {len(samples)} samples written to {output_path}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: motion_analysis.py <video_path> <output_json> [sample_every_n]", file=sys.stderr)
        sys.exit(1)

    n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    analyze_motion(sys.argv[1], sys.argv[2], n)
