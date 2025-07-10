function startRecordingAndTranscription() {
  return new Promise((resolve, reject) => {
    if (
      !("webkitSpeechRecognition" in window) || !("MediaRecorder" in window)
    ) {
      reject(
        "SpeechRecognition or MediaRecorder not supported in this browser.",
      );
      return;
    }

    let finalTranscript = "";
    let isSpeechEnded = false;
    let speechEndTimeout = null;

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
    };

    recognition.onerror = function (event) {
      reject("Error occurred in recognition: " + event.error);
    };

    recognition.onspeechend = function () {
      isSpeechEnded = true;
      console.log("Speech has stopped being detected");
      // Start a timeout when speech ends
      speechEndTimeout = setTimeout(() => {
        recognition.stop(); // Stop speech recognition after 5 seconds of silence
      }, 5000);
    };

    recognition.onspeechstart = function () {
      isSpeechEnded = false;
      console.log("Speech has been detected");
      clearTimeout(speechEndTimeout); // Clear the timeout when speech starts again
    };

    // Start speech recognition
    recognition.start();

    // Set up audio recording
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        const mediaRecorder = new MediaRecorder(stream);
        const audioChunks = [];

        mediaRecorder.ondataavailable = function (event) {
          audioChunks.push(event.data);
        };

        mediaRecorder.onstop = function () {
          console.log("MediaRecorder stopped. Finalizing audio.");
          if (audioChunks.length === 0) {
            console.warn("No audio chunks recorded. Cannot create audio blob.");
            resolve({ transcript: finalTranscript, audioUrl: null });
            return;
          }
          try {
            const audioBlob = new Blob(audioChunks);
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.onerror = (event) => {
              console.error("Error playing audio:", event.target.error);
            };
            audio.play().catch((error) => {
              // This might happen due to browser autoplay policies.
              // It's not a fatal error for the recording process itself.
              console.warn("Audio playback failed:", error);
            });
            resolve({ transcript: finalTranscript, audioUrl: audioUrl });
          } catch (error) {
            console.error("Error processing audio:", error);
            reject("Failed to process recorded audio.");
          }
        };

        // Start audio recording
        mediaRecorder.start();

        // Stop recording when speech recognition stops
        recognition.onend = function () {
          mediaRecorder.stop();
        };
      })
      .catch(function (err) {
        reject("Could not get user media: " + err);
      });
  });
}

// Usage
startRecordingAndTranscription().then(({ transcript, audioUrl }) => {
  console.log("Final transcript:", transcript);
  console.log("Audio URL:", audioUrl);
}).catch((error) => {
  console.error("An error occurred:", error);
});
