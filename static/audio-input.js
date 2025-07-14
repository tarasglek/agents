/**
 * @typedef {object} AudioRecorderResult
 * @property {string} transcript
 * @property {string | null} audioUrl
 */

let lastLogTime = Date.now();
/** @param {string} message */
function log(message) {
  const now = Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;
  console.log(`+${diff}ms ${message}`);
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
function speak(text) {
  log(`Speaking: ${text}`);
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      log("Finished speaking.");
      resolve();
    };
    utterance.onerror = (event) => {
      log(`Error speaking: ${event.error}`);
      reject(event.error);
    };
    window.speechSynthesis.speak(utterance);
  });
}

class AudioRecorder {
  /**
   * @param {MediaRecorder} mediaRecorder
   * @param {Blob[]} audioChunks
   */
  constructor(mediaRecorder, audioChunks) {
    /** @type {MediaRecorder} */
    this.mediaRecorder = mediaRecorder;
    /** @type {Blob[]} */
    this.audioChunks = audioChunks;
  }

  /**
   * @returns {Promise<AudioRecorder>}
   */
  static async start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      const audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.start();
      log("Audio recording started.");

      return new AudioRecorder(mediaRecorder, audioChunks);
    } catch (err) {
      console.error("Could not start audio recording:", err);
      throw new Error("Could not get user media: " + err);
    }
  }

  /**
   * @returns {Promise<string | null>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      this.mediaRecorder.onstop = () => {
        log("MediaRecorder stopped. Finalizing audio.");
        if (this.audioChunks.length === 0) {
          console.warn("No audio chunks recorded. Cannot create audio blob.");
          resolve(null);
          return;
        }
        try {
          const audioBlob = new Blob(this.audioChunks);
          const audioUrl = URL.createObjectURL(audioBlob);
          resolve(audioUrl);
        } catch (error) {
          console.error("Error processing audio:", error);
          reject("Failed to process recorded audio.");
        }
      };

      this.mediaRecorder.stop();
    });
  }
}

/**
 * Initializes a voice assistant that listens for a wake word, records speech,
 * and uses TTS and VAD-equivalent logic.
 * @param {RegExp} [wakePhraseRegex]
 * @returns {void}
 */
function initVoiceAssistant(
  wakePhraseRegex = /ok[^a-z]+metallica/i,
) {
  if (
    !("webkitSpeechRecognition" in window) || !("MediaRecorder" in window) ||
    !("speechSynthesis" in window)
  ) {
    throw new Error(
      "SpeechRecognition, MediaRecorder, or SpeechSynthesis not supported in this browser.",
    );
  }

  const State = {
    LISTENING_FOR_WAKE_WORD: "LISTENING_FOR_WAKE_WORD",
    ACTIVATING: "ACTIVATING", // Wake word detected, playing confirmation sound.
    RECORDING_USER_SPEECH: "RECORDING_USER_SPEECH",
    PROCESSING_USER_SPEECH: "PROCESSING_USER_SPEECH", // Speech ended, processing.
  };

  let state = State.LISTENING_FOR_WAKE_WORD;

  /** @type { AudioRecorder | undefined} */
  let audioRecorder;
  let endOfSpeechTimeout;
  let noSpeechAfterWakeWordTimeout;

  let finalTranscriptSinceRecording = "";

  async function activate() {
    if (state !== State.LISTENING_FOR_WAKE_WORD) return;

    log("Wake phrase detected! Activating...");
    state = State.ACTIVATING;

    await speak("Listening");
    finalTranscriptSinceRecording = "";
    audioRecorder = await AudioRecorder.start();
    state = State.RECORDING_USER_SPEECH;
    log("Recording user speech.");

    // Timeout if no speech is detected after activation.
    noSpeechAfterWakeWordTimeout = setTimeout(() => {
      log("No speech detected for 15s, cancelling recording.");
      stopRecording();
    }, 15000);
  }

  async function stopRecording() {
    if (state !== State.RECORDING_USER_SPEECH) return;

    log("Stopping recording session.");
    state = State.PROCESSING_USER_SPEECH;

    clearTimeout(endOfSpeechTimeout);
    endOfSpeechTimeout = undefined;
    clearTimeout(noSpeechAfterWakeWordTimeout);
    noSpeechAfterWakeWordTimeout = undefined;

    const audioUrl = await audioRecorder.stop();
    audioRecorder = undefined;

    if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.onerror = (event) => {
        console.error("Error playing audio:", event.target.error);
      };
      audio.play().catch((error) => {
        console.warn("Audio playback failed:", error);
      });
    }

    log("Processing complete. Listening for wake word.");
    state = State.LISTENING_FOR_WAKE_WORD;
  }

  // Initialize the SpeechRecognition object
  /** @type {SpeechRecognition} */
  const recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  // Set up the event listeners for SpeechRecognition
  /** @param {SpeechRecognitionEvent} event */
  recognition.onresult = async function (event) {
    let interimTranscript = "";
    let newlyFinalizedTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        newlyFinalizedTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }
    log(
      `Transcript update: final='${newlyFinalizedTranscript}' interim='${interimTranscript}'`,
    );

    if (state === State.LISTENING_FOR_WAKE_WORD) {
      if (wakePhraseRegex.test(interimTranscript)) {
        await activate();
      }
    } else if (state === State.RECORDING_USER_SPEECH) {
      finalTranscriptSinceRecording += newlyFinalizedTranscript;

      // VAD-equivalent: reset timeout if we are getting new transcript parts.
      const hasSpeech =
        finalTranscriptSinceRecording.length + interimTranscript.length > 0;
      const timeout = hasSpeech ? 500 : 4000; // Shorter timeout after speech starts.

      clearTimeout(endOfSpeechTimeout);
      log(`[re]-set endOfSpeechTimeout (${timeout}ms)`);
      endOfSpeechTimeout = setTimeout(stopRecording, timeout);
    }
  };

  /** @param {SpeechRecognitionErrorEvent} event */
  recognition.onerror = function (event) {
    if (state === State.RECORDING_USER_SPEECH) {
      stopRecording();
    }
    console.error("Error occurred in recognition: " + event.error);
  };

  recognition.onspeechend = function () {
    log("Speech has stopped being detected");
  };

  recognition.onspeechstart = function () {
    log("Speech has been detected");
    if (state === State.RECORDING_USER_SPEECH && noSpeechAfterWakeWordTimeout) {
      clearTimeout(noSpeechAfterWakeWordTimeout);
      noSpeechAfterWakeWordTimeout = undefined;
      log("Cleared no-speech-after-wake-word timeout.");
    }
  };

  recognition.onend = function () {
    log("Speech recognition has ended, restarting...");
    recognition.start();
  };

  // Start speech recognition
  recognition.start();
}

// Usage
(() => {
  try {
    initVoiceAssistant();
    log("Continuous speech recognition started.");
  } catch (err) {
    console.error("An error occurred:", err);
  }
})();
