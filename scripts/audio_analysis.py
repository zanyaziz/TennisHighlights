#!/usr/bin/env python3
"""
audio_analysis.py — Detect tennis point boundaries via audio onset detection.

Ball impacts (racket hits) produce sharp transients that stand out clearly
from ambient noise. This script finds those impacts, clusters them into
points, and outputs a segment list.

Algorithm:
  1. Extract mono audio via FFmpeg (handles any codec including H.265).
  2. Compute onset strength envelope with librosa.
  3. Detect onset frames (backtrack to the precise attack).
  4. Cluster onsets separated by ≤ gap_threshold into one point.
  5. Discard clusters shorter than min_duration (not a real point).
  6. Extend each cluster end by post_buffer seconds.

Usage:
    python3 audio_analysis.py <video_path> <output_json>
                              [gap_threshold] [min_duration] [post_buffer]
"""

import json
import subprocess
import sys
import numpy as np

try:
    import librosa
except ImportError:
    print("[audio_analysis] ERROR: librosa not installed. Run: pip install librosa", file=sys.stderr)
    sys.exit(1)

SAMPLE_RATE = 22050


def extract_audio(video_path: str) -> np.ndarray:
    """Pipe audio from FFmpeg as raw float32 mono samples."""
    cmd = [
        'ffmpeg', '-v', 'error',
        '-i', video_path,
        '-vn',                    # no video
        '-ac', '1',               # mono
        '-ar', str(SAMPLE_RATE),
        '-f', 'f32le',            # raw 32-bit float little-endian
        'pipe:1',
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        print(f"[audio_analysis] ERROR: FFmpeg failed: {proc.stderr.decode()}", file=sys.stderr)
        sys.exit(1)

    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    return audio


def detect_points(
    video_path: str,
    output_path: str,
    gap_threshold: float = 5.0,
    min_duration: float = 3.0,
    post_buffer: float = 1.5,
    onset_percentile: float = 85.0,
    calibration_window: float = 60.0,
    noise_multiplier: float = 3.0,
) -> None:

    print(f"[audio_analysis] Extracting audio from {video_path}", file=sys.stderr)
    audio = extract_audio(video_path)
    duration = len(audio) / SAMPLE_RATE
    print(f"[audio_analysis] {duration:.1f}s of audio loaded ({len(audio)} samples)", file=sys.stderr)

    # Onset strength envelope — captures burstiness of ball impacts
    hop_length = 512
    onset_env = librosa.onset.onset_strength(
        y=audio,
        sr=SAMPLE_RATE,
        hop_length=hop_length,
        aggregate=np.median,
    )
    frames_per_sec = SAMPLE_RATE / hop_length  # ~43 fps at sr=22050, hop=512

    # Smooth the onset envelope over ~2s to bridge gaps within a rally.
    # During play: many impacts per second → smoothed energy stays high.
    # Between points (20-25s silence): smoothed energy drops to near zero.
    smooth_frames = max(1, int(2.0 * frames_per_sec))
    smoothed = np.convolve(onset_env, np.ones(smooth_frames) / smooth_frames, mode='same')

    # ── Adaptive noise floor calibration ─────────────────────────────────────
    # Use the first `calibration_window` seconds (pre-play/warmup silence) to
    # measure the background noise level for this specific recording.
    # Threshold = noise_floor + noise_multiplier × noise_std
    # This adapts automatically to indoor/outdoor, crowd size, mic position.
    threshold = None
    calib_frames = int(calibration_window * frames_per_sec)
    if calib_frames >= 10 and calib_frames < len(smoothed):
        calib = smoothed[:calib_frames]
        noise_floor = float(np.median(calib))
        noise_std   = float(np.std(calib))
        adaptive    = noise_floor + noise_multiplier * noise_std
        # Sanity check: adaptive threshold must be above the noise floor
        # and below the global 99th percentile (avoids calibrating on a noisy start)
        ceiling = float(np.percentile(smoothed, 99))
        if noise_std > 0 and adaptive < ceiling:
            threshold = adaptive
            print(
                f"[audio_analysis] Noise floor: {noise_floor:.4f} ± {noise_std:.4f}  "
                f"→ threshold: {threshold:.4f} (calibrated from first {calibration_window:.0f}s)",
                file=sys.stderr,
            )

    if threshold is None:
        # Fallback: fixed global percentile
        threshold = float(np.percentile(smoothed, onset_percentile))
        print(
            f"[audio_analysis] Onset energy threshold: {threshold:.4f} "
            f"({onset_percentile:.0f}th pct, fallback)",
            file=sys.stderr,
        )

    # Segment: mark each frame as active/inactive, then apply inactivity timeout
    inactivity_frames = int(gap_threshold * frames_per_sec)
    min_duration_frames = int(min_duration * frames_per_sec)

    segments = []
    in_active = False
    seg_start_frame = 0
    last_active_frame = 0

    for fi, val in enumerate(smoothed):
        if val >= threshold:
            if not in_active:
                seg_start_frame = fi
                in_active = True
            last_active_frame = fi
        elif in_active:
            if fi - last_active_frame >= inactivity_frames:
                if last_active_frame - seg_start_frame >= min_duration_frames:
                    t_start = seg_start_frame / frames_per_sec
                    t_end   = last_active_frame / frames_per_sec + post_buffer
                    segments.append({
                        'start': round(t_start, 3),
                        'end':   round(min(t_end, duration), 3),
                    })
                in_active = False

    # Close any still-open segment
    if in_active and last_active_frame - seg_start_frame >= min_duration_frames:
        t_start = seg_start_frame / frames_per_sec
        t_end   = last_active_frame / frames_per_sec + post_buffer
        segments.append({
            'start': round(t_start, 3),
            'end':   round(min(t_end, duration), 3),
        })

    result = {
        'duration': round(duration, 3),
        'onset_count': int(np.sum(smoothed >= threshold)),
        'segments': segments,
    }

    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2)

    print(f"[audio_analysis] {len(segments)} point segment(s) → {output_path}", file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: audio_analysis.py <video_path> <output_json> "
              "[gap_threshold] [min_duration] [post_buffer]", file=sys.stderr)
        sys.exit(1)

    kwargs = {}
    if len(sys.argv) > 3: kwargs['gap_threshold']      = float(sys.argv[3])
    if len(sys.argv) > 4: kwargs['min_duration']       = float(sys.argv[4])
    if len(sys.argv) > 5: kwargs['post_buffer']        = float(sys.argv[5])
    if len(sys.argv) > 6: kwargs['onset_percentile']   = float(sys.argv[6])
    if len(sys.argv) > 7: kwargs['calibration_window'] = float(sys.argv[7])
    if len(sys.argv) > 8: kwargs['noise_multiplier']   = float(sys.argv[8])

    detect_points(sys.argv[1], sys.argv[2], **kwargs)
