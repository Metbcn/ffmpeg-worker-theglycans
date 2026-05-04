const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { download } = require('./download');

const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';

// Tolerance before declaring CLIP_TOO_SHORT (seconds).
// Allows for ffprobe float rounding but rejects genuinely short clips.
const FREEZE_TOLERANCE_S = 0.5;

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(
          `ffprobe failed on ${path.basename(filePath)}: ${err.trim().slice(-200)}`
        ));
      }
      const dur = parseFloat(out.trim());
      if (isNaN(dur) || dur <= 0) {
        return reject(new Error(
          `ffprobe returned invalid duration for ${path.basename(filePath)}: "${out.trim()}"`
        ));
      }
      resolve(dur);
    });
    proc.on('error', e => reject(new Error(`Failed to spawn ffprobe: ${e.message}`)));
  });
}

async function compose({ videoUrls, durations, voiceUrl, audioUrl, outputDir }) {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[${jobId}] Starting composition — ${videoUrls.length} clips, music: ${audioUrl ? 'yes' : 'none'}`);
  console.log(`[${jobId}] Declared durations: [${durations.join(', ')}]s`);

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

    // ── 2. Measure real durations with ffprobe ────────────────────────────────
    const [measuredVoiceDur, ...measuredClipDurs] = await Promise.all([
      getDuration(path.join(jobDir, 'voice.mp3')),
      ...videoUrls.map((_, i) => getDuration(path.join(jobDir, `clip_${i + 1}.mp4`)))
    ]);

    console.log(`[${jobId}] Voice:  ${measuredVoiceDur.toFixed(3)}s  (master clock)`);
    console.log(`[${jobId}] Clips:  [${measuredClipDurs.map(d => d.toFixed(3)).join(', ')}]s`);

    // ── 3. Calculate effective clip durations ─────────────────────────────────
    // Scale declared proportions to fit voice duration, then cap at actual clip length.
    // Voice is the master clock: video total = voice_duration.
    const declaredTotal = durations.reduce((a, b) => a + b, 0);
    const scaleFactor   = measuredVoiceDur / declaredTotal;

    const effectiveDurs = durations.map((d, i) => {
      const scaled = d * scaleFactor;
      const capped = Math.min(measuredClipDurs[i], scaled);
      return parseFloat(capped.toFixed(3));
    });

    const totalClipContent = parseFloat(
      effectiveDurs.reduce((a, b) => a + b, 0).toFixed(3)
    );

    console.log(`[${jobId}] Effective: [${effectiveDurs.map(d => d.toFixed(3)).join(', ')}]s`);
    console.log(`[${jobId}] Clip total: ${totalClipContent.toFixed(3)}s  Voice: ${measuredVoiceDur.toFixed(3)}s`);

    // ── 4. Validate: clips must fully cover voice ─────────────────────────────
    if (totalClipContent < measuredVoiceDur - FREEZE_TOLERANCE_S) {
      throw new Error(
        `CLIP_TOO_SHORT: available clip content (${totalClipContent.toFixed(2)}s) ` +
        `cannot cover voice (${measuredVoiceDur.toFixed(2)}s). ` +
        `Measured clip durations: [${measuredClipDurs.map(d => d.toFixed(2)).join(', ')}]s. ` +
        `Video would freeze on last frame. Aborting.`
      );
    }

    // targetDuration = voice duration (video cut to match, no frozen tail).
    // If clips provide more content than voice, the surplus is discarded by -t.
    const targetDuration = parseFloat(measuredVoiceDur.toFixed(3));

    // ── 5. Build and run FFmpeg ───────────────────────────────────────────────
    const outputFile = path.join(outputDir, `${jobId}.mp4`);
    const ffmpegArgs  = buildFFmpegArgs({
      jobDir,
      effectiveDurs,
      targetDuration,
      hasMusic: !!audioUrl,
      outputFile
    });

    await runFFmpeg(jobId, ffmpegArgs);
    console.log(`[${jobId}] FFmpeg complete → ${outputFile}`);

    return {
      jobId,
      filename: `${jobId}.mp4`,
      voice_duration_seconds: measuredVoiceDur,
      clip_durations:         measuredClipDurs,
      effective_durations:    effectiveDurs,
      total_duration:         targetDuration
    };

  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
    console.log(`[${jobId}] Temp files cleaned`);
  }
}

function buildFFmpegArgs({ jobDir, effectiveDurs, targetDuration, hasMusic, outputFile }) {
  const inputs = [];
  for (let i = 0; i < 4; i++) {
    inputs.push('-i', path.join(jobDir, `clip_${i + 1}.mp4`));
  }
  inputs.push('-i', path.join(jobDir, 'voice.mp3'));
  if (hasMusic) {
    inputs.push('-i', path.join(jobDir, 'music.mp3'));
  }

  // ── Filter complex ─────────────────────────────────────────────────────────
  // Each clip: trim to its effective duration (never exceeds actual content),
  //            scale to 1080x1920 (9:16), pad black bars if needed.
  const vFilters = effectiveDurs.map((dur, i) =>
    `[${i}:v]trim=0:${dur},setpts=PTS-STARTPTS,` +
    `scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`
  ).join('; ');

  const voiceIdx = 4;
  const musicIdx = 5;

  // Voice: apad guards against sub-millisecond underruns, atrim cuts to targetDuration.
  // Music: apad fills gaps if music < voice, atrim ensures no overflow.
  let audioFilter;
  if (hasMusic) {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=1.0[voice]; ` +
      `[${musicIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=0.12[music]; ` +
      `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
  } else {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=1.0[aout]`;
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
    '-t', String(targetDuration),
    '-y',
    outputFile
  ];
}

function runFFmpeg(jobId, args) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] ffmpeg → ${args[args.length - 1]}`);
    const proc = spawn('ffmpeg', args);
    const stderr = [];
    proc.stderr.on('data', chunk => stderr.push(chunk.toString()));
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

module.exports = { compose, getDuration };
