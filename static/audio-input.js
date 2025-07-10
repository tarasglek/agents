/**
 * @typedef {object} AudioRecorderResult
 * @property {string} transcript
 * @property {string | null} audioUrl
 */

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
      console.log("Audio recording started.");

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
        console.log("MediaRecorder stopped. Finalizing audio.");
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
 * @returns {Promise<AudioRecorderResult>}
 */
async function startRecordingAndTranscription(
  wakePhraseRegex = /ok[^a-z]+metallica/i,
) {
  if (!("webkitSpeechRecognition" in window) || !("MediaRecorder" in window)) {
    throw new Error(
      "SpeechRecognition or MediaRecorder not supported in this browser.",
    );
  }

  /** @type { AudioRecorder | undefined} */
  let audioRecorder;

  return new Promise((resolve, reject) => {
    let finalTranscript = "";
    let isSpeechEnded = false;
    let speechEndTimeout;

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
      console.log(
        "Interim transcript json:",
        JSON.stringify(interimTranscript),
      );
      if (wakePhraseRegex.test(interimTranscript)) {
        console.log("Wake phrase detected!");
        audioRecorder = await AudioRecorder.start();
      }
    };

    /** @param {SpeechRecognitionErrorEvent} event */
    recognition.onerror = function (event) {
      audioRecorder.stop();
      reject(new Error("Error occurred in recognition: " + event.error));
    };

    recognition.onspeechend = async function () {
      isSpeechEnded = true;
      console.log("Speech has stopped being detected", audioRecorder);
      if (audioRecorder) {
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
      }
      // Start a timeout when speech ends
      /*speechEndTimeout = setTimeout(() => {
          recognition.stop(); // Stop speech recognition after 5 seconds of silence
        }, 0);*/
    };

    recognition.onspeechstart = function () {
      isSpeechEnded = false;
      console.log("Speech has been detected");
      clearTimeout(speechEndTimeout); // Clear the timeout when speech starts again
    };

    // Start speech recognition
    recognition.start();
  });
}

// Usage
(async () => {
  try {
    const { transcript, audioUrl } = await startRecordingAndTranscription();
    console.log("Final transcript:", transcript);
    console.log("Audio URL:", audioUrl);
  } catch (err) {
    console.error("An error occurred:", err);
  }
})();
