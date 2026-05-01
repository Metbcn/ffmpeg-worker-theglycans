const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { download } = require('./download');

const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';

async function compose({ videoUrls, durations, voiceUrl, audioUrl, outputDir }) {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[${jobId}] Starting composition — ${videoUrls.length} clips, music: ${audioUrl ? 'yes' : 'none'}`);

  try {
    // ── 1. Download all assets in parallel ───────────────────────────────────
    const downloadTasks = videoUrls.map((url, i) =>
      download(url, path.join(jobDir, `clip_${i + 1}.mp4`))
    );
    downloadTasks.push(download(voiceUrl, path.join(jobDir, 'voice.mp3')));
    if (audioUrl) {
      downloadTasks.push(download(audioUrl, path.join(jobDir, 'music.mp3')));
    }

    await Promise.all(downloadTasks);
    console.log(`[${jobId}] All assets downloaded`);

    // ── 2. Build FFmpeg command ───────────────────────────────────────────────
    const outputFile = path.join(outputDir, `${jobId}.mp4`);
    const ffmpegArgs = buildFFmpegArgs({
      jobDir,
      durations,
      hasMusic: !!audioUrl,
      outputFile
    });

    // ── 3. Run FFmpeg ─────────────────────────────────────────────────────────
    await runFFmpeg(jobId, ffmpegArgs);
    console.log(`[${jobId}] FFmpeg complete → ${outputFile}`);

    return { jobId, filename: `${jobId}.mp4` };

  } finally {
    // ── 4. Clean up temp assets ───────────────────────────────────────────────
    fs.rmSync(jobDir, { recursive: true, force: true });
    console.log(`[${jobId}] Temp files cleaned`);
  }
}

function buildFFmpegArgs({ jobDir, durations, hasMusic, outputFile }) {
  // Input files
  const inputs = [];
  for (let i = 0; i < 4; i++) {
    inputs.push('-i', path.join(jobDir, `clip_${i + 1}.mp4`));
  }
  inputs.push('-i', path.join(jobDir, 'voice.mp3'));
  if (hasMusic) {
    inputs.push('-i', path.join(jobDir, 'music.mp3'));
  }

  // ── Filter complex ────────────────────────────────────────────────────────
  //
  // For each video clip:
  //   - Trim to its duration
  //   - Remove original audio (-an equivalent via filter)
  //   - Scale to 1080x1920 (9:16), pad with black bars if needed
  //   - Normalize SAR
  //
  // Then:
  //   - Concat 4 video streams into one 30s visual
  //   - Mix voice (100%) + optional music (12%)
  //   - Output combined audio
  //
  const vFilters = durations.map((dur, i) =>
    `[${i}:v]trim=0:${dur},setpts=PTS-STARTPTS,` +
    `scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`
  ).join('; ');

  const voiceIdx = 4;
  const musicIdx = 5;

  const totalDuration = durations.reduce((a, b) => a + b, 0); // 30

  let audioFilter;
  if (hasMusic) {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${totalDuration},atrim=0:${totalDuration},volume=1.0[voice]; ` +
      `[${musicIdx}:a]apad=pad_dur=${totalDuration},atrim=0:${totalDuration},volume=0.12[music]; ` +
      `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
  } else {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${totalDuration},atrim=0:${totalDuration},volume=1.0[aout]`;
  }

  const filterComplex =
    `${vFilters}; ` +
    `[v0][v1][v2][v3]concat=n=4:v=1:a=0[vout]; ` +
    audioFilter;

  return [
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-t', String(totalDuration),
    '-y',
    outputFile
  ];
}

function runFFmpeg(jobId, args) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] ffmpeg ${args.slice(-1)[0]}`);

    const proc = spawn('ffmpeg', args);
    const stderr = [];

    proc.stderr.on('data', chunk => {
      stderr.push(chunk.toString());
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        const log = stderr.join('').slice(-2000);
        console.error(`[${jobId}] ffmpeg exited with code ${code}\n${log}`);
        reject(new Error(`FFmpeg failed (exit ${code}). Last output:\n${log}`));
      }
    });

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Is FFmpeg installed?`));
    });
  });
}

module.exports = { compose };
