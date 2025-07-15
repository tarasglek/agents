/**
 * @typedef {object} AudioRecorderResult
 * @property {string} transcript
 * @property {string | null} audioUrl
 */

/**
 * @typedef {{type: 'statechange', state: string, timestamp: number}} StateChangeEvent
 * @typedef {{type: 'transcript', transcript: string, isFinal: boolean, timestamp: number}} TranscriptEvent
 * @typedef {{type: 'command', audioUrl: string | null, timestamp: number}} CommandEvent
 * @typedef {{type: 'speakstart', text: string, timestamp: number}} SpeakStartEvent
 * @typedef {{type: 'speakend', timestamp: number}} SpeakEndEvent
 * @typedef {{type: 'error', message: string, timestamp: number}} ErrorEvent
 * @typedef {StateChangeEvent | TranscriptEvent | CommandEvent | SpeakStartEvent | SpeakEndEvent | ErrorEvent} VoiceAssistantEvent
 */

let lastLogTime = Date.now();
/** @type {HTMLElement | null} */
let logDiv = null;

/**
 * @param {string} message
 * @param {number} [timestamp]
 */
function log(message, timestamp) {
  const now = timestamp ?? Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;
  const logMessage = `+${diff}ms ${message}`;
  console.log(logMessage);
  if (logDiv) {
    const logEntry = document.createElement("div");
    logEntry.textContent = logMessage;
    logDiv.prepend(logEntry);
  }
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
  #isMuted = false;
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

  /** @returns {boolean} */
  get isMuted() {
    return this.#isMuted;
  }

  toggleMute() {
    this.#isMuted = !this.#isMuted;
    log(`Mute toggled. isMuted: ${this.#isMuted}`);

    if (this.#isMuted) {
      window.speechSynthesis.cancel();
      if (
        this.state === VoiceAssistant.State.RECORDING_USER_SPEECH ||
        this.state === VoiceAssistant.State.ACTIVATING
      ) {
        // Don't emit a command, just stop recording and reset state.
        this.#audioRecorder?.stop().then((url) => {
          if (url) URL.revokeObjectURL(url); // Clean up blob URL
        });
        this.#audioRecorder = undefined;
        clearTimeout(this.#endOfSpeechTimeout);
        this.#endOfSpeechTimeout = undefined;
        clearTimeout(this.#noSpeechAfterWakeWordTimeout);
        this.#noSpeechAfterWakeWordTimeout = undefined;
        this.state = VoiceAssistant.State.LISTENING_FOR_WAKE_WORD;
        return;
      }
    }

    // To refresh UI
    this.#emit({ type: "statechange", state: this.state });
  }

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
   * @param {object} event - event data, timestamp will be added automatically
   */
  #emit(event) {
    this.#eventQueue.push({ ...event, timestamp: Date.now() });
    if (this.#eventResolver) {
      this.#eventResolver();
      this.#eventResolver = null;
    }
  }

  /**
   * @returns {AsyncGenerator<VoiceAssistantEvent>}
   */
  async *events() {
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
    if (this.#isMuted) return Promise.resolve();
    this.#emit({ type: "speakstart", text });
    return new Promise((resolve, reject) => {
      this.#utterance.text = text;
      this.#utterance.onend = () => {
        this.#emit({ type: "speakend" });
        resolve();
      };
      this.#utterance.onerror = (event) => {
        this.#emit({ type: "error", message: `TTS Error: ${event.error}` });
        reject(event.error);
      };
      window.speechSynthesis.speak(this.#utterance);
    });
  }

  /** @returns {Promise<void>} */
  async #activate() {
    if (this.state !== VoiceAssistant.State.LISTENING_FOR_WAKE_WORD) return;

    this.state = VoiceAssistant.State.ACTIVATING;

    this.#finalTranscriptSinceRecording = "";
    this.#audioRecorder = await AudioRecorder.start();
    this.state = VoiceAssistant.State.RECORDING_USER_SPEECH;

    this.#noSpeechAfterWakeWordTimeout = setTimeout(() => {
      log("No speech detected for 15s, cancelling recording.");
      this.#stopRecording();
    }, 15000);
  }

  /** @returns {Promise<void>} */
  async #stopRecording() {
    if (this.state !== VoiceAssistant.State.RECORDING_USER_SPEECH) return;

    this.state = VoiceAssistant.State.PROCESSING_USER_SPEECH;

    clearTimeout(this.#endOfSpeechTimeout);
    this.#endOfSpeechTimeout = undefined;
    clearTimeout(this.#noSpeechAfterWakeWordTimeout);
    this.#noSpeechAfterWakeWordTimeout = undefined;

    const audioUrl = await this.#audioRecorder.stop();
    this.#audioRecorder = undefined;

    this.#emit({ type: "command", audioUrl });

    this.state = VoiceAssistant.State.LISTENING_FOR_WAKE_WORD;
  }

  /**
   * @param {SpeechRecognitionEvent} event
   * @returns {Promise<void>}
   */
  async #onResult(event) {
    if (this.#isMuted) return;
    let interimTranscript = "";
    let newlyFinalizedTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        newlyFinalizedTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

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
      if (
        this.#wakePhraseRegex.test(interimTranscript + newlyFinalizedTranscript)
      ) {
        await this.#activate();
      }
    } else if (this.state === VoiceAssistant.State.RECORDING_USER_SPEECH) {
      this.#finalTranscriptSinceRecording += newlyFinalizedTranscript;

      const hasSpeech =
        this.#finalTranscriptSinceRecording.length + interimTranscript.length >
          0;
      const timeout = hasSpeech ? 1700 : 5000;

      clearTimeout(this.#endOfSpeechTimeout);
      this.#endOfSpeechTimeout = setTimeout(
        () => this.#stopRecording(),
        timeout,
      );
    }
  }

  /** @param {SpeechRecognitionErrorEvent} event */
  #onError(event) {
    if (event.error === "no-speech") {
      // It's normal for the speech recognition to time out if nobody's talking.
      // We don't need to show an error for that.
      console.log("Recognition: no-speech error. Ignoring.");
    } else {
      this.#emit({
        type: "error",
        message: `Recognition Error: ${event.error}`,
      });
      console.error("Error occurred in recognition: " + event.error);
    }

    if (this.state === VoiceAssistant.State.RECORDING_USER_SPEECH) {
      this.#stopRecording();
    }
  }

  #onSpeechEnd() {}

  #onSpeechStart() {
    if (
      this.state === VoiceAssistant.State.RECORDING_USER_SPEECH &&
      this.#noSpeechAfterWakeWordTimeout
    ) {
      clearTimeout(this.#noSpeechAfterWakeWordTimeout);
      this.#noSpeechAfterWakeWordTimeout = undefined;
    }
  }

  #onEnd() {
    this.#recognition.start();
  }
}

/**
 * @param {VoiceAssistantEvent} event
 * @param {HTMLElement} statusDiv
 * @param {SVGElement} micIconOn
 * @param {SVGElement} micIconOff
 * @param {VoiceAssistant} assistant
 * @param {HTMLAudioElement} activationSound
 */
function updateUI(
  event,
  statusDiv,
  micIconOn,
  micIconOff,
  assistant,
  activationSound,
) {
  if (assistant.isMuted) {
    micIconOn.style.display = "none";
    micIconOff.style.display = "block";
    statusDiv.textContent = "Muted. Tap mic to unmute.";
    return;
  }

  micIconOn.style.display = "block";
  micIconOff.style.display = "none";

  switch (event.type) {
    case "command":
      if (event.audioUrl) {
        log(
          `Got command, audio available at ${event.audioUrl}`,
          event.timestamp,
        );
        // To avoid confusion, we don't play back the user's command.
        // const audio = new Audio(event.audioUrl);
        // audio.onerror = (e) => {
        //   console.error("Error playing audio:", e.target.error);
        // };
        // audio.play().catch((error) => {
        //   console.warn("Audio playback failed:", error);
        // });
      } else {
        log("No command recorded.", event.timestamp);
      }
      break;
    case "statechange":
      log(`Assistant state: ${event.state}`, event.timestamp);
      switch (event.state) {
        case VoiceAssistant.State.LISTENING_FOR_WAKE_WORD:
          micIconOn.style.fill = "red";
          statusDiv.textContent = "Say 'OK Metallica' to start.";
          break;
        case VoiceAssistant.State.ACTIVATING:
          micIconOn.style.fill = "orange";
          statusDiv.textContent = "Heard you!";
          break;
        case VoiceAssistant.State.RECORDING_USER_SPEECH:
          micIconOn.style.fill = "green";
          statusDiv.textContent = "Listening...";
          break;
        case VoiceAssistant.State.PROCESSING_USER_SPEECH:
          micIconOn.style.fill = "blue";
          statusDiv.textContent = "Thinking...";
          break;
      }
      if (event.state === VoiceAssistant.State.ACTIVATING) {
        activationSound.play().catch((e) =>
          console.error("Activation sound failed to play", e)
        );
      }
      break;
    case "transcript":
      log(
        `Transcript (final=${event.isFinal}): ${event.transcript}`,
        event.timestamp,
      );
      statusDiv.textContent = event.transcript;
      break;
    case "error":
      console.error(`Assistant error: ${event.message}`);
      statusDiv.textContent = `Error: ${event.message}`;
      break;
    case "speakstart":
      log(`Assistant speaking: "${event.text}"`, event.timestamp);
      statusDiv.textContent = `Speaking...`;
      break;
    case "speakend":
      log("Assistant finished speaking.", event.timestamp);
      break;
  }
}

// Usage
(async () => {
  const statusDiv = document.getElementById("status-div");
  const micIconOn = document.getElementById("mic-icon-on");
  const micIconOff = document.getElementById("mic-icon-off");
  logDiv = document.getElementById("log-div");
  const activationSound =
    /** @type {HTMLAudioElement} */ (document.getElementById(
      "activation-sound",
    ));

  try {
    const assistant = await VoiceAssistant.init();
    log("Voice assistant initialized. Listening for events...");

    micIconOn.addEventListener("click", () => assistant.toggleMute());
    micIconOff.addEventListener("click", () => assistant.toggleMute());

    for await (const event of assistant.events()) {
      updateUI(
        event,
        statusDiv,
        micIconOn,
        micIconOff,
        assistant,
        activationSound,
      );
    }
  } catch (err) {
    console.error("An error occurred:", err);
    if (statusDiv) {
      statusDiv.textContent = `Error: ${err.message}`;
    }
    if (micIconOn && micIconOff) {
      micIconOn.style.display = "none";
      micIconOff.style.display = "block";
    }
  }
})();
