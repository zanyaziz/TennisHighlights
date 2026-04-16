#!/usr/bin/env node
/**
 * tennis-highlights CLI
 *
 * Usage:
 *   node index.js process <inputDir> <outputDir>    # process all videos in a folder
 *   node index.js single  <videoFile> <outputDir>   # process one video
 */

import { Command } from 'commander';
import path from 'path';
import { processFolder, processVideo } from './src/pipeline.js';

const program = new Command();

program
  .name('tennis-highlights')
  .description('Extract tennis highlights from GoPro footage — gameplay only, no dead time.')
  .version('1.0.0');

// ── process command ───────────────────────────────────────────────────────────
program
  .command('process')
  .description('Process all video files in a folder')
  .argument('<inputDir>',  'Folder containing GoPro .mp4 / .mov videos')
  .argument('<outputDir>', 'Folder where highlight videos will be saved')
  .action(async (inputDir, outputDir) => {
    await processFolder(
      path.resolve(inputDir),
      path.resolve(outputDir)
    );
  });

// ── single command ────────────────────────────────────────────────────────────
program
  .command('single')
  .description('Process a single video file')
  .argument('<videoFile>',  'Path to the GoPro video')
  .argument('<outputDir>',  'Folder where the highlight video will be saved')
  .action(async (videoFile, outputDir) => {
    await processVideo(
      path.resolve(videoFile),
      path.resolve(outputDir)
    );
  });

program.parse();
