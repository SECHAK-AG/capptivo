//! Caption clock: which cue is on screen and which word is highlighted.
//!
//! Ported from `captions/captionTiming.ts`. Layout and drawing live in the
//! renderer's text module; this is the time-only part.

use crate::document::{CaptionCue, CaptionWord};
use crate::math::{js_max, js_min};

const CUE_POST_ROLL_SEC: f64 = 0.22;
const CUE_NEXT_LEAD_IN_SEC: f64 = 0.04;
const WORD_SYNC_EPS_SEC: f64 = 0.018;
const WORD_PARTITION_MIN_SEC: f64 = 0.02;

/// A word ready to draw (`TimedDrawWord`).
#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub leading_space: bool,
}

/// How a cue draws (`CuePrep`).
#[derive(Debug, Clone, PartialEq)]
enum CuePrep {
    /// Whisper word timings: karaoke follows them.
    Words {
        words: Vec<TimedWord>,
        order: Vec<usize>,
    },
    /// No usable timings: draw the cue text, no highlight.
    NoTimings,
    /// Timings exist but none fall inside the cue: draw nothing.
    Empty,
}

/// The cue on screen at a time, with its words and the highlighted index.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveCue<'a> {
    pub cue_index: usize,
    pub cue: &'a CaptionCue,
    /// Empty for a cue without word timings.
    pub words: &'a [TimedWord],
    /// −1 when no word is active.
    pub active_word_index: isize,
}

fn is_valid_word(w: &CaptionWord) -> bool {
    !w.text.trim().is_empty()
        && w.start_ms.is_finite()
        && w.end_ms.is_finite()
        && w.end_ms > w.start_ms
}

fn prepare(cue: &CaptionCue) -> CuePrep {
    let Some(words) = cue.words.as_ref().filter(|w| !w.is_empty()) else {
        return CuePrep::NoTimings;
    };
    if !words.iter().all(is_valid_word) {
        return CuePrep::NoTimings;
    }
    let lo = cue.start_ms / 1000.0 - 1e-3;
    let hi = cue.end_ms / 1000.0 + 1e-3;
    let words: Vec<TimedWord> = words
        .iter()
        .filter(|w| is_valid_word(w))
        .map(|w| TimedWord {
            text: w.text.trim().to_string(),
            start_sec: w.start_ms / 1000.0,
            end_sec: w.end_ms / 1000.0,
            leading_space: w.leading_space.unwrap_or(false),
        })
        .filter(|w| w.end_sec > lo && w.start_sec < hi)
        .collect();
    if words.is_empty() {
        return CuePrep::Empty;
    }
    let mut order: Vec<usize> = (0..words.len()).collect();
    // Stable sort by start, then end — `karaokeOrder`'s comparator.
    order.sort_by(|&ia, &ib| {
        let da = words[ia].start_sec - words[ib].start_sec;
        let key = if da.abs() > 1e-6 {
            da
        } else {
            words[ia].end_sec - words[ib].end_sec
        };
        key.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    CuePrep::Words { words, order }
}

fn pick_cue_index(cues: &[CaptionCue], time_sec: f64) -> Option<usize> {
    let first = cues.first()?;
    if time_sec < first.start_ms / 1000.0 {
        return Some(0);
    }
    for (k, c) in cues.iter().enumerate() {
        let c_end = c.end_ms / 1000.0;
        let next_start = cues
            .get(k + 1)
            .map_or(f64::INFINITY, |n| n.start_ms / 1000.0);
        let display_until = js_max(
            c_end,
            js_min(c_end + CUE_POST_ROLL_SEC, next_start - CUE_NEXT_LEAD_IN_SEC),
        );
        if time_sec >= c.start_ms / 1000.0 && time_sec < display_until {
            return Some(k);
        }
    }
    Some(cues.len() - 1)
}

/// Karaoke hand-off at the next token's start (`pickActiveWordIndex`).
fn pick_active_word(words: &[TimedWord], order: &[usize], time_sec: f64) -> isize {
    let eps = WORD_SYNC_EPS_SEC;
    for (k, &i) in order.iter().enumerate() {
        let cur = &words[i];
        let lo = cur.start_sec - eps;
        let mut hi;
        if k + 1 < order.len() {
            let nx = &words[order[k + 1]];
            hi = if nx.start_sec > cur.start_sec + 0.008 {
                nx.start_sec
            } else {
                js_min(
                    js_max(cur.end_sec, cur.start_sec + WORD_PARTITION_MIN_SEC),
                    nx.end_sec,
                )
            };
            if hi <= lo + 1e-6 {
                hi = js_max(cur.end_sec, lo + WORD_PARTITION_MIN_SEC);
            }
        } else {
            hi = cur.end_sec + eps;
        }
        if time_sec >= lo && time_sec < hi {
            return i as isize;
        }
    }
    -1
}

/// Captions prepared once per export; cue lookups are per frame.
pub struct CaptionTrack {
    cues: Vec<CaptionCue>,
    preps: Vec<CuePrep>,
}

impl CaptionTrack {
    pub fn new(cues: &[CaptionCue]) -> Self {
        Self {
            cues: cues.to_vec(),
            preps: cues.iter().map(prepare).collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.cues.is_empty()
    }

    /// A cue and its timed words (empty when the cue has no word timings).
    pub fn cue(&self, index: usize) -> Option<(&CaptionCue, &[TimedWord])> {
        let cue = self.cues.get(index)?;
        let words: &[TimedWord] = match &self.preps[index] {
            CuePrep::Words { words, .. } => words,
            CuePrep::NoTimings | CuePrep::Empty => &[],
        };
        Some((cue, words))
    }

    /// `resolveActiveCueWords` at caption-clock time `time_ms` (offset already
    /// applied by the caller).
    pub fn active(&self, time_ms: f64) -> Option<ActiveCue<'_>> {
        let time_sec = time_ms / 1000.0;
        let cue_index = pick_cue_index(&self.cues, time_sec)?;
        let cue = &self.cues[cue_index];
        match &self.preps[cue_index] {
            CuePrep::Empty => None,
            CuePrep::NoTimings => Some(ActiveCue {
                cue_index,
                cue,
                words: &[],
                active_word_index: -1,
            }),
            CuePrep::Words { words, order } => Some(ActiveCue {
                cue_index,
                cue,
                words,
                active_word_index: pick_active_word(words, order, time_sec),
            }),
        }
    }
}
