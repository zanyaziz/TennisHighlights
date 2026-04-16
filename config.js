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
  motionThreshold: 3.5,

  // Smoothing window (in samples) applied to energy time-series to remove noise.
  smoothingWindow: 5,

  // A play segment must be at least this many seconds long to be considered a point.
  // Filters out brief motion blips (bird flying by, etc.)
  minPlayDuration: 3.0,

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
  postPointBuffer: 0.5,


  // ── System ──────────────────────────────────────────────────────────────────
  // Python binary to use. 'python3' should work on Mac with Homebrew.
  pythonBin: 'python3.9',

  // Temp directory for intermediate files. Cleaned up after each video.
  tempDir: '/tmp/tennis-highlights',

};
