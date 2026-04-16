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

  const { stderr } = await execFileAsync(
    config.pythonBin,
    [
      path.join(SCRIPTS_DIR, 'motion_analysis.py'),
      videoPath,
      outputPath,
      String(config.motionSampleEveryNFrames),
    ],
    { timeout: 45 * 60 * 1000 }  // 45-min hard cap for very long matches
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
  } = config;

  if (!samples || samples.length === 0) return [];

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
    if (sample.e >= motionThreshold) {
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
