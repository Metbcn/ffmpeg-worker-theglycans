'use strict';

// ── Default style config (scientific_clean profile) ──────────────────────────
// Used when style_config is absent or a sub-block is missing.
const DEFAULT_STYLE_CONFIG = {
  subtitle_style: {
    enabled:            true,
    font_style:         'clean_white',
    position:           'bottom_center',
    highlight_keywords: false,
    emoji_mode:         'none'
  },
  motion_style: {
    zoom_intensity:  'low',
    camera_movement: 'static',
    cut_pace:        'slow'
  },
  transition_style: {
    type:      'fade',
    intensity: 'soft'
  },
  sound_style: {
    sound_fx_enabled: false,
    sound_fx_type:    'none',
    music_mood:       'minimal_ambient',
    music_volume:     0.08
  },
  cta_style: {
    tone:          'educational_calm',
    text_overlay:  '',
    urgency_level: 'low'
  },
  visual_identity: {
    professional:        true,
    clear:               true,
    educational:         true,
    healthy:             true,
    non_aggressive_sales: true
  }
};

function getDefaultStyleConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_STYLE_CONFIG));
}

// Deep-merge received config with defaults so every sub-block is always present.
function mergeStyleConfig(received) {
  const d = getDefaultStyleConfig();
  if (!received || typeof received !== 'object') return d;
  return {
    subtitle_style:   { ...d.subtitle_style,   ...(received.subtitle_style   || {}) },
    motion_style:     { ...d.motion_style,     ...(received.motion_style     || {}) },
    transition_style: { ...d.transition_style, ...(received.transition_style || {}) },
    sound_style:      { ...d.sound_style,      ...(received.sound_style      || {}) },
    cta_style:        { ...d.cta_style,        ...(received.cta_style        || {}) },
    visual_identity:  { ...d.visual_identity,  ...(received.visual_identity  || {}) }
  };
}

// ── FASE 6B: Zoom resolution ─────────────────────────────────────────────────
// Maps string labels to numeric multipliers. Spec: min 1.00, max 1.08.
const ZOOM_MAP = {
  'static':      1.00,
  'low':         1.02,
  'medium_low':  1.03,
  'slow_drift':  1.02,
  'slow_zoom':   1.03,
  'gentle_zoom': 1.03,
  'medium_slow': 1.03,
  'medium':      1.04,
  'push_in':     1.05,
  'high':        1.06
};

function resolveZoom(zoom_intensity) {
  if (typeof zoom_intensity === 'number') {
    return Math.min(Math.max(zoom_intensity, 1.0), 1.08);
  }
  return ZOOM_MAP[zoom_intensity] ?? 1.02;
}

// ── FASE 6A: Audio ───────────────────────────────────────────────────────────
// Clamp music_volume to [0.05 – 0.18] so voice always stays dominant.
function clampMusicVolume(vol) {
  const v = parseFloat(vol);
  return isNaN(v) ? 0.10 : Math.min(Math.max(v, 0.05), 0.18);
}

// ── FASE 6A: CTA text escape for FFmpeg drawtext ─────────────────────────────
// Removes emojis and chars that could break the drawtext filter parser.
function escapeDrawtext(text) {
  if (!text || typeof text !== 'string') return '';
  const safe = text
    .replace(/[^ -~À-ɏ]/gu, '') // keep printable ASCII + Latin Extended
    .trim()
    .slice(0, 80);
  if (!safe) return '';
  return safe
    .replace(/\\/g, '\\\\')
    .replace(/:/g,  '\\:')
    .replace(/'/g,  "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

// ── FASE 6A: Subtitle positioning ────────────────────────────────────────────
function resolveSubtitlePosition(position) {
  switch (position) {
    case 'center':     return { x: '(w-text_w)/2', y: '(h-text_h)/2' };
    case 'top_center': return { x: '(w-text_w)/2', y: '80' };
    default:           return { x: '(w-text_w)/2', y: 'h-text_h-80' }; // bottom_center
  }
}

// ── FASE 6A: Font size per style ─────────────────────────────────────────────
const FONT_SIZE_MAP = {
  'clean_white':           52,
  'bold_dynamic':          62,
  'elegant_serif':         48,
  'clean_bold':            58,
  'warm_rounded':          54,
  'high_contrast_minimal': 60
};

function resolveFontSize(font_style) {
  return FONT_SIZE_MAP[font_style] ?? 52;
}

// ── FASE 6A: Visual identity → eq filter params ───────────────────────────────
// Returns { contrast, brightness, saturation } or null if no adjustment needed.
function resolveEqParams(visual_identity) {
  if (!visual_identity || typeof visual_identity !== 'object') return null;
  const contrast   = visual_identity.professional ? 1.04  : 1.0;
  const brightness = visual_identity.clear        ? 0.015 : 0.0;
  const saturation = visual_identity.healthy      ? 1.06  : 1.0;
  if (contrast === 1.0 && brightness === 0.0 && saturation === 1.0) return null;
  return { contrast, brightness, saturation };
}

// ── FASE 6C: Transition type validation ──────────────────────────────────────
// Only allow types that are stable in ffmpeg xfade; everything else → 'fade'.
const SAFE_XFADE_TYPES = new Set(['fade', 'wipeleft', 'wiperight', 'smoothleft', 'smoothright']);

function resolveTransitionType(type) {
  return SAFE_XFADE_TYPES.has(type) ? type : 'fade';
}

// Font file used for drawtext. DejaVu is installed in the Dockerfile.
const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

module.exports = {
  getDefaultStyleConfig,
  mergeStyleConfig,
  resolveZoom,
  clampMusicVolume,
  escapeDrawtext,
  resolveSubtitlePosition,
  resolveFontSize,
  resolveEqParams,
  resolveTransitionType,
  SAFE_XFADE_TYPES,
  FONT_FILE
};
