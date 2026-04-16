# Tennis Highlights Extractor

Automatically trims GoPro tennis match footage down to gameplay only —
every clip starts at a serve and ends when the point finishes.

**Camera**: GoPro mounted behind the baseline  
**Platform**: Mac Mini (Apple Silicon), runs 100% locally — no API costs

---

## How it works

```
GoPro .mp4
    │
    ├─ [1] Audio analysis (Python / librosa)       ──┐
    │       Detect ball-impact onsets.               │
    │       Cluster onsets into point segments.      ├─ Cross-validate
    │       Adaptive noise-floor calibration.        │  (both signals
    │                                                │   must agree)
    ├─ [2] Motion analysis (Python / FFmpeg)       ──┘
    │       Compute frame-diff energy on court area only (if mask set).
    │       Find "active" windows above adaptive threshold.
    │       Merge short gaps (fault → second serve = one clip).
    │
    ├─ [3] Serve detection (Python / FFmpeg + MOG2)
    │       For each confirmed segment, scan backward for ball toss.
    │       Background-subtraction blob tracking (no MediaPipe needed).
    │       Falls back to segment start if toss not detected.
    │
    ├─ [4] Clip extraction (FFmpeg)
    │       Cut each point: [serve_time − 1s buffer] → [point_end + 0.5s]
    │
    └─ [5] Merge (FFmpeg)
            Concatenate all point clips into one highlights video.
```

### Dual-signal cross-validation

Audio and motion run in parallel. Each candidate segment is scored:

| Score | Meaning |
|---|---|
| `1.0` (✓✓) | Confirmed by **both** audio and motion — highest confidence |
| `0.7` (♪)  | Audio-only — rally sound but low visual motion |
| `0.6` (▶)  | Motion-only — movement but quiet (audio unavailable) |

Set `minSegmentConfidence: 1.0` in `config.js` to keep only segments confirmed
by both signals — useful when adjacent courts create audio bleed.

---

## Setup

### 1. System dependencies

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install FFmpeg and Python
brew install ffmpeg python3
```

### 2. Python packages

If you are using **conda** (e.g. Anaconda or Miniconda), use `pip` inside your active conda environment:

```bash
pip install opencv-python numpy librosa soundfile
```

If you are **not** using conda, create a virtual environment first to avoid the macOS "externally-managed-environment" error:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install opencv-python numpy librosa soundfile
```

> **Note**: If `python3` points to the wrong interpreter, set `pythonBin` in
> `config.js` to the explicit binary (e.g. `'python3.9'`).

### 3. Node.js packages

```bash
npm install
```

---

## Court boundary mask (recommended for shared facilities)

If other courts are visible in the background, their motion and audio will
create false segments. Use the one-time calibration tool to define your court
boundary — motion energy will then be measured **only inside your court**.

### Step 1 — Run calibration once per camera position

```bash
python3.9 scripts/court_calibration.py "./Raw_Video/GX020122.MP4"
```

An OpenCV window opens with a frame from your video.

| Action | Control |
|---|---|
| Place a corner | Left click |
| Undo last corner | Right click |
| Reset all corners | R |
| Save and exit | Enter or Space |
| Cancel | Escape |

Click the 4 corners of **your** court in order (e.g. clockwise from top-left).
A preview shows the masked area before saving.

The tool saves `court_mask.json` in the current directory.

### Step 2 — Enable the mask in config.js

```js
courtMaskPath: './court_mask.json',
```

### Step 3 — Require both signals to agree

For shared facilities where audio bleeds between courts, also set:

```js
minSegmentConfidence: 1.0,
```

This keeps only segments confirmed by **both** audio onsets and masked motion —
significantly reducing false positives from adjacent courts.

---

## Usage

### Process a whole folder of match videos

```bash
node index.js process ./Raw_Video ./Highlights
```

### Process a single video

```bash
node index.js single ./Raw_Video/GX020122.MP4 ./Highlights
```

The output file will be named `<original_name>_highlights.mp4`.

---

## Configuration

All tunable parameters are in **`config.js`**.

### Signal thresholds

| Parameter | Default | What it does |
|---|---|---|
| `motionThreshold` | `1.0` | Fallback energy cutoff (overridden by adaptive calibration). |
| `audioOnsetPercentile` | `85` | Strictness of audio onset detection (0–100). Higher = fewer but more confident impacts. |
| `minSegmentConfidence` | `0.5` | Minimum score to keep a segment. Set to `1.0` for shared-facility noise rejection. |

### Timing

| Parameter | Default | What it does |
|---|---|---|
| `inactivityTimeout` | `2.5s` | Silence/stillness needed to declare point over. |
| `maxGapToMerge` | `6.0s` | Max gap between motion segments to merge (handles fault → second serve). |
| `audioGapThreshold` | `5.0s` | Max audio silence before declaring a point over. |
| `preServeBuffer` | `1.0s` | Clip starts this many seconds before the detected serve. |
| `postPointBuffer` | `0.5s` | Clip ends this many seconds after the point. |

### Adaptive calibration

The pipeline searches the first `calibrationSearchWindow` seconds (default: 180s)
for the quietest `calibrationWindow`-second window (default: 60s) and uses it
as the noise floor. The threshold is set at `mean + noiseMultiplier × std`.

| Parameter | Default | What it does |
|---|---|---|
| `calibrationWindow` | `60s` | Length of the quiet reference window. |
| `calibrationSearchWindow` | `180s` | How far into the recording to search. |
| `noiseMultiplier` | `2.5` | Standard deviations above noise floor for threshold. |

### Court mask

| Parameter | Default | What it does |
|---|---|---|
| `courtMaskPath` | `null` | Path to `court_mask.json`. Set after running calibration. |

---

## Troubleshooting

**"No play segments found"**  
→ Lower `motionThreshold` or `audioOnsetPercentile`. The camera angle, lighting,
and court colour all affect the energy baseline.

**Too many false segments (adjacent court noise)**  
→ Run court calibration and set `courtMaskPath`. Also set `minSegmentConfidence: 1.0`.

**Points are being split in two**  
→ Raise `maxGapToMerge` (to handle long pauses mid-point) or `inactivityTimeout`.

**Clips start too late (serve already in progress)**  
→ Raise `preServeBuffer` (e.g. `2.0`) or `serveSearchWindow`.

**FFmpeg not found**  
→ `which ffmpeg`. If installed via Homebrew, add `/opt/homebrew/bin` to your PATH.

**Wrong Python binary**  
→ Set `pythonBin: 'python3.9'` (or your specific version) in `config.js`.

---

## Project structure

```
tennis-highlights/
├── index.js                    CLI entry point
├── config.js                   All tunable parameters
├── court_mask.json             Generated by court_calibration.py (after setup)
├── package.json
├── src/
│   ├── pipeline.js             Main orchestration + cross-validation
│   ├── motionAnalysis.js       Calls Python, finds active segments
│   ├── audioAnalysis.js        Calls Python, onset-based segments
│   ├── serveDetection.js       Calls Python, finds serve timestamps
│   ├── clipExtractor.js        FFmpeg clip cutting
│   └── merger.js               FFmpeg concatenation
└── scripts/
    ├── motion_analysis.py      FFmpeg pipe + frame-diff energy (court mask aware)
    ├── audio_analysis.py       librosa onset detection
    ├── serve_detection.py      FFmpeg pipe + MOG2 blob tracking
    └── court_calibration.py   Interactive court boundary tool (run once)
```
