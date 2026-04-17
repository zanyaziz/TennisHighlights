/**
 * serveDetection.js
 *
 * Bridges to serve_detection.py (FFmpeg + blob tracking) to find the precise
 * ball toss frame for each play segment, then builds the final clip list.
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
      String(config.postPointBuffer),
    ],
    { timeout: 45 * 60 * 1000 }
  );

  if (stderr) process.stdout.write(stderr);

  return JSON.parse(await readFile(outputPath, 'utf8'));
}

/**
 * Convert serve detection output into a clip list.
 *
 * @param {{ serve_time:number, segment_end:number, detected:boolean }[]} serveData
 * @param {{ confidence:number, source:string }[]} segments - cross-validated segments (same order)
 * @returns {{ index:number, start:number, end:number, serveDetected:boolean, confidence:number, source:string }[]}
 */
export function buildClipList(serveData, segments = []) {
  return serveData.map((point, i) => ({
    index:         i + 1,
    start:         Math.max(0, point.serve_time - config.preServeBuffer),
    end:           point.segment_end + config.postPointBuffer,
    serveDetected: point.detected,
    confidence:    segments[i]?.confidence ?? 0.6,
    source:        segments[i]?.source     ?? 'motion',
  }));
}
