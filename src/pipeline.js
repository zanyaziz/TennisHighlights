/**
 * pipeline.js
 *
 * Orchestrates the full highlights extraction pipeline for one or many videos.
 *
 * Per-video flow:
 *   1. Audio analysis (librosa onset detection) → point segments  [primary]
 *      Motion analysis (OpenCV frame-diff)      → point segments  [secondary]
 *   2. Cross-validate: score segments by signal agreement
 *   3. Post-merge: collapse segments within postMergeGap of each other
 *   4. Serve detection (FFmpeg + blob tracking) → precise clip start times
 *   5. Clip extraction (FFmpeg)                 → individual point .mp4 files
 *   6. Merge (FFmpeg)                           → highlights video + best-of video
 *
 * processFolder() additionally stitches all per-video highlights into one
 * combined match_highlights.mp4.
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

function formatTime(seconds) {
  const m   = Math.floor(seconds / 60);
  const s   = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

/**
 * Merge any two adjacent segments separated by ≤ maxGap seconds.
 * Handles points split between audio/motion due to timing offsets.
 *
 * @param {{ start:number, end:number, confidence:number, source:string }[]} segments
 * @param {number} maxGap
 * @returns {{ start:number, end:number, confidence:number, source:string }[]}
 */
function mergeNearbySegments(segments, maxGap) {
  if (segments.length === 0) return [];
  const out = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    const curr = segments[i];
    if (curr.start - prev.end <= maxGap) {
      prev.end = Math.max(prev.end, curr.end);
      if (curr.confidence > prev.confidence) {
        prev.confidence = curr.confidence;
        prev.source     = curr.source;
      }
    } else {
      out.push({ ...curr });
    }
  }
  return out;
}

/**
 * Log suspected changeovers and set breaks based on gaps between segments.
 *
 * @param {{ start:number, end:number }[]} segments
 */
function logChangeovers(segments) {
  const breaks = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].start - segments[i - 1].end;
    if (gap >= config.changeoverGapThreshold) {
      breaks.push({ at: segments[i - 1].end, duration: gap });
    }
  }
  if (breaks.length === 0) return;

  console.log('\n        Breaks detected:');
  for (const b of breaks) {
    const label = b.duration >= 300 ? 'long break / end of file?'
                : b.duration >= 120 ? 'set break?'
                : 'changeover';
    console.log(`          ${formatTime(b.at)}  —  ${b.duration.toFixed(0)}s gap  (${label})`);
  }
}

// ── Single Video ──────────────────────────────────────────────────────────────

/**
 * Process a single video file end-to-end.
 *
 * @param {string} videoPath   - Absolute path to source video
 * @param {string} outputDir   - Directory for the output highlights video
 * @returns {Promise<string|null>} Path to the highlights video, or null if nothing found
 */
export async function processVideo(videoPath, outputDir) {
  const videoName  = path.basename(videoPath, path.extname(videoPath));
  const tempDir    = path.join(config.tempDir, videoName.replace(/\s/g, '_'));
  const clipsDir   = path.join(tempDir, 'clips');
  const outputPath = path.join(outputDir, `${videoName}_highlights.mp4`);

  console.log(`\n🎾  ${path.basename(videoPath)}`);
  console.log(`    Output → ${outputPath}`);
  const t0 = Date.now();

  await mkdir(tempDir,   { recursive: true });
  await mkdir(outputDir, { recursive: true });

  try {

    // ── Step 1: Segment detection (audio + motion, parallel) ───────────────
    console.log('\n  [1/3] Detecting play segments...');

    const [audioResult, motionResult] = await Promise.allSettled([
      analyzeAudio(videoPath, tempDir),
      analyzeMotion(videoPath, tempDir).then(d => findActiveSegments(d)),
    ]);

    const audioSegs  = audioResult.status  === 'fulfilled' ? audioResult.value.segments : [];
    const motionSegs = motionResult.status === 'fulfilled' ? motionResult.value          : [];

    if (audioResult.status  === 'rejected') console.log(`        ⚠ Audio analysis failed: ${audioResult.reason.message}`);
    if (motionResult.status === 'rejected') console.log(`        ⚠ Motion analysis failed: ${motionResult.reason.message}`);

    console.log(`        Audio:  ${audioSegs.length} segment(s)`);
    console.log(`        Motion: ${motionSegs.length} segment(s)`);

    // Cross-validate
    const validated = crossValidate(audioSegs, motionSegs, config.minSegmentOverlap);
    let segments    = validated.filter(s => s.confidence >= config.minSegmentConfidence);

    const nBoth   = segments.filter(s => s.source === 'both').length;
    const nAudio  = segments.filter(s => s.source === 'audio').length;
    const nMotion = segments.filter(s => s.source === 'motion').length;
    console.log(`\n        ${segments.length} segment(s) after cross-validation`);
    console.log(`        Confirmed by both: ${nBoth}  |  Audio-only: ${nAudio}  |  Motion-only: ${nMotion}`);

    // Post-merge: collapse segments within postMergeGap of each other
    const beforeMerge = segments.length;
    segments = mergeNearbySegments(segments, config.postMergeGap);
    if (segments.length < beforeMerge) {
      console.log(`        Post-merge: ${beforeMerge} → ${segments.length} segment(s) (collapsed ${beforeMerge - segments.length} nearby pair(s))`);
    }

    if (segments.length === 0) {
      console.log('\n  ⚠️   No play segments found.');
      console.log('       Tips:');
      console.log('       • Check that the video has audio (GoPro audio enabled)');
      console.log('       • Lower minSegmentConfidence in config.js to include single-signal segments');
      console.log('       • Lower audioGapThreshold or audioMinPointDuration in config.js');
      return null;
    }

    // Log changeovers / breaks
    logChangeovers(segments);

    const confidenceLabel = s =>
      s.source === 'both' ? '✓✓' : s.source === 'audio' ? '♪ ' : '▶ ';

    console.log('');
    segments.forEach((s, i) =>
      console.log(
        `        [${String(i + 1).padStart(2)}] ${confidenceLabel(s)} ` +
        `${formatTime(s.start)}  (${(s.end - s.start).toFixed(1)}s)`
      )
    );

    // ── Step 2: Serve detection ────────────────────────────────────────────
    console.log('\n  [2/3] Serve detection (ball toss)...');
    const serveData = await detectServes(videoPath, segments, tempDir);
    const clips     = buildClipList(serveData, segments);

    const nDetected = clips.filter(c => c.serveDetected).length;
    console.log(`        Serve located: ${nDetected}/${clips.length} via blob detection (rest use segment start)`);

    // ── Step 3: Extract clips ──────────────────────────────────────────────
    console.log('\n  [3/3] Extracting clips...');
    const clipPaths = await extractAllClips(videoPath, clips, clipsDir);

    // Main highlights (chronological)
    console.log('\n        Merging highlights...');
    await mergeClips(clipPaths, outputPath);

    // Best-of (top N by duration × confidence, re-sorted chronologically)
    if (config.bestOfCount > 0 && clips.length > config.bestOfCount) {
      const scored = clips.map((c, i) => ({
        ...c,
        filePath: clipPaths[i],
        score: (c.end - c.start) * c.confidence,
      }));
      const bestOf = scored
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, config.bestOfCount)
        .sort((a, b) => a.start - b.start);

      const bestOfPath = path.join(outputDir, `${videoName}_bestof.mp4`);
      console.log(`        Merging best-of (top ${config.bestOfCount} clips)...`);
      await mergeClips(bestOf.map(c => c.filePath), bestOfPath);
      console.log(`        → ${bestOfPath}`);
    }

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

// ── Folder / Match ────────────────────────────────────────────────────────────

/**
 * Process all video files found in inputDir, then stitch all per-video
 * highlights into a single match_highlights.mp4.
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

  const highlightPaths = [];
  for (const videoPath of videoFiles) {
    const out = await processVideo(videoPath, outputDir);
    if (out) highlightPaths.push(out);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`✅  Complete: ${highlightPaths.length}/${videoFiles.length} videos processed.`);

  // Stitch all per-video highlights into one combined match file
  if (highlightPaths.length > 1) {
    const matchPath = path.join(outputDir, 'match_highlights.mp4');
    console.log(`\n  Stitching ${highlightPaths.length} files into match highlights...`);
    try {
      await mergeClips(highlightPaths, matchPath);
      console.log(`  → ${matchPath}`);
    } catch (err) {
      console.error(`  ⚠ Could not stitch match highlights: ${err.message}`);
    }
  }

  if (highlightPaths.length > 0) {
    console.log(`\n  Output folder: ${outputDir}`);
  }
}
