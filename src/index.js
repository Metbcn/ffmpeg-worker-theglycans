const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { compose, getDuration } = require('./compose');
const { scheduleCleanup } = require('./cleanup');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FFMPEG_WORKER_API_KEY;
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/output';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

if (!API_KEY) {
  console.error('[FATAL] FFMPEG_WORKER_API_KEY not set. Exiting.');
  process.exit(1);
}

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    console.warn(`[AUTH] Rejected request from ${req.ip} — invalid or missing x-api-key`);
    return res.status(401).json({ success: false, error_code: 'UNAUTHORIZED', message: 'Invalid or missing x-api-key' });
  }
  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} => ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

app.use(requestLogger);

// ── Static output serving ───────────────────────────────────────────────────

app.use('/output', express.static(OUTPUT_DIR));

// ── Multer — audio upload ───────────────────────────────────────────────────

const AUDIO_DIR = path.join(OUTPUT_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const audioStorage = multer.diskStorage({
  destination: AUDIO_DIR,
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.mp3`)
});

const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'application/octet-stream'];
    cb(null, allowed.includes(file.mimetype) || file.originalname?.match(/\.(mp3|wav|webm|mpeg)$/i) != null);
  }
});

// ── Payload normalization ───────────────────────────────────────────────────
// Supports two incoming formats:
//
// Old (n8n current):  { VideoURL_1..4, VoiceURL, AudioURL, MusicStatus, durations[] }
// New (current):      { voice_url, videos: [{segment_index, url, target_duration_seconds}],
//                       durations[], style_profile, style_config, publish_enabled, environment }
//
// Both are normalized to the same internal shape before validation.
// style_profile and style_config are always forwarded regardless of format.

function normalizePayload(body) {
  // Style fields are format-independent
  const styleProfile = body.style_profile || null;
  const styleConfig  = body.style_config  || null;

  // Detect new format by presence of voice_url or videos array
  if (body.voice_url || Array.isArray(body.videos)) {
    const sorted = (body.videos || []).slice().sort(
      (a, b) => (a.segment_index ?? 0) - (b.segment_index ?? 0)
    );

    const videoUrls = sorted.map(v => v.url || v.video_url || null);

    // Use explicit durations[] if provided, else fall back to per-segment target_duration_seconds
    let durations;
    if (Array.isArray(body.durations) && body.durations.length === 4) {
      durations = body.durations.map(Number);
    } else {
      const perSegment = sorted.map(v => parseFloat(v.target_duration_seconds));
      durations = perSegment.every(n => !isNaN(n) && n > 0) ? perSegment : null;
    }

    return {
      voiceUrl:         body.voice_url || null,
      videoUrls,
      durations,
      audioUrl:         body.audio_url || body.AudioURL || null,
      musicStatus:      body.music_status || body.MusicStatus || 'skipped',
      publishEnabled:   body.publish_enabled ?? false,
      environment:      body.environment || 'production',
      styleProfile,
      styleConfig,
      subtitlesEnabled: body.subtitles_enabled ?? false,
      subtitleMode:     body.subtitle_mode || 'approximate',
      subtitleText:     body.subtitle_text || '',
      format:           'new'
    };
  }

  // Old format (no style_config expected, but accepted if present)
  const videoUrls = [
    body.VideoURL_1 || null,
    body.VideoURL_2 || null,
    body.VideoURL_3 || null,
    body.VideoURL_4 || null
  ];

  let durations = null;
  if (Array.isArray(body.durations) && body.durations.length === 4) {
    durations = body.durations.map(Number);
  }

  return {
    voiceUrl:         body.VoiceURL || null,
    videoUrls,
    durations,
    audioUrl:         body.AudioURL || null,
    musicStatus:      body.MusicStatus || 'skipped',
    publishEnabled:   false,
    environment:      'production',
    styleProfile,
    styleConfig,
    subtitlesEnabled: false,
    subtitleMode:     'approximate',
    subtitleText:     '',
    format:           'old'
  };
}

function validatePayload(p) {
  if (!p.voiceUrl) {
    return { valid: false, error_code: 'INVALID_PAYLOAD', message: 'Missing required field: VoiceURL / voice_url' };
  }
  if (!Array.isArray(p.videoUrls) || p.videoUrls.length !== 4) {
    return { valid: false, error_code: 'INVALID_PAYLOAD', message: `Expected 4 video URLs, got ${p.videoUrls?.length ?? 0}` };
  }
  const missing = p.videoUrls.map((u, i) => (!u ? `VideoURL_${i + 1}` : null)).filter(Boolean);
  if (missing.length > 0) {
    return { valid: false, error_code: 'INVALID_PAYLOAD', message: `Missing video URLs: ${missing.join(', ')}` };
  }
  const unique = new Set(p.videoUrls);
  if (unique.size < 4) {
    return {
      valid: false,
      error_code: 'INVALID_PAYLOAD',
      message: `Duplicate video URLs detected (${unique.size} unique of 4 required). All 4 clips must be distinct.`
    };
  }
  if (p.durations !== null) {
    if (p.durations.some(isNaN) || p.durations.some(d => d <= 0)) {
      return { valid: false, error_code: 'INVALID_PAYLOAD', message: 'durations must be 4 positive numbers (seconds per clip)' };
    }
  }
  return { valid: true };
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ffmpeg-worker',
    timestamp: new Date().toISOString(),
    version: '2.0.1',
    public_base_url: process.env.PUBLIC_BASE_URL || null,
    build_commit: '8ff8697',
    drawtext_ascii_fix: true,
    drawtext_sanitizer: 'ascii-normalized-v2'
  });
});

app.post('/upload-audio', requireApiKey, audioUpload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error_code: 'INVALID_PAYLOAD', message: 'No audio file received. Send field name: audio' });
  }

  const VoiceURL = `${PUBLIC_BASE_URL}/output/audio/${req.file.filename}`;
  console.log(`[UPLOAD] Audio saved => ${req.file.filename} (${(req.file.size / 1024).toFixed(0)} KB)`);

  let voice_duration_seconds = null;
  try {
    voice_duration_seconds = await getDuration(req.file.path);
    console.log(`[UPLOAD] Voice duration: ${voice_duration_seconds.toFixed(3)}s`);
  } catch (err) {
    console.warn(`[UPLOAD] Could not measure audio duration: ${err.message}`);
  }

  scheduleCleanup(req.file.path);

  return res.json({ VoiceURL, voice_duration_seconds });
});

app.post('/compose', requireApiKey, async (req, res) => {
  const normalized = normalizePayload(req.body);
  const validation = validatePayload(normalized);

  if (!validation.valid) {
    console.warn(`[COMPOSE] Invalid payload (${normalized.format} format): ${validation.message}`);
    return res.status(400).json({ success: false, error_code: validation.error_code, message: validation.message });
  }

  // Resolve final durations: validated array or default
  const durations = (normalized.durations && !normalized.durations.some(isNaN) && normalized.durations.every(d => d > 0))
    ? normalized.durations
    : [7.5, 7.5, 7.5, 7.5];

  if (!normalized.durations) {
    console.warn('[COMPOSE] No valid durations provided — using default [7.5, 7.5, 7.5, 7.5]');
  }

  console.log(
    `[COMPOSE] New job (${normalized.format} format) — durations: [${durations.join(', ')}], ` +
    `music: ${normalized.audioUrl ? 'yes' : 'no'}, MusicStatus: ${normalized.musicStatus}, ` +
    `env: ${normalized.environment}, publish: ${normalized.publishEnabled}, ` +
    `style_profile: ${normalized.styleProfile || 'scientific_clean'}`
  );

  try {
    const result = await compose({
      videoUrls:        normalized.videoUrls,
      durations,
      voiceUrl:         normalized.voiceUrl,
      audioUrl:         normalized.audioUrl || null,
      outputDir:        OUTPUT_DIR,
      styleProfile:     normalized.styleProfile,
      styleConfig:      normalized.styleConfig,
      subtitlesEnabled: normalized.subtitlesEnabled,
      subtitleMode:     normalized.subtitleMode,
      subtitleText:     normalized.subtitleText
    });

    const FinalVideoURL = `${PUBLIC_BASE_URL}/output/${result.filename}`;
    console.log(
      `[COMPOSE] Job ${result.jobId} complete => ${FinalVideoURL} ` +
      `| voice=${result.voice_duration_seconds.toFixed(2)}s ` +
      `| total=${result.total_duration.toFixed(2)}s`
    );

    scheduleCleanup(path.join(OUTPUT_DIR, result.filename));

    return res.json({
      success:                true,
      final_video_url:        FinalVideoURL,
      FinalVideoURL,                          // backward compatibility
      jobId:                  result.jobId,
      voice_duration_seconds: result.voice_duration_seconds,
      total_duration:         result.total_duration,
      clip_durations:         result.clip_durations,
      effective_durations:    result.effective_durations,
      style_profile:          result.style_profile,
      fallback_used:          result.fallback_used
    });

  } catch (err) {
    console.error(`[COMPOSE] Error:`, err.message);
    if (err.message.startsWith('CLIP_TOO_SHORT')) {
      return res.status(422).json({ success: false, error_code: 'CLIP_TOO_SHORT', message: err.message });
    }
    return res.status(500).json({ success: false, error_code: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── 404 ─────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ success: false, error_code: 'NOT_FOUND', message: 'Not found' });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[START] ffmpeg-worker v2.0.1 running on port ${PORT}`);
  console.log(`[START] Output dir: ${OUTPUT_DIR}`);
  console.log(`[START] Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`[START] drawtext sanitizer: ascii-normalized-v2`);
});
