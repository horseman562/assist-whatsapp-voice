'use strict';

// Default values must match those in content.js
const DEFAULTS = {
  enabled:    true,
  voiceName:  '',
  rate:       1.0,
  pitch:      1.0,
  volume:     1.0,
  speakGroup:  true,
  speakSender: true,
};

// Element references
const el = {
  enabled:    document.getElementById('enabled'),
  voice:      document.getElementById('voice'),
  rate:       document.getElementById('rate'),
  pitch:      document.getElementById('pitch'),
  volume:     document.getElementById('volume'),
  rateVal:    document.getElementById('rateVal'),
  pitchVal:   document.getElementById('pitchVal'),
  volumeVal:  document.getElementById('volumeVal'),
  speakGroup:  document.getElementById('speakGroup'),
  speakSender: document.getElementById('speakSender'),
  testBtn:    document.getElementById('testBtn'),
};

// =============================================================================
// Voice list
// Voices load asynchronously; handle both the immediate and deferred cases.
// =============================================================================

function buildVoiceList(savedName) {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return; // not ready yet; voiceschanged will retry

  // Keep only the default option then append available voices
  el.voice.length = 1; // reset to "— System default —"
  voices.forEach(v => {
    const opt = document.createElement('option');
    opt.value       = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    el.voice.appendChild(opt);
  });

  if (savedName) el.voice.value = savedName;
}

// =============================================================================
// Persist a single setting key
// =============================================================================

function save(key, value) {
  chrome.storage.sync.set({ [key]: value });
}

// =============================================================================
// Initialise UI from stored settings
// =============================================================================

chrome.storage.sync.get(DEFAULTS, cfg => {
  el.enabled.checked     = cfg.enabled;
  el.rate.value          = cfg.rate;
  el.pitch.value         = cfg.pitch;
  el.volume.value        = cfg.volume;
  el.rateVal.textContent  = Number(cfg.rate).toFixed(1);
  el.pitchVal.textContent = Number(cfg.pitch).toFixed(1);
  el.volumeVal.textContent = Number(cfg.volume).toFixed(2);
  el.speakGroup.checked  = cfg.speakGroup;
  el.speakSender.checked = cfg.speakSender;

  // Voices may already be available (e.g. on subsequent popup opens)
  const voices = speechSynthesis.getVoices();
  if (voices.length) {
    buildVoiceList(cfg.voiceName);
  } else {
    speechSynthesis.addEventListener('voiceschanged', () => buildVoiceList(cfg.voiceName), { once: true });
  }
});

// =============================================================================
// Event listeners
// =============================================================================

el.enabled.addEventListener('change', () =>
  save('enabled', el.enabled.checked));

el.voice.addEventListener('change', () =>
  save('voiceName', el.voice.value));

el.rate.addEventListener('input', () => {
  const v = parseFloat(el.rate.value);
  el.rateVal.textContent = v.toFixed(1);
  save('rate', v);
});

el.pitch.addEventListener('input', () => {
  const v = parseFloat(el.pitch.value);
  el.pitchVal.textContent = v.toFixed(1);
  save('pitch', v);
});

el.volume.addEventListener('input', () => {
  const v = parseFloat(el.volume.value);
  el.volumeVal.textContent = v.toFixed(2);
  save('volume', v);
});

el.speakGroup.addEventListener('change', () =>
  save('speakGroup', el.speakGroup.checked));

el.speakSender.addEventListener('change', () =>
  save('speakSender', el.speakSender.checked));

// Test button – speaks a sample using current slider values
el.testBtn.addEventListener('click', () => {
  speechSynthesis.cancel(); // clear any queue
  const utt = new SpeechSynthesisUtterance('WhatsApp Reader is active. Hello from John!');
  utt.rate   = parseFloat(el.rate.value);
  utt.pitch  = parseFloat(el.pitch.value);
  utt.volume = parseFloat(el.volume.value);

  const voiceName = el.voice.value;
  if (voiceName) {
    const voice = speechSynthesis.getVoices().find(v => v.name === voiceName);
    if (voice) utt.voice = voice;
  }

  speechSynthesis.speak(utt);
});
