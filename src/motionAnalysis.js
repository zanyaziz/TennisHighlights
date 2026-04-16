/**
 * motionAnalysis.js
 *
 * Runs the Python motion_analysis.py script against a video file, parses the
 * resulting energy time-series, and segments it into "active" (play) windows.
 *
 * Segment merging handles the fault-serve case: a brief quiet gap between the
 * first-serve fault and the second serve + rally stays within a single clip.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

/**
 * Run motion_analysis.py and return parsed JSON.
 * @param {string} videoPath
 * @param {string} tempDir
 * @returns {Promise<{fps:number, total_frames:number, duration:number, samples:{t:number,e:number}[]}>}
 */
export async function analyzeMotion(videoPath, tempDir) {
  const outputPath = path.join(tempDir, 'motion.json');

  const args = [
    path.join(SCRIPTS_DIR, 'motion_analysis.py'),
    videoPath,
    outputPath,
    String(config.motionSampleEveryNFrames),
  ];
  if (config.courtMaskPath) {
    args.push(path.resolve(config.courtMaskPath));
  }

  const { stderr } = await execFileAsync(
    config.pythonBin,
    args,
    { timeout: 45 * 60 * 1000 }
  );

  // Forward Python stderr to our console
  if (stderr) process.stdout.write(stderr);

  return JSON.parse(await readFile(outputPath, 'utf8'));
}

/**
 * Convert the raw motion energy samples into a list of active play segments.
 *
 * Algorithm:
 *   1. Smooth energy values over a rolling window.
 *   2. Threshold → produce raw on/off periods.
 *   3. Close a segment after inactivityTimeout seconds of low energy.
 *   4. Discard segments shorter than minPlayDuration (noise).
 *   5. Merge adjacent segments separated by ≤ maxGapToMerge (fault + 2nd serve).
 *
 * @param {{ samples: {t:number, e:number}[] }} motionData
 * @returns {{ start:number, end:number }[]}
 */
export function findActiveSegments(motionData) {
  const { samples } = motionData;
  const {
    motionThreshold,
    smoothingWindow,
    minPlayDuration,
    inactivityTimeout,
    maxGapToMerge,
    calibrationWindow,
    calibrationSearchWindow,
    noiseMultiplier,
  } = config;

  if (!samples || samples.length === 0) return [];

  // ── Adaptive noise floor calibration ───────────────────────────────────────
  // Slide a window across the first calibrationSearchWindow seconds and pick
  // the QUIETEST window (lowest std) as the noise floor reference.
  let effectiveThreshold = motionThreshold;
  const searchSamples = samples.filter(s => s.t < calibrationSearchWindow);
  const calibCount    = samples.filter(s => s.t < calibrationWindow).length;

  if (calibCount >= 10 && searchSamples.length > calibCount) {
    const step = Math.max(1, Math.floor(calibCount / 6));
    let bestStd = Infinity, bestStart = 0;

    for (let i = 0; i <= searchSamples.length - calibCount; i += step) {
      const w       = searchSamples.slice(i, i + calibCount).map(s => s.e);
      const wMean   = w.reduce((a, b) => a + b, 0) / w.length;
      const wStd    = Math.sqrt(w.reduce((s, v) => s + (v - wMean) ** 2, 0) / w.length);
      if (wStd < bestStd) { bestStd = wStd; bestStart = i; }
    }

    const calib    = searchSamples.slice(bestStart, bestStart + calibCount).map(s => s.e);
    const mean     = calib.reduce((a, b) => a + b, 0) / calib.length;
    const std      = Math.sqrt(calib.reduce((s, v) => s + (v - mean) ** 2, 0) / calib.length);
    const adaptive = mean + noiseMultiplier * std;

    if (std > 0 && adaptive > mean * 1.5) {
      effectiveThreshold = adaptive;
      const tStart = searchSamples[bestStart].t.toFixed(0);
      const tEnd   = searchSamples[Math.min(bestStart + calibCount - 1, searchSamples.length - 1)].t.toFixed(0);
      process.stdout.write(
        `[motion_analysis] Quietest window: ${tStart}s–${tEnd}s  ` +
        `noise=${mean.toFixed(4)} ± ${std.toFixed(4)}  → threshold: ${effectiveThreshold.toFixed(4)}\n`
      );
    }
  }

  // ── 1. Smooth ────────────────────────────────────────────────────────────────
  const smoothed = samples.map((s, i) => {
    const lo = Math.max(0, i - smoothingWindow);
    const hi = Math.min(samples.length - 1, i + smoothingWindow);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += samples[j].e;
    return { t: s.t, e: sum / (hi - lo + 1) };
  });

  // ── 2 & 3. Threshold + inactivity timeout ────────────────────────────────────
  const rawSegments = [];
  let inActive = false;
  let segStart = 0;
  let lastActiveTime = 0;

  for (const sample of smoothed) {
    if (sample.e >= effectiveThreshold) {
      if (!inActive) {
        segStart = sample.t;
        inActive = true;
      }
      lastActiveTime = sample.t;
    } else if (inActive) {
      if (sample.t - lastActiveTime >= inactivityTimeout) {
        if (lastActiveTime - segStart >= minPlayDuration) {
          rawSegments.push({ start: segStart, end: lastActiveTime });
        }
        inActive = false;
      }
    }
  }

  // Close any still-open segment at end of video
  if (inActive && lastActiveTime - segStart >= minPlayDuration) {
    rawSegments.push({ start: segStart, end: lastActiveTime });
  }

  // ── 4. Already filtered by minPlayDuration above ─────────────────────────────

  // ── 5. Merge nearby segments (fault → second serve) ──────────────────────────
  const merged = [];
  for (const seg of rawSegments) {
    const prev = merged[merged.length - 1];
    if (prev && seg.start - prev.end <= maxGapToMerge) {
      prev.end = seg.end;
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  return merged;
}
