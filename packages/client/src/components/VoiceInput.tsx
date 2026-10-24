import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { VoiceService, postProcessTranscript, voiceAvailability, type VoiceState } from '../services/voice.js';

interface VoiceInputProps {
  onCommand: (command: string) => void;
}

/** Speak a command, review the transcribed text, then send it. */
export function VoiceInput({ onCommand }: VoiceInputProps) {
  const voiceRef = useRef<VoiceService | null>(null);
  const [availability] = useState(voiceAvailability);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (availability !== 'available') return;
    const voice = new VoiceService();
    voiceRef.current = voice;
    const unsubscribeState = voice.onStateChange(setVoiceState);
    const unsubscribeResult = voice.onResult((result) => {
      if (result.isFinal) {
        setFinalText(postProcessTranscript(result.transcript));
        setInterimText('');
      } else {
        setInterimText(result.transcript);
      }
    });
    return () => {
      unsubscribeState();
      unsubscribeResult();
      voice.stop();
      voiceRef.current = null;
    };
  }, [availability]);

  const toggle = useCallback(() => {
    const voice = voiceRef.current;
    if (!voice) return;
    if (voice.state === 'idle') {
      setFinalText('');
      setInterimText('');
    }
    voice.toggle();
  }, []);

  const send = useCallback(() => {
    if (!finalText) return;
    onCommand(finalText);
    setFinalText('');
  }, [finalText, onCommand]);

  const clear = useCallback(() => {
    setFinalText('');
    setInterimText('');
  }, []);

  if (availability === 'unsupported') return null;

  if (availability === 'insecure-context') {
    return (
      <div class="voice-bar">
        <button type="button" class="voice-btn voice-btn-disabled" aria-expanded={showHint} onClick={() => setShowHint((v) => !v)}>
          Voice unavailable
        </button>
        {showHint && (
          <p class="voice-hint" role="note">
            Browsers only allow the microphone on HTTPS pages or localhost. Start TermPilot with
            <code>--tunnel</code> for an HTTPS address.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {(finalText || interimText) && (
        <div class="voice-preview" aria-live="polite">
          {interimText && <span class="interim">{interimText}</span>}
          {finalText && <span class="final">{finalText}</span>}
          {finalText && (
            <div class="voice-actions">
              <button type="button" class="send-btn" onClick={send}>Send</button>
              <button type="button" onClick={clear}>Clear</button>
            </div>
          )}
        </div>
      )}
      <div class="voice-bar">
        <button
          type="button"
          class={`voice-btn ${voiceState === 'listening' ? 'listening' : ''}`}
          onClick={toggle}
          aria-label={voiceState === 'listening' ? 'Stop listening' : 'Speak a command'}
        >
          {voiceState === 'listening' ? 'Stop' : 'Voice'}
        </button>
      </div>
    </>
  );
}
