'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { download } = require('./download');
const {
  mergeStyleConfig,
  resolveZoom,
  clampMusicVolume,
  cleanCtaText,
  escapeDrawtext,
  resolveSubtitlePosition,
  resolveFontSize,
  getCropPosition,
  resolveEqParams,
  resolveTransitionType,
  FONT_FILE
} = require('./style');

const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';

// Tolerance before declaring CLIP_TOO_SHORT (seconds).
const FREEZE_TOLERANCE_S = 0.5;

// Crossfade overlap duration for FASE 6C xfade transitions.
const XFADE_DUR = 0.20;

// Per-clip fade-in/fade-out duration for 'fade' transitions.
const FADE_CLIP_DUR = 0.25;

// ── ffprobe duration helper ──────────────────────────────────────────────────

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

// ── Main composition entry point ─────────────────────────────────────────────
// styleProfile: string label (e.g. 'scientific_clean')
// styleConfig:  raw style_config object from the n8n payload (or null/undefined)

async function compose({ videoUrls, durations, voiceUrl, audioUrl, outputDir, styleProfile, styleConfig,
                          subtitlesEnabled = false, subtitleMode = 'approximate', subtitleText = '' }) {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Merge received config with safe defaults — guarantees all sub-blocks exist.
  const style = mergeStyleConfig(styleConfig);
  const profile = styleProfile || 'scientific_clean';

  console.log(`[${jobId}] Starting composition — ${videoUrls.length} clips, music: ${audioUrl ? 'yes' : 'none'}`);
  console.log(`[${jobId}] style_profile: ${profile}`);
  console.log(`[${jobId}] subtitle_style applied: font=${style.subtitle_style.font_style}, pos=${style.subtitle_style.position}`);
  console.log(`[${jobId}] motion_style: zoom=${style.motion_style.zoom_intensity}`);
  console.log(`[${jobId}] sound_style: music_volume=${style.sound_style.music_volume}`);
  console.log(`[${jobId}] transition_style: type=${style.transition_style.type}`);
  console.log(`[${jobId}] cta_style: text="${style.cta_style.text_overlay}"`);
  console.log(`[${jobId}] subtitles: ${subtitlesEnabled ? `enabled (${subtitleMode}, ${subtitleText.trim().split(/\s+/).length} words)` : 'disabled'}`);
  console.log(`[${jobId}] Declared durations: [${durations.join(', ')}]s`);

  try {
    // ── 1. Download all assets in parallel ─────────────────────────────────
    const downloadTasks = videoUrls.map((url, i) =>
      download(url, path.join(jobDir, `clip_${i + 1}.mp4`))
    );
    downloadTasks.push(download(voiceUrl, path.join(jobDir, 'voice.mp3')));
    if (audioUrl) {
      downloadTasks.push(download(audioUrl, path.join(jobDir, 'music.mp3')));
    }
    await Promise.all(downloadTasks);
    console.log(`[${jobId}] All assets downloaded`);

    // ── 2. Measure real durations with ffprobe ──────────────────────────────
    const [measuredVoiceDur, ...measuredClipDurs] = await Promise.all([
      getDuration(path.join(jobDir, 'voice.mp3')),
      ...videoUrls.map((_, i) => getDuration(path.join(jobDir, `clip_${i + 1}.mp4`)))
    ]);

    console.log(`[${jobId}] Voice:  ${measuredVoiceDur.toFixed(3)}s  (master clock)`);
    console.log(`[${jobId}] Clips:  [${measuredClipDurs.map(d => d.toFixed(3)).join(', ')}]s`);

    // ── 3. Calculate effective clip durations ───────────────────────────────
    // Scale declared proportions to voice duration, then cap at actual clip length.
    const declaredTotal = durations.reduce((a, b) => a + b, 0);
    const scaleFactor   = measuredVoiceDur / declaredTotal;

    const effectiveDurs = durations.map((d, i) => {
      const scaled = d * scaleFactor;
      const capped = Math.min(measuredClipDurs[i], scaled);
      return parseFloat(capped.toFixed(3));
    });

    const totalClipContent = parseFloat(effectiveDurs.reduce((a, b) => a + b, 0).toFixed(3));

    console.log(`[${jobId}] Effective: [${effectiveDurs.map(d => d.toFixed(3)).join(', ')}]s`);
    console.log(`[${jobId}] Clip total: ${totalClipContent.toFixed(3)}s  Voice: ${measuredVoiceDur.toFixed(3)}s`);

    // ── 4. Validate: clips must cover voice (or fill gap by looping) ───────
    // Loop fill is allowed when: coverage >= 85% OR gap <= 8s.
    // If both conditions fail → abort (gap too large and coverage too low).
    const LOOP_FILL_MIN_COVERAGE = 0.85; // 85%
    const LOOP_FILL_MAX_GAP_S    = 8.0;  // seconds
    let loopSegs = []; // { clipIdx, duration, label }

    const gap0     = measuredVoiceDur - totalClipContent;
    const coverage = totalClipContent / measuredVoiceDur;

    console.log(`[${jobId}] available_video_duration: ${totalClipContent.toFixed(3)}s`);
    console.log(`[${jobId}] voice_duration:           ${measuredVoiceDur.toFixed(3)}s`);
    console.log(`[${jobId}] gap:                      ${gap0.toFixed(3)}s`);
    console.log(`[${jobId}] coverage:                 ${(coverage * 100).toFixed(1)}%`);

    if (totalClipContent < measuredVoiceDur - FREEZE_TOLERANCE_S) {
      const canLoop = coverage >= LOOP_FILL_MIN_COVERAGE || gap0 <= LOOP_FILL_MAX_GAP_S;

      if (!canLoop) {
        console.log(`[${jobId}] loop_fill_applied: false — coverage ${(coverage * 100).toFixed(1)}% < 85% AND gap ${gap0.toFixed(2)}s > 8s`);
        throw new Error(
          `CLIP_TOO_SHORT: available clip content (${totalClipContent.toFixed(2)}s) ` +
          `cannot cover voice (${measuredVoiceDur.toFixed(2)}s). ` +
          `Gap: ${gap0.toFixed(2)}s, coverage: ${(coverage * 100).toFixed(1)}%. ` +
          `Loop fill requires coverage ≥ 85% or gap ≤ 8s. ` +
          `Measured clip durations: [${measuredClipDurs.map(d => d.toFixed(2)).join(', ')}]s. Aborting.`
        );
      }

      let gap = gap0;
      let iter = 0;
      while (gap > 0.05 && iter < 20) {
        const ci = iter % 4;
        const take = parseFloat(Math.min(measuredClipDurs[ci], gap).toFixed(3));
        loopSegs.push({ clipIdx: ci, duration: take, label: `lv${iter}` });
        gap -= take;
        iter++;
      }

      const extraAdded = loopSegs.reduce((a, s) => a + s.duration, 0);
      console.log(`[${jobId}] loop_fill_applied:          true`);
      console.log(`[${jobId}] source_clip_used_for_loop:  ${loopSegs.map(s => `clip${s.clipIdx + 1}`).join(', ')}`);
      console.log(`[${jobId}] extra_duration_added:       ${extraAdded.toFixed(3)}s`);
    } else {
      console.log(`[${jobId}] loop_fill_applied: false — clips cover voice (no gap)`);
    }

    const targetDuration = parseFloat(measuredVoiceDur.toFixed(3));
    const outputFile = path.join(outputDir, `${jobId}.mp4`);

    // ── 5. Build styled FFmpeg args; fall back to simple on any error ───────
    let usedFallback = false;
    let fallbackReason = null;
    let ffmpegArgs;

    try {
      ffmpegArgs = buildStyledFFmpegArgs({
        jobDir, effectiveDurs, measuredClipDurs, targetDuration,
        hasMusic: !!audioUrl, outputFile, style, loopSegs,
        subtitlesEnabled, subtitleMode, subtitleText
      });
    } catch (buildErr) {
      fallbackReason = `filter_build: ${buildErr.message}`;
      console.warn(`[${jobId}] FALLBACK (filter build): ${buildErr.message}`);
      ffmpegArgs = buildSimpleFFmpegArgs({ jobDir, effectiveDurs, loopSegs, targetDuration, hasMusic: !!audioUrl, outputFile });
      usedFallback = true;
    }

    try {
      await runFFmpeg(jobId, ffmpegArgs);
    } catch (ffmpegErr) {
      if (usedFallback) throw ffmpegErr; // simple render also failed → propagate
      fallbackReason = `ffmpeg_error: ${ffmpegErr.message.slice(0, 400)}`;
      console.warn(`[${jobId}] FALLBACK (FFmpeg error): ${ffmpegErr.message.slice(0, 200)}`);
      const simpleArgs = buildSimpleFFmpegArgs({ jobDir, effectiveDurs, targetDuration, hasMusic: !!audioUrl, outputFile });
      await runFFmpeg(jobId, simpleArgs);
      usedFallback = true;
      console.log(`[${jobId}] Fallback simple render succeeded`);
    }

    if (!usedFallback) {
      console.log(`[${jobId}] Styled render complete → ${outputFile}`);
      console.log(`[${jobId}] visual_identity applied: eq filter active`);
    }

    return {
      jobId,
      filename:               `${jobId}.mp4`,
      voice_duration_seconds: measuredVoiceDur,
      clip_durations:         measuredClipDurs,
      effective_durations:    effectiveDurs,
      total_duration:         targetDuration,
      style_profile:          profile,
      fallback_used:          usedFallback,
      fallback_reason:        fallbackReason
    };

  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
    console.log(`[${jobId}] Temp files cleaned`);
  }
}

// ── FASE 6D-LITE: Approximate subtitle filter chain ──────────────────────────
// Splits guion text into equal-duration chunks and renders each via drawtext.
// Uses 10 words/chunk (max 15 chunks) to keep the filter chain manageable.
// Positioned at y=h-text_h-220 so it never overlaps the CTA (at h-text_h-80).
function buildSubtitleFilters({ text, voiceDuration, fontFile, fontStyle, inputLabel }) {
  const words = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length < 3) return { filterChain: '', outputLabel: inputLabel };

  const WORDS_PER_CHUNK = 10;
  const MAX_CHUNKS      = 15;
  const allChunks = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
    allChunks.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
  }
  const chunks   = allChunks.slice(0, MAX_CHUNKS);
  const chunkDur = voiceDuration / chunks.length;
  const fontSize = Math.max(34, (resolveFontSize(fontStyle) || 48) - 14);

  const parts = [];
  let prevLabel = inputLabel;

  chunks.forEach((chunk, i) => {
    const safe = escapeDrawtext(chunk);
    if (!safe) return;
    const start     = parseFloat((i * chunkDur).toFixed(2));
    const end       = parseFloat(Math.min((i + 1) * chunkDur, voiceDuration).toFixed(2));
    const nextLabel = i === chunks.length - 1 ? '[vwithsubs]' : `[sub${i}]`;
    parts.push(
      `${prevLabel}drawtext=fontfile=${fontFile}:text='${safe}':fontsize=${fontSize}:` +
      `fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10:` +
      `x=(w-text_w)/2:y=h-text_h-220:` +
      `enable='between(t,${start},${end})'${nextLabel}`
    );
    prevLabel = nextLabel;
  });

  if (parts.length === 0) return { filterChain: '', outputLabel: inputLabel };
  return { filterChain: '; ' + parts.join('; '), outputLabel: prevLabel };
}

// ── Simple fallback renderer (no style) ─────────────────────────────────────
// Identical to the original v1.x buildFFmpegArgs.
function buildSimpleFFmpegArgs({ jobDir, effectiveDurs, loopSegs = [], targetDuration, hasMusic, outputFile }) {
  const inputs = [];
  for (let i = 0; i < 4; i++) inputs.push('-i', path.join(jobDir, `clip_${i + 1}.mp4`));
  inputs.push('-i', path.join(jobDir, 'voice.mp3'));
  if (hasMusic) inputs.push('-i', path.join(jobDir, 'music.mp3'));

  const voiceIdx = 4;
  const musicIdx = 5;

  const vFilters = effectiveDurs.map((dur, i) =>
    `[${i}:v]trim=0:${dur},setpts=PTS-STARTPTS,` +
    `scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`
  ).join('; ');

  const loopFilters = loopSegs.map(({ clipIdx, duration, label }) =>
    `[${clipIdx}:v]trim=0:${duration},setpts=PTS-STARTPTS,` +
    `scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[${label}]`
  ).join('; ');

  const totalSegs = 4 + loopSegs.length;
  const loopLabels = loopSegs.map(s => `[${s.label}]`).join('');
  const concatFilter = `[v0][v1][v2][v3]${loopLabels}concat=n=${totalSegs}:v=1:a=0[vout]`;

  let audioFilter;
  if (hasMusic) {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=1.0[voice]; ` +
      `[${musicIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=0.10[music]; ` +
      `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
  } else {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=1.0[aout]`;
  }

  const allVFilters = loopFilters ? `${vFilters}; ${loopFilters}` : vFilters;
  const filterComplex = `${allVFilters}; ${concatFilter}; ${audioFilter}`;

  return [
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', String(targetDuration), '-y', outputFile
  ];
}

// ── Styled renderer (FASE 6A + 6B + 6C) ─────────────────────────────────────

function buildStyledFFmpegArgs({ jobDir, effectiveDurs, measuredClipDurs, targetDuration, hasMusic, outputFile, style, loopSegs = [],
                                  subtitlesEnabled = false, subtitleMode = 'approximate', subtitleText = '' }) {
  // ── FASE 6B: zoom multiplier ──────────────────────────────────────────────
  const zoomMult   = resolveZoom(style.motion_style.zoom_intensity);
  const applyZoom  = zoomMult > 1.005;

  // ── FASE 6A: visual identity eq filter string ─────────────────────────────
  const eqParams = resolveEqParams(style.visual_identity);
  const eqFilter = eqParams
    ? `eq=contrast=${eqParams.contrast}:brightness=${eqParams.brightness}:saturation=${eqParams.saturation}`
    : null;

  // ── FASE 6C: transition mode ──────────────────────────────────────────────
  const rawTransType  = style.transition_style.type;
  const resolvedTrans = resolveTransitionType(rawTransType);
  const useFadeTrans  = resolvedTrans === 'fade'; // fade-in/out per clip + concat
  const useXfade      = !useFadeTrans;             // wipeleft / wiperight / smooth*

  // For xfade: extend each clip by the amount needed to cover the overlap,
  // so total video output = targetDuration exactly.
  // Extra per clip = (XFADE_DUR * num_transitions) / num_clips = (0.2*3)/4 = 0.15s
  const numClips      = effectiveDurs.length;          // 4
  const numTransitions = numClips - 1;                 // 3
  const xfadeExtra    = (XFADE_DUR * numTransitions) / numClips;

  let clipDurs = effectiveDurs; // default: use as-is
  if (useXfade) {
    // Try to extend each clip; fall back to original if the actual clip is too short.
    const extended = effectiveDurs.map((d, i) => {
      const ext = parseFloat((d + xfadeExtra).toFixed(3));
      return ext <= measuredClipDurs[i] + 0.01 ? ext : d;
    });
    const allExtended = extended.every((d, i) => d > effectiveDurs[i] - 0.001);
    clipDurs = allExtended ? extended : effectiveDurs;
    if (!allExtended) {
      // Not enough content to safely do xfade — downgrade to fade
      console.warn('[STYLED] xfade downgraded to fade (clips too short for overlap)');
    }
  }

  // ── Per-clip video filter builder ─────────────────────────────────────────
  // FASE 6B: Ken Burns (scale-up + animated crop)
  // FASE 6A: eq visual identity
  // FASE 6C: per-clip fade-in/out (only for 'fade' mode)
  function buildClipFilter(i) {
    const dur = clipDurs[i];
    let f = `[${i}:v]trim=0:${dur},setpts=PTS-STARTPTS,`;
    f += `scale=1080:1920:force_original_aspect_ratio=decrease,`;
    f += `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;

    // FASE 6.1 — directional Ken Burns: each clip uses a distinct corner anchor
    // Clip 0: TL→center, Clip 1: TR→center, Clip 2: BL→center, Clip 3: BR→center
    if (applyZoom) {
      const sw       = Math.round(1080 * zoomMult / 2) * 2; // even dimensions
      const sh       = Math.round(1920 * zoomMult / 2) * 2;
      const halfOffX = (sw - 1080) / 2;
      const halfOffY = (sh - 1920) / 2;
      const cropPos  = getCropPosition(i, halfOffX, halfOffY, dur);
      f += `,scale=${sw}:${sh}`;
      f += `,crop=1080:1920:'${cropPos.x}':'${cropPos.y}',setsar=1`;
    }

    // FASE 6A — visual identity: contrast / brightness / saturation
    if (eqFilter) {
      f += `,${eqFilter}`;
    }

    // FASE 6C — fade-in/out per clip (only when NOT using xfade)
    if (useFadeTrans && dur > FADE_CLIP_DUR * 3) {
      f += `,fade=in:st=0:d=${FADE_CLIP_DUR}`;
      f += `,fade=out:st=${(dur - FADE_CLIP_DUR).toFixed(3)}:d=${FADE_CLIP_DUR}`;
    }

    f += `[v${i}]`;
    return f;
  }

  const vFilters = clipDurs.map((_, i) => buildClipFilter(i)).join('; ');

  // ── FASE 6C — join clips ──────────────────────────────────────────────────
  let joinFilter;
  if (useXfade && clipDurs !== effectiveDurs) {
    // Build xfade chain: [v0][v1]xfade…[vt01]; [vt01][v2]xfade…[vt012]; ...
    let cumOffset = 0;
    const xfParts = [];
    let prevLabel = 'v0';
    for (let i = 0; i < numTransitions; i++) {
      cumOffset += clipDurs[i] - XFADE_DUR;
      const nextLabel = i < numTransitions - 1 ? `vt0${i + 2}` : 'vmerged';
      xfParts.push(
        `[${prevLabel}][v${i + 1}]xfade=transition=${resolvedTrans}:duration=${XFADE_DUR}:` +
        `offset=${parseFloat(cumOffset.toFixed(3))}[${nextLabel}]`
      );
      prevLabel = nextLabel;
    }
    joinFilter = xfParts.join('; ');
  } else {
    // Simple concat (works with fade-in/out per clip or plain clips)
    joinFilter = `[v0][v1][v2][v3]concat=n=4:v=1:a=0[vmerged]`;
  }

  // ── Loop fill segments (when clips shorter than voice) ───────────────────
  let loopVFilters = '';
  let afterLoopsLabel = '[vmerged]';
  if (loopSegs.length > 0) {
    const lfs = loopSegs.map(({ clipIdx, duration, label }) => {
      let f = `[${clipIdx}:v]trim=0:${duration},setpts=PTS-STARTPTS,`;
      f += `scale=1080:1920:force_original_aspect_ratio=decrease,`;
      f += `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
      if (eqFilter) f += `,${eqFilter}`;
      f += `[${label}]`;
      return f;
    });
    const loopLabels = loopSegs.map(s => `[${s.label}]`).join('');
    afterLoopsLabel = '[vlooped]';
    loopVFilters = `; ${lfs.join('; ')}; [vmerged]${loopLabels}concat=n=${1 + loopSegs.length}:v=1:a=0[vlooped]`;
    console.log(`[STYLED] Loop fill: ${loopSegs.length} segment(s) appended`);
  }

  // ── FASE 6D-LITE — Approximate subtitles ────────────────────────────────────
  let subFilterChain = '';
  let afterSubsLabel = afterLoopsLabel;

  if (subtitlesEnabled && subtitleText && subtitleText.trim().length > 10) {
    try {
      const subResult = buildSubtitleFilters({
        text:          subtitleText,
        voiceDuration: targetDuration,
        fontFile:      FONT_FILE,
        fontStyle:     style.subtitle_style.font_style,
        inputLabel:    afterLoopsLabel
      });
      if (subResult.filterChain) {
        subFilterChain = subResult.filterChain;
        afterSubsLabel = subResult.outputLabel;
        console.log(`[STYLED] Subtitles: ${subtitleText.trim().split(/\s+/).length} words → ${subResult.filterChain.split('; ').length - 1} chunks over ${targetDuration.toFixed(1)}s`);
      }
    } catch (subErr) {
      console.warn(`[STYLED] Subtitle filter build failed: ${subErr.message} — skipping subtitles`);
    }
  } else {
    console.log('[STYLED] Subtitles: disabled or no text');
  }

  // ── FASE 6.1 — CTA text overlay (improved visibility) ────────────────────
  // cleanCtaText detects encoding corruption (? inside words) before escaping.
  const ctaRaw  = cleanCtaText(style.cta_style.text_overlay || '');
  const ctaText = escapeDrawtext(ctaRaw);
  let ctaFilter    = '';
  let finalVLabel  = afterSubsLabel;

  if (ctaText.length > 0) {
    const fontSize  = resolveFontSize(style.subtitle_style.font_style) + 4;
    const pos       = resolveSubtitlePosition(style.subtitle_style.position);
    // CTA: last 4s or last 20% of video, whichever is longer
    const ctaStart  = Math.max(targetDuration - 4.0, targetDuration * 0.80).toFixed(2);
    ctaFilter =
      `; ${afterSubsLabel}drawtext=` +
      `fontfile=${FONT_FILE}:` +
      `text='${ctaText}':` +
      `fontsize=${fontSize}:` +
      `fontcolor=white:` +
      `box=1:boxcolor=black@0.70:boxborderw=18:` +
      `x=${pos.x}:y=${pos.y}:` +
      `enable='gte(t,${ctaStart})'` +
      `[vout]`;
    finalVLabel = '[vout]';
    console.log(`[STYLED] CTA overlay: "${ctaText}" @ t>=${ctaStart}s (font+4, box 70%)`);
  } else {
    console.log('[STYLED] CTA skipped: no text_overlay');
  }

  // ── FASE 6A — Audio with configurable music volume ────────────────────────
  const voiceIdx  = 4;
  const musicIdx  = 5;
  const musicVol  = clampMusicVolume(style.sound_style.music_volume);
  let audioFilter;

  if (hasMusic) {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=1.0[voice]; ` +
      `[${musicIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=${musicVol}[music]; ` +
      `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
    console.log(`[STYLED] sound_style applied: music_volume=${musicVol}`);
  } else {
    audioFilter =
      `[${voiceIdx}:a]apad=pad_dur=${targetDuration},atrim=0:${targetDuration},volume=1.0[aout]`;
    console.log('[STYLED] sound_style: no music track');
  }

  // ── Assemble filter_complex ───────────────────────────────────────────────
  const filterComplex =
    `${vFilters}; ` +
    `${joinFilter}` +
    `${loopVFilters}` +
    `${subFilterChain}` +
    `${ctaFilter}; ` +
    audioFilter;

  // ── Build inputs list ─────────────────────────────────────────────────────
  const inputs = [];
  for (let i = 0; i < 4; i++) inputs.push('-i', path.join(jobDir, `clip_${i + 1}.mp4`));
  inputs.push('-i', path.join(jobDir, 'voice.mp3'));
  if (hasMusic) inputs.push('-i', path.join(jobDir, 'music.mp3'));

  return [
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', finalVLabel,
    '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', String(targetDuration), '-y', outputFile
  ];
}

// ── FFmpeg runner ─────────────────────────────────────────────────────────────

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
