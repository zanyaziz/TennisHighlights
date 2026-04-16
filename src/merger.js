/**
 * merger.js
 *
 * Concatenates all point clips into a single highlights video using FFmpeg's
 * concat demuxer. Stream-copies (no re-encode) since all clips share the same
 * codec/resolution from extractClip().
 */

import ffmpeg from 'fluent-ffmpeg';
import { writeFile } from 'fs/promises';
import path from 'path';

/**
 * Merge an ordered list of clip files into one output video.
 *
 * @param {string[]} clipPaths  - Ordered list of .mp4 clip paths
 * @param {string}   outputPath - Destination for the merged highlights video
 * @returns {Promise<void>}
 */
export function mergeClips(clipPaths, outputPath) {
  return new Promise(async (resolve, reject) => {
    if (clipPaths.length === 0) {
      reject(new Error('No clips to merge.'));
      return;
    }

    // FFmpeg concat demuxer requires a plain-text list file
    const concatListPath = path.join(path.dirname(outputPath), '_concat_list.txt');
    const concatContent  = clipPaths.map(p => `file '${p}'`).join('\n');
    await writeFile(concatListPath, concatContent);

    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c copy',             // stream-copy: no re-encode needed
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`FFmpeg merge error: ${err.message}`)))
      .run();
  });
}
