/**
 * pipeline.js
 *
 * Orchestrates the full highlights extraction pipeline for one or many videos.
 *
 * Per-video flow:
 *   1. Motion analysis (Python/OpenCV) → energy time-series
 *   2. Segment detection               → active play windows
 *   3. Serve detection (Python/MediaPipe) → precise clip start times
 *   4. Clip extraction (FFmpeg)        → individual point .mp4 files
 *   5. Merge (FFmpeg)                  → single highlights video
 */

import { readdir, mkdir, rm } from 'fs/promises';
import path from 'path';
import { analyzeMotion, findActiveSegments } from './motionAnalysis.js';
import { detectServes, buildClipList } from './serveDetection.js';
import { extractAllClips } from './clipExtractor.js';
import { mergeClips } from './merger.js';
import config from '../config.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.MP4', '.MOV']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ── Single Video ──────────────────────────────────────────────────────────────

/**
 * Process a single video file end-to-end.
 *
 * @param {string} videoPath  - Absolute path to source video
 * @param {string} outputDir  - Directory for the output highlights video
 * @returns {Promise<string|null>} Path to output file, or null if nothing found
 */
export async function processVideo(videoPath, outputDir) {
  const videoName  = path.basename(videoPath, path.extname(videoPath));
  const tempDir    = path.join(config.tempDir, videoName.replace(/\s/g, '_'));
  const clipsDir   = path.join(tempDir, 'clips');
  const outputPath = path.join(outputDir, `${videoName}_highlights.mp4`);

  console.log(`\n🎾  ${path.basename(videoPath)}`);
  console.log(`    Output → ${outputPath}`);
  const t0 = Date.now();

  await mkdir(tempDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  try {

    // ── Step 1: Motion analysis ──────────────────────────────────────────────
    console.log('\n  [1/4] Motion analysis...');
    const motionData = await analyzeMotion(videoPath, tempDir);
    console.log(`        Video: ${formatDuration(motionData.duration)} | ${motionData.fps.toFixed(0)} fps`);

    // ── Step 2: Segment detection ────────────────────────────────────────────
    const segments = findActiveSegments(motionData);
    console.log(`\n  [2/4] Segment detection → ${segments.length} play segment(s) found`);

    if (segments.length === 0) {
      console.log('\n  ⚠️   No play segments found.');
      console.log('       Tips:');
      console.log('       • Lower motionThreshold in config.js (currently ' + config.motionThreshold + ')');
      console.log('       • Check that the video actually contains play');
      return null;
    }

    segments.forEach((s, i) =>
      console.log(`        [${i + 1}] ${s.start.toFixed(1)}s – ${s.end.toFixed(1)}s  (${(s.end - s.start).toFixed(1)}s)`)
    );

    // ── Step 3: Serve detection ──────────────────────────────────────────────
    console.log('\n  [3/4] Serve detection...');
    const serveData = await detectServes(videoPath, segments, tempDir);
    const clips     = buildClipList(serveData);

    const nDetected = clips.filter(c => c.serveDetected).length;
    console.log(`        Serve located: ${nDetected}/${clips.length} via MediaPipe (rest use segment start)`);

    // ── Step 4: Extract + merge ──────────────────────────────────────────────
    console.log('\n  [4/4] Extracting clips...');
    const clipPaths = await extractAllClips(videoPath, clips, clipsDir);

    console.log('\n        Merging...');
    await mergeClips(clipPaths, outputPath);

    const totalHighlightDuration = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    console.log('\n  ✅  Done!');
    console.log(`        ${clips.length} points | ${formatDuration(totalHighlightDuration)} of highlights`);
    console.log(`        Original: ${formatDuration(motionData.duration)} → compressed by ${((1 - totalHighlightDuration / motionData.duration) * 100).toFixed(0)}%`);
    console.log(`        Processing time: ${elapsed}s`);
    console.log(`        → ${outputPath}`);

    return outputPath;

  } catch (err) {
    console.error(`\n  ❌  Error processing ${path.basename(videoPath)}:`, err.message);
    return null;
  } finally {
    // Always clean up temp files
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Folder ────────────────────────────────────────────────────────────────────

/**
 * Process all video files found in inputDir.
 *
 * @param {string} inputDir
 * @param {string} outputDir
 */
export async function processFolder(inputDir, outputDir) {
  let entries;
  try {
    entries = await readdir(inputDir);
  } catch {
    console.error(`Cannot read input directory: ${inputDir}`);
    process.exit(1);
  }

  const videoFiles = entries
    .filter(f => VIDEO_EXTENSIONS.has(path.extname(f)))
    .sort()
    .map(f => path.join(inputDir, f));

  if (videoFiles.length === 0) {
    console.log(`No video files found in ${inputDir}`);
    console.log(`Supported extensions: ${[...VIDEO_EXTENSIONS].join(', ')}`);
    return;
  }

  console.log(`\nFound ${videoFiles.length} video file(s) in ${inputDir}`);
  console.log('─'.repeat(60));

  const results = [];
  for (const videoPath of videoFiles) {
    const out = await processVideo(videoPath, outputDir);
    if (out) results.push(out);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`✅  Complete: ${results.length}/${videoFiles.length} videos processed successfully.`);
  if (results.length > 0) {
    console.log(`Output folder: ${outputDir}`);
  }
}
