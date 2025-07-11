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
 * @param {string} [wakePhrase]
 * @returns {void}
 */
function startRecordingAndTranscription(
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

  /** @type { AudioRecorder | undefined} */
  let audioRecorder;
  let noInterimResultsTimeout;

  let finalTranscript = "";

  // Initialize the SpeechRecognition object
  /** @type {SpeechRecognition} */
  const recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  // Set up the event listeners for SpeechRecognition
  /** @param {SpeechRecognitionEvent} event */
  recognition.onresult = async function (event) {
    let interimTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }
    log(
      `Interim transcript json: ${JSON.stringify(interimTranscript)}`,
    );
    if (wakePhraseRegex.test(interimTranscript) && !audioRecorder) {
      log("Wake phrase detected!");
      speak("Listening");
      audioRecorder = await AudioRecorder.start();
    }
    const TIMEOUT = 4000;
    if (audioRecorder) {
      clearTimeout(noInterimResultsTimeout);
      log("[re]-set noInterimResultsTimeout");
      noInterimResultsTimeout = setTimeout(async () => {
        log(`No interim results for ${TIMEOUT}ms, stopping recording.`);
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
      }, TIMEOUT);
    }
  };

  /** @param {SpeechRecognitionErrorEvent} event */
  recognition.onerror = function (event) {
    if (audioRecorder) {
      audioRecorder.stop();
    }
    console.error("Error occurred in recognition: " + event.error);
  };

  recognition.onspeechend = function () {
    log("Speech has stopped being detected");
  };

  recognition.onspeechstart = function () {
    log("Speech has been detected");
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
    startRecordingAndTranscription();
    log("Continuous speech recognition started.");
  } catch (err) {
    console.error("An error occurred:", err);
  }
})();
