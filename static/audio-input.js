class AudioRecorder {
  constructor(mediaRecorder, audioChunks) {
    this.mediaRecorder = mediaRecorder;
    this.audioChunks = audioChunks;
  }

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

async function startRecordingAndTranscription(wakePhrase = "ok metallica") {
  if (!("webkitSpeechRecognition" in window) || !("MediaRecorder" in window)) {
    throw new Error(
      "SpeechRecognition or MediaRecorder not supported in this browser.",
    );
  }

  let finalTranscript = "";
    let speechEndTimeout = null;
    let wakePhraseDetected = false;
    const wakePhraseRegex = new RegExp(wakePhrase, "i");

    // Initialize the SpeechRecognition object
    const recognition = new webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    // Set up the event listeners for SpeechRecognition
    recognition.onresult = function (event) {
      let interimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      console.log("Interim transcript:", interimTranscript);
      if (!wakePhraseDetected) {
        const currentTranscript = finalTranscript + interimTranscript;
        if (wakePhraseRegex.test(currentTranscript)) {
          console.log("Wake phrase detected!");
          wakePhraseDetected = true;
        }
      }
    };

    recognition.onerror = function (event) {
      throw new Error("Error occurred in recognition: " + event.error);
    };

    recognition.onspeechend = function () {
      isSpeechEnded = true;
      console.log("Speech has stopped being detected");
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

    const audioRecorder = await AudioRecorder.start();

    recognition.onend = async () => {
      console.log("Speech recognition ended. Stopping media recorder.");
      const audioUrl = await audioRecorder.stop();

      if (audioUrl) {
        const audio = new Audio(audioUrl);
        audio.onerror = (event) => {
          console.error("Error playing audio:", event.target.error);
        };
        audio.play().catch((error) => {
          console.warn("Audio playback failed:", error);
        });
      }

      return { transcript: finalTranscript, audioUrl: audioUrl };
    };

    // Start speech recognition
    recognition.start();
}

// Usage
(async () => {
  try {
    const { transcript, audioUrl } = await startRecordingAndTranscription();
    console.log("Final transcript:", transcript);
    console.log("Audio URL:", audioUrl);
  } catch (error) {
    console.error("An error occurred:", error);
  }
})();
