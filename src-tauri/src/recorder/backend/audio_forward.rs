//! Hand-off of captured PCM from audio callbacks to the encode loop.

use super::RawAudio;
use crossbeam_channel::Sender;
use std::sync::atomic::{AtomicU64, Ordering};

/// PCM chunks the encode loop never received, this process.
///
/// Every *video* send site checks the result of `try_send`; every audio one
/// used to be written `let _ = tx.try_send(..)`. So the one loss the user can
/// actually hear was the only one that left no trace, and "the audio cuts out"
/// arrived with nothing to diagnose it from.
static AUDIO_CHUNKS_DROPPED: AtomicU64 = AtomicU64::new(0);

/// Hand one PCM chunk to the encode loop, reporting overflow instead of
/// swallowing it.
///
/// Dropping audio is not like dropping a frame. `Encoder::write_mic_at` pads to
/// the next chunk's timeline position, so what is lost comes back as silence
/// rather than as a shorter track — the recording stays in sync and sounds
/// broken, which is the hardest kind of fault to report.
pub fn forward_audio(tx: &Sender<RawAudio>, chunk: RawAudio, source: &'static str) {
    if tx.try_send(chunk).is_err() {
        let total = AUDIO_CHUNKS_DROPPED.fetch_add(1, Ordering::Relaxed) + 1;
        // Doubling backoff: a one-off burst costs a line or two, a sustained
        // problem keeps reporting, and an audio callback running every few
        // milliseconds can never flood the log.
        if total.is_power_of_two() {
            tracing::warn!(
                source,
                total,
                "audio queue full; PCM dropped (lands in the recording as silence)"
            );
        }
    }
}

/// Total PCM chunks dropped this process — see [`forward_audio`].
#[cfg(test)]
fn audio_chunks_dropped() -> u64 {
    AUDIO_CHUNKS_DROPPED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn pcm(len: usize) -> RawAudio {
        RawAudio {
            data: vec![0u8; len],
            sample_rate: 48_000,
            channels: 2,
            timestamp: Duration::from_millis(0),
        }
    }

    #[test]
    fn forwarding_audio_delivers_when_there_is_room() {
        let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(2);
        forward_audio(&tx, pcm(16), "test");
        assert_eq!(rx.try_recv().map(|c| c.data.len()), Ok(16));
    }

    #[test]
    fn a_full_audio_queue_is_counted_rather_than_swallowed() {
        // The whole point of the helper. `let _ = tx.try_send(..)` lost this
        // silently at every audio source, so the one kind of loss the user can
        // actually *hear* was the only one with no trace behind it.
        let (tx, _rx) = crossbeam_channel::bounded::<RawAudio>(1);
        forward_audio(&tx, pcm(8), "test");
        let before = audio_chunks_dropped();
        forward_audio(&tx, pcm(8), "test");
        assert_eq!(
            audio_chunks_dropped(),
            before + 1,
            "an overflowing chunk must be counted"
        );
    }
}
