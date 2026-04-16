/**
 * pipeline.js
 *
 * Orchestrates the full highlights extraction pipeline for one or many videos.
 *
 * Per-video flow:
 *   1. Audio analysis (librosa onset detection) → point segments  [primary]
 *      Motion analysis (OpenCV frame-diff)      → point segments  [fallback]
 *   2. Serve detection (FFmpeg + blob tracking) → precise clip start times
 *   3. Clip extraction (FFmpeg)                 → individual point .mp4 files
 *   4. Merge (FFmpeg)                           → single highlights video
 */

import { readdir, mkdir, rm } from 'fs/promises';
import path from 'path';
import { analyzeAudio } from './audioAnalysis.js';
import { analyzeMotion, findActiveSegments } from './motionAnalysis.js';

import { detectServes, buildClipList } from './serveDetection.js';
import { extractAllClips } from './clipExtractor.js';
import { mergeClips } from './merger.js';
import config from '../config.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.MP4', '.MOV']);

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Cross-validate segments from two independent signals (audio + motion).
 *
 * Segments that both signals agree on get confidence=1.0 and their boundaries
 * are merged (union). Segments found by only one signal get confidence=0.7
 * (audio-only) or 0.6 (motion-only).
 *
 * @param {{ start:number, end:number }[]} audioSegs
 * @param {{ start:number, end:number }[]} motionSegs
 * @param {number} minOverlap  - fraction of shorter segment that must overlap to "agree"
 * @returns {{ start:number, end:number, confidence:number, source:string }[]}
 */
function crossValidate(audioSegs, motionSegs, minOverlap) {
  const usedMotion = new Set();
  const results = [];

  for (const a of audioSegs) {
    let bestIdx = -1, bestRatio = 0;
    for (let i = 0; i < motionSegs.length; i++) {
      if (usedMotion.has(i)) continue;
      const m = motionSegs[i];
      const overlapStart = Math.max(a.start, m.start);
      const overlapEnd   = Math.min(a.end,   m.end);
      if (overlapEnd <= overlapStart) continue;
      const shorter = Math.min(a.end - a.start, m.end - m.start);
      const ratio   = (overlapEnd - overlapStart) / shorter;
      if (ratio > bestRatio) { bestRatio = ratio; bestIdx = i; }
    }

    if (bestIdx >= 0 && bestRatio >= minOverlap) {
      const m = motionSegs[bestIdx];
      usedMotion.add(bestIdx);
      results.push({
        start:      Math.min(a.start, m.start),
        end:        Math.max(a.end,   m.end),
        confidence: 1.0,
        source:     'both',
      });
    } else {
      results.push({ ...a, confidence: 0.7, source: 'audio' });
    }
  }

  for (let i = 0; i < motionSegs.length; i++) {
    if (!usedMotion.has(i)) {
      results.push({ ...motionSegs[i], confidence: 0.6, source: 'motion' });
    }
  }

  return results.sort((a, b) => a.start - b.start);
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

    // ── Step 1: Segment detection (audio + motion, cross-validated) ─────────
    console.log('\n  [1/3] Detecting play segments...');

    // Run both signals in parallel — they fail independently
    const [audioResult, motionResult] = await Promise.allSettled([
      analyzeAudio(videoPath, tempDir),
      analyzeMotion(videoPath, tempDir).then(d => findActiveSegments(d)),
    ]);

    const audioSegs  = audioResult.status  === 'fulfilled' ? audioResult.value.segments : [];
    const motionSegs = motionResult.status === 'fulfilled' ? motionResult.value         : [];

    if (audioResult.status  === 'rejected') console.log(`        ⚠ Audio analysis failed: ${audioResult.reason.message}`);
    if (motionResult.status === 'rejected') console.log(`        ⚠ Motion analysis failed: ${motionResult.reason.message}`);

    console.log(`        Audio:  ${audioSegs.length} segment(s)`);
    console.log(`        Motion: ${motionSegs.length} segment(s)`);

    // Cross-validate: score by agreement between the two signals
    const validated = crossValidate(audioSegs, motionSegs, config.minSegmentOverlap);
    const segments  = validated.filter(s => s.confidence >= config.minSegmentConfidence);

    const nBoth   = segments.filter(s => s.source === 'both').length;
    const nAudio  = segments.filter(s => s.source === 'audio').length;
    const nMotion = segments.filter(s => s.source === 'motion').length;

    console.log(`\n        ${segments.length} play segment(s) after cross-validation`);
    console.log(`        Confirmed by both: ${nBoth}  |  Audio-only: ${nAudio}  |  Motion-only: ${nMotion}`);

    if (segments.length === 0) {
      console.log('\n  ⚠️   No play segments found.');
      console.log('       Tips:');
      console.log('       • Check that the video has audio (GoPro audio enabled)');
      console.log('       • Lower minSegmentConfidence in config.js to include single-signal segments');
      console.log('       • Lower audioGapThreshold or audioMinPointDuration in config.js');
      return null;
    }

    const confidenceLabel = s =>
      s.source === 'both' ? '✓✓' : s.source === 'audio' ? '♪ ' : '▶ ';

    segments.forEach((s, i) =>
      console.log(
        `        [${String(i + 1).padStart(2)}] ${confidenceLabel(s)} ` +
        `${s.start.toFixed(1)}s – ${s.end.toFixed(1)}s  (${(s.end - s.start).toFixed(1)}s)`
      )
    );

    // ── Step 2: Serve detection ──────────────────────────────────────────────
    console.log('\n  [2/3] Serve detection (ball toss)...');
    const serveData = await detectServes(videoPath, segments, tempDir);
    const clips     = buildClipList(serveData);

    const nDetected = clips.filter(c => c.serveDetected).length;
    console.log(`        Serve located: ${nDetected}/${clips.length} via blob detection (rest use segment start)`);

    // ── Step 3: Extract + merge ──────────────────────────────────────────────
    console.log('\n  [3/3] Extracting clips...');
    const clipPaths = await extractAllClips(videoPath, clips, clipsDir);

    console.log('\n        Merging...');
    await mergeClips(clipPaths, outputPath);

    const videoDuration = segments.length > 0
      ? segments[segments.length - 1].end
      : 0;
    const totalHighlightDuration = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    console.log('\n  ✅  Done!');
    console.log(`        ${clips.length} points | ${formatDuration(totalHighlightDuration)} of highlights`);
    console.log(`        Processing time: ${elapsed}s`);
    console.log(`        → ${outputPath}`);

    return outputPath;

  } catch (err) {
    console.error(`\n  ❌  Error processing ${path.basename(videoPath)}:`, err.message);
    return null;
  } finally {
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
