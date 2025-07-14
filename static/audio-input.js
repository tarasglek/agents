/**
 * @typedef {object} AudioRecorderResult
 * @property {string} transcript
 * @property {string | null} audioUrl
 */

/**
 * @typedef {{type: 'statechange', state: string}} StateChangeEvent
 * @typedef {{type: 'transcript', transcript: string, isFinal: boolean}} TranscriptEvent
 * @typedef {{type: 'command', audioUrl: string | null}} CommandEvent
 * @typedef {{type: 'speakstart', text: string}} SpeakStartEvent
 * @typedef {{type: 'speakend'}} SpeakEndEvent
 * @typedef {{type: 'error', message: string}} ErrorEvent
 * @typedef {StateChangeEvent | TranscriptEvent | CommandEvent | SpeakStartEvent | SpeakEndEvent | ErrorEvent} VoiceAssistantEvent
 */

let lastLogTime = Date.now();
/** @param {string} message */
function log(message) {
  const now = Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;
  console.log(`+${diff}ms ${message}`);
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
 * Manages the voice assistant's state, including wake word detection,
 * speech recording, and text-to-speech.
 */
class VoiceAssistant {
  /** @type {string} */
  #state;
  /** @type {RegExp} */
  #wakePhraseRegex;
  /** @type {SpeechRecognition} */
  #recognition;
  /** @type {AudioRecorder | undefined} */
  #audioRecorder;
  /** @type {number | undefined} */
  #endOfSpeechTimeout;
  /** @type {number | undefined} */
  #noSpeechAfterWakeWordTimeout;
  /** @type {string} */
  #finalTranscriptSinceRecording;
  /** @type {SpeechSynthesisUtterance} */
  #utterance;

  /** @type {VoiceAssistantEvent[]} */
  #eventQueue = [];
  /** @type {(() => void) | null} */
  #eventResolver = null;

  static State = {
    LISTENING_FOR_WAKE_WORD: "LISTENING_FOR_WAKE_WORD",
    ACTIVATING: "ACTIVATING",
    RECORDING_USER_SPEECH: "RECORDING_USER_SPEECH",
    PROCESSING_USER_SPEECH: "PROCESSING_USER_SPEECH",
  };

  /**
   * @param {RegExp} wakePhraseRegex
   */
  constructor(wakePhraseRegex) {
    this.#wakePhraseRegex = wakePhraseRegex;
    this.#state = VoiceAssistant.State.LISTENING_FOR_WAKE_WORD; // Set initial state without event
    this.#finalTranscriptSinceRecording = "";
    this.#utterance = new SpeechSynthesisUtterance();
    this.#audioRecorder = undefined;
    this.#endOfSpeechTimeout = undefined;
    this.#noSpeechAfterWakeWordTimeout = undefined;

    this.#recognition = new webkitSpeechRecognition();
    this.#recognition.continuous = true;
    this.#recognition.interimResults = true;

    this.#recognition.onresult = this.#onResult.bind(this);
    this.#recognition.onerror = this.#onError.bind(this);
    this.#recognition.onspeechend = this.#onSpeechEnd.bind(this);
    this.#recognition.onspeechstart = this.#onSpeechStart.bind(this);
    this.#recognition.onend = this.#onEnd.bind(this);
  }

  /**
   * @param {VoiceAssistantEvent} event
   */
  #emit(event) {
    this.#eventQueue.push(event);
    if (this.#eventResolver) {
      this.#eventResolver();
      this.#eventResolver = null;
    }
  }

  /**
   * @returns {AsyncGenerator<VoiceAssistantEvent>}
   */
  async *events() {
    log("Starting event stream.");
    // emit initial state
    this.#emit({
      type: "statechange",
      state: this.#state,
    });

    while (true) {
      while (this.#eventQueue.length > 0) {
        const event = this.#eventQueue.shift();
        if (event) yield event;
      }
      await new Promise((resolve) => {
        this.#eventResolver = resolve;
      });
    }
  }

  get state() {
    return this.#state;
  }

  /** @param {string} newState */
  set state(newState) {
    if (this.#state === newState) return;
    this.#state = newState;
    this.#emit({ type: "statechange", state: this.#state });
  }

  /**
   * @param {{wakePhraseRegex?: RegExp}} [options]
   * @returns {Promise<VoiceAssistant>}
   */
  static async init({ wakePhraseRegex = /ok[^a-z]+metallica/i } = {}) {
    if (
      !("webkitSpeechRecognition" in window) || !("MediaRecorder" in window) ||
      !("speechSynthesis" in window)
    ) {
      throw new Error(
        "SpeechRecognition, MediaRecorder, or SpeechSynthesis not supported in this browser.",
      );
    }
    const assistant = new VoiceAssistant(wakePhraseRegex);
    assistant.#recognition.start();
    return assistant;
  }

  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  speak(text) {
    log(`Speaking: ${text}`);
    this.#emit({ type: "speakstart", text });
    return new Promise((resolve, reject) => {
      this.#utterance.text = text;
      this.#utterance.onend = () => {
        log("Finished speaking.");
        this.#emit({ type: "speakend" });
        resolve();
      };
      this.#utterance.onerror = (event) => {
        log(`Error speaking: ${event.error}`);
        this.#emit({ type: "error", message: `TTS Error: ${event.error}` });
        reject(event.error);
      };
      window.speechSynthesis.speak(this.#utterance);
    });
  }

  /** @returns {Promise<void>} */
  async #activate() {
    if (this.state !== VoiceAssistant.State.LISTENING_FOR_WAKE_WORD) return;

    log("Wake phrase detected! Activating...");
    this.state = VoiceAssistant.State.ACTIVATING;

    await this.speak("Listening");
    this.#finalTranscriptSinceRecording = "";
    this.#audioRecorder = await AudioRecorder.start();
    this.state = VoiceAssistant.State.RECORDING_USER_SPEECH;
    log("Recording user speech.");

    this.#noSpeechAfterWakeWordTimeout = setTimeout(() => {
      log("No speech detected for 15s, cancelling recording.");
      this.#stopRecording();
    }, 15000);
  }

  /** @returns {Promise<void>} */
  async #stopRecording() {
    if (this.state !== VoiceAssistant.State.RECORDING_USER_SPEECH) return;

    log("Stopping recording session.");
    this.state = VoiceAssistant.State.PROCESSING_USER_SPEECH;

    clearTimeout(this.#endOfSpeechTimeout);
    this.#endOfSpeechTimeout = undefined;
    clearTimeout(this.#noSpeechAfterWakeWordTimeout);
    this.#noSpeechAfterWakeWordTimeout = undefined;

    const audioUrl = await this.#audioRecorder.stop();
    this.#audioRecorder = undefined;

    this.#emit({ type: "command", audioUrl });

    log("Processing complete. Listening for wake word.");
    this.state = VoiceAssistant.State.LISTENING_FOR_WAKE_WORD;
  }

  /**
   * @param {SpeechRecognitionEvent} event
   * @returns {Promise<void>}
   */
  async #onResult(event) {
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

    if (interimTranscript) {
      this.#emit({
        type: "transcript",
        transcript: interimTranscript,
        isFinal: false,
      });
    }
    if (newlyFinalizedTranscript) {
      this.#emit({
        type: "transcript",
        transcript: newlyFinalizedTranscript,
        isFinal: true,
      });
    }

    if (this.state === VoiceAssistant.State.LISTENING_FOR_WAKE_WORD) {
      if (this.#wakePhraseRegex.test(interimTranscript)) {
        await this.#activate();
      }
    } else if (this.state === VoiceAssistant.State.RECORDING_USER_SPEECH) {
      this.#finalTranscriptSinceRecording += newlyFinalizedTranscript;

      const hasSpeech =
        this.#finalTranscriptSinceRecording.length + interimTranscript.length >
        0;
      const timeout = hasSpeech ? 1500 : 4000;

      clearTimeout(this.#endOfSpeechTimeout);
      log(`[re]-set endOfSpeechTimeout (${timeout}ms)`);
      this.#endOfSpeechTimeout = setTimeout(
        () => this.#stopRecording(),
        timeout,
      );
    }
  }

  /** @param {SpeechRecognitionErrorEvent} event */
  #onError(event) {
    this.#emit({ type: "error", message: `Recognition Error: ${event.error}` });
    if (this.state === VoiceAssistant.State.RECORDING_USER_SPEECH) {
      this.#stopRecording();
    }
    console.error("Error occurred in recognition: " + event.error);
  }

  #onSpeechEnd() {
    log("Speech has stopped being detected");
  }

  #onSpeechStart() {
    log("Speech has been detected");
    if (
      this.state === VoiceAssistant.State.RECORDING_USER_SPEECH &&
      this.#noSpeechAfterWakeWordTimeout
    ) {
      clearTimeout(this.#noSpeechAfterWakeWordTimeout);
      this.#noSpeechAfterWakeWordTimeout = undefined;
      log("Cleared no-speech-after-wake-word timeout.");
    }
  }

  #onEnd() {
    log("Speech recognition has ended, restarting...");
    this.#recognition.start();
  }
}

// Usage
(async () => {
  try {
    const assistant = await VoiceAssistant.init();
    log("Voice assistant initialized. Listening for events...");

    for await (const event of assistant.events()) {
      log(`Event: ${event.type}`);
      switch (event.type) {
        case "command":
          if (event.audioUrl) {
            log(`Got command, playing audio from ${event.audioUrl}`);
            const audio = new Audio(event.audioUrl);
            audio.onerror = (e) => {
              console.error("Error playing audio:", e.target.error);
            };
            audio.play().catch((error) => {
              console.warn("Audio playback failed:", error);
            });
          } else {
            log("No command recorded.");
          }
          break;
        case "statechange":
          log(`Assistant state: ${event.state}`);
          break;
        case "transcript":
          log(`Transcript (final=${event.isFinal}): ${event.transcript}`);
          break;
        case "error":
          console.error(`Assistant error: ${event.message}`);
          break;
        case "speakstart":
          log(`Assistant speaking: "${event.text}"`);
          break;
        case "speakend":
          log(`Assistant finished speaking.`);
          break;
      }
    }
  } catch (err) {
    console.error("An error occurred:", err);
  }
})();
