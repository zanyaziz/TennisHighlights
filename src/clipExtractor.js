/**
 * clipExtractor.js
 *
 * Extracts individual point clips from the source video using FFmpeg.
 * Re-encodes to H.264/AAC to ensure accurate keyframe alignment at cut points.
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { mkdir } from 'fs/promises';

/**
 * Extract a single clip from videoPath between start and end seconds.
 *
 * @param {string} videoPath
 * @param {number} start - Start time in seconds
 * @param {number} end   - End time in seconds
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
export function extractClip(videoPath, start, end, outputPath) {
  return new Promise((resolve, reject) => {
    const duration = Math.max(0.1, end - start);

    ffmpeg(videoPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',          // fast encode; change to 'medium' for better compression
        '-crf 18',               // near-lossless at 1080p; raise to 23 to save space
        '-c:a aac',
        '-b:a 128k',
        '-avoid_negative_ts make_zero',
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`FFmpeg clip error: ${err.message}`)))
      .run();
  });
}

/**
 * Extract all clips sequentially.
 *
 * @param {string} videoPath
 * @param {{ index:number, start:number, end:number, serveDetected:boolean }[]} clips
 * @param {string} clipsDir
 * @returns {Promise<string[]>} Ordered list of output clip paths
 */
export async function extractAllClips(videoPath, clips, clipsDir) {
  await mkdir(clipsDir, { recursive: true });
  const clipPaths = [];

  for (const clip of clips) {
    const filename = `clip_${String(clip.index).padStart(4, '0')}.mp4`;
    const outputPath = path.join(clipsDir, filename);
    const duration = (clip.end - clip.start).toFixed(1);
    const flag = clip.serveDetected ? '' : ' (serve fallback)';

    console.log(`    Point ${clip.index}: ${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s  (${duration}s)${flag}`);

    await extractClip(videoPath, clip.start, clip.end, outputPath);
    clipPaths.push(outputPath);
  }

  return clipPaths;
}
