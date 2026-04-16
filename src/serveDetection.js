/**
 * serveDetection.js
 *
 * Bridges to serve_detection.py (MediaPipe Pose) to find the precise serve
 * start frame for each active segment, then builds the final clip list with
 * pre-serve buffer and post-point buffer applied.
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
 * Run serve_detection.py for every active segment.
 *
 * @param {string} videoPath
 * @param {{ start:number, end:number }[]} segments
 * @param {string} tempDir
 * @returns {Promise<{segment_start:number, segment_end:number, serve_time:number, detected:boolean}[]>}
 */
export async function detectServes(videoPath, segments, tempDir) {
  const segmentsPath = path.join(tempDir, 'segments.json');
  const outputPath   = path.join(tempDir, 'serves.json');

  await writeFile(segmentsPath, JSON.stringify(segments, null, 2));

  const { stderr } = await execFileAsync(
    config.pythonBin,
    [
      path.join(SCRIPTS_DIR, 'serve_detection.py'),
      videoPath,
      segmentsPath,
      outputPath,
      String(config.serveSearchWindow),
      String(config.serveMinWristRiseFrames),
      String(config.serveWristThreshold),
    ],
    { timeout: 45 * 60 * 1000 }
  );

  if (stderr) process.stdout.write(stderr);

  return JSON.parse(await readFile(outputPath, 'utf8'));
}

/**
 * Convert serve detection output into a clip list.
 * Each clip has a start (serve - preServeBuffer) and end (segment_end + postPointBuffer).
 *
 * @param {{ serve_time:number, segment_end:number, detected:boolean }[]} serveData
 * @returns {{ index:number, start:number, end:number, serveDetected:boolean }[]}
 */
export function buildClipList(serveData) {
  return serveData.map((point, i) => ({
    index: i + 1,
    start: Math.max(0, point.serve_time - config.preServeBuffer),
    end: point.segment_end + config.postPointBuffer,
    serveDetected: point.detected,
  }));
}
