import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { VoiceService, postProcessTranscript } from '../services/voice.js';
import type { VoiceState } from '../services/voice.js';

interface VoiceInputProps {
  onCommand: (command: string) => void;
}

export function VoiceInput({ onCommand }: VoiceInputProps) {
  const voiceRef = useRef<VoiceService | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');

  useEffect(() => {
    const voice = new VoiceService();
    voiceRef.current = voice;

    voice.onStateChange(setVoiceState);
    voice.onResult((result) => {
      if (result.isFinal) {
        const processed = postProcessTranscript(result.transcript);
        setFinalText(processed);
        setInterimText('');
      } else {
        setInterimText(result.transcript);
      }
    });

    return () => {
      voice.stop();
    };
  }, []);

  const toggleVoice = useCallback(() => {
    voiceRef.current?.toggle();
    if (voiceState === 'idle') {
      setFinalText('');
      setInterimText('');
    }
  }, [voiceState]);

  const sendCommand = useCallback(() => {
    if (finalText) {
      onCommand(finalText);
      setFinalText('');
    }
  }, [finalText, onCommand]);

  const clearCommand = useCallback(() => {
    setFinalText('');
    setInterimText('');
  }, []);

  if (!voiceRef.current?.available) {
    return null; // Hide voice UI if not available
  }

  return (
    <>
      {(finalText || interimText) && (
        <div class="voice-preview">
          {interimText && <span class="interim">{interimText}</span>}
          {finalText && <span class="final">{finalText}</span>}
          {finalText && (
            <div class="voice-actions">
              <button class="send-btn" onClick={sendCommand}>
                Send
              </button>
              <button onClick={clearCommand}>Clear</button>
            </div>
          )}
        </div>
      )}
      <div class="extra-keys" style={{ justifyContent: 'center' }}>
        <button
          class={`voice-btn ${voiceState === 'listening' ? 'listening' : ''}`}
          onClick={toggleVoice}
        >
          {voiceState === 'listening' ? 'Stop' : 'Voice'}
        </button>
      </div>
    </>
  );
}
