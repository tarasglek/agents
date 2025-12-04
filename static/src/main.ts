import * as emr from "extendable-media-recorder";
import * as wavEncoder from "extendable-media-recorder-wav-encoder";

interface StateChangeEvent { type: 'statechange'; state: string; timestamp: number; }
interface TranscriptEvent { type: 'transcript'; transcript: string; isFinal: boolean; timestamp: number; }
interface CommandEvent { type: 'command'; audioUrl: string | null; extension: string | undefined; timestamp: number; }
interface SpeakStartEvent { type: 'speakstart'; text: string; timestamp: number; }
interface SpeakEndEvent { type: 'speakend'; timestamp: number; }
interface ErrorEvent { type: 'error'; message: string; timestamp: number; }
type VoiceAssistantEvent = StateChangeEvent | TranscriptEvent | CommandEvent | SpeakStartEvent | SpeakEndEvent | ErrorEvent;

let lastLogTime = Date.now();
/** @type {HTMLElement | null} */
let logDiv: HTMLElement | null = null;

/**
 * @param {string | Node} message
 * @param {number} [timestamp]
 */
function log(message: string | Node, timestamp?: number) {
  const now = timestamp ?? Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;
  const prefix = `+${diff}ms `;
  const logMessage = prefix +
    (typeof message === "string" ? message : message.textContent);
  console.log(logMessage);
  if (logDiv) {
    const logEntry = document.createElement("div");
    logEntry.append(prefix, message);
    logDiv.prepend(logEntry);
  }
}

class AudioRecorder {
  mediaRecorder: emr.MediaRecorder;
  audioChunks: Blob[];

  /**
   * @param {MediaRecorder} mediaRecorder
   * @param {Blob[]} audioChunks
   */
  constructor(mediaRecorder: emr.MediaRecorder, audioChunks: Blob[]) {
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

      const mediaRecorder = new emr.MediaRecorder(stream, {
        mimeType: "audio/wav",
      });
      log(`Using mimeType: ${mediaRecorder.mimeType}`);
      const audioChunks: Blob[] = [];

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
   * @returns {Promise<{audioUrl: string, extension: string} | null>}
   */
  stop(): Promise<{audioUrl: string, extension: string} | null> {
    return new Promise((resolve, reject) => {
      this.mediaRecorder.onstop = () => {
        if (this.audioChunks.length === 0) {
          console.warn("No audio chunks recorded. Cannot create audio blob.");
          resolve(null);
          return;
        }
        try {
          const mimeType = this.mediaRecorder.mimeType;
          const audioBlob = new Blob(this.audioChunks, { type: mimeType });
          const audioUrl = URL.createObjectURL(audioBlob);
          const extension = (mimeType.split(";")[0].split("/")[1]) || "bin";
          resolve({ audioUrl, extension });
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
  #state: string;
  #isMuted = false;
  /** @type {RegExp} */
  #wakePhraseRegex: RegExp;
  /** @type {SpeechRecognition} */
  #recognition: any;
  /** @type {AudioRecorder | undefined} */
  #audioRecorder: AudioRecorder | undefined;
  /** @type {number | undefined} */
  #endOfSpeechTimeout: number | undefined;
  /** @type {number | undefined} */
  #noSpeechAfterWakeWordTimeout: number | undefined;
  /** @type {string} */
  #finalTranscriptSinceRecording: string;
  /** @type {SpeechSynthesisUtterance} */
  #utterance: SpeechSynthesisUtterance;

  /** @type {VoiceAssistantEvent[]} */
  #eventQueue: VoiceAssistantEvent[] = [];
  /** @type {(() => void) | null} */
  #eventResolver: ((value?: void) => void) | null = null;

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
        this.#audioRecorder?.stop().then((result) => {
          if (result?.audioUrl) URL.revokeObjectURL(result.audioUrl); // Clean up blob URL
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
   * @param {any} SpeechRecognition
   */
  constructor(wakePhraseRegex: RegExp, SpeechRecognition: any) {
    this.#wakePhraseRegex = wakePhraseRegex;
    this.#state = VoiceAssistant.State.LISTENING_FOR_WAKE_WORD; // Set initial state without event
    this.#finalTranscriptSinceRecording = "";
    this.#utterance = new SpeechSynthesisUtterance();
    this.#audioRecorder = undefined;
    this.#endOfSpeechTimeout = undefined;
    this.#noSpeechAfterWakeWordTimeout = undefined;

    this.#recognition = new SpeechRecognition();
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
  #emit(event: Omit<VoiceAssistantEvent, "timestamp">) {
    this.#eventQueue.push({ ...event, timestamp: Date.now() } as VoiceAssistantEvent);
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
      await new Promise<void>((resolve) => {
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
  static async init({
    // The `?:` syntax is for a non-capturing group. It allows us to match
    // "ok" or "okay" without capturing which one was said.
    wakePhraseRegex = /(?:ok|okay)[^a-z]+metallica/i,
  } = {}) {
    await emr.register(await wavEncoder.connect());
    const SpeechRecognition = (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    const missingFeatures = [];
    if (!SpeechRecognition) {
      missingFeatures.push(
        "SpeechRecognition (window.SpeechRecognition or window.webkitSpeechRecognition)",
      );
    }
    if (!("MediaRecorder" in window)) {
      missingFeatures.push("MediaRecorder");
    }
    if (!("speechSynthesis" in window)) {
      missingFeatures.push("SpeechSynthesis");
    }

    if (missingFeatures.length > 0) {
      throw new Error(
        `The following features are not supported in this browser: ${
          missingFeatures.join(", ")
        }.`,
      );
    }
    const assistant = new VoiceAssistant(wakePhraseRegex, SpeechRecognition);
    assistant.#recognition.start();
    return assistant;
  }

  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  speak(text: string) {
    if (this.#isMuted) return Promise.resolve();
    this.#emit({ type: "speakstart", text });
    return new Promise<void>((resolve, reject) => {
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

    const result = await this.#audioRecorder.stop();
    this.#audioRecorder = undefined;

    this.#emit({
      type: "command",
      audioUrl: result?.audioUrl ?? null,
      extension: result?.extension,
    });

    this.state = VoiceAssistant.State.LISTENING_FOR_WAKE_WORD;
  }

  /**
   * @param {SpeechRecognitionEvent} event
   * @returns {Promise<void>}
   */
  async #onResult(event: any) {
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
  #onError(event: any) {
    if (event.error === "no-speech") {
      // It's normal for the speech recognition to time out if nobody's talking.
      console.log("Recognition: no-speech error.");
      // If we get a no-speech error while recording, it means the user
      // has stopped talking.
      this.#stopRecording();
      return;
    }

    this.#emit({
      type: "error",
      message: `Recognition Error: ${event.error}`,
    });
    console.error("Error occurred in recognition: " + event.error);

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
  event: VoiceAssistantEvent,
  statusDiv: HTMLElement,
  micIconOn: SVGElement,
  micIconOff: SVGElement,
  assistant: VoiceAssistant,
  activationSound: HTMLAudioElement,
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
        const messageNode = document.createElement("span");

        const playButton = document.createElement("a");
        playButton.href = "#";
        playButton.textContent = "▶️";
        playButton.title = "Play audio";
        playButton.style.textDecoration = "none";
        playButton.style.cursor = "pointer";
        playButton.onclick = (e) => {
          e.preventDefault();
          const audio = new Audio(event.audioUrl);
          audio.onerror = (err) => {
            console.error("Error playing audio:", err);
          };
          audio.play().catch((error) => {
            console.warn("Audio playback failed:", error);
          });
        };

        const link = document.createElement("a");
        link.href = event.audioUrl;
        link.textContent = "download";
        link.download = `command-audio-${event.timestamp}.${
          event.extension || "wav"
        }`;
        messageNode.append(
          "Got command, audio available for ",
          playButton,
          " ",
          link,
        );
        log(messageNode, event.timestamp);
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
        activationSound.play().catch((e: any) =>
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

    if (micIconOn) micIconOn.addEventListener("click", () => assistant.toggleMute());
    if (micIconOff) micIconOff.addEventListener("click", () => assistant.toggleMute());

    for await (const event of assistant.events()) {
      if (statusDiv && micIconOn && micIconOff) {
        updateUI(
          event,
          statusDiv,
          micIconOn as SVGElement,
          micIconOff as SVGElement,
          assistant,
          activationSound,
        );
      }
    }
  } catch (err: any) {
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
