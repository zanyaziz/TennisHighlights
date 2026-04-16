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
    ├─ [1] Motion analysis (Python / OpenCV)
    │       Compute frame-diff energy across the whole video.
    │       Find "active" windows where energy is above threshold.
    │       Merge short gaps (handles fault → second serve as one clip).
    │
    ├─ [2] Serve detection (Python / MediaPipe Pose)
    │       For each active window, scan backward through the preceding
    │       quiet period looking for the ball toss (wrist above shoulder).
    │       Falls back to segment start if pose not detected.
    │
    ├─ [3] Clip extraction (FFmpeg)
    │       Cut each point: [serve_time − 1s buffer] → [point_end + 0.5s]
    │
    └─ [4] Merge (FFmpeg)
            Concatenate all point clips into one highlights video.
```

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

If you are using **conda** (e.g. Anaconda or Miniconda), use `pip` inside your active conda environment — no venv needed:

```bash
pip install opencv-python mediapipe
```

If you are **not** using conda, create a virtual environment first to avoid the macOS "externally-managed-environment" error:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install opencv-python mediapipe
```

> **Note**: `mediapipe` requires Python 3.8–3.11. If you're on a newer Python,
> use `pyenv` to install 3.11:
> ```bash
> brew install pyenv
> pyenv install 3.11
> pyenv global 3.11
> python3 -m venv .venv
> source .venv/bin/activate
> pip install opencv-python mediapipe
> ```

### 3. Node.js packages

```bash
cd tennis-highlights
npm install
```

---

## Usage

### Process a whole folder of match videos

```bash
node index.js process ~/Videos/Tennis/Matches ~/Videos/Tennis/Highlights
```

### Process a single video

```bash
node index.js single ~/Videos/Tennis/match_2024_06_15.mp4 ~/Videos/Tennis/Highlights
```

The output file will be named `<original_name>_highlights.mp4`.

---

## Configuration

All tunable parameters are in **`config.js`**. The most important ones to tweak
after your first run:

| Parameter | Default | What it does |
|---|---|---|
| `motionThreshold` | `3.5` | Energy cutoff for "active" frames. Lower = more sensitive. |
| `inactivityTimeout` | `2.5s` | Silence needed to declare point over. |
| `maxGapToMerge` | `6.0s` | Max gap between segments before treating as new point (fault handling). |
| `serveSearchWindow` | `8.0s` | How far back to scan for the ball toss. |
| `preServeBuffer` | `1.0s` | Clip starts this many seconds before the serve. |

### First-run tuning workflow

1. Run on a short test clip (2–3 mins of play).
2. Check the console output for segment count vs expected points.
3. If **too many segments**: raise `motionThreshold`.
4. If **missing segments**: lower `motionThreshold`.
5. If **points getting split**: raise `inactivityTimeout` or `maxGapToMerge`.
6. If **serve detection is off**: raise `preServeBuffer` or adjust `serveSearchWindow`.

---

## Troubleshooting

**"No play segments found"**  
→ Lower `motionThreshold` in `config.js`. The camera angle, lighting, and court
colour all affect the energy baseline.

**Points are being split in two**  
→ Raise `maxGapToMerge` (to handle long pauses mid-point) or `inactivityTimeout`.

**Clips start too late (serve already in progress)**  
→ Raise `preServeBuffer` (e.g. `2.0`) or `serveSearchWindow`.

**MediaPipe serve detection not working**  
→ The system falls back to segment start automatically. Check your Python/mediapipe
installation: `python3 -c "import mediapipe; print('OK')"`.

**FFmpeg not found**  
→ Make sure `ffmpeg` is on your PATH: `which ffmpeg`. If installed via Homebrew,
you may need to add `/opt/homebrew/bin` to your PATH.

---

## Project structure

```
tennis-highlights/
├── index.js                 CLI entry point
├── config.js                All tunable parameters
├── package.json
├── src/
│   ├── pipeline.js          Main orchestration
│   ├── motionAnalysis.js    Calls Python, finds active segments
│   ├── serveDetection.js    Calls Python, finds serve timestamps
│   ├── clipExtractor.js     FFmpeg clip cutting
│   └── merger.js            FFmpeg concatenation
└── scripts/
    ├── motion_analysis.py   OpenCV frame-diff energy analysis
    └── serve_detection.py   MediaPipe Pose serve detection
```
