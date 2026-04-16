/**
 * audioAnalysis.js
 *
 * Runs audio_analysis.py (librosa onset detection) against the video's audio
 * track and returns play segments clustered from ball-impact onsets.
 *
 * This is the primary point-boundary signal. Motion energy is used as a
 * fallback when audio is unavailable or produces no segments.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

/**
 * Run audio_analysis.py and return parsed result.
 *
 * @param {string} videoPath
 * @param {string} tempDir
 * @returns {Promise<{duration:number, onset_count:number, segments:{start:number,end:number}[]}>}
 */
export async function analyzeAudio(videoPath, tempDir) {
  const outputPath = path.join(tempDir, 'audio_segments.json');

  const { stderr } = await execFileAsync(
    config.pythonBin,
    [
      path.join(SCRIPTS_DIR, 'audio_analysis.py'),
      videoPath,
      outputPath,
      String(config.audioGapThreshold),
      String(config.audioMinPointDuration),
      String(config.audioPostBuffer),
      String(config.audioOnsetPercentile),
      String(config.calibrationWindow),
      String(config.noiseMultiplier),
      String(config.calibrationSearchWindow),
    ],
    { timeout: 45 * 60 * 1000 }
  );

  if (stderr) process.stdout.write(stderr);

  return JSON.parse(await readFile(outputPath, 'utf8'));
}
