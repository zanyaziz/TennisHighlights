// ─── Tennis Highlights — Configuration ────────────────────────────────────────
// Tune these values to match your footage and court conditions.

export default {

  // ── Motion Detection ────────────────────────────────────────────────────────
  // How often to sample frames for motion (every N frames).
  // 3 = every 3rd frame at 30fps → ~10 samples/sec. Faster = more accurate, slower.
  motionSampleEveryNFrames: 3,

  // Mean pixel-diff energy (0–255) above which a frame is considered "active".
  // Increase if getting too many false positives (e.g. swaying trees).
  // Decrease if missing real play. Start here and tune after first run.
  motionThreshold: 1.0,

  // Smoothing window (in samples) applied to energy time-series to remove noise.
  smoothingWindow: 5,

  // A play segment must be at least this many seconds long to be considered a point.
  // Filters out brief motion blips (bird flying by, etc.)
  minPlayDuration: 2.0,

  // How many seconds of low motion before we declare a point has ended.
  // 2.5s works well for recreational play; increase if points are being split.
  inactivityTimeout: 2.5,

  // Max gap (seconds) between two motion segments to merge them into one point.
  // This handles fault + second serve: the brief stillness between the two serves
  // stays within one clip rather than being split.
  maxGapToMerge: 6.0,


  // ── Serve Detection ─────────────────────────────────────────────────────────
  // How many seconds before each motion segment to scan for the serve toss.
  // The serve starts in the "quiet" period before the rally motion spikes.
  serveSearchWindow: 8.0,

  // Minimum number of frames wrist must be elevated to count as a ball toss
  // (not just a brief arm swing). At 30fps, 3 = ~0.1s.
  serveMinWristRiseFrames: 3,

  // How far above the shoulder the wrist must be (MediaPipe normalized coords).
  // 0.08 = 8% of frame height above shoulder. Increase to require more pronounced toss.
  serveWristThreshold: 0.08,


  // ── Clip Assembly ───────────────────────────────────────────────────────────
  // Seconds to include BEFORE the detected serve start.
  preServeBuffer: 1.0,

  // Seconds to include AFTER the detected point end (catches the ball landing, etc.)
  postPointBuffer: 2.5,


  // ── Audio Onset Detection ───────────────────────────────────────────────────
  // Max silence gap (seconds) before declaring a point over.
  // 5s: merges fault+second serve (~5s apart) but splits between points (20-25s apart).
  // Lower if points are being merged together; raise if points are being split.
  audioGapThreshold: 5.0,

  // Onset energy percentile used as the active/inactive threshold (0–100).
  // Higher = stricter — only the loudest impact bursts count as play.
  // Raise if crowd noise is creating false segments; lower if missing quiet points.
  audioOnsetPercentile: 85,

  // Minimum cluster duration (seconds) to count as a real point.
  // Filters out stray sounds (crowd clap, chair scrape).
  audioMinPointDuration: 2.0,

  // Seconds added after the last impact to catch the ball landing.
  audioPostBuffer: 3.0,


  // ── Cross-validation ────────────────────────────────────────────────────────
  // Seconds at the start of the recording used to calibrate the noise floor.
  // The first ~60s is almost always pre-play warmup or silence — ideal for
  // measuring background noise specific to this court/mic/conditions.
  calibrationWindow: 60,

  // How far into the recording to search for the quietest window (seconds).
  // 180s = search the first 3 minutes. Handles recordings that start mid-warmup.
  calibrationSearchWindow: 180,

  // How many standard deviations above the quiet baseline to set the threshold.
  // 3.0 = only flag audio/motion significantly above background noise.
  // Lower (e.g. 2.0) = more sensitive; raise (e.g. 4.0) = stricter.
  noiseMultiplier: 1.5,

  // Minimum overlap fraction between an audio segment and a motion segment
  // for them to be considered "agreeing" (0–1). 0.1 = 10% of the shorter
  // segment must overlap. Audio fires on first impact; motion fires on sustained
  // movement — they naturally offset by 1–3s, so keep this low.
  minSegmentOverlap: 0.1,

  // Minimum confidence to include a segment (0–1).
  // 1.0 = only segments confirmed by both signals
  // 0.7 = include audio-only (and above)
  // 0.6 = include motion-only (and above) — keep everything
  minSegmentConfidence: 0.5,

  // Max gap (seconds) between two cross-validated segments to merge them.
  // Catches points split between audio and motion due to timing offsets.
  postMergeGap: 3.0,

  // Gaps between segments longer than this (seconds) are logged as breaks.
  // 60s = end-of-game changeover. 120s+ = set break. 300s+ = long break.
  changeoverGapThreshold: 60,


  // ── Best-of Output ──────────────────────────────────────────────────────────
  // Number of clips to include in the _bestof.mp4 (ranked by duration × confidence).
  // Set to 0 to disable best-of generation.
  bestOfCount: 10,


  // ── Court Mask ──────────────────────────────────────────────────────────────
  // Path to court_mask.json generated by scripts/court_calibration.py.
  // When set, motion energy is computed ONLY inside your court boundary,
  // filtering out players on adjacent courts visible in the background.
  // Set to null to use the full frame (no mask).
  courtMaskPath: null,


  // ── System ──────────────────────────────────────────────────────────────────
  // Python binary to use. 'python3' should work on Mac with Homebrew.
  pythonBin: 'python3.9',

  // Temp directory for intermediate files. Cleaned up after each video.
  tempDir: '/tmp/tennis-highlights',

};
