import type { CaptionCuePayload, CaptionWordPayload } from "./types";
import { buildCaptionTextFromWords } from "./parser";
import { padSpans, resegmentCuesBySilence, type SilenceInterval } from "./silence";

/** Phrase-aware caption segmentation on Whisper word timings and acoustic silence. */

/** A gap (ms) between two consecutive words this long or longer starts a new phrase. */
const DEFAULT_PHRASE_PAUSE_MS = 700;
/** An ffmpeg `silencedetect` interval this long inside a word gap also starts a new phrase. */
const DEFAULT_SPLIT_SILENCE_MS = 1_500;
/** Padding (ms) kept around each phrase so captions don't feel clipped. */
const DEFAULT_EDGE_PAD_MS = 80;
/** Safety cap: a phrase with no sentence end and no pause is split once it gets this long. */
const DEFAULT_MAX_PHRASE_MS = 12_000;

/** Captions shorter than this (ms) may merge with an adjacent short caption. */
const DEFAULT_MIN_CAPTION_MS = 800;
/** Only merge short captions separated by at most this gap (ms) — never across a real pause. */
const DEFAULT_MERGE_GAP_MS = 400;
/** A merged short-caption run never grows past this duration (ms) or character count. */
const DEFAULT_MAX_MERGED_MS = 2_500;
const DEFAULT_MAX_MERGED_CHARS = 80;

export interface SegmentOptions {
	/** Word gap (ms) that splits one phrase into two. Lower = more, shorter captions. */
	pauseMs?: number;
	/** Minimum acoustic silence (ms) inside a word gap that also splits a phrase. */
	splitSilenceMs?: number;
	/** Padding (ms) kept around each phrase. */
	edgePadMs?: number;
	/** Safety cap (ms) that splits a punctuation-less, pause-less runaway phrase. */
	maxPhraseMs?: number;
	/** A caption shorter than this (ms) may be merged with an adjacent short caption. */
	minCaptionMs?: number;
	/** Only merge short captions separated by at most this gap (ms). */
	mergeGapMs?: number;
	/** A merged short-caption run never grows past this duration (ms). */
	maxMergedMs?: number;
	/** A merged short-caption run never grows past this character count. */
	maxMergedChars?: number;
}

interface CaptionPiece {
	startMs: number;
	endMs: number;
	text: string;
	words: CaptionWordPayload[];
}

const SENTENCE_END = /[.?!…。！？]$/;
/** Closing quotes/brackets that can trail terminal punctuation, e.g. `said."` */
const TRAILING_CLOSERS = /[)\]}"'”’»」』）】］｝>]+$/u;

/**
 * English titles that take a trailing period mid-sentence (non-English audio never matches).
 */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc"]);

/** A trailing period belongs to an abbreviation/initialism rather than ending a sentence. */
function isAbbreviation(text: string): boolean {
	const trimmed = text.trim().replace(TRAILING_CLOSERS, "").trim();
	if (!trimmed.endsWith(".")) {
		return false; // only a plain period can be an abbreviation marker
	}
	const core = trimmed.slice(0, -1).toLowerCase();
	if (core.length === 0) {
		return false;
	}
	// Single-letter initial or dotted initialism.
	if (/^[a-z]$/.test(core) || /^[a-z](\.[a-z])+$/.test(core)) {
		return true;
	}
	return ABBREVIATIONS.has(core);
}

/**
 * True when a word ends a sentence, ignoring trailing closers and abbreviations.
 */
export function endsSentence(text: string): boolean {
	const trimmed = text.trim().replace(TRAILING_CLOSERS, "").trim();
	if (!SENTENCE_END.test(trimmed)) {
		return false;
	}
	return !isAbbreviation(text);
}

/** Every cue carries usable word timing, so we can segment on the word stream. */
function hasWordTimings(cues: CaptionCuePayload[]): boolean {
	return cues.length > 0 && cues.every((cue) => Array.isArray(cue.words) && cue.words.length > 0);
}

/** Flatten all cues' words into one time-ordered stream, spacing across cue joins. */
function flattenWords(cues: CaptionCuePayload[]): CaptionWordPayload[] {
	const stream: CaptionWordPayload[] = [];
	for (const cue of cues) {
		const words = (cue.words ?? []) as CaptionWordPayload[];
		words.forEach((word, index) => {
			const leadingSpace =
				stream.length > 0 && (index === 0 ? true : word.leadingSpace !== false);
			stream.push({
				text: word.text,
				startMs: word.startMs,
				endMs: word.endMs,
				...(leadingSpace ? { leadingSpace: true } : {}),
			});
		});
	}
	return stream.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

/** Drop words that sit entirely inside a long detected silence (Whisper hallucinations). */
function dropHallucinations(
	words: CaptionWordPayload[],
	silences: SilenceInterval[],
	splitSilenceMs: number,
): CaptionWordPayload[] {
	const longSilences = silences.filter(
		(silence) => silence.endMs - silence.startMs >= splitSilenceMs,
	);
	if (longSilences.length === 0) {
		return words;
	}
	return words.filter(
		(word) =>
			!longSilences.some(
				(silence) => silence.startMs <= word.startMs && word.endMs <= silence.endMs,
			),
	);
}

/** A long silence interval overlaps the gap between two consecutive words. */
function silenceInGap(
	gapStartMs: number,
	gapEndMs: number,
	silences: SilenceInterval[],
	splitSilenceMs: number,
): boolean {
	return silences.some(
		(silence) =>
			silence.endMs - silence.startMs >= splitSilenceMs &&
			silence.startMs < gapEndMs &&
			silence.endMs > gapStartMs,
	);
}

/** Reset the first word's leading space so a phrase reads as its own line. */
function normalizePhraseWords(words: CaptionWordPayload[]): CaptionWordPayload[] {
	return words.map((word, index) => {
		if (index === 0 && word.leadingSpace) {
			const { leadingSpace: _leadingSpace, ...rest } = word;
			return rest;
		}
		return word;
	});
}

/** Group a cue's words into runs that each end on a sentence boundary. */
function groupWordsBySentence(words: CaptionWordPayload[]): CaptionWordPayload[][] {
	const groups: CaptionWordPayload[][] = [];
	let current: CaptionWordPayload[] = [];
	words.forEach((word, index) => {
		current.push(word);
		if (endsSentence(word.text) && index < words.length - 1) {
			groups.push(current);
			current = [];
		}
	});
	if (current.length > 0) {
		groups.push(current);
	}
	return groups;
}

/** Split a word-less cue into one cue per sentence with proportional timing. */
function splitTextBySentence(cue: CaptionCuePayload): CaptionCuePayload[] {
	const tokens = cue.text.trim().split(/\s+/).filter(Boolean);
	if (tokens.length <= 1) {
		return [cue];
	}

	const groups: string[][] = [];
	let current: string[] = [];
	tokens.forEach((token, index) => {
		current.push(token);
		if (endsSentence(token) && index < tokens.length - 1) {
			groups.push(current);
			current = [];
		}
	});
	if (current.length > 0) {
		groups.push(current);
	}
	if (groups.length <= 1) {
		return [cue];
	}

	const texts = groups.map((group) => group.join(" "));
	const totalChars = texts.reduce((sum, text) => sum + text.length, 0) || 1;
	const spanMs = Math.max(1, cue.endMs - cue.startMs);
	let cursorMs = cue.startMs;
	return texts.map((text, index) => {
		const startMs = cursorMs;
		const endMs =
			index === texts.length - 1
				? cue.endMs
				: Math.min(
						cue.endMs - 1,
						Math.round(startMs + (spanMs * text.length) / totalChars),
					);
		cursorMs = Math.max(startMs + 1, endMs);
		return { id: cue.id, startMs, endMs: Math.max(startMs + 1, endMs), text };
	});
}

/** Split one re-segmented cue into one cue per sentence (by words if present, else text). */
function splitCueBySentences(cue: CaptionCuePayload): CaptionCuePayload[] {
	const words = Array.isArray(cue.words) ? (cue.words as CaptionWordPayload[]) : [];
	if (words.length === 0) {
		return splitTextBySentence(cue);
	}

	const groups = groupWordsBySentence(words);
	if (groups.length <= 1) {
		return [cue];
	}
	return groups.map((group) => {
		const phraseWords = normalizePhraseWords(group);
		return {
			id: cue.id,
			startMs: phraseWords[0].startMs,
			endMs: phraseWords[phraseWords.length - 1].endMs,
			text: buildCaptionTextFromWords(phraseWords),
			words: phraseWords,
		};
	});
}

/** Concatenate two adjacent cues into one, joining words (with a space) when both have them. */
function mergeTwoCues(left: CaptionCuePayload, right: CaptionCuePayload): CaptionCuePayload {
	const leftWords = Array.isArray(left.words) ? (left.words as CaptionWordPayload[]) : [];
	const rightWords = Array.isArray(right.words) ? (right.words as CaptionWordPayload[]) : [];
	if (leftWords.length > 0 && rightWords.length > 0) {
		const joined = normalizePhraseWords([
			...leftWords,
			...rightWords.map((word, index) =>
				index === 0 ? { ...word, leadingSpace: true } : word,
			),
		]);
		return {
			id: left.id,
			startMs: left.startMs,
			endMs: right.endMs,
			text: buildCaptionTextFromWords(joined),
			words: joined,
		};
	}
	return {
		id: left.id,
		startMs: left.startMs,
		endMs: right.endMs,
		text: `${left.text} ${right.text}`.trim(),
	};
}

interface MergeOptions {
	minCaptionMs: number;
	mergeGapMs: number;
	maxMergedMs: number;
	maxMergedChars: number;
}

/** Merge adjacent short captions separated by a tiny gap. */
function mergeShortAdjacentCaptions(
	cues: CaptionCuePayload[],
	options: MergeOptions,
): CaptionCuePayload[] {
	if (cues.length <= 1) {
		return cues;
	}

	const merged: CaptionCuePayload[] = [];
	let group = cues[0];
	for (let index = 1; index < cues.length; index += 1) {
		const next = cues[index];
		const groupDurationMs = group.endMs - group.startMs;
		const nextDurationMs = next.endMs - next.startMs;
		const gapMs = next.startMs - group.endMs;
		const combinedDurationMs = next.endMs - group.startMs;
		const combinedChars = group.text.length + next.text.length + 1;

		const canMerge =
			groupDurationMs < options.minCaptionMs &&
			nextDurationMs < options.minCaptionMs &&
			gapMs <= options.mergeGapMs &&
			combinedDurationMs <= options.maxMergedMs &&
			combinedChars <= options.maxMergedChars;

		if (canMerge) {
			group = mergeTwoCues(group, next);
		} else {
			merged.push(group);
			group = next;
		}
	}
	merged.push(group);
	return merged;
}

/** Assign sequential, stable ids to the final cue list. */
function renumberCues(cues: CaptionCuePayload[]): CaptionCuePayload[] {
	return cues.map((cue, index) => ({ ...cue, id: `caption-${index + 1}` }));
}

/** Re-segment Whisper cues into phrase-sized captions; falls back to silence-only path without word timings. */
export function segmentCuesIntoPhrases(
	cues: CaptionCuePayload[],
	silences: SilenceInterval[],
	options: SegmentOptions = {},
): CaptionCuePayload[] {
	const pauseMs = options.pauseMs ?? DEFAULT_PHRASE_PAUSE_MS;
	const splitSilenceMs = options.splitSilenceMs ?? DEFAULT_SPLIT_SILENCE_MS;
	const edgePadMs = options.edgePadMs ?? DEFAULT_EDGE_PAD_MS;
	const maxPhraseMs = options.maxPhraseMs ?? DEFAULT_MAX_PHRASE_MS;
	const mergeOptions: MergeOptions = {
		minCaptionMs: options.minCaptionMs ?? DEFAULT_MIN_CAPTION_MS,
		mergeGapMs: options.mergeGapMs ?? DEFAULT_MERGE_GAP_MS,
		maxMergedMs: options.maxMergedMs ?? DEFAULT_MAX_MERGED_MS,
		maxMergedChars: options.maxMergedChars ?? DEFAULT_MAX_MERGED_CHARS,
	};

	if (cues.length === 0) {
		return [];
	}

	if (!hasWordTimings(cues)) {
		const base = resegmentCuesBySilence(cues, silences, { splitSilenceMs, edgePadMs });
		const sentences = base.flatMap(splitCueBySentences);
		return renumberCues(mergeShortAdjacentCaptions(sentences, mergeOptions));
	}

	const sortedCues = [...cues].sort(
		(left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
	);
	const stream = dropHallucinations(flattenWords(sortedCues), silences, splitSilenceMs);
	if (stream.length === 0) {
		return [];
	}

	const phrases: CaptionWordPayload[][] = [];
	let current: CaptionWordPayload[] = [];

	for (let index = 0; index < stream.length; index += 1) {
		const word = stream[index];
		current.push(word);

		const next = stream[index + 1];
		if (!next) {
			break;
		}

		const gapMs = next.startMs - word.endMs;
		const phraseDurationMs = word.endMs - current[0].startMs;
		const shouldBreak =
			endsSentence(word.text) ||
			gapMs >= pauseMs ||
			(gapMs > 0 && silenceInGap(word.endMs, next.startMs, silences, splitSilenceMs)) ||
			phraseDurationMs >= maxPhraseMs;

		if (shouldBreak) {
			phrases.push(current);
			current = [];
		}
	}
	if (current.length > 0) {
		phrases.push(current);
	}

	const pieces: CaptionPiece[] = phrases
		.map((words) => {
			const phraseWords = normalizePhraseWords(words);
			return {
				startMs: phraseWords[0].startMs,
				endMs: phraseWords[phraseWords.length - 1].endMs,
				text: buildCaptionTextFromWords(phraseWords),
				words: phraseWords,
			};
		})
		.filter((piece) => piece.text.trim().length > 0);

	if (pieces.length === 0) {
		return [];
	}

	pieces.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

	const sentenceCues: CaptionCuePayload[] = pieces.map((piece) => ({
		id: "",
		startMs: piece.startMs,
		endMs: piece.endMs,
		text: piece.text,
		...(piece.words.length > 0 ? { words: piece.words } : {}),
	}));
	const merged = mergeShortAdjacentCaptions(sentenceCues, mergeOptions);
	padSpans(merged, edgePadMs);
	return renumberCues(merged);
}
